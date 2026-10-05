import crypto from 'node:crypto';
import { ROLES, CHARS, LIMITS, ROOM_ERRORS } from '../../../common/protocol/events.mjs';
import { Room } from './room.js';

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no lookalikes (I/L/1, O/0)

export class RoomManager {
  constructor({ graceMs, emptyTtlMs, codeLength, sweepIntervalMs, log, onRoomClose }) {
    this.graceMs = graceMs;
    this.emptyTtlMs = emptyTtlMs;
    this.codeLength = codeLength;
    this.onRoomClose = onRoomClose ?? (() => {});
    this.rooms = new Map(); // code -> Room
    this.tokens = new Map(); // token -> { code, role } (rejoin index)
    this.sweeper = setInterval(() => this.sweep(), sweepIntervalMs);
    this.sweeper.unref?.();
    this.log = log ?? (() => {});
  }

  newToken() {
    return crypto.randomBytes(16).toString('hex');
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

  /** Create a room with the requesting socket as host. */
  createRoom({ char }) {
    if (!Object.values(CHARS).includes(char)) {
      return { error: ROOM_ERRORS.CHAR_TAKEN, message: 'invalid character' };
    }
    const code = this.generateCode();
    const room = new Room(code, {
      graceMs: this.graceMs,
      emptyTtlMs: this.emptyTtlMs,
      onClose: (reason) => {
        // Notify peers first, then drop the room immediately (destroyRoom
        // is a no-op re-close; the sweeper stays as a safety net).
        this.onRoomClose(room, reason);
        this.destroyRoom(room);
      },
    });
    const token = this.newToken();
    const member = room.seatHost({ char, token });
    room.startEmptyTimer();
    this.rooms.set(code, room);
    this.tokens.set(token, { code, role: ROLES.HOST });
    this.log(`room ${code} created (host char ${char})`);
    return { room, member, token, role: ROLES.HOST, char };
  }

  /** Join an existing room as guest. A stale disconnected guest seat may be
   * taken over (e.g. the player lost sessionStorage but the room lives on). */
  joinRoom({ code }) {
    const room = this.rooms.get(code);
    if (!room || room.closed) {
      return { error: ROOM_ERRORS.ROOM_NOT_FOUND, message: 'room not found' };
    }
    if (room.isFull()) {
      const staleGuest = room.getMember(ROLES.GUEST);
      if (staleGuest && !staleGuest.connected) {
        this.releaseToken(staleGuest.token);
        room.members.delete(ROLES.GUEST);
      } else {
        return { error: ROOM_ERRORS.ROOM_FULL, message: 'room is full' };
      }
    }
    const token = this.newToken();
    const member = room.seatGuest({ token });
    this.tokens.set(token, { code, role: ROLES.GUEST });
    this.log(`room ${code} joined as guest (char ${member.char})`);
    return { room, member, token, role: ROLES.GUEST, char: member.char };
  }

  /**
   * Rebind a reconnecting member to a fresh socket. Membership (seat + char)
   * survives; only the transport changes.
   */
  rejoin({ token }) {
    const entry = this.tokens.get(token);
    if (!entry) return { error: ROOM_ERRORS.BAD_TOKEN, message: 'unknown token' };
    const room = this.rooms.get(entry.code);
    if (!room || room.closed) {
      this.tokens.delete(token);
      return { error: ROOM_ERRORS.ROOM_CLOSED, message: 'room closed' };
    }
    const member = room.getMemberByToken(token);
    if (!member) return { error: ROOM_ERRORS.BAD_TOKEN, message: 'unknown token' };
    return { room, member, role: member.role, char: member.char };
  }

  releaseToken(token) {
    this.tokens.delete(token);
  }

  destroyRoom(room) {
    room.close(room.closeReason ?? 'destroyed');
    for (const member of room.members.values()) {
      this.tokens.delete(member.token);
    }
    this.rooms.delete(room.code);
    this.log(`room ${room.code} destroyed (${room.closeReason ?? 'unknown'})`);
  }

  /** Drop expired rooms (closed rooms, or rooms whose grace window elapsed). */
  sweep() {
    const now = Date.now();
    for (const room of [...this.rooms.values()]) {
      if (room.closed) {
        this.destroyRoom(room);
        continue;
      }
      const hostGone = room.hostLeftAt && now - room.hostLeftAt > room.graceMs;
      const emptyTooLong = room.members.size === 0 && now - room.createdAt > this.emptyTtlMs;
      if (hostGone || emptyTooLong) this.destroyRoom(room);
    }
  }

  stats() {
    return { rooms: this.rooms.size, tokens: this.tokens.size };
  }

  stop() {
    clearInterval(this.sweeper);
  }
}

export { LIMITS };
