/**
 * Snapshot synchronization — the host-authoritative state channel.
 *
 * HOST (SnapshotSender): samples the adapter at SYNC_HZ (default 15), numbers
 * every snapshot with a monotonic seq, piggybacks the last processed guest
 * input seq as `ack`, and collapses unchanged worlds into tiny `same` markers
 * so an idle scene costs ~30 bytes instead of the full payload.
 *
 * GUEST (GuestSnapshotApplier): runs its own local simulation for low-latency
 * feedback and feeds every snapshot through the adapter's threshold correction
 * (soft position lerp, hard snap, discrete facts). It also follows the host's
 * level: when the host enters (or restarts) a level the guest auto-enters the
 * same one via the adapter's startLevel, and if the guest's local sim ever
 * ends a level the host is still playing, the guest re-enters it (host truth
 * wins — a level the host has not finished is not over).
 *
 * Ordering/dupes: seq strictly increases; stale or replayed snapshots (socket
 * reconnects can duplicate) are dropped. Snapshot payloads themselves are
 * validated by the server before relay; the guest additionally trusts nothing
 * that would make the adapter crash (adapter guards every write).
 */
import { logger } from '../core/logger.js';

export class SnapshotSender {
  constructor({ bus, net, session, adapter, P, hz = 15, getAck = () => -1 }) {
    this.bus = bus;
    this.net = net;
    this.session = session;
    this.adapter = adapter;
    this.P = P;
    this.hz = hz;
    this.getAck = getAck;

    this.seq = 0;
    // Sequence numbers restart when the host page reloads. The epoch lets a
    // guest distinguish that fresh stream from an old one it has already seen.
    this.epoch = globalThis.crypto?.randomUUID?.().replaceAll('-', '') ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
    this.timer = null;
    this.lastHash = null;
    this.enteringLevel = false;

    // A rejoining guest has missed everything: force the next full payload.
    bus.on('session:peer', ({ connected }) => {
      if (connected) {
        this.lastHash = null;
        this.start();
      } else {
        this.stop();
      }
    });
    bus.on('session:left', () => this.stop());
  }

  start() {
    if (this.timer || !this.session.isHost) return;
    this.timer = setInterval(() => this.#tick(), Math.round(1000 / this.hz));
    logger.info(`snapshot sender started at ${this.hz}Hz`);
  }

  stop() {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
    // seq stays MONOTONIC across peer sessions: the guest dedupes by seq and
    // a reset would make it drop every snapshot until the old counter is
    // exceeded again.
    this.lastHash = null;
  }

  /** Next tick sends a full payload even if the world hash is unchanged. */
  forceFull() {
    this.lastHash = null;
  }

  #tick() {
    if (!this.session.isHost || !this.session.peer.connected) return;
    if (!this.net.connected) return;
    // Relay gate mirrors the server: nothing flows outside live room states.
    const roomState = this.session.state?.state;
    const relay = new Set([
      this.P.ROOM_STATES.PLAYING,
      this.P.ROOM_STATES.PAUSED,
      this.P.ROOM_STATES.RECONNECTING,
      this.P.ROOM_STATES.FINISHED,
    ]);
    if (!relay.has(roomState)) return;

    const state = this.adapter.getState();
    // Menu phases: no world to send (the guest follows via game:status).
    if (!state) return;

    // Round identity: the server drops snapshots from an older round, so a
    // restart/level switch can never be polluted by in-flight packets.
    const roundId = this.session.round?.id ?? 0;
    const hash = `${roundId}|${JSON.stringify(state)}`;
    const unchanged = hash === this.lastHash && this.lastHash !== null;
    this.seq += 1;
    const payload = unchanged
      ? { e: this.epoch, seq: this.seq, ack: this.getAck(), r: roundId, same: true }
      : { e: this.epoch, seq: this.seq, ack: this.getAck(), r: roundId, snap: state };
    this.lastHash = hash;

    this.net.emit(this.P.EVENTS.SYNC_SNAPSHOT, payload);
    this.sentCount = (this.sentCount ?? 0) + 1;
    this.bus.emit('sync:stats', {
      seq: this.seq,
      ack: payload.ack,
      r: roundId,
      same: unchanged || undefined,
      bytes: unchanged ? 0 : hash.length,
      hz: this.hz,
    });
  }
}

const ENTER_RETRY_MS = 1500;

export class GuestSnapshotApplier {
  constructor({ bus, net, session, adapter, P }) {
    this.bus = bus;
    this.net = net;
    this.session = session;
    this.adapter = adapter;
    this.P = P;

    this.lastSeq = -1;
    this.lastEpoch = null;
    this.lastAck = -1;
    this.lastAgeMs = null;
    this.entering = false;
    this.lastEnterAt = 0;
    this.lastRecoverAt = 0;
    /** One host-authoritative recovery restart per local level instance. */
    this.recovering = false;
    /** Level the host was last seen in (full snapshots only) — a static world
     * only produces `same` heartbeats (no lvl), so follow retries need this. */
    this.lastSeenHostLevel = null;

    // Correction totals for the HUD + the per-frame delta carried on input frames.
    this.correctionsTotal = 0;
    this.correctionsSoft = 0;
    this.correctionsHard = 0;
    this.correctionsDiscrete = 0;
    this.#correctionsSinceFrame = 0;

    // A fresh seat binding (join, rejoin after a network blip, page reload)
    // must not keep the old seq filter: the host's counter may legitimately
    // continue from where this page last saw it, or start over after a
    // reload. Reset so the very next snapshot is applied.
    bus.on('session:joined', ({ role }) => {
      if (role === P.ROLES.GUEST) {
        this.lastSeq = -1;
        this.lastHash = null;
      }
    });
    // A new Level instance is the only point at which a recovery restart is
    // complete. Clear the guard here so a later, genuine round can recover.
    bus.on('adapter:level-created', () => {
      this.recovering = false;
    });
    bus.on('adapter:level-destroyed', () => {
      this.recovering = false;
    });

    net.on(P.EVENTS.SYNC_SNAPSHOT, (payload) => this.#onSnapshot(payload));
  }

  #correctionsSinceFrame;

  /** Corrections accumulated since the previous call (consumed per input frame). */
  takeCorrections() {
    const n = this.#correctionsSinceFrame;
    this.#correctionsSinceFrame = 0;
    return n;
  }

  #onSnapshot(payload) {
    // The host must never apply its own snapshots, even if the server was
    // somehow coaxed into echoing them back.
    if (this.session.isHost) return;
    if (!payload || typeof payload !== 'object') return;
    // A host reload starts its counter at zero. Reset the ordering window when
    // the stream epoch changes so the guest keeps receiving authoritative
    // movement immediately after reconnect/reload.
    const epoch = typeof payload.e === 'string' ? payload.e : '';
    if (epoch !== this.lastEpoch) {
      this.lastEpoch = epoch;
      this.lastSeq = -1;
    }
    if (typeof payload.seq !== 'number' || payload.seq <= this.lastSeq) {
      this.droppedCount = (this.droppedCount ?? 0) + 1; // stale / duplicate
      return;
    }
    // Round isolation, client-side echo of the server gate: never let a
    // packet from an abandoned round touch the current level.
    const roundId = this.session.round?.id ?? 0;
    if (Number.isInteger(payload.r) && payload.r < roundId) {
      this.droppedCount = (this.droppedCount ?? 0) + 1; // old round
      return;
    }
    this.lastSeq = payload.seq;
    this.lastAck = typeof payload.ack === 'number' ? payload.ack : this.lastAck;
    this.lastAgeMs = typeof payload.st === 'number' ? Date.now() - payload.st : null;
    this.receivedCount = (this.receivedCount ?? 0) + 1;

    if (payload.same) {
      // Liveness marker: the guest's local sim stands; nothing to correct.
      // A static world sends NO level descriptor — keep pursuing the level
      // the host was last seen in (a failed/rejected navigation must retry).
      this.#followIfBehind();
      this.#emitStats();
      return;
    }
    const snap = payload.snap;
    if (!snap || typeof snap !== 'object') return;

    // ---- level following ------------------------------------------------------
    const hostLevel = snap.lvl;
    if (hostLevel) this.lastSeenHostLevel = hostLevel;
    const myLevel = this.adapter.getLevel();
    if (hostLevel && (!myLevel || myLevel.id !== hostLevel.id)) {
      this.#enterHostLevel(hostLevel);
      this.#emitStats({ entering: true });
      return;
    }

    // ---- correction -------------------------------------------------------------
    // The guest simulates its own character locally. The other character is
    // rendered from host snapshots; pass its seat explicitly so the adapter
    // can keep that character's animation input state in sync without
    // overwriting the locally controlled character's keys.
    const remoteChar = this.session.char === this.P.CHARS?.FIREBOY || this.session.char === 'fb'
      ? 'wg'
      : 'fb';
    const res = this.adapter.applyState(payload, { remoteChar });
    if (res.levelMismatch) {
      // Identity drift (guest still loading or rotated into another level):
      // re-enter the host's level.
      if (hostLevel) this.#enterHostLevel(hostLevel);
      this.#emitStats({ mismatch: true });
      return;
    }
    if (res.ok) {
      this.correctionsTotal += res.soft + res.hard + res.discrete;
      this.correctionsSoft += res.soft;
      this.correctionsHard += res.hard;
      this.correctionsDiscrete += res.discrete;
      this.#correctionsSinceFrame += res.soft + res.hard + res.discrete;
      // The guest's sim finished a level the host is still playing: the host
      // is authoritative, so re-enter the level and keep going.
      if (
        res.endedMismatch &&
        !this.recovering &&
        Date.now() - this.lastRecoverAt > ENTER_RETRY_MS
      ) {
        this.lastRecoverAt = Date.now();
        logger.warn('guest ended but host still playing — restarting level');
        const restarted = this.adapter.restart();
        // `restart()` is deliberately idempotent. Treat a concurrent round
        // transition as recovery too, preventing another snapshot from
        // enqueueing a second fade before the lifecycle hook fires.
        this.recovering = Boolean(restarted || this.adapter.transition);
      }
    }
    this.#emitStats();
  }

  /** On `same` heartbeats: if we know the host's level and we are not in it,
   * keep trying to follow (paced by #enterHostLevel's debounce). */
  #followIfBehind() {
    if (!this.lastSeenHostLevel) return;
    const myLevel = this.adapter.getLevel();
    if (myLevel && myLevel.id === this.lastSeenHostLevel.id && myLevel.temple === this.lastSeenHostLevel.temple) {
      return;
    }
    this.#enterHostLevel(this.lastSeenHostLevel);
  }

  #enterHostLevel(hostLevel) {
    if (this.entering) return;
    if (Date.now() - this.lastEnterAt < ENTER_RETRY_MS) return;
    this.entering = true;
    this.lastEnterAt = Date.now();
    this.adapter
      .startLevel({ temple: hostLevel.temple, id: hostLevel.id })
      .then((started) => {
        if (started) logger.info('guest following host into level', hostLevel.id);
      })
      .catch((err) => logger.warn('startLevel failed', err?.message ?? err, err?.stack?.split('\n')[1] ?? ''))
      .finally(() => {
        this.entering = false;
      });
  }

  #emitStats(extra = {}) {
    this.bus.emit('sync:guest-stats', {
      seq: this.lastSeq,
      ack: this.lastAck,
      ageMs: this.lastAgeMs,
      corrections: this.correctionsTotal,
      soft: this.correctionsSoft,
      hard: this.correctionsHard,
      discrete: this.correctionsDiscrete,
      dropped: this.droppedCount ?? 0,
      received: this.receivedCount ?? 0,
      ...extra,
    });
  }
}
