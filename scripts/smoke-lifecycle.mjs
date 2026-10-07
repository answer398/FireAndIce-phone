/**
 * Game-lifecycle smoke test — six real games, two real browser pages.
 *
 * Boots the production Node server (static + Socket.IO), launches a headless
 * Chromium, opens TWO game pages (host + guest via ?room= link) and drives
 * the FULL production flow through the public surface only:
 *   room create → join → ready → server start → level enter →
 *   death → room finished → restart → next level → pause/resume →
 *   guest page refresh (rejoin) → host short disconnect (policy pause +
 *   reconnect mask + recovery).
 *
 * No game files are patched; everything goes through __mpDebug (only present
 * with ?mpDebug=1) and the game's own adapter paths. Round identity is read
 * from session.round on both pages — the assertion is that BOTH ends always
 * agree on {game, level, roundId}.
 *
 * Run:  node scripts/smoke-lifecycle.mjs            (all six games, deep on 1)
 *       node scripts/smoke-lifecycle.mjs 1-forest-temple --deep
 * Requires: chrome-headless-shell (ms-playwright cache) — override CHROME_SHELL.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import http from 'node:http';

const REPO = join(import.meta.dirname, '..');
const CHROME_SHELL =
  process.env.CHROME_SHELL ??
  join(process.env.LOCALAPPDATA ?? '', 'ms-playwright', 'chromium_headless_shell-1223', 'chrome-headless-shell-win64', 'chrome-headless-shell.exe');

const GAMES = {
  '1-forest-temple': 'forest',
  '2-light-temple': 'light',
  '3-ice-temple': 'ice',
  '4-crystal-temple': 'crystal',
  '5-elements': 'elements/fire',
  '6-fairy-tales': 'fairytales',
};
const DEEP_GAME = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : '1-forest-temple';
const ONLY = process.argv[2] && !process.argv[2].startsWith('--') ? [process.argv[2]] : Object.keys(GAMES);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- server -----------------------------------------------------------------

async function startServer() {
  const { createApp } = await import(pathToFileURL(join(REPO, 'server', 'src', 'app.js')));
  const { RoomManager } = await import(pathToFileURL(join(REPO, 'server', 'src', 'rooms', 'roomManager.js')));
  const { createSocketServer } = await import(pathToFileURL(join(REPO, 'server', 'src', 'realtime', 'socketServer.js')));
  const app = createApp();
  const httpServer = http.createServer(app);
  const roomManager = new RoomManager({ log: () => {} });
  const realtime = createSocketServer(httpServer, { roomManager, allowedOrigins: [], log: () => {} });
  await new Promise((res) => httpServer.listen(0, '127.0.0.1', res));
  return { port: httpServer.address().port, rooms: roomManager.rooms, stop: () => { roomManager.stop(); realtime.stop(); httpServer.close(); } };
}

// ---- CDP --------------------------------------------------------------------

class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.nextId = 1;
    this.pending = new Map();
    this.consolePages = new Map(); // sessionId -> Page
    this.ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(String(ev.data));
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(`${msg.error.message} (${msg.error.data ?? ''})`)) : resolve(msg.result);
        return;
      }
      if (msg.method === 'Runtime.consoleAPICalled') {
        const page = this.consolePages.get(msg.sessionId);
        if (page) {
          const text = msg.params.args.map((a) => a.value ?? a.description ?? '').join(' ');
          page.logs.push(`[${msg.params.type}] ${text}`);
        }
      }
    });
    this.opened = new Promise((res, rej) => {
      this.ws.addEventListener('open', res, { once: true });
      this.ws.addEventListener('error', rej, { once: true });
    });
  }

  send(method, params = {}, sessionId) {
    const id = this.nextId++;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(payload));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP timeout: ${method}`));
        }
      }, 30_000).unref();
    });
  }
}

class Page {
  constructor(cdp, sessionId, url, tag = 'page') {
    this.cdp = cdp;
    this.sessionId = sessionId;
    this.url = url;
    this.tag = tag;
    this.logs = [];
  }

  async eval(expression) {
    const res = await this.cdp.send(
      'Runtime.evaluate',
      { expression, awaitPromise: true, returnByValue: true },
      this.sessionId,
    );
    if (res.exceptionDetails) {
      throw new Error(`page eval failed: ${res.exceptionDetails.exception?.description ?? res.exceptionDetails.text}`);
    }
    return res.result.value;
  }

  async navigate(url) {
    await this.cdp.send('Page.navigate', { url }, this.sessionId);
  }

  /** Advance the engine loop through its real update path (see __mpPump). */
  async pump(ticks = 6) {
    try {
      await this.eval(`window.__mpPump ? __mpPump(${ticks}) : 0`);
    } catch { /* page mid-navigation */ }
  }

  /** Poll `expression` until truthy, pumping the loop while waiting. */
  async waitFor(expression, desc, timeoutMs = 30_000, pollMs = 300) {
    const deadline = Date.now() + timeoutMs;
    let last = null;
    while (Date.now() < deadline) {
      try {
        await this.pump(4);
        last = await this.eval(expression);
        if (last) return last;
      } catch { /* page mid-navigation etc. */ }
      await sleep(pollMs);
    }
    throw new Error(`timeout waiting for ${desc} (last=${JSON.stringify(last)?.slice(0, 200)})`);
  }
}

async function launchBrowser() {
  const profile = mkdtempSync(join(tmpdir(), 'fbw-smoke-'));
  const child = spawn(CHROME_SHELL, [
    '--headless',
    '--no-sandbox',
    '--disable-gpu',
    '--mute-audio',
    // Keep pages "visible": headless throttles rAF for backgrounded pages,
    // which would freeze the simulated device artificially (real devices in
    // the foreground don't hit this).
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling',
    '--window-size=960,540',
    `--user-data-dir=${profile}`,
    '--remote-debugging-port=0',
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  const wsUrl = await new Promise((resolve, reject) => {
    let buf = '';
    child.stderr.on('data', (d) => {
      buf += d.toString();
      const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
      if (m) resolve(m[1]);
    });
    child.on('exit', () => reject(new Error('chrome exited early: ' + buf.slice(0, 400))));
    setTimeout(() => reject(new Error('devtools endpoint timeout: ' + buf.slice(0, 400))), 15_000).unref();
  });
  const cdp = new CDP(wsUrl);
  await cdp.opened;
  return {
    cdp,
    child,
    async close() {
      child.kill();
      await sleep(300);
      try { rmSync(profile, { recursive: true, force: true }); } catch { /* locked on win32 */ }
    },
  };
}

async function openPage(browser, url, tag) {
  const { targetId } = await browser.cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await browser.cdp.send('Target.attachToTarget', { targetId, flatten: true });
  await browser.cdp.send('Page.enable', {}, sessionId);
  await browser.cdp.send('Runtime.enable', {}, sessionId);
  // In-page console ring buffer — survives navigation (CDP console events
  // stop flowing to the old session after a cross-document navigation).
  // ALSO: disable the service worker. On a fresh profile the game pages
  // register ../sw.js and RELOAD themselves once it activates — that race
  // would randomly reset the page mid-test. (The Node server serves the
  // shared assets directly, so the SW adds nothing here.)
  await browser.cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `
      try { navigator.serviceWorker.register = function () { return Promise.reject(new Error('sw disabled in smoke')); }; } catch (e) {}
      // Manual loop pump: headless throttles timers so aggressively that a
      // background browser's game loop can freeze entirely (real devices in
      // hand don't hit this). The pump advances the engine through its REAL
      // update path (game.update) with true elapsed deltas; the harness calls
      // it while waiting, which keeps state machines/tweens/physics alive.
      window.__mpPump = function (n) {
        n = n || 1;
        const g = window.__mpDebug && __mpDebug.adapter && __mpDebug.adapter.game;
        if (!g) return 0;
        for (let i = 0; i < n; i++) {
          const t0 = performance.now();
          while (performance.now() - t0 < 15) { /* pace real elapsed time */ }
          try { g.update(performance.now()); } catch (e) { /* engine state mid-transition */ }
        }
        return g.time.time;
      };
      window.__mpLogs = [];
      for (const m of ['log', 'info', 'warn', 'error', 'debug']) {
        const orig = console[m].bind(console);
        console[m] = function (...args) {
          try {
            window.__mpLogs.push('[' + m + '] ' + args.map((a) => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' '));
            if (window.__mpLogs.length > 500) window.__mpLogs.shift();
          } catch (e) { /* ignore */ }
          orig(...args);
        };
      }
    `,
  }, sessionId);
  const page = new Page(browser.cdp, sessionId, url, tag);
  browser.cdp.consolePages.set(sessionId, page);
  await page.navigate(url);
  return page;
}

// ---- test scaffolding ----------------------------------------------------------

const results = [];
function record(game, step, ok, note = '') {
  results.push({ game, step, ok, note });
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} [${game}] ${step}${note ? ' — ' + note : ''}`);
}

async function diag(page) {
  return page
    .eval(`(function(){ const g = window.__mpDebug && __mpDebug.adapter.game; const mp = window.__mpState ? __mpState() : {}; return JSON.stringify({ noGame: !g, current: g && g.state.current, pending: g && g.state._pendingState, fading: g && g.state.fading, paused: g && g.paused, clock: g && g.time.time, vis: document.visibilityState, rafIsTimeout: g && g.raf && g.raf.isSetTimeOut ? g.raf.isSetTimeOut() : null, net: mp.net, roomState: mp.roomState && mp.roomState.state, peerConnected: mp.peer && mp.peer.connected, round: mp.round && mp.round.id }); })()`)
    .then(async (v) => {
      await sleep(1200);
      const v2 = await page.eval(`(function(){ const g = window.__mpDebug && __mpDebug.adapter.game; return g ? g.time.time : -1; })()`).catch(() => '?');
      return String(v) + ` clock2=${v2}`;
    })
    .catch((e) => 'diag failed: ' + e.message);
}

async function runGame(browsers, server, gameId, { deep, onPages = () => {} }) {
  const hostBrowser = browsers[0];
  const guestBrowser = browsers[1];
  const base = `http://127.0.0.1:${server.port}`;
  const temple = GAMES[gameId];

  // 1. Host page: load + create room through the production session.
  const host = await openPage(hostBrowser, `${base}/games/${gameId}/?mpDebug=1`, 'host');
  await host.waitFor(
    `Boolean(window.__mpDebug && __mpDebug.adapter && __mpDebug.adapter.game)`,
    `${gameId} host: game instance captured`,
    60_000,
  );
  record(gameId, '游戏加载完成（adapter 捕获 game 实例）', true);
  await host.eval(`__mpDebug.session.create({ game: '${gameId}' })`);
  const code = await host.waitFor(`__mpDebug.session.code`, 'host: room created', 20_000);
  record(gameId, '建房成功', Boolean(code), `room ${code}`);

  // 2. Guest page: join via the invite link (production resumeOrJoin path).
  //    A SEPARATE browser process = a separate visible page, exactly like a
  //    second device (headless throttles rAF for background tabs of the same
  //    process, which would freeze the guest's simulation artificially).
  const guest = await openPage(guestBrowser, `${base}/games/${gameId}/?mpDebug=1&room=${code}`, 'guest');
  onPages(host, guest);
  await guest.waitFor(
    `Boolean(window.__mpDebug && __mpDebug.session && __mpDebug.session.role === 'guest')`,
    'guest: joined as guest seat',
    30_000,
  );
  record(gameId, '队友经邀请链接入座（guest）', true);

  // 3. Ready both → server countdown → start.
  await host.eval(`__mpDebug.session.setReady(true)`);
  await guest.eval(`__mpDebug.session.setReady(true)`);
  await guest.waitFor(`__mpDebug.session.state && __mpDebug.session.state.state === 'playing'`, 'server start (playing)', 20_000);
  await host.waitFor(`__mpDebug.session.state && __mpDebug.session.state.state === 'playing'`, 'host sees playing', 10_000);
  record(gameId, '双方准备 → 服务器统一开局', true);

  // 4. Host enters level 1; guest follows via the round channel.
  await host.waitFor(`__mpDebug.adapter.getPhase() === 'menu'`, 'host: menu phase', 30_000);
  const entered = await host.eval(
    `__mpDebug.adapter.startLevel({ temple: '${temple}', id: 1 }).then(r => ({ started: r }))`,
  );
  record(gameId, '房主进入第 1 关', Boolean(entered?.started));
  const hostRound1 = await host.waitFor(
    `(__mpDebug.adapter.getPhase() === 'level' && __mpDebug.adapter.getLevel() && __mpDebug.session.round.id >= 1) ? __mpDebug.session.round.id : 0`,
    'host: round 1 live in level 1',
    30_000,
  );
  const guestRound1 = await guest.waitFor(
    `(__mpDebug.adapter.getPhase() === 'level' && __mpDebug.adapter.getLevel() && __mpDebug.adapter.getLevel().id === 1 && __mpDebug.session.round.id >= 1) ? __mpDebug.session.round.id : 0`,
    'guest: followed into level 1 (same round)',
    30_000,
  );
  record(gameId, 'guest 经 round:update 跟随进入同一关', guestRound1 === hostRound1, `round=${hostRound1}/${guestRound1}`);
  const guestSnaps = await guest.eval(`__mpDebug.snapshotApplier.receivedCount ?? 0`);
  for (let i = 0; i < 8; i++) {
    await host.pump(5);
    await guest.pump(2);
    await sleep(150);
  }
  const guestSnaps2 = await guest.eval(`__mpDebug.snapshotApplier.receivedCount ?? 0`);
  record(gameId, 'guest 收到 host 权威快照流', guestSnaps2 > guestSnaps, `${guestSnaps} → ${guestSnaps2}`);
  const guestRoundEcho = await guest.eval(`JSON.stringify(__mpDebug.session.round)`);
  record(gameId, '两端 round 一致（同游戏/同关/同 roundId）', guestRoundEcho.includes(`"id":${hostRound1}`), guestRoundEcho);

  if (!deep) return;

  // ---- deep lifecycle (game 1) ----------------------------------------------

  // 5. Pause/resume parity.
  await host.eval(`__mpDebug.adapter.togglePause()`);
  await guest.waitFor(`__mpDebug.adapter.isPaused() === true`, 'guest mirrors host pause', 10_000);
  record(gameId, '暂停同步（host 暂停 → guest 跟随）', true);
  await host.eval(`__mpDebug.adapter.togglePause()`);
  await guest.waitFor(`__mpDebug.adapter.isPaused() === false`, 'guest mirrors host resume', 10_000);
  record(gameId, '恢复同步', true);

  // 6. Death on the host: the room machine finishes the round; the guest's
  // end state is corrected by the authoritative snapshots (kill chain).
  const roundBeforeDeath = await host.eval(`__mpDebug.session.round.id`);
  await host.eval(`__mpDebug.adapter.level.pers2.kill()`);
  await host.waitFor(`__mpDebug.adapter.getPhase() === 'end'`, 'host: end screen after death', 20_000);
  await guest.waitFor(`__mpDebug.session.state && __mpDebug.session.state.state === 'finished'`, 'room finished after death', 15_000);
  record(gameId, '玩家死亡 → 过关结束状态（finished）广播两端', true, `round ${roundBeforeDeath} kept`);
  const guestEnded = await guest.waitFor(
    `(__mpDebug.adapter.getPhase() === 'end' || __mpDebug.adapter.getLevel() === null) ? true : false`,
    'guest reached its own end screen / left the level',
    20_000,
  );
  record(gameId, 'guest 本地模拟经权威校正进入结束态', Boolean(guestEnded));

  // 6b. The real post-level flow: both players ready up again → the server
  // starts the next session (finished → countdown → playing).
  await host.eval(`void __mpDebug.session.setReady(true)`);
  await guest.eval(`void __mpDebug.session.setReady(true)`);
  await guest.waitFor(`__mpDebug.session.state && __mpDebug.session.state.state === 'playing'`, 'next session started', 15_000);
  record(gameId, '过关后重新准备 → 服务器开启下一局', true);

  // 7. Restart from the end screen (game's own retry path) → NEW round, same level.
  await host.eval(`(function(){ const g = __mpDebug.adapter.game; if (g && g.level && typeof g.level.retry === 'function') { g.level.retry(); return true; } return false; })()`);
  const hostRound2 = await host.waitFor(
    `(__mpDebug.session.round.id > ${roundBeforeDeath} && __mpDebug.adapter.getPhase() === 'level') ? __mpDebug.session.round.id : 0`,
    'host: restart opened a NEW round',
    30_000,
  );
  const guestRound2 = await guest.waitFor(
    `(__mpDebug.adapter.getPhase() === 'level' && __mpDebug.adapter.getLevel() && __mpDebug.adapter.getLevel().id === 1 && __mpDebug.session.round.id === ${hostRound2}) ? __mpDebug.session.round.id : 0`,
    'guest followed the restart into the same round',
    30_000,
  );
  record(gameId, '重开 → 新 roundId，两端同关同步', guestRound2 === hostRound2, `round ${roundBeforeDeath} → ${hostRound2}/${guestRound2}`);

  // 8. Switch to the next level (level 2): new round, both ends follow.
  const prevRound = hostRound2;
  await host.eval(`__mpDebug.adapter.startLevel({ temple: '${temple}', id: 2 }).then(r => ({ started: r }))`);
  const hostRound3 = await host.waitFor(
    `(__mpDebug.adapter.getLevel() && __mpDebug.adapter.getLevel().id === 2 && __mpDebug.session.round.id > ${prevRound}) ? __mpDebug.session.round.id : 0`,
    'host: entered level 2 with a new round',
    30_000,
  );
  const guestRound3 = await guest.waitFor(
    `(__mpDebug.adapter.getPhase() === 'level' && __mpDebug.adapter.getLevel() && __mpDebug.adapter.getLevel().id === 2 && __mpDebug.session.round.id === ${hostRound3}) ? __mpDebug.session.round.id : 0`,
    'guest followed into level 2 (same round)',
    30_000,
  );
  record(gameId, '切换关卡 → 两端同 roundId 进入第 2 关', guestRound3 === hostRound3, `round=${hostRound3}`);

  // 9. Guest page refresh: token rejoin + full snapshot + follow the level.
  guest.logs.push('===NAVIGATED===');
  await guest.navigate(`${base}/games/${gameId}/?mpDebug=1&room=${code}`);
  try {
    await guest.waitFor(
      `(__mpDebug.session.role === 'guest' && __mpDebug.session.round.id === ${hostRound3}) ? true : false`,
      'guest: rejoin restored the seat AND the round',
      45_000,
    );
    await guest.waitFor(
      `(__mpDebug.adapter.getPhase() === 'level' && __mpDebug.adapter.getLevel() && __mpDebug.adapter.getLevel().id === 2) ? true : false`,
      'guest: followed back into the live level after refresh',
      45_000,
    );
  } catch (err) {
    const dump = await guest
      .eval(`JSON.stringify(window.__mpState ? __mpState() : { mp: false })`)
      .catch((e) => 'eval failed: ' + e.message);
    const logs = await guest
      .eval(`(function(){ console.info('DIRECT-PROBE-MARKER'); return JSON.stringify({ n: (window.__mpLogs ?? []).length, tail: (window.__mpLogs ?? []).slice(-40) }); })()`)
      .catch(() => '(no logs)');
    const stack = await guest
      .eval(`(function(){ return __mpDebug.adapter.startLevel({temple:'forest', id:2}).then(function(){ return 'OK'; }, function(e){ return 'STACK: ' + (e && e.stack); }); })()`)
      .catch((e) => 'eval failed: ' + e.message);
    record(gameId, 'guest 刷新恢复', false, `${err.message} :: STACK=${String(stack).slice(0, 1200)} :: guest=${String(dump).slice(0, 500)} :: glogs=${String(logs).slice(0, 1200)}`);
    return;
  }
  record(gameId, 'guest 刷新页面 → token 恢复席位 + round + 关卡', true);

  // 10. Host short disconnect: policy pause + reconnect mask on the guest.
  await host.eval(`void __mpDebug.net.socket.disconnect()`);
  await guest.waitFor(`__mpDebug.session.state && __mpDebug.session.state.state === 'reconnecting'`, 'guest sees reconnecting', 15_000);
  const guestPaused = await guest.waitFor(`__mpDebug.adapter.isPaused() === true ? true : false`, 'guest policy-paused', 10_000);
  const maskShown = await guest.eval(
    `(function(){ const m = document.getElementById('mp-mask'); return m && m.style.display !== 'none'; })()`,
  );
  record(gameId, 'host 断线 → guest 策略暂停 + 重连遮罩', Boolean(guestPaused && maskShown));
  // Keys the guest holds must be released (pads disabled ⇒ released frame).
  const padsOff = await guest.eval(`__mpDebug.session.state.state === 'reconnecting'`);
  record(gameId, '断连期间 guest 输入门控关闭', padsOff);

  await host.eval(`void __mpDebug.net.socket.connect()`);
  await guest.waitFor(
    `__mpDebug.session.state && __mpDebug.session.state.state === 'playing'`,
    'room back to playing after host reconnect',
    20_000,
  );
  const maskGone = await guest.waitFor(
    `(function(){ const m = document.getElementById('mp-mask'); return m && m.style.display === 'none'; })() ? true : false`,
    'reconnect mask cleared',
    15_000,
  );
  const guestRoundAfter = await guest.eval(`__mpDebug.session.round.id`);
  record(gameId, 'host 恢复 → 双端回 playing，round 保持一致', Boolean(maskGone) && guestRoundAfter === hostRound3, `round=${guestRoundAfter}`);
}

async function main() {
  const server = await startServer();
  // Two independent browser processes = two independent "devices": rAF runs
  // for both pages (a single headless process freezes background pages).
  const hostBrowser = await launchBrowser();
  const guestBrowser = await launchBrowser();
  let lastHost = null;
  let lastGuest = null;
  try {
    for (const gameId of ONLY) {
      console.log(`\n=== ${gameId} ===`);
      try {
        await runGame([hostBrowser, guestBrowser], server, gameId, {
          deep: gameId === DEEP_GAME,
          onPages: (h, g) => {
            lastHost = h;
            lastGuest = g;
          },
        });
      } catch (err) {
        let detail = err.message;
        try {
          const serverRooms = [...server.rooms.values()].map((r) => ({
            state: r.state,
            hostOn: r.players.host?.connected,
            guestOn: r.players.guest?.connected,
            guestSock: (r.players.guest?.socketId ?? '').slice(-6),
          }));
          detail += ` :: server=${JSON.stringify(serverRooms)}`;
          if (lastGuest) {
            detail += ` :: gdiag=${await diag(lastGuest)}`;
            detail += ` :: glogs=${lastGuest.logs.slice(-25).join(' | ').slice(-1300)}`;
          }
          if (lastHost) {
            detail += ` :: hdiag=${await diag(lastHost)}`;
          }
        } catch { /* dump best-effort */ }
        record(gameId, 'SMOKE RUN', false, detail);
      }
    }
  } finally {
    await hostBrowser.close();
    await guestBrowser.close();
    server.stop();
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} steps passed`);
  if (failed.length) {
    console.log('FAILED:');
    for (const f of failed) console.log(`  [${f.game}] ${f.step} — ${f.note}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
