import {
  ROLES,
  CHARS,
  ROOM_STATES,
  ROOM_CLOSE_REASONS,
  LIMITS,
  oppositeChar,
} from '../../../common/protocol/events.mjs';

let nextMemberId = 1;

function isConnected(player) {
  return Boolean(player && player.connected);
}

/**
 * A room holds exactly two seats (slots): `host` (creator) and `guest`
 * (joiner). Each seat owns one character; the host slot's char is the
 * anchor (`hostChar`), the guest always plays the opposite one, and the
 * only way chars change is a mutually accepted swap.
 *
 * The room is the single authority for the state machine:
 *
 *   waiting ── both seated+loaded+ready ──▶ ready ──▶ countdown ──▶ playing
 *     ▲                                                                  │
 *     │── guest seat released ◀────────────────── reconnecting ◁────────┤
 *     │                                     playing ⇄ paused            │
 *     └────────── re-ready for the next level ◀──────── finished ◀──────┘
 *
 * Every mutation funnels through #evaluate() and notifies #onChange, so the
 * socket layer only broadcasts — it never decides state.
 */
export class Room {
  constructor(code, game, { seatGraceMs, countdownMs, swapOfferTtlMs, emptyTtlMs, log, onChange, onClose }) {
    this.code = code;
    this.game = game;
    this.seatGraceMs = seatGraceMs;
    this.countdownMs = countdownMs;
    this.swapOfferTtlMs = swapOfferTtlMs;
    this.emptyTtlMs = emptyTtlMs;
    this.log = log ?? (() => {});
    /** Invoked after every state/seat mutation (broadcast room:state). */
    this.onChange = onChange ?? (() => {});
    /** Invoked exactly once with the close reason when the room closes. */
    this.onClose = onClose ?? (() => {});
    /** Invoked when the synchronized start fires, with the scheduled startAt. */
    this.onStart = null;
    /** Invoked when a seat is freed (grace expiry or leave) so the manager
     * can drop that seat's rejoin-token index entry. */
    this.onSeatRelease = () => {};

    this.createdAt = Date.now();
    this.state = ROOM_STATES.WAITING;
    /** Character of the HOST slot ('fb' | 'wg'); guest slot plays the opposite. */
    this.hostChar = CHARS.FIREBOY;
    /** slot ('host'|'guest') -> player | null */
    this.players = { host: null, guest: null };
    /** {from: slot, timer} | null */
    this.swapOffer = null;
    /** Fact reported by the host via game:status; drives paused ⇄ playing. */
    this.hostPaused = false;
    /** True once the host reported a finished level (resting in 'finished'). */
    this.levelEnded = false;

    this.closed = false;
    this.closeReason = null;
    this.timers = { countdown: null, seatHost: null, seatGuest: null, empty: null, swap: null };
  }

  static createPlayer(slot, char, token) {
    return {
      id: nextMemberId++,
      slot,
      char,
      token,
      socketId: null,
      connected: false,
      loaded: false,
      ready: false,
      latencyMs: null,
      joinedAt: Date.now(),
      disconnectedAt: null,
    };
  }

  // ---- seat queries --------------------------------------------------------

  getPlayer(slot) {
    return this.players[slot] ?? null;
  }

  getPlayerByToken(token) {
    for (const player of Object.values(this.players)) {
      if (player && player.token === token) return player;
    }
    return null;
  }

  getPlayerBySocket(socketId) {
    for (const player of Object.values(this.players)) {
      if (player && player.socketId === socketId) return player;
    }
    return null;
  }

  getPeer(player) {
    return this.players[player.slot === ROLES.HOST ? ROLES.GUEST : ROLES.HOST] ?? null;
  }

  isFull() {
    return Boolean(this.players.host && this.players.guest);
  }

  /**
   * Countdown can only run when both seats are occupied, connected, have
   * loaded the game resources, and manually readied up — and no swap is
   * pending. This is the gate; nothing else starts a game.
   */
  #readyToStart() {
    const h = this.players.host;
    const g = this.players.guest;
    return (
      Boolean(h && g) &&
      h.connected &&
      g.connected &&
      h.loaded &&
      g.loaded &&
      h.ready &&
      g.ready &&
      !this.swapOffer
    );
  }

  // ---- seating ---------------------------------------------------------------

  /** Seat the creator. `char` is their choice; defaults to Fireboy. */
  seatHost({ char = CHARS.FIREBOY, token }) {
    this.hostChar = char;
    const player = Room.createPlayer(ROLES.HOST, char, token);
    this.players.host = player;
    this.#rearmEmptyTimer();
    this.#evaluate();
    return player;
  }

  /** Seat the joiner — always the character opposite the host slot's. */
  seatGuest({ token }) {
    const player = Room.createPlayer(ROLES.GUEST, oppositeChar(this.hostChar), token);
    this.players.guest = player;
    this.#evaluate();
    return player;
  }

  /** Bind a live socket to a seated player (fresh join or rejoin). */
  attachSocket(player, socketId) {
    player.socketId = socketId;
    player.connected = true;
    player.disconnectedAt = null;
    this.clearTimer(player.slot === ROLES.HOST ? 'seatHost' : 'seatGuest');
    this.clearTimer('empty');
    // Still not full (e.g. creator waiting in the lobby): keep the empty-room
    // TTL armed so an abandoned room cannot linger forever.
    if (!this.isFull()) this.#rearmEmptyTimer();
    this.#evaluate();
  }

  /**
   * Socket dropped. The SEAT is held for seatGraceMs — the peer sees
   * "reconnecting" — and only then is the slot truly released.
   */
  detachSocket(player) {
    player.connected = false;
    player.disconnectedAt = Date.now();
    const timerKey = player.slot === ROLES.HOST ? 'seatHost' : 'seatGuest';
    this.clearTimer(timerKey);
    this.timers[timerKey] = setTimeout(() => {
      this.timers[timerKey] = null;
      // Only release if the same drop is still in effect.
      const current = this.getPlayer(player.slot);
      if (current === player && !current.connected) this.#releaseSeat(player.slot, 'grace-expired');
    }, this.seatGraceMs);
    this.timers[timerKey].unref?.();
    this.#evaluate();
  }

  /** Free a seat immediately (voluntary leave or grace expiry). */
  #releaseSeat(slot, reason) {
    const player = this.players[slot];
    if (!player) return;
    this.clearTimer(slot === ROLES.HOST ? 'seatHost' : 'seatGuest');
    this.players[slot] = null;
    this.onSeatRelease(player);
    this.log(`room ${this.code}: ${slot} seat released (${reason})`);
    if (slot === ROLES.HOST) {
      // The room belongs to its creator: no host seat, no room.
      this.close(reason === 'left' ? ROOM_CLOSE_REASONS.HOST_LEFT : ROOM_CLOSE_REASONS.HOST_TIMEOUT);
      return;
    }
    // Nobody incoming: don't let an abandoned room linger forever.
    this.#rearmEmptyTimer();
    this.#evaluate();
  }

  releaseSeatByToken(token) {
    const player = this.getPlayerByToken(token);
    if (!player) return false;
    this.#releaseSeat(player.slot, 'left');
    return true;
  }

  // ---- readiness / gameplay facts -----------------------------------------

  setLoaded(player, loaded) {
    if (player.loaded === loaded) return;
    player.loaded = loaded;
    this.#evaluate();
  }

  setReady(player, ready) {
    if (player.ready === ready) return;
    player.ready = ready;
    this.#evaluate();
  }

  /** Host-reported pause fact (game:status). Only meaningful while live. */
  setHostPaused(paused) {
    if (this.hostPaused === paused) return;
    this.hostPaused = paused;
    this.#evaluate();
  }

  /**
   * Host reported the level ended (game:status phase === 'end').
   */
  markLevelEnded() {
    if (this.state !== ROOM_STATES.PLAYING && this.state !== ROOM_STATES.PAUSED && this.state !== ROOM_STATES.RECONNECTING) {
      return;
    }
    this.levelEnded = true;
    // A finished level always requires a fresh conscious ready from both.
    if (this.players.host) this.players.host.ready = false;
    if (this.players.guest) this.players.guest.ready = false;
    this.state = ROOM_STATES.FINISHED;
    this.#evaluate();
  }

  /** Self-reported RTT (cosmetic); never affects state, just broadcasts. */
  setLatency(player, ms) {
    player.latencyMs = ms;
    this.#notify();
  }

  // ---- role swap -------------------------------------------------------------

  offerSwap(fromSlot) {
    if (this.swapOffer) return false;
    if (this.state !== ROOM_STATES.WAITING && this.state !== ROOM_STATES.READY && this.state !== ROOM_STATES.FINISHED) {
      return false;
    }
    if (!this.isFull()) return false;
    this.swapOffer = { from: fromSlot, expiresAt: Date.now() + this.swapOfferTtlMs };
    this.clearTimer('swap');
    this.timers.swap = setTimeout(() => {
      this.timers.swap = null;
      this.swapOffer = null;
      this.#evaluate();
    }, this.swapOfferTtlMs);
    this.timers.swap.unref?.();
    this.#evaluate();
    return true;
  }

  /** The offered-to player accepts: flip chars, clear readiness, close offer. */
  acceptSwap(bySlot) {
    if (!this.swapOffer || this.swapOffer.from === bySlot) return false;
    const from = this.swapOffer.from;
    const offerer = this.players[from];
    if (!offerer || !this.players[bySlot]) return false;
    this.#clearSwapOffer();
    this.hostChar = oppositeChar(this.hostChar);
    this.players.host.char = this.hostChar;
    this.players.guest.char = oppositeChar(this.hostChar);
    // Roles changed hands: both players must ready up again.
    this.players.host.ready = false;
    this.players.guest.ready = false;
    this.log(`room ${this.code}: swap accepted (initiator ${from})`);
    this.#evaluate();
    return true;
  }

  cancelSwap() {
    if (!this.swapOffer) return false;
    this.#clearSwapOffer();
    this.#evaluate();
    return true;
  }

  #clearSwapOffer() {
    this.clearTimer('swap');
    this.swapOffer = null;
  }

  // ---- state machine core ---------------------------------------------------
  //
  // Every mutation lands here. #evaluate() always notifies at the end so
  // seat facts (connected/loaded/ready/latency) reach the peers even when
  // the machine's state itself did not change.

  #evaluate() {
    if (this.closed) return;

    // Countdown disturbed (disconnect / un-ready / swap offered): abort it,
    // then fall through to the resting resolution.
    if (this.state === ROOM_STATES.COUNTDOWN && !this.#readyToStart()) {
      this.clearTimer('countdown');
      this.countdownStartsAt = null;
      this.levelEnded = false;
      this.state = ROOM_STATES.WAITING;
      this.log(`room ${this.code}: countdown aborted`);
    }

    if (this.state === ROOM_STATES.PLAYING || this.state === ROOM_STATES.PAUSED || this.state === ROOM_STATES.RECONNECTING) {
      const host = this.players.host;
      const guest = this.players.guest;
      if (host && guest) {
        if (isConnected(host) && isConnected(guest)) {
          this.state = this.hostPaused ? ROOM_STATES.PAUSED : ROOM_STATES.PLAYING;
          this.#notify();
          return;
        }
        this.state = ROOM_STATES.RECONNECTING;
        this.#notify();
        return;
      }
      if (!host) {
        // Host seat released: the room is closing right now.
        this.#notify();
        return;
      }
      // Guest seat released mid-game: back to matchmaking.
      this.state = ROOM_STATES.WAITING;
    }

    // Resting states: waiting / ready / finished.
    if (this.#readyToStart()) {
      this.state = ROOM_STATES.READY;
      this.#notify();
      this.#beginCountdown();
      return;
    }
    this.state = this.levelEnded ? ROOM_STATES.FINISHED : ROOM_STATES.WAITING;
    this.#notify();
  }

  #beginCountdown() {
    this.clearTimer('countdown');
    this.state = ROOM_STATES.COUNTDOWN;
    this.countdownStartsAt = Date.now() + this.countdownMs;
    this.timers.countdown = setTimeout(() => {
      this.timers.countdown = null;
      if (this.closed || this.state !== ROOM_STATES.COUNTDOWN) return;
      const startAt = this.countdownStartsAt ?? Date.now();
      this.state = ROOM_STATES.PLAYING;
      this.hostPaused = false;
      this.levelEnded = false;
      this.countdownStartsAt = null;
      this.log(`room ${this.code}: started`);
      // Order matters: room:state first, then the start command.
      this.#notify();
      this.onStart?.(startAt);
    }, this.countdownMs);
    this.timers.countdown.unref?.();
    this.log(`room ${this.code}: countdown ${this.countdownMs}ms`);
    this.#notify();
  }

  #notify() {
    try {
      this.onChange(this);
    } catch (err) {
      this.log(`room ${this.code}: onChange failed: ${err?.message ?? err}`);
    }
  }

  #rearmEmptyTimer() {
    this.clearTimer('empty');
    this.timers.empty = setTimeout(() => {
      this.timers.empty = null;
      if (this.closed) return;
      if (!this.isFull()) this.close('expired');
    }, this.emptyTtlMs);
    this.timers.empty.unref?.();
  }

  /** Safety net for timers a sweeper restart may have missed. */
  checkSeatGrace(now = Date.now()) {
    for (const slot of [ROLES.HOST, ROLES.GUEST]) {
      const player = this.players[slot];
      if (player && !player.connected && player.disconnectedAt && now - player.disconnectedAt > this.seatGraceMs) {
        this.#releaseSeat(slot, 'grace-expired');
      }
    }
  }

  clearTimer(name) {
    if (this.timers[name]) {
      clearTimeout(this.timers[name]);
      this.timers[name] = null;
    }
  }

  /** Voluntary shutdown by the host seat or the server. */
  close(reason) {
    if (this.closed) return;
    this.closed = true;
    this.closeReason = reason;
    for (const name of Object.keys(this.timers)) this.clearTimer(name);
    this.#clearSwapOffer();
    this.onClose(reason);
  }

  /**
   * Authoritative projection broadcast as room:state. Contains no secrets —
   * the rejoin token never appears here.
   */
  describe() {
    const playerView = (player) =>
      player
        ? {
            char: player.char,
            connected: player.connected,
            loaded: player.loaded,
            ready: player.ready,
            latencyMs: player.latencyMs,
          }
        : null;
    return {
      code: this.code,
      game: this.game,
      state: this.state,
      hostChar: this.hostChar,
      serverNow: Date.now(),
      players: {
        host: playerView(this.players.host),
        guest: playerView(this.players.guest),
      },
      swap: this.swapOffer ? { from: this.swapOffer.from, expiresAt: this.swapOffer.expiresAt } : null,
      countdown:
        this.state === ROOM_STATES.COUNTDOWN
          ? { startAt: this.countdownStartsAt, durationMs: this.countdownMs }
          : null,
    };
  }
}

export { LIMITS };
