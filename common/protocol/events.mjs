/**
 * Fireboy & Watergirl Online — shared protocol constants.
 *
 * Single source of truth for every Socket.IO event name, payload shape and
 * role/character identifier exchanged between the browser client
 * (games/lib/multiplayer/) and the Node server (server/).
 *
 * Loaded as a native ES module by BOTH sides:
 *   - server:  import { EVENTS } from '../../common/protocol/events.mjs'
 *   - browser: import { EVENTS } from '/common/protocol/events.mjs'
 *
 * Hardcoding event names anywhere else is a bug.
 */

export const PROTOCOL_VERSION = 1;

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

  // ---- latency probe (client -> server -> client, acked) ----
  NET_PING: 'net:ping',

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

/** Room member roles. */
export const ROLES = {
  HOST: 'host',
  GUEST: 'guest',
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

/** Machine-readable ROOM_ERROR codes. */
export const ROOM_ERRORS = {
  ROOM_NOT_FOUND: 'room-not-found',
  ROOM_FULL: 'room-full',
  ROOM_CLOSED: 'room-closed',
  BAD_TOKEN: 'bad-token',
  CHAR_TAKEN: 'char-taken',
  ALREADY_IN_ROOM: 'already-in-room',
  NOT_IN_ROOM: 'not-in-room',
  PROTOCOL_VERSION_MISMATCH: 'protocol-version-mismatch',
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

/** Room limits / timings (server defaults; server/.env may override). */
export const LIMITS = {
  ROOM_CODE_LENGTH: 4,
  ROOM_GRACE_MS: 60_000, // keep room alive for host rejoin
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
    return null;
  },

  roomCode(code) {
    if (typeof code !== 'string') return 'bad code';
    if (code.length !== LIMITS.ROOM_CODE_LENGTH) return 'bad code length';
    if (!/^[A-Z0-9]+$/.test(code)) return 'bad code charset';
    return null;
  },
};
