/**
 * Fireboy & Watergirl Online — shared protocol constants.
 *
 * Single source of truth for every Socket.IO event name, payload shape and
 * role/character identifier exchanged between the browser clients
 * (games/lib/multiplayer/, games/lib/lobby/) and the Node server (server/).
 *
 * Loaded as a native ES module by BOTH sides:
 *   - server:  import { EVENTS } from '../../common/protocol/events.mjs'
 *   - browser: import { EVENTS } from '/common/protocol/events.mjs'
 *
 * Hardcoding event names anywhere else is a bug.
 */

export const PROTOCOL_VERSION = 2;

/** Socket.IO event names. */
export const EVENTS = {
  // ---- room lifecycle (client -> server, server -> client) ----
  ROOM_CREATE: 'room:create',
  ROOM_CREATED: 'room:created',
  ROOM_JOIN: 'room:join',
  ROOM_JOINED: 'room:joined',
  ROOM_REJOIN: 'room:rejoin',
  ROOM_REJOINED: 'room:rejoined',
  ROOM_LEAVE: 'room:leave',
  ROOM_CLOSED: 'room:closed',
  ROOM_PEER_JOINED: 'room:peer:joined',
  ROOM_PEER_LEFT: 'room:peer:left',
  ROOM_ERROR: 'room:error',

  /** Server -> both members on EVERY room mutation. The room state machine's
   * single authoritative projection (see ROOM_STATE_SHAPE below). */
  ROOM_STATE: 'room:state',

  // ---- readiness gate (client -> server) ----
  /** {loaded: boolean} — this client finished loading the game resources. */
  ROOM_LOAD: 'room:load',
  /** {ready: boolean} — this player toggled their manual ready flag. */
  ROOM_READY: 'room:ready',

  // ---- synchronized start (server -> both, the ONLY start path) ----
  /** {serverNow, startAt, durationMs} — countdown begins. */
  ROOM_COUNTDOWN: 'room:countdown',
  /** {serverNow, startAt} — fired exactly at startAt (server clock). */
  ROOM_START: 'room:start',

  // ---- role swap (client -> server, results arrive via room:state) ----
  ROOM_SWAP: 'room:swap',

  // ---- latency (client -> server -> other member via room:state) ----
  NET_PING: 'net:ping',
  /** {ms} — self-reported RTT, cosmetic only, included in room:state. */
  NET_LATENCY: 'net:latency',

  // ---- input relay (guest -> server -> host) ----
  INPUT_FRAME: 'input:frame',
  INPUT_POINTER: 'input:pointer',

  // ---- game command requests (guest -> server -> host) ----
  GAME_COMMAND: 'game:command',

  // ---- status broadcast (host -> server -> guest) ----
  GAME_STATUS: 'game:status',

  // ---- WebRTC video signaling (both peers -> server -> other peer) ----
  RTC_SIGNAL: 'rtc:signal',
};

/**
 * Room state machine (server is the ONLY writer; clients just render).
 *
 *   waiting ── both seated+loaded+ready ──▶ ready ──▶ countdown ──▶ playing
 *     ▲                                                                  │
 *     │──── guest seat released (grace expired / left) ◀── reconnecting ◁┤
 *     │                                        playing ⇄ paused          │
 *     └──────────────── re-ready after level end ◀────── finished ◀──────┘
 */
export const ROOM_STATES = {
  /** Created, not everyone ready yet. */
  WAITING: 'waiting',
  /** Both seats ready — countdown is being issued right now. */
  READY: 'ready',
  /** Countdown running; aborts back to a resting state on any disturbance. */
  COUNTDOWN: 'countdown',
  /** Server-issued start has fired; the session is live. */
  PLAYING: 'playing',
  /** Host paused the game. */
  PAUSED: 'paused',
  /** A seat dropped mid-game; held for SEAT_GRACE_MS before release. */
  RECONNECTING: 'reconnecting',
  /** The host reported the level finished. Ready up again for the next one. */
  FINISHED: 'finished',
};

export const RESTING_STATES = new Set([ROOM_STATES.WAITING, ROOM_STATES.READY, ROOM_STATES.FINISHED]);

/** States in which gameplay relays (input frames / pointer / commands) flow. */
export const PLAY_RELAY_STATES = new Set([
  ROOM_STATES.PLAYING,
  ROOM_STATES.PAUSED,
  ROOM_STATES.RECONNECTING,
  ROOM_STATES.FINISHED,
]);

/**
 * Swap-role request actions (EVENTS.ROOM_SWAP payload.action). Requesting
 * seat offers, the peer accepts or declines, either side can cancel while
 * the offer is pending. Swap only outside an active game.
 */
export const SWAP_ACTIONS = {
  REQUEST: 'request',
  ACCEPT: 'accept',
  DECLINE: 'decline',
  CANCEL: 'cancel',
};

/**
 * Room member slots (= roles). The slot is assigned by the server and can
 * NEVER be claimed by a client payload; the character rides on the slot and
 * flips only through a mutually-accepted swap.
 */
export const ROLES = {
  HOST: 'host', // room creator
  GUEST: 'guest', // joiner
};

/**
 * Character identifiers. These are the literal values the game engine uses
 * internally (character constructor param g / data.char, 'States/Level/character'),
 * do not rename them.
 */
export const CHARS = {
  FIREBOY: 'fb', // right side, arrow keys (Up/Left/Right)
  WATERGIRL: 'wg', // left side, W/A/D keys
};

export function oppositeChar(char) {
  return char === CHARS.FIREBOY ? CHARS.WATERGIRL : CHARS.FIREBOY;
}

/** Guest -> host game command types (EVENTS.GAME_COMMAND payload). */
export const GAME_COMMANDS = {
  PAUSE_TOGGLE: 'pause-toggle',
};

/** Why a room closed (EVENTS.ROOM_CLOSED payload.reason). */
export const ROOM_CLOSE_REASONS = {
  HOST_LEFT: 'host-left',
  HOST_TIMEOUT: 'host-timeout',
  EXPIRED: 'expired',
  DESTROYED: 'destroyed',
};

/** Machine-readable ROOM_ERROR codes. */
export const ROOM_ERRORS = {
  /** Room code unknown or malformed. */
  ROOM_NOT_FOUND: 'room-not-found',
  /** Both seats occupied (a seat under reconnect grace is still occupied). */
  ROOM_FULL: 'room-full',
  /** Room ended and was destroyed. */
  ROOM_CLOSED: 'room-closed',
  /** Rejoin token unknown/expired, or its room is gone. */
  BAD_TOKEN: 'bad-token',
  /** This seat is already live on another connection (duplicate tab). */
  DUPLICATE_TAB: 'duplicate-tab',
  /** The requested character is not available. */
  CHAR_TAKEN: 'char-taken',
  /** The socket already holds a seat; leave first. */
  ALREADY_IN_ROOM: 'already-in-room',
  /** Action requires a seat; this socket has none. */
  NOT_IN_ROOM: 'not-in-room',
  /** Action not allowed in the room's current state (e.g. swap mid-game). */
  INVALID_STATE: 'invalid-state',
  /** Malformed/out-of-range payload. */
  BAD_PAYLOAD: 'bad-payload',
  /** Client/backend protocol version mismatch. */
  PROTOCOL_VERSION_MISMATCH: 'protocol-version-mismatch',
  /** Client sent room operations too fast. */
  RATE_LIMITED: 'rate-limited',
  /** Server at capacity (max rooms). */
  SERVER_BUSY: 'server-busy',
  /** Unknown game id. */
  GAME_NOT_FOUND: 'game-not-found',
};

/**
 * Input frame field names (EVENTS.INPUT_FRAME payload).
 * State-based frames (booleans) rather than key events so a reconnecting
 * peer re-syncs with the very next frame.
 */
export const INPUT_ACTIONS = {
  UP: 'up',
  LEFT: 'left',
  RIGHT: 'right',
};

/** Pointer event phases (EVENTS.INPUT_POINTER payload). */
export const POINTER_PHASES = {
  MOVE: 'move',
  DOWN: 'down',
  UP: 'up',
};

/** Host -> guest game phases (EVENTS.GAME_STATUS payload.phase). */
export const GAME_PHASES = {
  BOOTING: 'booting',
  MENU: 'menu',
  LEVEL_MENU: 'level-menu',
  LEVEL: 'level',
  END: 'end',
  UNKNOWN: 'unknown',
};

/**
 * room:state payload shape (EVENTS.ROOM_STATE). Sent on every room mutation
 * to every connected member socket.
 *
 * {
 *   code: 'AB23', game: '1-forest-temple', state: ROOM_STATES.*,
 *   hostChar: 'fb',                 // char of the HOST slot; guest = opposite
 *   serverNow: 1710000000000,       // server clock at send time
 *   players: {
 *     host:  { char, connected, loaded, ready, latencyMs } | null,
 *     guest: { char, connected, loaded, ready, latencyMs } | null,
 *   },
 *   swap: { from: 'host'|'guest', expiresAt } | null,
 *   countdown: { startAt, durationMs } | null,   // while state === countdown
 * }
 *
 * Reconnect tokens are NEVER part of this broadcast — they travel only in
 * room:created / room:joined / room:rejoined to the owning socket.
 */

/** Room limits / timings (server defaults; server/.env may override). */
export const LIMITS = {
  ROOM_CODE_LENGTH: 4,
  /** Disconnected seat hold time before the slot is truly released. */
  SEAT_GRACE_MS: 45_000,
  /** Ready→start countdown length. */
  COUNTDOWN_MS: 3_000,
  /** Unaccepted swap offer lifetime. */
  SWAP_OFFER_TTL_MS: 15_000,
  /** Created-but-never-refilled room lifetime. */
  EMPTY_ROOM_TTL_MS: 10 * 60_000,
  /** Safety-net sweep interval. */
  SWEEP_INTERVAL_MS: 30_000,
  /** Maximum simultaneously existing rooms. */
  MAX_ROOMS: 200,
  INPUT_FRAME_MAX_BYTES: 256,
};

/**
 * Payload validators (defensive, shared so both sides agree on shapes).
 * Each returns null when valid, otherwise a short error string.
 */
export const VALIDATE = {
  inputFrame(frame) {
    if (!frame || typeof frame !== 'object') return 'frame must be an object';
    if (typeof frame.seq !== 'number' || frame.seq < 0) return 'bad seq';
    for (const key of Object.values(INPUT_ACTIONS)) {
      if (typeof frame[key] !== 'boolean') return `bad ${key}`;
    }
    return null;
  },

  pointerEvent(ev) {
    if (!ev || typeof ev !== 'object') return 'pointer event must be an object';
    if (!Object.values(POINTER_PHASES).includes(ev.phase)) return 'bad phase';
    if (typeof ev.nx !== 'number' || ev.nx < 0 || ev.nx > 1) return 'bad nx';
    if (typeof ev.ny !== 'number' || ev.ny < 0 || ev.ny > 1) return 'bad ny';
    return null;
  },

  gameStatus(status) {
    if (!status || typeof status !== 'object') return 'status must be an object';
    if (!Object.values(GAME_PHASES).includes(status.phase)) return 'bad phase';
    if (status.paused !== undefined && typeof status.paused !== 'boolean') return 'bad paused';
    return null;
  },

  roomCode(code) {
    if (typeof code !== 'string') return 'bad code';
    if (code.length !== LIMITS.ROOM_CODE_LENGTH) return 'bad code length';
    if (!/^[A-Z0-9]+$/.test(code)) return 'bad code charset';
    return null;
  },

  /** Game directory ids look like '1-forest-temple'. */
  gameId(game) {
    if (typeof game !== 'string') return 'bad game';
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(game) || game.length > 40) return 'bad game id';
    return null;
  },

  booleanFlag(value) {
    return typeof value === 'boolean' ? null : 'expected boolean';
  },

  swapAction(action) {
    return Object.values(SWAP_ACTIONS).includes(action) ? null : 'bad swap action';
  },

  latencyMs(ms) {
    if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0 || ms > 60_000) return 'bad latency';
    return null;
  },

  token(token) {
    if (typeof token !== 'string' || token.length < 16 || token.length > 128) return 'bad token';
    if (!/^[a-f0-9]+$/.test(token)) return 'bad token charset';
    return null;
  },
};
