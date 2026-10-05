import { ROLES, oppositeChar } from '../../../common/protocol/events.mjs';

let nextMemberId = 1;

/**
 * A room holds exactly two seats: one host (owns the running game) and one
 * guest (streams the host's screen, sends input). Membership survives socket
 * reconnects via opaque `token`s; sockets are just transports.
 */
export class Room {
  constructor(code, { graceMs, emptyTtlMs, onClose }) {
    this.code = code;
    this.graceMs = graceMs;
    this.emptyTtlMs = emptyTtlMs;
    /** Invoked exactly once with the close reason when the room closes. */
    this.onClose = onClose ?? (() => {});

    this.createdAt = Date.now();
    this.members = new Map(); // role -> member
    this.hostChar = null; // CHARS.* picked by the host at create time
    this.closed = false;
    this.closeReason = null;

    this.hostLeftAt = null;
    this.timers = { grace: null, empty: null };
  }

  static createMember({ role, char, token }) {
    return {
      id: nextMemberId++,
      role,
      char,
      token,
      socketId: null,
      connected: false,
      joinedAt: Date.now(),
    };
  }

  isFull() {
    return this.members.size >= 2;
  }

  hasRole(role) {
    return this.members.has(role);
  }

  getMember(role) {
    return this.members.get(role) ?? null;
  }

  getMemberByToken(token) {
    for (const member of this.members.values()) {
      if (member.token === token) return member;
    }
    return null;
  }

  getMemberBySocket(socketId) {
    for (const member of this.members.values()) {
      if (member.socketId === socketId) return member;
    }
    return null;
  }

  getPeer(member) {
    const peerRole = member.role === ROLES.HOST ? ROLES.GUEST : ROLES.HOST;
    return this.members.get(peerRole) ?? null;
  }

  /** Seat the host. Returns the created member. */
  seatHost({ char, token }) {
    this.hostChar = char;
    const member = Room.createMember({ role: ROLES.HOST, char, token });
    this.members.set(ROLES.HOST, member);
    return member;
  }

  /** Seat the guest. The guest always plays the character opposite the host. */
  seatGuest({ token }) {
    const member = Room.createMember({
      role: ROLES.GUEST,
      char: oppositeChar(this.hostChar),
      token,
    });
    this.members.set(ROLES.GUEST, member);
    return member;
  }

  attachSocket(member, socketId) {
    member.socketId = socketId;
    member.connected = true;
    this.hostLeftAt = null;
    this.clearTimer('grace');
    this.clearTimer('empty');
  }

  detachSocket(member) {
    member.connected = false;
    member.socketId = null;
    if (member.role === ROLES.HOST) {
      this.hostLeftAt = Date.now();
      this.startGraceTimer();
    }
  }

  startGraceTimer() {
    this.clearTimer('grace');
    this.timers.grace = setTimeout(() => {
      if (!this.getMember(ROLES.HOST)?.connected) {
        this.close('host-timeout');
      }
    }, this.graceMs);
  }

  startEmptyTimer() {
    this.clearTimer('empty');
    this.timers.empty = setTimeout(() => {
      if (this.members.size < 2) this.close('expired');
    }, this.emptyTtlMs);
  }

  clearTimer(name) {
    if (this.timers[name]) {
      clearTimeout(this.timers[name]);
      this.timers[name] = null;
    }
  }

  close(reason) {
    if (this.closed) return;
    this.closed = true;
    this.closeReason = reason;
    this.clearTimer('grace');
    this.clearTimer('empty');
    this.onClose(reason);
  }

  /** Stable snapshot used in events and logs. */
  describe() {
    return {
      code: this.code,
      hostChar: this.hostChar,
      closed: this.closed,
      members: [...this.members.values()].map((m) => ({
        role: m.role,
        char: m.char,
        connected: m.connected,
      })),
    };
  }
}
