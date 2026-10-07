/**
 * Room session state machine (browser side, shared by the lobby page and
 * the game pages).
 *
 * Owns the create / join / rejoin / leave flow and mirrors the server's
 * authoritative room:state onto the bus. The rejoin token arrives ONLY in
 * the seat payload (room:created / room:joined / room:rejoined — never in
 * room:state) and is persisted in sessionStorage keyed by room code, so a
 * reload, a lobby→game navigation or a network blip transparently resumes
 * the same seat (role + char + readiness facts).
 *
 * Emits on the bus:
 *   session:joined    { code, role, char, game, peerConnected }
 *   session:left      { code, role, reason }
 *   session:peer      { role, char, connected }        (the other seat)
 *   session:error     { code, message, friendly }
 *   room:state        { ...server projection incl. players, swap, countdown }
 *   room:countdown    { serverNow, startAt, durationMs }
 *   room:start        { serverNow, startAt }
 *   round:update      { round: {id, level, phase}, reason }  (game lifecycle)
 */
import { logger } from '../core/logger.js';

const SEAT_KEY = 'mp:seat';
const EMPTY_ROUND = Object.freeze({ id: 0, level: null, phase: 'idle' });

/** UI-facing messages per protocol error code (server message is fallback). */
export const ERROR_TEXT = {
  'room-not-found': '房间不存在或房间码有误',
  'room-full': '房间已满（对方可能正在重连，请稍后再试）',
  'room-closed': '房间已结束或已被清理',
  'bad-token': '会话已过期，请重新加入',
  'duplicate-tab': '此房间已在新的标签页/连接中打开，当前页面已退出',
  'char-taken': '该角色已被占用',
  'already-in-room': '已在一个房间中，请先退出',
  'not-in-room': '尚未加入房间',
  'invalid-state': '当前状态无法执行该操作',
  'bad-payload': '请求格式错误',
  'protocol-version-mismatch': '页面版本与服务器不一致，请刷新页面',
  'rate-limited': '操作太频繁，请稍后再试',
  'server-busy': '服务器繁忙（房间数已达上限），请稍后再试',
  'game-not-found': '未知的游戏',
  offline: '正在连接联机服务器，请稍后重试',
};

export class RoomSession {
  constructor({ bus, net, P }) {
    this.bus = bus;
    this.net = net;
    this.P = P;

    this.code = null;
    this.role = null; // 'host' | 'guest' — server-assigned, never client-claimed
    this.char = null; // 'fb' | 'wg'
    this.game = null;
    this.token = null;
    this.state = null; // latest room:state projection
    /** Server-assigned session id (stable for the room's life). */
    this.sessionId = null;
    /** Current game round {id, level, phase} — server-owned, followed by all. */
    this.round = { ...EMPTY_ROUND };
    /** Mirrored peer presence (derived from room:state, kept for consumers). */
    this.peer = { role: null, char: null, connected: false, seated: false };
    this.joining = false;
    /**
     * A lobby tap can arrive while the first mobile transport is still
     * connecting. Keep one explicit action and flush it when the socket is
     * ready instead of dropping the user's request.
     */
    this.pendingAction = null;
    /** serverNow - clientNow at the last server timestamp we saw. */
    this.serverOffsetMs = 0;

    // Re-join with the stored token whenever the socket reconnects.
    this.bus.on('net:reconnected', () => this.rejoin(this.token));
    this.bus.on('net:state', (state) => {
      if (state === 'connected') this.#flushPendingAction();
    });

    const E = P.EVENTS;
    this.unsubscribers = [
      net.on(E.ROOM_CREATED, (payload) => this.#onSeated(payload)),
      net.on(E.ROOM_JOINED, (payload) => this.#onSeated(payload)),
      net.on(E.ROOM_REJOINED, (payload) => this.#onSeated(payload)),
      net.on(E.ROOM_STATE, (payload) => this.#onRoomState(payload)),
      net.on(E.ROUND_UPDATE, (payload) => this.#onRoundUpdate(payload)),
      net.on(E.ROOM_COUNTDOWN, (payload) => {
        this.#trackClock(payload);
        this.bus.emit('room:countdown', payload);
      }),
      net.on(E.ROOM_START, (payload) => {
        this.#trackClock(payload);
        this.bus.emit('room:start', payload);
      }),
      net.on(E.ROOM_CLOSED, (payload) => this.leave('room-closed', payload, { notifyServer: false })),
      net.on(E.ROOM_ERROR, (payload) => this.#onRoomError(payload)),
    ];
  }

  // ---- outgoing actions -----------------------------------------------------

  create({ game, char }) {
    if (this.joining || this.code) return;
    if (!this.net.connected) {
      if (!this.pendingAction) this.pendingAction = { type: 'create', game, char };
      this.#emitError({ code: 'offline' });
      return false;
    }
    this.joining = true;
    const sent = this.net.emit(this.P.EVENTS.ROOM_CREATE, { game, char, protocol: this.P.PROTOCOL_VERSION }, (ack) => {
      this.joining = false;
      if (ack && ack.ok === false) this.#emitError({ code: ack.code });
    });
    if (!sent) {
      this.joining = false;
      if (!this.pendingAction) this.pendingAction = { type: 'create', game, char };
    }
    return sent;
  }

  join(code) {
    if (this.joining || this.code) return;
    const normalizedCode = String(code ?? '').toUpperCase();
    if (!this.net.connected) {
      if (!this.pendingAction) this.pendingAction = { type: 'join', code: normalizedCode };
      this.#emitError({ code: 'offline' });
      return false;
    }
    this.joining = true;
    const sent = this.net.emit(
      this.P.EVENTS.ROOM_JOIN,
      { code: normalizedCode, protocol: this.P.PROTOCOL_VERSION },
      (ack) => {
        this.joining = false;
        if (ack && ack.ok === false) this.#emitError({ code: ack.code });
      },
    );
    if (!sent) {
      this.joining = false;
      if (!this.pendingAction) this.pendingAction = { type: 'join', code: normalizedCode };
    }
    return sent;
  }

  #flushPendingAction() {
    const action = this.pendingAction;
    if (!action || this.joining || this.code || !this.net.connected) return;
    this.pendingAction = null;
    if (action.type === 'create') this.create(action);
    else if (action.type === 'join') this.join(action.code);
  }

  /**
   * Rebind this socket to a known seat (after reconnect or page reload).
   *
   * NOTE: this MUST also run when `code` is still set — a mid-game network
   * blip (Wi-Fi↔cellular, background kill) drops the transport WITHOUT
   * clearing the session, and the only way back onto the seat is a rejoin.
   * The server's duplicate-tab policy makes a rejoin from a socket that is
   * somehow still live safe (newest connection wins).
   */
  rejoin(token) {
    if (!token || this.joining) return;
    this.joining = true;
    this.net.emit(this.P.EVENTS.ROOM_REJOIN, { token, protocol: this.P.PROTOCOL_VERSION }, (ack) => {
      this.joining = false;
      if (ack && ack.ok === false) this.#emitError({ code: ack.code });
    });
  }

  /** Game resources finished loading on this page (auto-signal). */
  setLoaded(loaded) {
    if (!this.code) return;
    this.net.emit(this.P.EVENTS.ROOM_LOAD, { loaded: Boolean(loaded) });
  }

  /** Player toggled their manual ready flag. */
  setReady(ready) {
    if (!this.code) return;
    this.net.emit(this.P.EVENTS.ROOM_READY, { ready: Boolean(ready) });
  }

  /** request | accept | decline | cancel (see SWAP_ACTIONS). */
  swap(action) {
    if (!this.code) return;
    this.net.emit(this.P.EVENTS.ROOM_SWAP, { action });
  }

  /**
   * Reload/reconnect entry: resume the stored seat first; when that fails
   * (token gone, room closed) fall back to joining by code, e.g. the
   * ?room= link the host shared. A ?room= code for a DIFFERENT room is an
   * explicit intent and wins over the stored seat.
   */
  resumeOrJoin(roomCodeFromUrl) {
    const stored = this.restoreStoredSession();
    if (roomCodeFromUrl && stored && stored.code !== roomCodeFromUrl.toUpperCase()) {
      this.#forgetToken();
      this.join(roomCodeFromUrl);
      return;
    }
    if (stored) {
      this.#fallbackJoinCode = roomCodeFromUrl ?? null;
      this.rejoin(stored.token);
      return;
    }
    if (roomCodeFromUrl) this.join(roomCodeFromUrl);
  }

  #fallbackJoinCode = null;

  leave(reason = 'user-leave', serverPayload = null, { notifyServer = true } = {}) {
    if (this.code && notifyServer && this.net.connected) {
      this.net.emit(this.P.EVENTS.ROOM_LEAVE, {});
    }
    const left = { code: this.code, role: this.role, reason, serverPayload };
    this.code = null;
    this.role = null;
    this.char = null;
    this.game = null;
    this.token = null;
    this.state = null;
    this.sessionId = null;
    this.round = { ...EMPTY_ROUND };
    this.peer = { role: null, char: null, connected: false, seated: false };
    this.pendingAction = null;
    this.#forgetToken();
    this.bus.emit('session:left', left);
  }

  // ---- server projections ----------------------------------------------------

  #onSeated(payload) {
    this.code = payload.code;
    this.role = payload.role;
    this.char = payload.char;
    this.game = payload.game ?? null;
    if (payload.token) this.token = payload.token;
    if (payload.state) this.#applyState(payload.state);
    this.peer = this.#peerFromState() ?? { role: null, char: null, connected: false, seated: false };
    this.#storeToken();
    logger.info(`seated: room ${this.code} as ${this.role} (${this.char}) in ${this.game}`);
    this.bus.emit('session:joined', {
      code: this.code,
      role: this.role,
      char: this.char,
      game: this.game,
      peerConnected: Boolean(this.peer.connected),
    });
  }

  #onRoomState(payload) {
    if (!this.code || payload.code !== this.code) return;
    // Monotonic projection: an out-of-order room:state (e.g. a duplicate
    // delivery after a reconnect) must not roll the room backwards.
    const prevRev = this.state?.rev ?? 0;
    if (typeof payload.rev === 'number' && payload.rev < prevRev) return;
    const prevPeer = this.peer;
    this.#applyState(payload);
    this.peer = this.#peerFromState() ?? { role: null, char: null, connected: false, seated: false };
    if (
      !prevPeer ||
      prevPeer.connected !== this.peer.connected ||
      prevPeer.char !== this.peer.char ||
      prevPeer.seated !== this.peer.seated
    ) {
      this.bus.emit('session:peer', { ...this.peer });
    }
    this.bus.emit('room:state', payload);
  }

  #onRoundUpdate(payload) {
    if (!this.code || payload?.code !== this.code) return;
    const round = payload.round && typeof payload.round === 'object' ? payload.round : { ...EMPTY_ROUND };
    const id = Number.isInteger(round.id) ? round.id : 0;
    if (id < this.round.id) return; // stale broadcast; never roll back
    this.round = {
      id,
      level: round.level ?? null,
      phase: round.phase ?? 'idle',
    };
    logger.info('round update', this.round, payload.reason ?? '');
    this.bus.emit('round:update', { round: this.round, reason: payload.reason ?? null });
  }

  #applyState(state) {
    this.state = state;
    this.#trackClock(state);
    if (typeof state.sid === 'string') this.sessionId = state.sid;
    // Round identity rides on room:state too; ROUND_UPDATE stays the primary
    // notification channel (this is a resync for reload/rejoin paths).
    if (state.round && typeof state.round === 'object' && Number.isInteger(state.round.id)) {
      if (state.round.id >= this.round.id) {
        this.round = { id: state.round.id, level: state.round.level ?? null, phase: state.round.phase ?? 'idle' };
      }
    }
    // Swaps reassign chars server-side; keep the session in sync.
    const mine = state.players?.[this.role];
    if (mine && mine.char !== this.char) {
      this.char = mine.char;
      this.#storeToken();
    }
  }

  #peerFromState() {
    if (!this.state || !this.role) return null;
    const peerRole = this.role === this.P.ROLES.HOST ? this.P.ROLES.GUEST : this.P.ROLES.HOST;
    const peer = this.state.players?.[peerRole];
    if (!peer) return { role: peerRole, char: null, connected: false, seated: false };
    return { role: peerRole, char: peer.char, connected: peer.connected, seated: true, ...peer };
  }

  #onRoomError(payload) {
    this.joining = false;
    const code = payload?.code;
    // A failed rejoin falls back to joining by share code (if any).
    const rejoinFailed =
      code === this.P.ROOM_ERRORS.BAD_TOKEN ||
      code === this.P.ROOM_ERRORS.ROOM_CLOSED ||
      code === this.P.ROOM_ERRORS.ROOM_NOT_FOUND;
    if (rejoinFailed && this.#fallbackJoinCode && !this.code) {
      const joinCode = this.#fallbackJoinCode;
      this.#fallbackJoinCode = null;
      this.#forgetToken();
      this.join(joinCode);
      return;
    }
    if (code === this.P.ROOM_ERRORS.DUPLICATE_TAB) {
      // The seat now lives in a newer tab; drop the local session WITHOUT
      // touching the server seat (a room:leave here would kick the new tab).
      this.code = null;
      this.role = null;
      this.char = null;
      this.game = null;
      this.token = null;
      this.state = null;
      this.sessionId = null;
      this.round = { ...EMPTY_ROUND };
      this.peer = { role: null, char: null, connected: false, seated: false };
      this.#forgetToken();
      this.bus.emit('session:left', { code: null, role: null, reason: 'duplicate-tab' });
    }
    this.#emitError(payload);
  }

  #emitError(payload) {
    const friendly = ERROR_TEXT[payload?.code] ?? payload?.message ?? '联机错误';
    this.bus.emit('session:error', { ...payload, friendly });
  }

  #trackClock(payload) {
    if (payload && typeof payload.serverNow === 'number') {
      this.serverOffsetMs = payload.serverNow - Date.now();
    }
  }

  /** Server-clock timestamp for "now" (offset-corrected local clock). */
  serverNow() {
    return Date.now() + this.serverOffsetMs;
  }

  // ---- token persistence ------------------------------------------------
  //
  // sessionStorage (per tab) so two tabs never share an identity; keyed by
  // ROOM CODE, not pathname, so the seat survives the lobby→game navigation.

  #storeToken() {
    if (!this.code || !this.token) return;
    try {
      sessionStorage.setItem(
        SEAT_KEY,
        JSON.stringify({
          code: this.code,
          token: this.token,
          role: this.role,
          char: this.char,
          game: this.game,
          storedAt: Date.now(),
        }),
      );
    } catch {
      /* private mode etc. — rejoin simply won't survive reload */
    }
  }

  #forgetToken() {
    try {
      sessionStorage.removeItem(SEAT_KEY);
    } catch {
      /* ignore */
    }
  }

  /** Restore a previous session recorded before a reload/navigation. */
  restoreStoredSession() {
    try {
      const raw = sessionStorage.getItem(SEAT_KEY);
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
