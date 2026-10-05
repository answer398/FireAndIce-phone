import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ROLES,
  CHARS,
  ROOM_CLOSE_REASONS,
  ROOM_ERRORS,
  VALIDATE,
  LIMITS,
} from '../../../common/protocol/events.mjs';
import { Room } from './room.js';

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no lookalikes (I/L/1, O/0)
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** Discover playable game ids once at boot (directories like 1-forest-temple). */
export function discoverGameIds() {
  try {
    return fs
      .readdirSync(path.join(repoRoot, 'games'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^\d-[a-z0-9-]+$/.test(entry.name))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

/**
 * Owns the room table and the token → seat index. All room-lifecycle
 * decisions (codes, capacity, expiry) live here; the socket layer only
 * translates events into these calls.
 */
export class RoomManager {
  constructor({
    seatGraceMs = LIMITS.SEAT_GRACE_MS,
    countdownMs = LIMITS.COUNTDOWN_MS,
    swapOfferTtlMs = LIMITS.SWAP_OFFER_TTL_MS,
    emptyTtlMs = LIMITS.EMPTY_ROOM_TTL_MS,
    codeLength = LIMITS.ROOM_CODE_LENGTH,
    maxRooms = LIMITS.MAX_ROOMS,
    sweepIntervalMs = LIMITS.SWEEP_INTERVAL_MS,
    log,
  } = {}) {
    this.seatGraceMs = seatGraceMs;
    this.countdownMs = countdownMs;
    this.swapOfferTtlMs = swapOfferTtlMs;
    this.emptyTtlMs = emptyTtlMs;
    this.codeLength = codeLength;
    this.maxRooms = maxRooms;
    this.gameIds = discoverGameIds();
    /** Hooks the socket layer assigns: broadcast state / start / closure. */
    this.onRoomChange = () => {};
    this.onRoomStart = () => {};
    this.onRoomClose = () => {};

    this.rooms = new Map(); // code -> Room
    this.tokens = new Map(); // token -> { code, slot } (rejoin index)
    this.sweeper = setInterval(() => this.sweep(), sweepIntervalMs);
    this.sweeper.unref?.();
    this.log = log ?? (() => {});
  }

  newToken() {
    return crypto.randomBytes(16).toString('hex'); // 128-bit, opaque
  }

  hasGame(game) {
    return this.gameIds.includes(game);
  }

  generateCode() {
    for (let attempt = 0; attempt < 50; attempt++) {
      let code = '';
      const bytes = crypto.randomBytes(this.codeLength);
      for (let i = 0; i < this.codeLength; i++) {
        code += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
      }
      if (!this.rooms.has(code)) return code;
    }
    throw new Error('unable to allocate room code');
  }

  /** Create a room; the requesting socket becomes the host seat. */
  createRoom({ game, char = CHARS.FIREBOY }) {
    if (this.rooms.size >= this.maxRooms) {
      return { error: ROOM_ERRORS.SERVER_BUSY, message: 'server at capacity, try again later' };
    }
    if (typeof game !== 'string' || !this.hasGame(game)) {
      return { error: ROOM_ERRORS.GAME_NOT_FOUND, message: `unknown game: ${game}` };
    }
    if (!Object.values(CHARS).includes(char)) {
      return { error: ROOM_ERRORS.CHAR_TAKEN, message: 'invalid character' };
    }
    const code = this.generateCode();
    const room = new Room(code, game, {
      seatGraceMs: this.seatGraceMs,
      countdownMs: this.countdownMs,
      swapOfferTtlMs: this.swapOfferTtlMs,
      emptyTtlMs: this.emptyTtlMs,
      log: this.log,
      onChange: (changed) => this.onRoomChange(changed),
      onClose: (reason) => {
        this.onRoomClose(room, reason);
        this.destroyRoom(room);
      },
    });
    room.onStart = (startAt) => this.onRoomStart(room, startAt);
    room.onSeatRelease = (player) => this.releaseToken(player.token);
    const token = this.newToken();
    const player = room.seatHost({ char, token });
    this.rooms.set(code, room);
    this.tokens.set(token, { code, slot: ROLES.HOST });
    this.log(`room ${code} created (game ${game}, host char ${char})`);
    return { room, player, token, slot: ROLES.HOST, char, game };
  }

  /**
   * Join an existing room as guest. A seat whose occupant dropped but is
   * still inside the reconnect grace window is NOT free yet — the third
   * player is rejected with room-full until the grace expires.
   */
  joinRoom({ code }) {
    const room = this.rooms.get(code);
    if (!room || room.closed) {
      return { error: ROOM_ERRORS.ROOM_NOT_FOUND, message: 'room not found' };
    }
    if (room.players.guest) {
      return { error: ROOM_ERRORS.ROOM_FULL, message: 'room is full' };
    }
    const token = this.newToken();
    const player = room.seatGuest({ token });
    this.tokens.set(token, { code, slot: ROLES.GUEST });
    this.log(`room ${code} joined as guest (char ${player.char})`);
    return { room, player, token, slot: ROLES.GUEST, char: player.char, game: room.game };
  }

  /**
   * Rebind a reconnecting member to a fresh socket. The seat (role + char +
   * readiness facts) survives; only the transport changes. The caller still
   * has to run the duplicate-tab policy BEFORE applying the result.
   */
  rejoin({ token }) {
    if (VALIDATE.token(token)) return { error: ROOM_ERRORS.BAD_TOKEN, message: 'malformed token' };
    const entry = this.tokens.get(token);
    if (!entry) return { error: ROOM_ERRORS.BAD_TOKEN, message: 'unknown token' };
    const room = this.rooms.get(entry.code);
    if (!room || room.closed) {
      this.tokens.delete(token);
      return { error: ROOM_ERRORS.ROOM_CLOSED, message: 'room closed' };
    }
    const player = room.getPlayerByToken(token);
    if (!player) return { error: ROOM_ERRORS.BAD_TOKEN, message: 'unknown token' };
    return { room, player, slot: player.slot, char: player.char, game: room.game };
  }

  /** Drop the token index entry of a released/destroyed seat. */
  releaseToken(token) {
    this.tokens.delete(token);
  }

  /** Voluntary seat release (room:leave). Host leaving closes the room. */
  leaveByToken(token) {
    const entry = this.tokens.get(token);
    if (!entry) return false;
    const room = this.rooms.get(entry.code);
    if (!room || room.closed) return false;
    const player = room.getPlayerByToken(token);
    if (!player) return false;
    room.releaseSeatByToken(token);
    return true;
  }

  destroyRoom(room) {
    room.close(room.closeReason ?? ROOM_CLOSE_REASONS.DESTROYED);
    for (const player of Object.values(room.players)) {
      if (player) this.tokens.delete(player.token);
    }
    this.rooms.delete(room.code);
    this.log(`room ${room.code} destroyed (${room.closeReason ?? 'unknown'})`);
  }

  /** Safety net: release expired seat graces and destroy dead rooms. */
  sweep() {
    const now = Date.now();
    for (const room of [...this.rooms.values()]) {
      if (room.closed) {
        this.destroyRoom(room);
        continue;
      }
      room.checkSeatGrace(now);
      // Host release closes the room synchronously; re-check below.
      if (!room.closed && room.players.host === null) {
        this.destroyRoom(room);
      }
    }
  }

  stats() {
    let seated = 0;
    for (const room of this.rooms.values()) seated += room.isFull() ? 2 : 1;
    return { rooms: this.rooms.size, tokens: this.tokens.size, seats: seated };
  }

  stop() {
    clearInterval(this.sweeper);
  }
}

export { LIMITS };
