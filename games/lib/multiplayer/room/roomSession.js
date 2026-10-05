/**
 * Room session state machine (browser side).
 *
 * Owns the create / join / rejoin / leave flow. The rejoin token arrives in
 * the seat payload (sent only to the owning socket) and is persisted in
 * sessionStorage so a reload or network blip transparently resumes the seat.
 *
 * Emits high-level facts on the bus:
 *   session:joined   { code, role, char, peerConnected }
 *   session:left     { code, role, reason }
 *   session:peer     { role, char, connected }   (presence of the other seat)
 *   session:error    { code, message }
 */
import { logger } from '../core/logger.js';

const TOKEN_KEY = 'mp:session-token';

export class RoomSession {
  constructor({ bus, net, P }) {
    this.bus = bus;
    this.net = net;
    this.P = P;

    this.code = null;
    this.role = null;
    this.char = null;
    this.token = null;
    this.peer = { role: null, char: null, connected: false };
    this.joining = false;

    // Re-join with the stored token whenever the socket reconnects.
    this.bus.on('net:reconnected', () => this.rejoin(this.token));

    const E = P.EVENTS;
    this.unsubscribers = [
      net.on(E.ROOM_CREATED, (payload) => this.#onSeated(payload)),
      net.on(E.ROOM_JOINED, (payload) => this.#onSeated(payload)),
      net.on(E.ROOM_REJOINED, (payload) => this.#onSeated(payload)),
      net.on(E.ROOM_PEER_JOINED, (payload) => this.#setPeerPresence({ role: payload.role, char: payload.char, connected: true })),
      net.on(E.ROOM_PEER_LEFT, () => this.#setPeerPresence({ connected: false })),
      net.on(E.ROOM_CLOSED, (payload) => this.leave('room-closed', payload)),
      net.on(E.ROOM_ERROR, (payload) => {
        this.joining = false;
        // A failed rejoin falls back to joining by share code (if any).
        const rejoinFailed =
          payload?.code === this.P.ROOM_ERRORS.BAD_TOKEN ||
          payload?.code === this.P.ROOM_ERRORS.ROOM_CLOSED ||
          payload?.code === this.P.ROOM_ERRORS.ROOM_NOT_FOUND;
        if (rejoinFailed && this.#fallbackJoinCode && !this.code) {
          const code = this.#fallbackJoinCode;
          this.#fallbackJoinCode = null;
          this.join(code);
          return;
        }
        this.bus.emit('session:error', payload);
      }),
    ];
  }

  #storageKey() {
    return `${TOKEN_KEY}:${location.pathname}`;
  }

  #fallbackJoinCode = null;

  create({ char }) {
    if (this.joining || this.code) return;
    this.joining = true;
    this.net.emit(this.P.EVENTS.ROOM_CREATE, { char }, () => {
      // ack errors arrive as ROOM_ERROR; success arrives as ROOM_CREATED.
      this.joining = false;
    });
  }

  join(code) {
    if (this.joining || this.code) return;
    this.joining = true;
    this.net.emit(this.P.EVENTS.ROOM_JOIN, { code: String(code ?? '').toUpperCase() }, () => {
      this.joining = false;
    });
  }

  /** Rebind this socket to a known seat (after reconnect or page reload). */
  rejoin(token) {
    if (!token || this.code) return;
    this.net.emit(this.P.EVENTS.ROOM_REJOIN, { token }, () => {
      // Failure arrives as ROOM_ERROR (e.g. room closed while we were gone).
    });
  }

  /**
   * Reload/reconnect entry: resume the stored seat first; when that fails
   * (token gone, room closed) fall back to joining by code, e.g. the
   * ?room= link the host shared.
   */
  resumeOrJoin(roomCodeFromUrl) {
    const stored = this.restoreStoredSession();
    if (stored) {
      this.#fallbackJoinCode = roomCodeFromUrl ?? null;
      this.rejoin(stored.token);
      return;
    }
    if (roomCodeFromUrl) this.join(roomCodeFromUrl);
  }

  #onSeated(payload) {
    this.code = payload.code;
    this.role = payload.role;
    this.char = payload.char;
    if (payload.token) this.token = payload.token;
    this.peer = { role: null, char: null, connected: Boolean(payload.peerConnected) };
    this.#storeToken();
    logger.info(`seated: room ${this.code} as ${this.role} (${this.char})`);
    this.bus.emit('session:joined', {
      code: this.code,
      role: this.role,
      char: this.char,
      peerConnected: this.peer.connected,
    });
  }

  #setPeerPresence({ role = null, char = null, connected }) {
    this.peer = { role, char, connected };
    this.bus.emit('session:peer', { ...this.peer });
  }

  leave(reason = 'user-leave', serverPayload = null) {
    if (this.code && this.net.connected) {
      this.net.emit(this.P.EVENTS.ROOM_LEAVE, {});
    }
    const left = { code: this.code, role: this.role, reason, serverPayload };
    this.code = null;
    this.role = null;
    this.char = null;
    this.token = null;
    this.peer = { role: null, char: null, connected: false };
    this.#forgetToken();
    this.bus.emit('session:left', left);
  }

  // ---- token persistence ------------------------------------------------

  #storeToken() {
    if (!this.code || !this.token) return;
    try {
      sessionStorage.setItem(
        this.#storageKey(),
        JSON.stringify({ code: this.code, token: this.token }),
      );
    } catch {
      /* private mode etc. — rejoin simply won't survive reload */
    }
  }

  #forgetToken() {
    try {
      sessionStorage.removeItem(this.#storageKey());
    } catch {
      /* ignore */
    }
  }

  /** Restore a previous session recorded before a page reload. */
  restoreStoredSession() {
    try {
      const raw = sessionStorage.getItem(this.#storageKey());
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      return parsed && parsed.code && parsed.token ? parsed : null;
    } catch {
      return null;
    }
  }

  get isHost() {
    return this.role === this.P.ROLES.HOST;
  }
}
