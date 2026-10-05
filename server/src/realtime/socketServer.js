import { Server } from 'socket.io';
import {
  EVENTS,
  PROTOCOL_VERSION,
  ROLES,
  VALIDATE,
} from '../../../common/protocol/events.mjs';

/**
 * Socket.IO wiring.
 *
 * The server is a pure switchboard: it seats members into rooms, forwards
 * frames between the two seats, and never inspects gameplay semantics.
 * Every event name comes from the shared protocol module.
 */
export function createSocketServer(httpServer, { roomManager, allowedOrigins, log }) {
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

  // Deliver ROOM_CLOSED to whoever is still connected when a room closes
  // (host grace window expired, room destroyed, …). Assigned before any
  // room can exist — the manager is created just before this call.
  roomManager.onRoomClose = (room, reason) => {
    for (const member of room.members.values()) {
      if (!member.connected) continue;
      const memberSocket = io.sockets.sockets.get(member.socketId);
      memberSocket?.emit(EVENTS.ROOM_CLOSED, { code: room.code, reason });
      memberSocket?.leave(`room:${room.code}`);
    }
  };

  io.on('connection', (socket) => {
    /** The room seat bound to this socket, if any. */
    let seat = null; // { room, member, role, char }

    const emitRoomError = (code, message) => {
      socket.emit(EVENTS.ROOM_ERROR, { code, message });
    };

    const peerSocket = () => {
      if (!seat) return null;
      const peer = seat.room.getPeer(seat.member);
      return peer?.connected ? io.sockets.sockets.get(peer.socketId) ?? null : null;
    };

    const leaveSeat = (notifyPeer = true) => {
      if (!seat) return;
      const { room, member, role } = seat;
      seat = null;
      room.detachSocket(member);
      if (notifyPeer) {
        const peer = room.getPeer(member);
        if (peer?.connected) {
          io.sockets.sockets.get(peer.socketId)?.emit(EVENTS.ROOM_PEER_LEFT, {
            role,
            graceMs: room.graceMs,
          });
        }
      }
      // Closed rooms are swept by the manager; nothing else to do here.
    };

    const seatAndAnnounce = ({ room, member, role, char }) => {
      room.attachSocket(member, socket.id);
      seat = { room, member, role, char };
      socket.join(`room:${room.code}`);
      const peer = room.getPeer(member);

      // `token` is private: it only ever travels to the owning socket and
      // lets that seat rejoin after a reconnect or page reload.
      socket.emit(
        role === ROLES.HOST ? EVENTS.ROOM_CREATED : EVENTS.ROOM_JOINED,
        {
          code: room.code,
          role,
          char,
          token: member.token,
          protocol: PROTOCOL_VERSION,
          peerConnected: Boolean(peer?.connected),
        },
      );

      if (peer?.connected) {
        const peerSocketRef = io.sockets.sockets.get(peer.socketId);
        // Tell the existing member about the (re)arrival…
        peerSocketRef?.emit(EVENTS.ROOM_PEER_JOINED, { role, char });
        // …and make sure the newcomer learns the peer is already there.
        socket.emit(EVENTS.ROOM_PEER_JOINED, { role: peer.role, char: peer.char });
      }
    };

    // ---- room lifecycle -------------------------------------------------

    socket.on(EVENTS.ROOM_CREATE, (payload = {}, ack) => {
      if (seat) return emitRoomError('already-in-room', 'leave the current room first');
      const char = payload?.char;
      const result = roomManager.createRoom({ char });
      if (result.error) return emitRoomError(result.error, result.message);
      seatAndAnnounce(result);
      ack?.({ ok: true, code: result.room.code });
    });

    socket.on(EVENTS.ROOM_JOIN, (payload = {}, ack) => {
      if (seat) return emitRoomError('already-in-room', 'leave the current room first');
      const code = String(payload?.code ?? '').toUpperCase();
      if (VALIDATE.roomCode(code)) return emitRoomError('room-not-found', 'invalid room code');
      const result = roomManager.joinRoom({ code });
      if (result.error) return emitRoomError(result.error, result.message);
      seatAndAnnounce(result);
      ack?.({ ok: true, code: result.room.code, char: result.char });
    });

    socket.on(EVENTS.ROOM_REJOIN, (payload = {}, ack) => {
      if (seat) return emitRoomError('already-in-room', 'leave the current room first');
      const token = String(payload?.token ?? '');
      const result = roomManager.rejoin({ token });
      if (result.error) return emitRoomError(result.error, result.message);
      seatAndAnnounce(result);
      ack?.({ ok: true, code: result.room.code, role: result.role, char: result.char, token });
    });

    socket.on(EVENTS.ROOM_LEAVE, () => {
      leaveSeat(true);
    });

    // ---- latency probe ---------------------------------------------------

    socket.on(EVENTS.NET_PING, (sentAt, ack) => {
      if (typeof ack === 'function') ack(sentAt);
    });

    // ---- peer-to-peer relays (guest <-> host through the server) ---------

    socket.on(EVENTS.INPUT_FRAME, (payload) => {
      if (!seat || seat.role !== ROLES.GUEST) return;
      if (VALIDATE.inputFrame(payload)) return;
      const peer = peerSocket();
      peer?.emit(EVENTS.INPUT_FRAME, payload);
    });

    socket.on(EVENTS.INPUT_POINTER, (payload) => {
      if (!seat || seat.role !== ROLES.GUEST) return;
      if (VALIDATE.pointerEvent(payload)) return;
      const peer = peerSocket();
      peer?.emit(EVENTS.INPUT_POINTER, payload);
    });

    socket.on(EVENTS.GAME_COMMAND, (payload) => {
      if (!seat || seat.role !== ROLES.GUEST) return;
      if (!payload || typeof payload !== 'object') return;
      const peer = peerSocket();
      peer?.emit(EVENTS.GAME_COMMAND, payload);
    });

    socket.on(EVENTS.GAME_STATUS, (payload) => {
      log(`game:status from ${socket.id} seat=${seat ? `${seat.role}@${seat.room.code}` : 'none'}`);
      if (!seat || seat.role !== ROLES.HOST) return;
      const invalid = VALIDATE.gameStatus(payload);
      if (invalid) {
        log(`room ${seat.room.code}: rejected game:status (${invalid})`);
        return;
      }
      const peer = peerSocket();
      if (peer) {
        peer.emit(EVENTS.GAME_STATUS, payload);
      } else {
        log(`room ${seat.room.code}: game:status dropped (no connected peer)`);
      }
    });

    socket.on(EVENTS.RTC_SIGNAL, (payload) => {
      if (!seat) return;
      if (!payload || typeof payload !== 'object' || typeof payload.kind !== 'string') return;
      const peer = peerSocket();
      peer?.emit(EVENTS.RTC_SIGNAL, payload);
    });

    // ---- teardown ---------------------------------------------------------

    socket.on('disconnect', () => {
      leaveSeat(true);
    });
  });

  return io;
}
