/**
 * Round synchronization — the game-lifecycle channel.
 *
 * A ROUND is one attempt at one level. The SERVER owns the roundId; the
 * HOST is the only reporter (it observes the real game through the adapter's
 * level lifecycle hooks), and the GUEST only follows `round:update` — no
 * device ever switches a level on its own.
 *
 * HOST (HostRoundReporter): maps adapter lifecycle events onto round events.
 *   level created  → 'enter' (first entry / different level)
 *                    or 'restart' (SAME level re-entered — always a fresh
 *                    round: retry, death-retry, pause-menu restart)
 *   level destroyed→ 'leave' (back to the level menu / end screen)
 *   end screen     → 'end' with result 'win' | 'dead' (from the captured
 *                    lastLevelEnd fact; the room machine marks 'finished')
 *
 * GUEST (GuestRoundFollower): applies round:update to its local game:
 *   new round, different level  → adapter.startLevel (enter with the host)
 *   new round, same level       → adapter.restart (follow the restart; the
 *                                 local sim must not survive an old round)
 *   round left (phase 'idle')   → adapter.exitLevel (follow back to the menu)
 *
 * Stale-packet isolation rides on the roundId every gameplay payload
 * carries: the server drops anything with an older roundId, the guest's
 * snapshot applier additionally ignores snapshots from before its round.
 */
import { logger } from '../core/logger.js';

const ROUND_EMIT_STATES = (P) =>
  new Set([P.ROOM_STATES.PLAYING, P.ROOM_STATES.PAUSED, P.ROOM_STATES.RECONNECTING, P.ROOM_STATES.FINISHED]);

export class HostRoundReporter {
  constructor({ bus, net, session, adapter, P }) {
    this.bus = bus;
    this.net = net;
    this.session = session;
    this.adapter = adapter;
    this.P = P;
    /** Level key of the previous level-create (restart detection). */
    this.lastCreatedKey = null;
    /** Level key of the currently reported round (dedupe of leave events). */
    this.activeKey = null;

    bus.on('adapter:level-created', ({ level }) => this.#onLevelCreated(level));
    bus.on('adapter:level-destroyed', () => this.#onLevelDestroyed());
    bus.on('adapter:phase', ({ phase }) => {
      // The end screen phase is the observable "level finished" fact; the
      // result (win|dead) was captured by the adapter at level shutdown.
      if (phase === this.P.GAME_PHASES.END && this.activeKey && this.adapter.lastLevelEnd) {
        this.#emit(this.P.ROUND_EVENT_TYPES.END, { result: this.adapter.lastLevelEnd });
        this.activeKey = null;
      }
    });
  }

  #onLevelCreated(level) {
    if (!level) return;
    const key = `${level.temple}#${level.id}`;
    const isRestart = this.lastCreatedKey === key;
    this.lastCreatedKey = key;
    if (isRestart) {
      // Re-entering the level just left/ended: a restart, never a new level.
      this.activeKey = key;
      this.#emit(this.P.ROUND_EVENT_TYPES.RESTART, { level });
      return;
    }
    // First entry (or a different level / switched game level): 'enter'. The
    // server opens a fresh round whenever the previous one already ended.
    this.activeKey = key;
    this.#emit(this.P.ROUND_EVENT_TYPES.ENTER, { level });
  }

  #onLevelDestroyed() {
    if (!this.activeKey) return;
    this.activeKey = null;
    this.#emit(this.P.ROUND_EVENT_TYPES.LEAVE, {});
  }

  #emit(type, extra = {}) {
    if (!this.session.isHost || !this.session.code) return;
    const roomState = this.session.state?.state;
    if (!ROUND_EMIT_STATES(this.P).has(roomState)) return;
    const payload = { type, ...extra };
    // Keep listeners local-testable: mirror on the bus before sending.
    this.bus.emit('round:host-event', payload);
    this.net.emit(this.P.EVENTS.ROUND_EVENT, payload);
    logger.info('round event', type, extra.result ?? extra.level?.id ?? '');
  }
}

export class GuestRoundFollower {
  constructor({ bus, net, session, adapter, P }) {
    this.bus = bus;
    this.net = net;
    this.session = session;
    this.adapter = adapter;
    this.P = P;
    this.entering = false;
    this.lastEnterAt = 0;
    this.pendingHostLevel = null;
    /** The last round THIS follower saw (session.round is already updated
     * by the time our net listener runs — we need the previous value). */
    this.lastRound = { id: 0, level: null, phase: this.P.ROUND_PHASES.IDLE };

    net.on(P.EVENTS.ROUND_UPDATE, (payload) => this.#onRoundUpdate(payload));
  }

  #onRoundUpdate(payload) {
    if (this.session.isHost) return; // the host's own game is the source
    const round = payload?.round;
    if (!round || typeof round !== 'object') return;
    const prev = this.lastRound;
    if (round.id < prev.id) return; // stale broadcast; never roll back
    this.lastRound = { ...round };

    if (round.phase === this.P.ROUND_PHASES.PLAYING && round.level) {
      const myLevel = this.adapter.getLevel();
      const sameLevel = myLevel && myLevel.temple === round.level.temple && myLevel.id === round.level.id;
      if (prev.id >= round.id && sameLevel) return; // nothing to do
      const isRestart = sameLevel && prev.id > 0 && round.id > prev.id;
      if (isRestart) {
        // Same level, NEW round: the host restarted — drop the old attempt
        // and run the game's own retry path so both sims start fresh. When
        // this page is NOT inside the level anymore (its own end screen),
        // retry() has nothing to retry: re-enter through the menu instead.
        let restarted = false;
        try { restarted = this.adapter.restart(); } catch { /* retried=false */ }
        if (!restarted) this.#enterHostLevel(round.level);
        return;
      }
      this.#enterHostLevel(round.level);
      return;
    }

    if (round.phase === this.P.ROUND_PHASES.IDLE && prev.id > 0 && round.id >= prev.id) {
      // The host left the level (menu / quit): follow it back out.
      const inLevel = this.adapter.getPhase() === this.P.GAME_PHASES.LEVEL;
      if (inLevel) {
        logger.info('guest follows round leave');
        this.adapter.exitLevel();
      }
    }
    // phase 'ended': nothing to navigate — the guest's own end screen follows
    // from its local sim (authoritative corrections already ran).
  }

  #enterHostLevel(hostLevel) {
    if (this.entering) {
      // Keep the newest authoritative target. A level switch can arrive while
      // the previous round's restart fade is still completing.
      this.pendingHostLevel = { ...hostLevel };
      return;
    }
    const waitMs = 1500 - (Date.now() - this.lastEnterAt);
    if (waitMs > 0) {
      this.pendingHostLevel = { ...hostLevel };
      setTimeout(() => {
        const pending = this.pendingHostLevel;
        this.pendingHostLevel = null;
        if (pending) this.#enterHostLevel(pending);
      }, waitMs);
      return;
    }
    this.entering = true;
    this.lastEnterAt = Date.now();
      this.adapter
      .startLevel({ temple: hostLevel.temple, id: hostLevel.id })
      .then((started) => {
        if (started) logger.info('guest following host into level', hostLevel.id);
        // A stale recovery transition may have won the race. Retry the host
        // target after its watchdog is invalidated instead of silently
        // leaving the guest in the previous level.
        if (!started) {
          const current = this.adapter.getLevel();
          if (!current || current.temple !== hostLevel.temple || current.id !== hostLevel.id) {
            setTimeout(() => this.#enterHostLevel(hostLevel), 100);
          }
        }
      })
      .catch((err) => logger.warn('startLevel failed', err?.message ?? err))
      .finally(() => {
        this.entering = false;
        const pending = this.pendingHostLevel;
        this.pendingHostLevel = null;
        if (pending) this.#enterHostLevel(pending);
      });
  }
}
