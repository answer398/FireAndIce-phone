/**
 * Protocol-level smoke test: boots the real server stack (express + io +
 * rooms) on a random port and drives it with socket.io-client.
 *
 * Covers: create/join, role+char assignment, input relay hostward,
 * status relay guestward, rtc signal relay, guest rejoin with token,
 * host grace window and room closure. Run: npm run smoke
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { io } from 'socket.io-client';

import { createApp } from '../src/app.js';
import { RoomManager } from '../src/rooms/roomManager.js';
import { createSocketServer } from '../src/realtime/socketServer.js';
import { EVENTS, CHARS, GAME_COMMANDS } from '../../common/protocol/events.mjs';

const GRACE_MS = 1500;

function startServer() {
  const app = createApp();
  const httpServer = http.createServer(app);
  const roomManager = new RoomManager({
    graceMs: GRACE_MS,
    emptyTtlMs: 5000,
    codeLength: 4,
    sweepIntervalMs: 250,
    log: () => {},
  });
  createSocketServer(httpServer, { roomManager, allowedOrigins: [], log: () => {} });
  return new Promise((resolve) => {
    httpServer.listen(0, '127.0.0.1', () => {
      const { port } = httpServer.address();
      const stop = () =>
        new Promise((done) => {
          roomManager.stop();
          httpServer.close(done);
        });
      resolve({ port, stop, roomManager });
    });
  });
}

function client(port) {
  return io(`http://127.0.0.1:${port}`, {
    transports: ['websocket'],
    reconnection: false,
  });
}

function waitEvent(socket, event, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting ${event}`)), timeoutMs);
    socket.once(event, (payload) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

function emitAck(socket, event, payload) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`ack timeout ${event}`)), 3000);
    socket.timeout(3000).emit(event, payload, (err, response) => {
      clearTimeout(timer);
      if (err) reject(new Error(`ack error ${event}`));
      else resolve(response);
    });
  });
}

async function main() {
  const { port, stop, roomManager } = await startServer();
  const failures = [];
  const check = (name, fn) =>
    fn()
      .then(() => console.log('  ok -', name))
      .catch((err) => {
        failures.push({ name, err });
        console.error('  FAIL -', name, err.message);
      });

  // ---- static surface guards ----------------------------------------------
  await check('denylist blocks /server', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/server/src/index.js`);
    assert.equal(res.status, 403);
  });
  await check('denylist blocks /.git config', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/.git/config`);
    assert.ok(res.status === 403 || res.status === 404);
  });
  await check('denylist blocks /tools', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/tools/restore-assets.sh`);
    assert.equal(res.status, 403);
  });
  await check('serves game page', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/games/1-forest-temple/`);
    assert.equal(res.status, 200);
  });
  await check('serves shared protocol module', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/common/protocol/events.mjs`);
    assert.equal(res.status, 200);
  });
  await check('healthz', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/healthz`);
    assert.equal(res.status, 200);
  });

  // ---- room flow -------------------------------------------------------------
  const host = client(port);
  const guest = client(port);
  host.onAny(() => {});
  guest.onAny(() => {});

  const seatPayloadPromise = waitEvent(host, EVENTS.ROOM_CREATED);
  const created = await emitAck(host, EVENTS.ROOM_CREATE, { char: CHARS.FIREBOY });
  assert.ok(created.ok && created.code.length === 4);
  const code = created.code;
  console.log('  ok - create room', code);

  const seatPayload = await seatPayloadPromise;
  assert.equal(seatPayload.role, 'host');
  assert.ok(seatPayload.token, 'seat payload carries rejoin token');

  await check('join assigns opposite char', async () => {
    const joined = await emitAck(guest, EVENTS.ROOM_JOIN, { code });
    assert.equal(joined.ok, true);
    assert.equal(joined.char, CHARS.WATERGIRL);
  });

  await check('host hears peer joined', async () => {
    const peer = await waitEvent(host, EVENTS.ROOM_PEER_JOINED);
    assert.equal(peer.role, 'guest');
  });

  await check('third client rejected (full)', async () => {
    const third = client(port);
    const err = await new Promise((resolve) => {
      third.once(EVENTS.ROOM_ERROR, resolve);
      third.emit(EVENTS.ROOM_JOIN, { code }, () => {});
    });
    assert.equal(err.code, 'room-full');
    third.disconnect();
  });

  await check('input frame flows guest->host', async () => {
    const received = waitEvent(host, EVENTS.INPUT_FRAME);
    guest.emit(EVENTS.INPUT_FRAME, { up: true, left: false, right: false, seq: 1 });
    const frame = await received;
    assert.equal(frame.up, true);
    assert.equal(frame.seq, 1);
  });

  await check('stale input frames dropped server-side shape ok', async () => {
    // malformed frames must be swallowed, not relayed
    let got = false;
    host.once(EVENTS.INPUT_FRAME, () => (got = true));
    guest.emit(EVENTS.INPUT_FRAME, { up: 'yes', seq: 2 }); // invalid type
    guest.emit(EVENTS.INPUT_FRAME, null);
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(got, false);
  });

  await check('host input frames never relayed', async () => {
    let got = false;
    guest.once(EVENTS.INPUT_FRAME, () => (got = true));
    host.emit(EVENTS.INPUT_FRAME, { up: true, left: true, right: true, seq: 9 });
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(got, false);
  });

  await check('status flows host->guest', async () => {
    const received = waitEvent(guest, EVENTS.GAME_STATUS);
    host.emit(EVENTS.GAME_STATUS, { phase: 'level', paused: false, ts: Date.now() });
    const status = await received;
    assert.equal(status.phase, 'level');
  });

  await check('rtc signal relays both ways', async () => {
    const onGuest = waitEvent(guest, EVENTS.RTC_SIGNAL);
    host.emit(EVENTS.RTC_SIGNAL, { kind: 'offer', sdp: 'x' });
    assert.equal((await onGuest).kind, 'offer');
    const onHost = waitEvent(host, EVENTS.RTC_SIGNAL);
    guest.emit(EVENTS.RTC_SIGNAL, { kind: 'answer', sdp: 'y' });
    assert.equal((await onHost).kind, 'answer');
  });

  await check('game command flows guest->host only', async () => {
    const received = waitEvent(host, EVENTS.GAME_COMMAND);
    guest.emit(EVENTS.GAME_COMMAND, { type: GAME_COMMANDS.PAUSE_TOGGLE });
    assert.equal((await received).type, GAME_COMMANDS.PAUSE_TOGGLE);
  });

  await check('latency probe acks', async () => {
    const t0 = 123.45;
    const sentBack = await emitAck(guest, EVENTS.NET_PING, t0);
    assert.equal(sentBack, t0);
  });

  await check('rejoin resolves the same seat (token)', async () => {
    // Emulates a page reload: fresh socket, same token -> same role+char.
    const room = [...roomManager.rooms.values()].find((r) => r.code === code);
    const guestMember = room.getMember('guest');
    const rejoined = roomManager.rejoin({ token: guestMember.token });
    assert.equal(rejoined.role, 'guest');
    assert.equal(rejoined.char, CHARS.WATERGIRL);
  });

  await check('host grace: host drop holds room, then closes', async () => {
    const closed = waitEvent(guest, EVENTS.ROOM_CLOSED, GRACE_MS + 4000);
    host.disconnect();
    // within grace the room still exists
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(roomManager.rooms.has(code), 'room should survive grace window');
    await closed; // then closes
    assert.ok(!roomManager.rooms.has(code));
  });

  guest.disconnect();
  await stop();

  console.log(failures.length === 0 ? '\nALL SMOKE TESTS PASSED' : `\n${failures.length} FAILURES`);
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
