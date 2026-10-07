/**
 * Lobby multiplayer module (served at / on the Node server).
 *
 * The lobby is where rooms live BEFORE the game: create (pick game +
 * character), join via share link (`/?room=CODE`, auto-recognized) or by
 * entering the code, ready up, swap roles by mutual consent — then both
 * players tap 进入游戏. The server keeps the room state machine; this
 * module only renders its room:state projections.
 *
 * Reuses the same SocketClient + RoomSession as the game pages, so the
 * seat (token) survives the lobby→game navigation in sessionStorage and
 * the game page transparently rejoins the identical seat.
 *
 * On static-only hosting (GitHub Pages) the socket SDK is unavailable and
 * the section degrades to a hint instead of breaking the page.
 */
import { SocketClient, ConnectionState } from '../multiplayer/net/socketClient.js';
import { RoomSession, ERROR_TEXT } from '../multiplayer/room/roomSession.js';
import { Bus } from '../multiplayer/core/bus.js';

const GAMES = [
  { id: '1-forest-temple', zh: '森林神庙' },
  { id: '2-light-temple', zh: '光明神庙' },
  { id: '3-ice-temple', zh: '寒冰圣殿' },
  { id: '4-crystal-temple', zh: '水晶殿' },
  { id: '5-elements', zh: '元素' },
  { id: '6-fairy-tales', zh: '童话' },
];

const STATE_TEXT = {
  waiting: '等待双方准备',
  ready: '双方已就绪',
  countdown: '即将开始…',
  playing: '游戏进行中',
  paused: '游戏已暂停',
  reconnecting: '对方正在重连…',
  finished: '本关结束，可再来一局',
};

const CHARS = { fb: { icon: '🔥', zh: '火娃' }, wg: { icon: '💧', zh: '水娃' } };

void (async () => {
  const root = document.getElementById('lobby-mp');
  if (!root) return;

  let P;
  try {
    P = await import('/common/protocol/events.mjs');
  } catch {
    root.innerHTML = '<p class="lbp-hint">联机功能需要由 Node 服务器提供（静态托管下不可用）。单机游戏不受影响。</p>';
    return;
  }

  root.innerHTML = `
    <div class="lbp-box">
      <div class="lbp-head">
        <h2>双人联机大厅</h2>
        <button class="lbp-refresh" id="lbp-net-dot" title="连接状态"><span class="lbp-dot"></span></button>
      </div>

      <div class="lbp-view" id="lbp-standalone">
        <p class="lbp-hint">创建房间后把邀请链接发给队友；或直接输入房间码加入。无需注册任何账号。</p>
        <div class="lbp-label">1 · 选择游戏</div>
        <div class="lbp-games" id="lbp-games"></div>
        <div class="lbp-label">2 · 选择角色（默认火娃，进房后可协商交换）</div>
        <div class="lbp-choices" id="lbp-chars"></div>
        <button class="lbp-btn lbp-primary" id="lbp-create">创建房间</button>
        <div class="lbp-divider"></div>
        <div class="lbp-joinrow">
          <input class="lbp-input" id="lbp-code" maxlength="4" placeholder="房间码" inputmode="latin" autocapitalize="characters" autocomplete="off">
          <button class="lbp-btn" id="lbp-join">加入房间</button>
        </div>
      </div>

      <div class="lbp-view" id="lbp-seated" style="display:none">
        <div class="lbp-codewrap">
          <div class="lbp-code" id="lbp-room-code"></div>
          <div class="lbp-game-picked" id="lbp-game-picked"></div>
          <div class="lbp-state" id="lbp-room-state"></div>
        </div>
        <div class="lbp-invite">
          <input class="lbp-input lbp-url" id="lbp-url" readonly>
          <button class="lbp-btn lbp-small" id="lbp-copy">复制</button>
          <button class="lbp-btn lbp-small" id="lbp-share">分享</button>
        </div>
        <div class="lbp-slots" id="lbp-slots"></div>
        <div class="lbp-btnrow">
          <button class="lbp-btn" id="lbp-ready">准备</button>
          <button class="lbp-btn" id="lbp-swap">交换角色</button>
          <button class="lbp-btn lbp-danger" id="lbp-swap-reject" style="display:none">拒绝</button>
        </div>
        <div class="lbp-btnrow">
          <button class="lbp-btn lbp-primary" id="lbp-enter">进入游戏 →</button>
        </div>
        <div class="lbp-btnrow">
          <button class="lbp-btn lbp-ghost" id="lbp-leave">退出房间</button>
        </div>
      </div>

      <div class="lbp-error" id="lbp-error" style="display:none"></div>
    </div>
  `;

  const $ = (id) => root.querySelector(`#${id}`);
  const el = {
    dot: $('lbp-net-dot'),
    standalone: $('lbp-standalone'),
    seated: $('lbp-seated'),
    games: $('lbp-games'),
    chars: $('lbp-chars'),
    create: $('lbp-create'),
    join: $('lbp-join'),
    code: $('lbp-code'),
    roomCode: $('lbp-room-code'),
    gamePicked: $('lbp-game-picked'),
    roomState: $('lbp-room-state'),
    url: $('lbp-url'),
    copy: $('lbp-copy'),
    share: $('lbp-share'),
    slots: $('lbp-slots'),
    ready: $('lbp-ready'),
    swap: $('lbp-swap'),
    swapReject: $('lbp-swap-reject'),
    enter: $('lbp-enter'),
    leave: $('lbp-leave'),
    error: $('lbp-error'),
  };

  // ---- wiring ----------------------------------------------------------------

  const bus = new Bus();
  const net = new SocketClient(bus, P);
  const session = new RoomSession({ bus, net, P });
  void net.connect();

  let selectedGame = GAMES[0].id;
  let selectedChar = 'fb'; // 创建者默认火娃
  let myLatency = null;
  let errorTimer = null;

  for (const g of GAMES) {
    const btn = document.createElement('button');
    btn.className = 'lbp-game';
    btn.textContent = g.zh;
    btn.dataset.game = g.id;
    btn.addEventListener('click', () => {
      selectedGame = g.id;
      renderGames();
    });
    el.games.appendChild(btn);
  }
  for (const [id, c] of Object.entries(CHARS)) {
    const btn = document.createElement('button');
    btn.className = 'lbp-game';
    btn.textContent = `${c.icon} ${c.zh}`;
    btn.dataset.char = id;
    btn.addEventListener('click', () => {
      selectedChar = id;
      renderChars();
    });
    el.chars.appendChild(btn);
  }
  const renderGames = () => {
    for (const b of el.games.children) b.classList.toggle('lbp-on', b.dataset.game === selectedGame);
  };
  const renderChars = () => {
    for (const b of el.chars.children) b.classList.toggle('lbp-on', b.dataset.char === selectedChar);
  };
  renderGames();
  renderChars();

  el.create.addEventListener('click', () => session.create({ game: selectedGame, char: selectedChar }));
  el.join.addEventListener('click', () => {
    const code = el.code.value.trim().toUpperCase();
    if (code) session.join(code);
    else showError('请输入 4 位房间码');
  });
  el.code.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') el.join.click();
  });
  el.leave.addEventListener('click', () => session.leave('user-leave'));
  el.ready.addEventListener('click', () => {
    const mine = session.state?.players?.[session.role];
    session.setReady(!(mine?.ready ?? false));
  });
  el.swap.addEventListener('click', () => {
    const swap = session.state?.swap;
    if (!swap) return session.swap(P.SWAP_ACTIONS.REQUEST);
    if (swap.from === session.role) return session.swap(P.SWAP_ACTIONS.CANCEL);
    return session.swap(P.SWAP_ACTIONS.ACCEPT);
  });
  el.swapReject.addEventListener('click', () => session.swap(P.SWAP_ACTIONS.DECLINE));
  el.enter.addEventListener('click', () => {
    if (!session.code) return;
    if (!session.game) {
      showError('房间缺少游戏信息，请退出后重建');
      return;
    }
    const url = `/games/${session.game}/?room=${session.code}`;
    window.location.href = url;
  });
  el.copy.addEventListener('click', copyInvite);
  el.share.addEventListener('click', shareInvite);

  async function copyInvite() {
    const url = inviteUrl();
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      showOk('邀请链接已复制');
    } catch {
      el.url.select();
      document.execCommand?.('copy');
      showOk('链接已选中，请手动复制');
    }
  }

  async function shareInvite() {
    const url = inviteUrl();
    if (!url) return;
    const data = { title: '森林冰火人 · 双人联机', text: `房间码 ${session.code}，点链接直接加入：`, url };
    if (navigator.share) {
      try {
        await navigator.share(data);
        return;
      } catch (err) {
        if (err?.name === 'AbortError') return;
      }
    }
    await copyInvite();
  }

  const inviteUrl = () => (session.code ? `${location.origin}/?room=${session.code}` : null);

  // ---- rendering ----------------------------------------------------------------

  function showError(text) {
    el.error.textContent = text;
    el.error.style.display = 'block';
    el.error.classList.remove('lbp-flash');
    void el.error.offsetWidth; // restart animation
    el.error.classList.add('lbp-flash');
    if (errorTimer) clearTimeout(errorTimer);
    errorTimer = setTimeout(() => (el.error.style.display = 'none'), 5000);
  }

  const showOk = (text) => showError(text);

  function render() {
    const seated = Boolean(session.code);
    el.standalone.style.display = seated ? 'none' : '';
    el.seated.style.display = seated ? '' : 'none';
    if (!seated) return;

    el.roomCode.textContent = session.code;
    const state = session.state;
    const selected = GAMES.find((game) => game.id === session.game);
    el.gamePicked.textContent = selected ? `本局游戏：${selected.zh}` : '等待房主选择游戏…';
    el.roomState.textContent = STATE_TEXT[state?.state] ?? state?.state ?? '连接中…';
    el.url.value = inviteUrl() ?? '';

    const role = session.role;
    const peerRole = role === 'host' ? 'guest' : 'host';
    const me = state?.players?.[role];
    const peer = state?.players?.[peerRole] ?? null;
    el.slots.innerHTML = slotHtml(me, true) + slotHtml(peer, false);

    const readyBtn = el.ready;
    readyBtn.textContent = me?.ready ? '取消准备' : '准备';
    readyBtn.classList.toggle('lbp-on', Boolean(me?.ready));

    const swap = state?.swap ?? null;
    if (swap && swap.from !== role) {
      el.swap.textContent = '同意交换';
      el.swap.classList.add('lbp-on');
      el.swapReject.style.display = '';
    } else if (swap && swap.from === role) {
      el.swap.textContent = '取消请求';
      el.swap.classList.add('lbp-on');
      el.swapReject.style.display = 'none';
    } else {
      el.swap.textContent = '交换角色';
      el.swap.classList.remove('lbp-on');
      el.swapReject.style.display = 'none';
    }
    const swapBlocked = state && ['playing', 'paused', 'countdown'].includes(state.state);
    el.swap.disabled = Boolean(swapBlocked);
    el.swapReject.disabled = Boolean(swapBlocked);

    const inGame = state && ['playing', 'paused', 'reconnecting'].includes(state.state);
    el.enter.textContent = inGame ? '回到游戏 →' : '进入游戏 →';
  }

  function slotHtml(player, mine) {
    if (!player) {
      return `
        <div class="lbp-slot">
          <div class="lbp-slot-head"><span class="lbp-slot-char">— 空位</span></div>
          <div class="lbp-slot-line lbp-dim">等待玩家加入…</div>
        </div>`;
    }
    const c = CHARS[player.char] ?? { icon: '', zh: player.char };
    const online = player.connected
      ? '<span class="lbp-dot lbp-dot-on"></span>在线'
      : '<span class="lbp-dot lbp-dot-off"></span>重连中';
    const latency = mine
      ? myLatency != null
        ? `${myLatency}ms`
        : '…'
      : player.latencyMs != null
        ? `${player.latencyMs}ms`
        : '—';
    return `
      <div class="lbp-slot${mine ? ' lbp-me' : ''}${player.connected ? '' : ' lbp-off'}">
        <div class="lbp-slot-head"><span class="lbp-slot-char">${c.icon} ${c.zh}</span><span class="lbp-you">${mine ? '你' : '对方'}</span></div>
        <div class="lbp-slot-line">${online}</div>
        <div class="lbp-slot-line">${player.ready ? '✓ 已准备' : '未准备'} · ${latency}</div>
      </div>`;
  }

  // ---- bus → UI ------------------------------------------------------------------

  bus.on('session:joined', () => render());
  bus.on('session:left', () => render());
  bus.on('session:peer', () => render());
  bus.on('room:state', () => render());
  bus.on('session:error', (err) => showError(err?.friendly ?? err?.message ?? '联机错误'));

  bus.on('room:countdown', ({ startAt, serverNow }) => {
    const offset = serverNow - Date.now();
    const renderTick = () => {
      if (!session.code || session.state?.state !== 'countdown') return;
      const remaining = startAt - (Date.now() + offset);
      el.roomState.textContent = remaining > 0 ? `即将开始 ${Math.ceil(remaining / 1000)}…` : '开始！';
      setTimeout(renderTick, 150);
    };
    renderTick();
  });

  bus.on('room:start', () => {
    // Both players are on game pages in the normal flow; if the countdown
    // fired while someone is still in the lobby, bring them in.
    if (session.code && session.game && session.state?.state === 'playing') {
      window.location.href = `/games/${session.game}/?room=${session.code}`;
    }
  });

  bus.on('net:state', (state) => {
    el.dot.classList.toggle('lbp-bad', state === ConnectionState.DISCONNECTED || state === ConnectionState.SDK_UNAVAILABLE);
    el.dot.classList.toggle('lbp-warn', state === ConnectionState.CONNECTING || state === ConnectionState.LOADING_SDK);
    if (state === ConnectionState.SDK_UNAVAILABLE) {
      showError('无法连接联机服务器（需要由 Node 服务器托管本页面）');
    }
  });

  net.onLatency = (ms) => {
    myLatency = ms;
    if (session.code) net.emit(P.EVENTS.NET_LATENCY, { ms });
    render();
  };

  // ---- auto-join from ?room=CODE --------------------------------------------

  const urlCode = new URLSearchParams(location.search).get('room');
  const initial = () => {
    if (net.state !== ConnectionState.CONNECTED) return setTimeout(initial, 120);
    if (urlCode) session.resumeOrJoin(urlCode);
  };
  initial();

  loggerReady();
  function loggerReady() {
    console.info('[lobby] multiplayer lobby ready');
  }

  window.__lobbyState = () => ({
    net: net.state,
    code: session.code,
    role: session.role,
    char: session.char,
    game: session.game,
    state: session.state,
    latency: myLatency,
  });
})();
