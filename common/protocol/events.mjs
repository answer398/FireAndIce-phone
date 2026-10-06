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

export const PROTOCOL_VERSION = 3;

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

  // ---- state snapshots (host -> server -> guest, host-authoritative) ----
  /** {seq, ack, same?, snap, st?} — periodic world snapshot; `st` is added by
   * the server at relay time. `same` marks a skip-unchanged mini snapshot. */
  SYNC_SNAPSHOT: 'sync:snapshot',

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
  /** Guest asks the host to restart the current level. */
  LEVEL_RESTART: 'level-restart',
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
 * Host -> guest world snapshot (EVENTS.SYNC_SNAPSHOT payload).
 *
 * The host is the ONLY simulation authority: it runs the real game and
 * broadcasts compact snapshots at SYNC_HZ. The guest keeps simulating locally
 * for low-latency feedback and applies each snapshot through the game
 * adapter's threshold correction (soft position lerp, hard snap).
 *
 * {
 *   seq: 12,              // monotonic snapshot counter (host)
 *   ack: 41,              // last guest input:frame seq the host processed
 *   same: true?,          // skip-unchanged: everything below is omitted
 *   st: 1710000000000,    // server clock at relay (added by the server)
 *   snap: {
 *     lvl: { temple: 'forest', id: 1, filename: 'tutorials/levels/forest_01.json' },
 *     ch: [                                 // pers1 (fb), pers2 (wg)
 *       { x, y, vx, vy, f, a, d, s },       // px pos, px/s vel, facing,
 *                                           // alive, diamonds, silverDiamonds
 *       { ... },
 *     ],
 *     di: [['pusher', 992, 352], ...],      // device identity (options.type/x/y)
 *     dv: [[state, bx, by, bvx, bvy, ja], ...],   // per-device: state int,
 *                                           // body px pos/vel, lever joint angle
 *     gi: [['wg', 752, 464], ...],          // gem identity (char + tilemap xy)
 *     dm: [0, 3, ...],                      // collected gem indexes into gi
 *     dr: [[isOpen, currentFrac, isUp], ...],     // door1 (fb), door2 (wg)
 *     lv: { s: levelStarted, e: 0|1|2, p: paused }, // ended: 0 none, 1 win, 2 dead
 *   },
 * }
 *
 * All numeric fields are bounded and rounded by the adapter before send.
 */

/** Snapshot payload validator (merged into VALIDATE below). */
const num = (v) => typeof v === 'number' && Number.isFinite(v);
const isInt = (v) => Number.isInteger(v) && v >= 0;
/** Char body tuple: x,y,vx,vy in [-5000, 5000]; f string; a bool; d,s counts. */
function validChar(ch) {
  if (!Array.isArray(ch) || ch.length !== 8) return false;
  return [0, 1, 2, 3].every((i) => num(ch[i]) && Math.abs(ch[i]) <= 5000) &&
    typeof ch[4] === 'boolean' && isInt(ch[5]) && isInt(ch[6]) &&
    (ch[7] === null || typeof ch[7] === 'string');
}

function snapshotValidator(payload) {
    if (!payload || typeof payload !== 'object') return 'snapshot must be an object';
    if (!isInt(payload.seq)) return 'bad seq';
    if (payload.ack !== -1 && !isInt(payload.ack)) return 'bad ack';
    if (payload.same) return null; // mini snapshot: no snap field
    const s = payload.snap;
    if (!s || typeof s !== 'object') return 'snap must be an object';
    if (s.lvl !== undefined && (typeof s.lvl !== 'object' || s.lvl === null)) return 'bad lvl';
    if (s.lvl) {
      if (typeof s.lvl.temple !== 'string' || s.lvl.temple.length > 60) return 'bad lvl.temple';
      if (!isInt(s.lvl.id)) return 'bad lvl.id';
      if (typeof s.lvl.filename !== 'string' || s.lvl.filename.length > 120) return 'bad lvl.filename';
    }
    if (!Array.isArray(s.ch) || s.ch.length !== 2 || !s.ch.every(validChar)) return 'bad ch';
    if (!Array.isArray(s.di) || s.di.length > 64) return 'bad di';
    for (const d of s.di) {
      if (!Array.isArray(d) || d.length !== 3 || typeof d[0] !== 'string' || d[0].length > 24 ||
        !num(d[1]) || !num(d[2])) return 'bad di entry';
    }
    if (!Array.isArray(s.dv) || s.dv.length > 64 || s.dv.length !== s.di.length) return 'bad dv';
    for (const d of s.dv) {
      if (!Array.isArray(d) || d.length !== 6) return 'bad dv entry';
      if (!isInt(d[0]) || d[0] > 9) return 'bad dv state';
      for (let i = 1; i < 6; i++) {
        if (d[i] !== null && (!num(d[i]) || Math.abs(d[i]) > 5000)) return 'bad dv value';
      }
    }
    if (!Array.isArray(s.gi) || s.gi.length > 64) return 'bad gi';
    for (const g of s.gi) {
      if (!Array.isArray(g) || g.length !== 3 || typeof g[0] !== 'string' || g[0].length > 8 ||
        !num(g[1]) || !num(g[2])) return 'bad gi entry';
    }
    if (!Array.isArray(s.dm) || s.dm.length > s.gi.length || !s.dm.every(isInt)) return 'bad dm';
    if (!Array.isArray(s.dr) || s.dr.length > 2) return 'bad dr';
    for (const d of s.dr) {
      if (!Array.isArray(d) || d.length !== 3 || typeof d[0] !== 'boolean' ||
        !num(d[1]) || typeof d[2] !== 'boolean') return 'bad dr entry';
    }
    if (!s.lv || typeof s.lv !== 'object') return 'bad lv';
    if (typeof s.lv.s !== 'boolean' || typeof s.lv.p !== 'boolean') return 'bad lv flags';
    if (!isInt(s.lv.e) || s.lv.e > 2) return 'bad lv.e';
    return null;
}

function inputFrameValidator(frame) {
    if (!frame || typeof frame !== 'object') return 'frame must be an object';
    if (typeof frame.seq !== 'number' || frame.seq < 0) return 'bad seq';
    for (const key of Object.values(INPUT_ACTIONS)) {
      if (typeof frame[key] !== 'boolean') return `bad ${key}`;
    }
    return null;
}

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
  snapshot(payload) {
    return snapshotValidator(payload);
  },

  inputFrame(frame) {
    const invalid = inputFrameValidator(frame);
    if (invalid) return invalid;
    // Optional guest -> host diagnostics: count of snapshot corrections since
    // the previous frame (for the host-side debug HUD).
    if (frame.c !== undefined && (!Number.isInteger(frame.c) || frame.c < 0 || frame.c > 10_000)) return 'bad c';
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
    // Optional level descriptor: the guest enters the SAME level the host is in.
    if (status.level !== undefined) {
      const lv = status.level;
      if (typeof lv !== 'object' || lv === null) return 'bad level';
      if (typeof lv.temple !== 'string' || lv.temple.length > 60) return 'bad level.temple';
      if (!Number.isInteger(lv.id) || lv.id < 0) return 'bad level.id';
      if (typeof lv.filename !== 'string' || lv.filename.length > 120) return 'bad level.filename';
    }
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
