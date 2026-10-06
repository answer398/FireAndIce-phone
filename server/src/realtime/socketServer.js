import { Server } from 'socket.io';
import {
  EVENTS,
  PROTOCOL_VERSION,
  ROLES,
  ROOM_ERRORS,
  ROOM_STATES,
  SWAP_ACTIONS,
  PLAY_RELAY_STATES,
  CHARS,
  VALIDATE,
} from '../../../common/protocol/events.mjs';
import { RateLimiter } from '../rooms/rateLimiter.js';

/**
 * Socket.IO wiring.
 *
 * This layer is a strict translator: it validates every payload, resolves
 * the CALLER'S seat from the connection (never from client-supplied
 * role/char fields), delegates every decision to the Room state machine,
 * and broadcasts room:state after each mutation. Clients can never claim a
 * role, a character, a room state, or another seat's identity.
 */
export function createSocketServer(httpServer, {
  roomManager,
  allowedOrigins = [],
  log = () => {},
  trustProxy = false,
  rateLimits = {},
}) {
  const io = new Server(httpServer, {
    path: '/socket.io',
    cors: { origin: allowedOrigins.length > 0 ? allowedOrigins : true },
    // Small payloads, interactive latency: websocket first, polling fallback
    // only for networks that break WS.
    transports: ['websocket', 'polling'],
    pingInterval: 10_000,
    pingTimeout: 20_000,
    maxHttpBufferSize: 8_192,
  });

  const rateCreate = new RateLimiter({ windowMs: 60_000, max: rateLimits.createMax ?? 6 });
  const rateJoin = new RateLimiter({ windowMs: 60_000, max: rateLimits.joinMax ?? 20 });
  const rateLatency = new RateLimiter({ windowMs: 60_000, max: rateLimits.latencyMax ?? 20 });

  // ---- room event hooks (rooms exist only after createRoom) ----------------

  const memberSocket = (player) => (player?.connected ? io.sockets.sockets.get(player.socketId) ?? null : null);

  const broadcastState = (room) => {
    const state = room.describe();
    for (const player of [room.players.host, room.players.guest]) {
      const target = memberSocket(player);
      target?.emit(EVENTS.ROOM_STATE, state);
    }
  };

  roomManager.onRoomChange = (room) => broadcastState(room);

  roomManager.onRoomStart = (room, startAt) => {
    const payload = { code: room.code, serverNow: Date.now(), startAt };
    for (const player of [room.players.host, room.players.guest]) {
      memberSocket(player)?.emit(EVENTS.ROOM_START, payload);
    }
  };

  roomManager.onRoomClose = (room, reason) => {
    for (const player of [room.players.host, room.players.guest]) {
      const target = memberSocket(player);
      if (!target) continue;
      target.emit(EVENTS.ROOM_CLOSED, { code: room.code, reason });
      target.leave(`room:${room.code}`);
    }
  };

  io.on('connection', (socket) => {
    /**
     * The seat bound to THIS connection: { room, player, slot, char }.
     * The slot/char always come from server-side assignment; nothing in any
     * client payload can influence them.
     */
    let seat = null;

    const clientKey = () => {
      if (trustProxy) {
        const fwd = socket.handshake.headers['x-forwarded-for'];
        const first = typeof fwd === 'string' ? fwd.split(',')[0].trim() : null;
        if (first) return first;
      }
      return socket.handshake.address ?? 'unknown';
    };

    const emitRoomError = (code, message) => {
      socket.emit(EVENTS.ROOM_ERROR, { code, message });
    };

    /** Rate-limit guard for room-mutation events. Emits the error itself. */
    const limited = (limiter) => {
      const verdict = limiter.consume(clientKey());
      if (verdict.ok) return false;
      emitRoomError(ROOM_ERRORS.RATE_LIMITED, `too many requests, retry in ${Math.ceil(verdict.retryAfterMs / 1000)}s`);
      return true;
    };

    const versionMismatch = (payload) =>
      payload && payload.protocol !== undefined && payload.protocol !== PROTOCOL_VERSION;

    /**
     * Bind the connection to a seat and announce it. `token` is private:
     * it only ever travels to the owning socket.
     */
    const bindSeat = ({ room, player, slot, char, game }, eventName, { token } = {}) => {
      room.attachSocket(player, socket.id);
      seat = { room, player, slot, char, game };
      socket.join(`room:${room.code}`);
      socket.emit(eventName, {
        code: room.code,
        game,
        role: slot,
        char,
        token: token ?? player.token,
        protocol: PROTOCOL_VERSION,
        state: room.describe(),
      });
      const peer = room.getPeer(player);
      if (peer && peer.socketId !== socket.id) {
        memberSocket(peer)?.emit(EVENTS.ROOM_PEER_JOINED, { role: slot, char });
      }
      broadcastState(room);
    };

    /** This connection still owns its seat? (A duplicate-tab takeover
     * rebinds player.socketId to the newer socket; stale teardown from the
     * older connection must be a no-op.) */
    const ownsSeat = () => Boolean(seat && seat.player.socketId === socket.id);

    // ---- room lifecycle -------------------------------------------------

    socket.on(EVENTS.ROOM_CREATE, (payload = {}, ack) => {
      if (seat) {
        emitRoomError(ROOM_ERRORS.ALREADY_IN_ROOM, 'leave the current room first');
        ack?.({ ok: false, code: ROOM_ERRORS.ALREADY_IN_ROOM });
        return;
      }
      if (versionMismatch(payload)) {
        emitRoomError(ROOM_ERRORS.PROTOCOL_VERSION_MISMATCH, 'refresh the page');
        ack?.({ ok: false, code: ROOM_ERRORS.PROTOCOL_VERSION_MISMATCH });
        return;
      }
      if (limited(rateCreate)) {
        ack?.({ ok: false, code: ROOM_ERRORS.RATE_LIMITED });
        return;
      }
      if (!payload || typeof payload !== 'object') {
        emitRoomError(ROOM_ERRORS.BAD_PAYLOAD, 'payload must be an object');
        ack?.({ ok: false, code: ROOM_ERRORS.BAD_PAYLOAD });
        return;
      }
      const char = payload.char ?? CHARS.FIREBOY;
      if (!Object.values(CHARS).includes(char)) {
        emitRoomError(ROOM_ERRORS.CHAR_TAKEN, 'invalid character');
        ack?.({ ok: false, code: ROOM_ERRORS.CHAR_TAKEN });
        return;
      }
      if (VALIDATE.gameId(payload.game)) {
        emitRoomError(ROOM_ERRORS.GAME_NOT_FOUND, 'unknown game');
        ack?.({ ok: false, code: ROOM_ERRORS.GAME_NOT_FOUND });
        return;
      }
      if (!roomManager.hasGame(payload.game)) {
        emitRoomError(ROOM_ERRORS.GAME_NOT_FOUND, 'unknown game');
        ack?.({ ok: false, code: ROOM_ERRORS.GAME_NOT_FOUND });
        return;
      }
      const result = roomManager.createRoom({ game: payload.game, char });
      if (result.error) {
        emitRoomError(result.error, result.message);
        ack?.({ ok: false, code: result.error });
        return;
      }
      bindSeat(result, EVENTS.ROOM_CREATED, { token: result.token });
      ack?.({ ok: true, code: result.room.code, game: result.game, char: result.char });
    });

    socket.on(EVENTS.ROOM_JOIN, (payload = {}, ack) => {
      if (seat) {
        emitRoomError(ROOM_ERRORS.ALREADY_IN_ROOM, 'leave the current room first');
        ack?.({ ok: false, code: ROOM_ERRORS.ALREADY_IN_ROOM });
        return;
      }
      if (versionMismatch(payload)) {
        emitRoomError(ROOM_ERRORS.PROTOCOL_VERSION_MISMATCH, 'refresh the page');
        ack?.({ ok: false, code: ROOM_ERRORS.PROTOCOL_VERSION_MISMATCH });
        return;
      }
      if (limited(rateJoin)) {
        ack?.({ ok: false, code: ROOM_ERRORS.RATE_LIMITED });
        return;
      }
      const code = String(payload?.code ?? '').toUpperCase();
      if (VALIDATE.roomCode(code)) {
        emitRoomError(ROOM_ERRORS.ROOM_NOT_FOUND, 'invalid room code');
        ack?.({ ok: false, code: ROOM_ERRORS.ROOM_NOT_FOUND });
        return;
      }
      const result = roomManager.joinRoom({ code });
      if (result.error) {
        emitRoomError(result.error, result.message);
        ack?.({ ok: false, code: result.error });
        return;
      }
      bindSeat(result, EVENTS.ROOM_JOINED, { token: result.token });
      ack?.({ ok: true, code: result.room.code, game: result.game, char: result.char });
    });

    socket.on(EVENTS.ROOM_REJOIN, (payload = {}, ack) => {
      if (seat) {
        emitRoomError(ROOM_ERRORS.ALREADY_IN_ROOM, 'leave the current room first');
        ack?.({ ok: false, code: ROOM_ERRORS.ALREADY_IN_ROOM });
        return;
      }
      if (versionMismatch(payload)) {
        emitRoomError(ROOM_ERRORS.PROTOCOL_VERSION_MISMATCH, 'refresh the page');
        ack?.({ ok: false, code: ROOM_ERRORS.PROTOCOL_VERSION_MISMATCH });
        return;
      }
      if (limited(rateJoin)) {
        ack?.({ ok: false, code: ROOM_ERRORS.RATE_LIMITED });
        return;
      }
      const token = typeof payload?.token === 'string' ? payload.token : '';
      const result = roomManager.rejoin({ token });
      if (result.error) {
        emitRoomError(result.error, result.message);
        ack?.({ ok: false, code: result.error });
        return;
      }
      const { room, player } = result;
      // Duplicate-tab policy: the NEWEST connection wins the seat. The
      // displaced socket gets an explicit error and stops receiving state;
      // its later teardown is neutralized by ownsSeat().
      if (player.connected && player.socketId && player.socketId !== socket.id) {
        const displaced = io.sockets.sockets.get(player.socketId);
        displaced?.emit(EVENTS.ROOM_ERROR, {
          code: ROOM_ERRORS.DUPLICATE_TAB,
          message: 'this seat was opened in a newer tab/connection',
        });
        displaced?.leave(`room:${room.code}`);
        log(`room ${room.code}: duplicate tab displaced ${player.socketId}`);
      }
      bindSeat(result, EVENTS.ROOM_REJOINED);
      ack?.({ ok: true, code: room.code, game: result.game, role: result.slot, char: result.char });
    });

    socket.on(EVENTS.ROOM_LEAVE, () => {
      if (!ownsSeat()) return;
      const { room, player } = seat;
      seat = null;
      socket.leave(`room:${room.code}`);
      room.releaseSeatByToken(player.token);
    });

    // ---- readiness gate ---------------------------------------------------

    socket.on(EVENTS.ROOM_LOAD, (payload = {}) => {
      if (!ownsSeat() || !payload || typeof payload !== 'object') return;
      const loaded = payload.loaded;
      if (typeof loaded !== 'boolean') return;
      seat.room.setLoaded(seat.player, loaded);
    });

    socket.on(EVENTS.ROOM_READY, (payload = {}) => {
      if (!ownsSeat() || !payload || typeof payload !== 'object') return;
      const ready = payload.ready;
      if (typeof ready !== 'boolean') return;
      seat.room.setReady(seat.player, ready);
    });

    // ---- role swap ---------------------------------------------------------

    socket.on(EVENTS.ROOM_SWAP, (payload = {}) => {
      if (!ownsSeat() || !payload || typeof payload !== 'object') return;
      if (VALIDATE.swapAction(payload.action)) return;
      const { room, slot } = seat;
      switch (payload.action) {
        case SWAP_ACTIONS.REQUEST:
          room.offerSwap(slot);
          break;
        case SWAP_ACTIONS.ACCEPT:
          room.acceptSwap(slot);
          break;
        case SWAP_ACTIONS.DECLINE:
        case SWAP_ACTIONS.CANCEL:
          // Either side may abort a pending offer.
          if (room.swapOffer) room.cancelSwap();
          break;
        default:
          break;
      }
    });

    // ---- latency ------------------------------------------------------------

    socket.on(EVENTS.NET_PING, (sentAt, ack) => {
      if (typeof ack === 'function') ack(sentAt);
    });

    socket.on(EVENTS.NET_LATENCY, (payload = {}) => {
      if (!ownsSeat()) return;
      if (VALIDATE.latencyMs(payload?.ms)) return;
      if (limited(rateLatency)) return;
      seat.room.setLatency(seat.player, Math.round(payload.ms));
    });

    // ---- gameplay relays (gated on the room state machine) -------------------

    socket.on(EVENTS.INPUT_FRAME, (payload) => {
      if (!seat || seat.slot !== ROLES.GUEST) return; // only the guest seat sends input
      if (!PLAY_RELAY_STATES.has(seat.room.state)) return; // nothing flows before the server starts the game
      if (VALIDATE.inputFrame(payload)) return;
      memberSocket(seat.room.getPeer(seat.player))?.emit(EVENTS.INPUT_FRAME, payload);
    });

    socket.on(EVENTS.INPUT_POINTER, (payload) => {
      if (!seat || seat.slot !== ROLES.GUEST) return;
      if (!PLAY_RELAY_STATES.has(seat.room.state)) return;
      if (VALIDATE.pointerEvent(payload)) return;
      memberSocket(seat.room.getPeer(seat.player))?.emit(EVENTS.INPUT_POINTER, payload);
    });

    socket.on(EVENTS.GAME_COMMAND, (payload) => {
      if (!seat || seat.slot !== ROLES.GUEST) return;
      if (!PLAY_RELAY_STATES.has(seat.room.state)) return;
      if (!payload || typeof payload !== 'object' || typeof payload.type !== 'string' || payload.type.length > 32) return;
      memberSocket(seat.room.getPeer(seat.player))?.emit(EVENTS.GAME_COMMAND, payload);
    });

    socket.on(EVENTS.GAME_STATUS, (payload) => {
      if (!seat || seat.slot !== ROLES.HOST) return; // only the host seat reports status
      const invalid = VALIDATE.gameStatus(payload);
      if (invalid) {
        log(`room ${seat.room.code}: rejected game:status (${invalid})`);
        return;
      }
      // The room machine consumes pause / finish facts from the same event.
      seat.room.setHostPaused(Boolean(payload.paused));
      if (payload.phase === 'end') seat.room.markLevelEnded();
      memberSocket(seat.room.getPeer(seat.player))?.emit(EVENTS.GAME_STATUS, payload);
    });

    // ---- host-authoritative world snapshots (host -> guest only) ----
    // Frequent but small: validated, size-capped, and stamped with the server
    // clock so the guest can age-check each snapshot. Ordering/dedup is the
    // guest's job (seq filter) — the relay stays a dumb, verified pipe.
    socket.on(EVENTS.SYNC_SNAPSHOT, (payload) => {
      if (!seat || seat.slot !== ROLES.HOST) return;
      if (!PLAY_RELAY_STATES.has(seat.room.state)) return;
      const invalid = VALIDATE.snapshot(payload);
      if (invalid) {
        log(`room ${seat.room.code}: rejected sync:snapshot (${invalid})`);
        return;
      }
      memberSocket(seat.room.getPeer(seat.player))?.emit(EVENTS.SYNC_SNAPSHOT, { ...payload, st: Date.now() });
    });

    socket.on(EVENTS.RTC_SIGNAL, (payload) => {
      if (!seat) return;
      if (!payload || typeof payload !== 'object' || typeof payload.kind !== 'string' || payload.kind.length > 32) return;
      memberSocket(seat.room.getPeer(seat.player))?.emit(EVENTS.RTC_SIGNAL, payload);
    });

    // ---- teardown ---------------------------------------------------------

    socket.on('disconnect', () => {
      if (!ownsSeat()) return;
      const { room, player } = seat;
      seat = null;
      room.detachSocket(player); // seat held for the grace window
      const peer = room.getPeer(player);
      if (peer?.connected) {
        memberSocket(peer)?.emit(EVENTS.ROOM_PEER_LEFT, {
          role: player.slot,
          graceMs: room.seatGraceMs,
          state: room.state,
        });
      }
    });
  });

  const stop = () => {
    rateCreate.stop();
    rateJoin.stop();
    rateLatency.stop();
    io.close();
  };

  return { io, stop };
}
