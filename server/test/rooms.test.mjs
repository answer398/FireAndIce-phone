/**
 * Room protocol test suite: boots the real server stack (express + io +
 * room state machine) on random ports and drives it with socket.io-client.
 *
 * Covers: create/join, role+char authorization, payload validation, the
 * ready→countdown→start gate with server timestamps, role swap, disconnect
 * + grace window, token rejoin, duplicate-tab takeover, pause/finish
 * observation, rate limiting, capacity guard and cleanup (seat grace,
 * empty-room TTL, host-timeout close).
 *
 * Run: npm test   (alias: npm run smoke)
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { io } from 'socket.io-client';

import { createApp } from '../src/app.js';
import { RoomManager } from '../src/rooms/roomManager.js';
import { createSocketServer } from '../src/realtime/socketServer.js';
import { EVENTS, CHARS, ROOM_ERRORS, ROOM_STATES, PROTOCOL_VERSION, LIMITS } from '../../common/protocol/events.mjs';

// Fast clocks: everything the suite waits on is sub-3s.
const GRACE_MS = 1000;
const COUNTDOWN_MS = 600;
const SWAP_TTL_MS = 800;
const EMPTY_TTL_MS = 2500;
const SWEEP_MS = 150;

function startServer({ rateLimits, maxRooms } = {}) {
  const app = createApp();
  const httpServer = http.createServer(app);
  const roomManager = new RoomManager({
    seatGraceMs: GRACE_MS,
    countdownMs: COUNTDOWN_MS,
    swapOfferTtlMs: SWAP_TTL_MS,
    emptyTtlMs: EMPTY_TTL_MS,
    sweepIntervalMs: SWEEP_MS,
    maxRooms: maxRooms ?? LIMITS.MAX_ROOMS,
    log: () => {},
  });
  const realtime = createSocketServer(httpServer, {
    roomManager,
    allowedOrigins: [],
    log: () => {},
    // The shared suite performs many creates/joins from one IP in a minute;
    // only the dedicated rate-limit instance tightens these.
    rateLimits: rateLimits ?? { createMax: 5000, joinMax: 5000, latencyMax: 5000 },
  });
  return new Promise((resolve) => {
    httpServer.listen(0, '127.0.0.1', () => {
      const { port } = httpServer.address();
      const stop = () =>
        new Promise((done) => {
          roomManager.stop();
          realtime.stop(); // closes every socket so httpServer.close settles
          httpServer.close(done);
          setTimeout(() => done(), 500).unref();
        });
      resolve({ port, stop, roomManager });
    });
  });
}

const client = (port) =>
  io(`http://127.0.0.1:${port}`, { transports: ['websocket'], reconnection: false });

const waitEvent = (socket, event, timeoutMs = 3000) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting ${event}`)), timeoutMs);
    socket.once(event, (payload) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });

const emitAck = (socket, event, payload, timeoutMs = 3000) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`ack timeout ${event}`)), timeoutMs);
    socket.timeout(timeoutMs).emit(event, payload, (err, response) => {
      clearTimeout(timer);
      if (err) reject(new Error(`ack error ${event}`));
      else resolve(response);
    });
  });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Resolves with the first room:state payload arriving AFTER the call that
 * matches `pred`. Only new events count — not the current room contents. */
const waitState = (socket, pred, timeoutMs = 3000) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(EVENTS.ROOM_STATE, onState);
      reject(new Error('timeout waiting room state'));
    }, timeoutMs);
    const onState = (state) => {
      if (pred(state)) {
        clearTimeout(timer);
        socket.off(EVENTS.ROOM_STATE, onState);
        resolve(state);
      }
    };
    socket.on(EVENTS.ROOM_STATE, onState);
  });

/** Seat one room with a host + guest, returning seats, tokens, sockets and a
 * promise for the first room:state that shows both seats. */
async function seatRoom(port, { game = '1-forest-temple', hostChar = CHARS.FIREBOY } = {}) {
  const host = client(port);
  const guest = client(port);
  // All listeners go on BEFORE the triggers: the server emits seat events
  // and state broadcasts before the acks resolve.
  const hostSeatP = waitEvent(host, EVENTS.ROOM_CREATED);
  const guestSeatP = waitEvent(guest, EVENTS.ROOM_JOINED);
  const bothStateP = waitState(guest, (s) => s.players.guest && s.players.host);
  const created = await emitAck(host, EVENTS.ROOM_CREATE, { game, char: hostChar, protocol: PROTOCOL_VERSION });
  assert.ok(created.ok, 'create ok');
  const joined = await emitAck(guest, EVENTS.ROOM_JOIN, { code: created.code, protocol: PROTOCOL_VERSION });
  assert.ok(joined.ok, 'join ok');
  const hostSeat = await hostSeatP;
  const guestSeat = await guestSeatP;
  return { host, guest, code: created.code, game, hostSeat, guestSeat, bothStateP };
}

/** Load + ready both seats; resolves with the ROOM_START payload. */
const bothReady = async ({ host, guest }) => {
  const playingP = waitState(guest, (s) => s.state === ROOM_STATES.PLAYING);
  host.emit(EVENTS.ROOM_LOAD, { loaded: true });
  guest.emit(EVENTS.ROOM_LOAD, { loaded: true });
  host.emit(EVENTS.ROOM_READY, { ready: true });
  guest.emit(EVENTS.ROOM_READY, { ready: true });
  const start = await waitEvent(guest, EVENTS.ROOM_START, 4000);
  await playingP;
  return start;
};

async function main() {
  const failures = [];
  const tests = [];
  const test = (name, fn) => tests.push([name, fn]);
  const run = async () => {
    for (const [name, fn] of tests) {
      try {
        await fn();
        console.log('  ok -', name);
      } catch (err) {
        failures.push({ name, err });
        console.error('  FAIL -', name, '::', err.message);
      }
    }
  };

  // =========================================================================
  const srv = await startServer();
  const port = srv.port;
  const M = (fn) => () => fn(port, srv);

  // ---- static surface ------------------------------------------------------
  test('denylist blocks /server', M(async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/server/src/index.js`);
    assert.equal(res.status, 403);
  }));
  test('denylist blocks /.git config', M(async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/.git/config`);
    assert.ok(res.status === 403 || res.status === 404);
  }));
  test('denylist blocks /tools', M(async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/tools/restore-assets.sh`);
    assert.equal(res.status, 403);
  }));
  test('serves game page + shared protocol + healthz', M(async (port) => {
    assert.equal((await fetch(`http://127.0.0.1:${port}/games/1-forest-temple/`)).status, 200);
    assert.equal((await fetch(`http://127.0.0.1:${port}/common/protocol/events.mjs`)).status, 200);
    assert.equal((await fetch(`http://127.0.0.1:${port}/healthz`)).status, 200);
  }));

  // ---- create / join / seats ------------------------------------------------
  test('create room: code, host seat, token, waiting state', M(async (port) => {
    const host = client(port);
    const statePromise = waitEvent(host, EVENTS.ROOM_STATE);
    const seatPromise = waitEvent(host, EVENTS.ROOM_CREATED);
    const created = await emitAck(host, EVENTS.ROOM_CREATE, { game: '1-forest-temple', char: CHARS.FIREBOY, protocol: PROTOCOL_VERSION });
    assert.ok(created.ok);
    assert.match(created.code, /^[A-Z0-9]{4}$/);
    const seatPayload = await seatPromise;
    assert.equal(seatPayload.role, 'host');
    assert.equal(seatPayload.char, CHARS.FIREBOY);
    assert.equal(seatPayload.game, '1-forest-temple');
    assert.match(seatPayload.token, /^[a-f0-9]{32}$/);
    const state = await statePromise;
    assert.equal(state.state, ROOM_STATES.WAITING);
    assert.equal(state.players.host.connected, true);
    assert.equal(state.players.guest, null);
    assert.ok(!JSON.stringify(state).includes(seatPayload.token), 'token must never leak into room:state');
    host.disconnect();
  }));

  test('join assigns the opposite char; both seats visible in room:state', M(async (port) => {
    const { host, guest, bothStateP } = await seatRoom(port);
    const state = await bothStateP;
    assert.equal(state.players.guest.char, CHARS.WATERGIRL);
    assert.equal(state.players.host.char, CHARS.FIREBOY);
    host.disconnect();
    guest.disconnect();
  }));

  test('wrong code rejected (ack + event), malformed codes too', M(async (port) => {
    const c = client(port);
    const errPromise = waitEvent(c, EVENTS.ROOM_ERROR);
    const ack = await emitAck(c, EVENTS.ROOM_JOIN, { code: 'ZZZZ' });
    assert.equal(ack.ok, false);
    assert.equal(ack.code, ROOM_ERRORS.ROOM_NOT_FOUND);
    const err = await errPromise;
    assert.equal(err.code, ROOM_ERRORS.ROOM_NOT_FOUND);
    for (const bad of ['ab1', 'ABCD1', 'AB-1', 42, null]) {
      const a = await emitAck(c, EVENTS.ROOM_JOIN, { code: bad });
      assert.equal(a.ok, false, `bad code ${JSON.stringify(bad)} must fail`);
    }
    c.disconnect();
  }));

  test('third player rejected: room-full while both seats live', M(async (port) => {
    const { host, guest, code } = await seatRoom(port);
    const third = client(port);
    const err = await new Promise((resolve) => {
      third.once(EVENTS.ROOM_ERROR, resolve);
      third.emit(EVENTS.ROOM_JOIN, { code }, () => {});
    });
    assert.equal(err.code, ROOM_ERRORS.ROOM_FULL);
    third.disconnect();
    host.disconnect();
    guest.disconnect();
  }));

  test('seat under reconnect grace is NOT free: joiner rejected', M(async (port) => {
    const { host, guest, code } = await seatRoom(port);
    guest.disconnect(); // seat held for GRACE_MS
    await sleep(100);
    const third = client(port);
    const err = await new Promise((resolve) => {
      third.once(EVENTS.ROOM_ERROR, resolve);
      third.emit(EVENTS.ROOM_JOIN, { code }, () => {});
    });
    assert.equal(err.code, ROOM_ERRORS.ROOM_FULL);
    third.disconnect();
    host.disconnect();
  }));

  test('create while seated rejected; duplicate join rejected', M(async (port) => {
    const { host, guest, code } = await seatRoom(port);
    const ack = await emitAck(host, EVENTS.ROOM_CREATE, { game: '1-forest-temple' });
    assert.equal(ack.code, ROOM_ERRORS.ALREADY_IN_ROOM);
    const ack2 = await emitAck(guest, EVENTS.ROOM_JOIN, { code });
    assert.equal(ack2.code, ROOM_ERRORS.ALREADY_IN_ROOM);
    host.disconnect();
    guest.disconnect();
  }));

  test('unknown game id rejected', M(async (port) => {
    const c = client(port);
    const ack = await emitAck(c, EVENTS.ROOM_CREATE, { game: 'no-such-game' });
    assert.equal(ack.code, ROOM_ERRORS.GAME_NOT_FOUND);
    c.disconnect();
  }));

  // ---- role / payload authorization -----------------------------------------
  test('guest cannot push game:status; host status is relayed + observed', M(async (port) => {
    const { host, guest } = await seatRoom(port);
    await bothReady({ host, guest });
    let hostGot = false;
    host.once(EVENTS.GAME_STATUS, () => (hostGot = true));
    guest.emit(EVENTS.GAME_STATUS, { phase: 'level', paused: false }); // forged: guest seat
    await sleep(120);
    assert.equal(hostGot, false, 'forged status must not relay');
    host.emit(EVENTS.GAME_STATUS, { phase: 'level', paused: true });
    await waitState(guest, (s) => s.state === ROOM_STATES.PAUSED);
    host.emit(EVENTS.GAME_STATUS, { phase: 'level', paused: false });
    await waitState(guest, (s) => s.state === ROOM_STATES.PLAYING);
    host.disconnect();
    guest.disconnect();
  }));

  test('host cannot send input frames; guest frames relay only in play states', M(async (port) => {
    const { host, guest } = await seatRoom(port);
    let got = false;
    guest.once(EVENTS.INPUT_FRAME, () => (got = true));
    host.emit(EVENTS.INPUT_FRAME, { up: true, left: false, right: false, seq: 1 }); // host seat: never
    guest.emit(EVENTS.INPUT_FRAME, { up: true, left: false, right: false, seq: 1 }); // waiting: gated
    await sleep(120);
    assert.equal(got, false);
    await bothReady({ host, guest });
    guest.emit(EVENTS.INPUT_FRAME, { up: true, left: false, right: false, seq: 2 });
    const frame = await waitEvent(host, EVENTS.INPUT_FRAME);
    assert.equal(frame.seq, 2);
    assert.equal(frame.up, true);
    // malformed frames swallowed
    let got2 = false;
    host.once(EVENTS.INPUT_FRAME, () => (got2 = true));
    guest.emit(EVENTS.INPUT_FRAME, { up: 'yes', seq: 3 });
    guest.emit(EVENTS.INPUT_FRAME, null);
    await sleep(100);
    assert.equal(got2, false);
    host.disconnect();
    guest.disconnect();
  }));

  test('client-declared role/char in payloads never changes the assignment', M(async (port) => {
    const host = client(port);
    const created = await emitAck(host, EVENTS.ROOM_CREATE, { game: '1-forest-temple', char: CHARS.FIREBOY });
    const guest = client(port);
    const stateP = waitState(guest, (s) => s.players.guest);
    const ack = await emitAck(guest, EVENTS.ROOM_JOIN, { code: created.code, role: 'host', char: CHARS.FIREBOY, protocol: PROTOCOL_VERSION });
    assert.ok(ack.ok);
    assert.equal(ack.char, CHARS.WATERGIRL, 'char must stay the server-assigned opposite');
    const state = await stateP;
    assert.equal(state.players.guest.char, CHARS.WATERGIRL);
    host.disconnect();
    guest.disconnect();
  }));

  test('malformed ready/load/swap/latency payloads are ignored', M(async (port) => {
    const { host, guest, code } = await seatRoom(port);
    guest.emit(EVENTS.ROOM_READY, { ready: 'yes' });
    guest.emit(EVENTS.ROOM_LOAD, { loaded: 1 });
    guest.emit(EVENTS.ROOM_SWAP, { action: 'hax' });
    guest.emit(EVENTS.NET_LATENCY, { ms: 'fast' });
    guest.emit(EVENTS.NET_LATENCY, { ms: 999999 });
    await sleep(150);
    const room = srv.roomManager.rooms.get(code);
    assert.equal(room.players.guest.ready, false);
    assert.equal(room.players.guest.loaded, false);
    assert.equal(room.swapOffer, null);
    assert.equal(room.players.guest.latencyMs, null);
    host.disconnect();
    guest.disconnect();
  }));

  test('self-reported latency reaches the peer via room:state', M(async (port) => {
    const { host, guest } = await seatRoom(port);
    guest.emit(EVENTS.NET_LATENCY, { ms: 42 });
    const state = await waitState(host, (s) => s.players.guest?.latencyMs === 42);
    assert.equal(state.players.guest.latencyMs, 42);
    host.disconnect();
    guest.disconnect();
  }));

  // ---- ready → countdown → start ---------------------------------------------
  test('both loaded+ready → server countdown → start with server timestamps', M(async (port) => {
    const { host, guest } = await seatRoom(port);
    host.emit(EVENTS.ROOM_LOAD, { loaded: true });
    host.emit(EVENTS.ROOM_READY, { ready: true });
    await sleep(100);
    let started = false;
    guest.once(EVENTS.ROOM_START, () => (started = true));
    await sleep(COUNTDOWN_MS + 200);
    assert.equal(started, false, 'single-sided readiness must not start');
    const playingP = waitState(host, (s) => s.state === ROOM_STATES.PLAYING);
    const countdownP = waitState(guest, (s) => s.state === ROOM_STATES.COUNTDOWN);
    guest.emit(EVENTS.ROOM_LOAD, { loaded: true });
    guest.emit(EVENTS.ROOM_READY, { ready: true });
    const countdownState = await countdownP;
    assert.ok(countdownState.countdown.startAt > countdownState.serverNow, 'startAt is in the server future');
    const start = await waitEvent(guest, EVENTS.ROOM_START);
    assert.ok(Math.abs(start.startAt - start.serverNow) < 500, 'ROOM_START fires at startAt (server clock)');
    await playingP;
    host.disconnect();
    guest.disconnect();
  }));

  test('loaded without ready never starts', M(async (port) => {
    const { host, guest } = await seatRoom(port);
    let started = false;
    guest.once(EVENTS.ROOM_START, () => (started = true));
    host.emit(EVENTS.ROOM_LOAD, { loaded: true });
    guest.emit(EVENTS.ROOM_LOAD, { loaded: true });
    await sleep(COUNTDOWN_MS + 200);
    assert.equal(started, false);
    host.disconnect();
    guest.disconnect();
  }));

  test('un-ready during countdown aborts it (no start)', M(async (port) => {
    const { host, guest } = await seatRoom(port);
    host.emit(EVENTS.ROOM_LOAD, { loaded: true });
    host.emit(EVENTS.ROOM_READY, { ready: true });
    guest.emit(EVENTS.ROOM_LOAD, { loaded: true });
    guest.emit(EVENTS.ROOM_READY, { ready: true });
    await waitState(guest, (s) => s.state === ROOM_STATES.COUNTDOWN);
    guest.emit(EVENTS.ROOM_READY, { ready: false });
    const back = await waitState(guest, (s) => s.state === ROOM_STATES.WAITING);
    assert.equal(back.countdown, null);
    let started = false;
    guest.once(EVENTS.ROOM_START, () => (started = true));
    await sleep(COUNTDOWN_MS + 250);
    assert.equal(started, false);
    host.disconnect();
    guest.disconnect();
  }));

  test('swap: pending offer blocks the start; accept flips chars and resets readiness', M(async (port) => {
    const { host, guest } = await seatRoom(port);
    guest.emit(EVENTS.ROOM_SWAP, { action: 'request' });
    const offered = await waitState(host, (s) => s.swap && s.swap.from === 'guest');
    assert.ok(offered.swap.expiresAt > Date.now() - 1000);
    host.emit(EVENTS.ROOM_LOAD, { loaded: true });
    guest.emit(EVENTS.ROOM_LOAD, { loaded: true });
    host.emit(EVENTS.ROOM_READY, { ready: true });
    guest.emit(EVENTS.ROOM_READY, { ready: true });
    let started = false;
    guest.once(EVENTS.ROOM_START, () => (started = true));
    await sleep(COUNTDOWN_MS - 100);
    assert.equal(started, false, 'a pending swap offer blocks the countdown');
    host.emit(EVENTS.ROOM_SWAP, { action: 'accept' });
    const swapped = await waitState(host, (s) => s.swap === null && s.players.host.char === CHARS.WATERGIRL);
    assert.equal(swapped.players.guest.char, CHARS.FIREBOY);
    assert.equal(swapped.players.host.ready, false, 'readiness resets after swap');
    assert.equal(swapped.players.guest.ready, false);
    assert.equal(swapped.state, ROOM_STATES.WAITING);
    host.disconnect();
    guest.disconnect();
  }));

  test('swap decline cancels the offer', M(async (port) => {
    const { host, guest } = await seatRoom(port);
    guest.emit(EVENTS.ROOM_SWAP, { action: 'request' });
    await waitState(host, (s) => s.swap);
    host.emit(EVENTS.ROOM_SWAP, { action: 'decline' });
    await waitState(guest, (s) => s.swap === null);
    host.disconnect();
    guest.disconnect();
  }));

  test('swap offer expires on its own', M(async (port) => {
    const { host, guest } = await seatRoom(port);
    guest.emit(EVENTS.ROOM_SWAP, { action: 'request' });
    await waitState(host, (s) => s.swap);
    await waitState(guest, (s) => s.swap === null, SWAP_TTL_MS + 1500);
    host.disconnect();
    guest.disconnect();
  }));

  test('finished level: host status phase=end → finished, fresh ready required', M(async (port) => {
    const { host, guest } = await seatRoom(port);
    await bothReady({ host, guest });
    host.emit(EVENTS.GAME_STATUS, { phase: 'end', paused: false });
    const finished = await waitState(guest, (s) => s.state === ROOM_STATES.FINISHED);
    assert.equal(finished.players.host.ready, false, 'ready flags reset for the next level');
    assert.equal(finished.players.guest.ready, false);
    host.emit(EVENTS.ROOM_READY, { ready: true });
    guest.emit(EVENTS.ROOM_READY, { ready: true });
    await waitState(guest, (s) => s.state === ROOM_STATES.COUNTDOWN);
    await waitEvent(guest, EVENTS.ROOM_START);
    host.disconnect();
    guest.disconnect();
  }));

  // ---- disconnect / grace / token rejoin --------------------------------------
  test('mid-game drop → reconnecting + peer notified; token rejoin restores seat', M(async (port) => {
    const { host, guest, code, guestSeat } = await seatRoom(port);
    await bothReady({ host, guest });
    const peerLeft = waitEvent(host, EVENTS.ROOM_PEER_LEFT);
    const reconnectingP = waitState(host, (s) => s.state === ROOM_STATES.RECONNECTING);
    guest.disconnect();
    const left = await peerLeft;
    assert.equal(left.role, 'guest');
    assert.ok(left.graceMs >= 500);
    const rec = await reconnectingP;
    assert.equal(rec.players.guest.connected, false);
    assert.equal(rec.players.guest.char, CHARS.WATERGIRL, 'seat (char) is held during grace');

    // Fresh socket, same token → same seat, state restores to playing.
    const guest2 = client(port);
    const playingP = waitState(host, (s) => s.state === ROOM_STATES.PLAYING);
    const rejoinedP = waitEvent(guest2, EVENTS.ROOM_REJOINED);
    const rejoinedAck = await emitAck(guest2, EVENTS.ROOM_REJOIN, { token: guestSeat.token, protocol: PROTOCOL_VERSION });
    assert.ok(rejoinedAck.ok);
    assert.equal(rejoinedAck.char, CHARS.WATERGIRL);
    assert.equal(rejoinedAck.code, code);
    const seatPayload = await rejoinedP;
    assert.equal(seatPayload.role, 'guest');
    await playingP;
    host.disconnect();
    guest2.disconnect();
  }));

  test('rejoin keeps loaded/ready facts (page-reload resume)', M(async (port) => {
    const { host, guest, guestSeat } = await seatRoom(port);
    guest.emit(EVENTS.ROOM_LOAD, { loaded: true });
    guest.emit(EVENTS.ROOM_READY, { ready: true });
    await sleep(80); // let the facts reach the server BEFORE the drop
    guest.disconnect();
    await sleep(80);
    const guest2 = client(port);
    const stateP = waitState(guest2, (s) => s.players.guest?.connected);
    await emitAck(guest2, EVENTS.ROOM_REJOIN, { token: guestSeat.token });
    const state = await stateP;
    assert.equal(state.players.guest.loaded, true, 'facts survive the reconnect');
    assert.equal(state.players.guest.ready, true);
    host.disconnect();
    guest2.disconnect();
  }));

  test('duplicate tab: newest connection takes the seat, old one gets an explicit error', M(async (port) => {
    const { host, guest, code, guestSeat } = await seatRoom(port);
    const dupError = waitEvent(guest, EVENTS.ROOM_ERROR);
    const dup = client(port);
    const dupStateP = waitState(dup, (s) => s.players.guest?.connected);
    const ack = await emitAck(dup, EVENTS.ROOM_REJOIN, { token: guestSeat.token });
    assert.ok(ack.ok);
    const err = await dupError;
    assert.equal(err.code, ROOM_ERRORS.DUPLICATE_TAB);
    await dupStateP;
    // The displaced socket's teardown must NOT release the new owner's seat.
    guest.disconnect();
    await sleep(200);
    const room = srv.roomManager.rooms.get(code);
    assert.ok(room, 'room alive');
    assert.equal(room.players.guest.connected, true, 'seat unaffected by displaced socket');
    assert.equal(room.players.guest.socketId, dup.id, 'seat belongs to the newest connection');
    dup.disconnect();
    host.disconnect();
  }));

  test('bad tokens rejected: garbage, unknown, released seat', M(async (port) => {
    const { host, guest, guestSeat } = await seatRoom(port);
    const stranger = client(port);
    for (const bad of ['short', 'zzzz-not-hex-zzzz-not-hex-zz', `a${'<'.repeat(30)}`]) {
      const ack = await emitAck(stranger, EVENTS.ROOM_REJOIN, { token: bad });
      assert.equal(ack.ok, false, `token ${bad} must fail`);
    }
    const ackUnknown = await emitAck(stranger, EVENTS.ROOM_REJOIN, { token: 'f'.repeat(32) });
    assert.equal(ackUnknown.code, ROOM_ERRORS.BAD_TOKEN);
    // Voluntary leave releases the seat AND its token.
    guest.emit(EVENTS.ROOM_LEAVE);
    await sleep(100);
    const ackGone = await emitAck(stranger, EVENTS.ROOM_REJOIN, { token: guestSeat.token });
    assert.equal(ackGone.code, ROOM_ERRORS.BAD_TOKEN);
    stranger.disconnect();
    host.disconnect();
  }));

  test('grace expiry frees the guest seat: slot refillable by a new player', M(async (port) => {
    const { host, guest, code } = await seatRoom(port);
    guest.disconnect();
    await waitState(host, (s) => s.players.guest === null, GRACE_MS + 2500);
    const fresh = client(port);
    const ack = await emitAck(fresh, EVENTS.ROOM_JOIN, { code });
    assert.ok(ack.ok, 'freed slot must be joinable');
    fresh.disconnect();
    host.disconnect();
  }));

  test('host grace expiry closes the room (peer informed, rooms cleaned)', M(async (port, srv) => {
    const { host, guest, code } = await seatRoom(port);
    const closed = waitEvent(guest, EVENTS.ROOM_CLOSED, GRACE_MS + 4000);
    host.disconnect();
    await sleep(150);
    assert.ok(srv.roomManager.rooms.has(code), 'room survives the grace window');
    const payload = await closed;
    assert.equal(payload.reason, 'host-timeout');
    assert.ok(!srv.roomManager.rooms.has(code), 'room destroyed after close');
    guest.disconnect();
  }));

  test('voluntary host leave closes the room; guest leave frees the seat', M(async (port) => {
    const a = await seatRoom(port);
    a.guest.emit(EVENTS.ROOM_LEAVE);
    await waitState(a.host, (s) => s.players.guest === null);
    a.host.disconnect();
    a.guest.disconnect();
    const b = await seatRoom(port);
    const closed = waitEvent(b.guest, EVENTS.ROOM_CLOSED);
    b.host.emit(EVENTS.ROOM_LEAVE);
    const payload = await closed;
    assert.equal(payload.reason, 'host-left');
    b.guest.disconnect();
  }));

  test('input frames flow again while paused (relay states include paused)', M(async (port) => {
    const { host, guest } = await seatRoom(port);
    await bothReady({ host, guest });
    host.emit(EVENTS.GAME_STATUS, { phase: 'level', paused: true });
    await waitState(guest, (s) => s.state === ROOM_STATES.PAUSED);
    guest.emit(EVENTS.INPUT_FRAME, { up: false, left: true, right: false, seq: 9 });
    const frame = await waitEvent(host, EVENTS.INPUT_FRAME);
    assert.equal(frame.left, true);
    host.disconnect();
    guest.disconnect();
  }));

  // ---- cleanup ----------------------------------------------------------------
  test('empty-room TTL destroys an unfilled room', M(async (port) => {
    const host = client(port);
    const closed = waitEvent(host, EVENTS.ROOM_CLOSED, EMPTY_TTL_MS + 3000);
    await emitAck(host, EVENTS.ROOM_CREATE, { game: '1-forest-temple' });
    const payload = await closed;
    assert.equal(payload.reason, 'expired');
    host.disconnect();
  }));

  await run();

  // =========================================================================
  // Dedicated server for rate limiting + capacity (tight budgets would
  // interfere with the shared instance above).
  try {
    const rateServer = await startServer({ rateLimits: { createMax: 2, joinMax: 2, latencyMax: 2 } });
    const rport = rateServer.port;
    const c1 = client(rport);
    const c2 = client(rport);
    const c3 = client(rport);
    const r1 = await emitAck(c1, EVENTS.ROOM_CREATE, { game: '1-forest-temple' });
    assert.ok(r1.ok);
    const r2 = await emitAck(c2, EVENTS.ROOM_CREATE, { game: '1-forest-temple' });
    assert.ok(r2.ok);
    const r3 = await emitAck(c3, EVENTS.ROOM_CREATE, { game: '1-forest-temple' });
    assert.equal(r3.ok, false);
    assert.equal(r3.code, ROOM_ERRORS.RATE_LIMITED, 'third create is rate limited');
    console.log('  ok - rate limit: third create rejected');

    const j1 = await emitAck(c3, EVENTS.ROOM_JOIN, { code: r1.code });
    assert.ok(j1.ok, 'first join ok (budget 1/2)');
    const c4 = client(rport);
    const j2 = await emitAck(c4, EVENTS.ROOM_JOIN, { code: r2.code });
    assert.ok(j2.ok, 'second join ok (budget 2/2)');
    const c5 = client(rport);
    const j3 = await emitAck(c5, EVENTS.ROOM_JOIN, { code: r2.code });
    assert.equal(j3.ok, false);
    assert.equal(j3.code, ROOM_ERRORS.RATE_LIMITED, 'join budget exhausted');
    console.log('  ok - rate limit: join over budget rejected');
    c1.disconnect();
    c2.disconnect();
    c3.disconnect();
    c4.disconnect();
    c5.disconnect();
    await rateServer.stop();
  } catch (err) {
    failures.push({ name: 'rate limiting', err });
    console.error('  FAIL - rate limiting ::', err.message);
  }

  try {
    const cap = await startServer({ maxRooms: 1 });
    const a = client(cap.port);
    const b = client(cap.port);
    const first = await emitAck(a, EVENTS.ROOM_CREATE, { game: '1-forest-temple' });
    assert.ok(first.ok);
    const second = await emitAck(b, EVENTS.ROOM_CREATE, { game: '1-forest-temple' });
    assert.equal(second.code, ROOM_ERRORS.SERVER_BUSY);
    console.log('  ok - capacity guard: server-busy beyond maxRooms');
    a.disconnect();
    b.disconnect();
    await cap.stop();
  } catch (err) {
    failures.push({ name: 'capacity guard', err });
    console.error('  FAIL - capacity guard ::', err.message);
  }

  const leaked = srv.roomManager.stats();
  await srv.stop();

  console.log(`\nroom stats after suite: ${JSON.stringify(leaked)}`);
  console.log(failures.length === 0 ? '\nALL ROOM TESTS PASSED' : `\n${failures.length} FAILURES`);
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
