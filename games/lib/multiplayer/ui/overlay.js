/**
 * Multiplayer overlay UI: the floating chip, the room panel (create/join +
 * live room status), the synchronized-countdown layer, the guest video
 * layer and status banners. Owns all DOM the player sees; logic stays in
 * main.js/roomSession — this module only renders state and forwards taps.
 *
 * Everything is sized for phones first (large touch targets, no hover
 * dependencies, safe-area aware).
 */
import { CHAR_LABELS } from '../input/keys.js';
import { STYLES } from './styles.js';

const STATE_TEXT = {
  waiting: '等待双方准备',
  ready: '双方已就绪',
  countdown: '即将开始…',
  playing: '游戏进行中',
  paused: '游戏已暂停',
  reconnecting: '对方正在重连…',
  finished: '本关结束，可再来一局',
};

export class Overlay {
  constructor({ bus, mount }) {
    this.bus = bus;
    this.root = document.createElement('div');
    this.root.className = 'mp-root';
    mount.appendChild(this.root);

    this.handlers = {}; // main.js: onCreate(char,game), onJoin(code), onLeave, onReady(bool), onSwap(action), onCopyLink(), onShare(), onClosePanel()
    this.sessionInfo = null; // { code, role, char, game, peerConnected }
    this.roomState = null; // latest room:state projection
    this.countdownTimer = null;
    this.selectedChar = 'fb';

    this.#injectStyles();
    this.#buildChip();
    this.#buildPanel();
    this.#buildCountdown();
    this.#buildVideo();
    this.#buildBanner();

    bus.on('session:joined', () => this.#renderSession());
    bus.on('session:left', () => this.#renderSession());
    bus.on('session:peer', () => this.#renderSession());
    bus.on('session:error', (err) => this.banner(err?.friendly ?? err?.message ?? '联机错误', 4500));
    bus.on('room:state', () => this.#renderSession());
    bus.on('net:state', () => this.#renderNetState());
    bus.on('host:status', () => this.#renderHostStatus());
    bus.on('video:started', () => document.body.classList.add('mp-guest-active'));
    bus.on('video:stopped', () => document.body.classList.remove('mp-guest-active'));
  }

  #injectStyles() {
    const style = document.createElement('style');
    style.textContent = STYLES;
    document.head.appendChild(style);
  }

  #buildChip() {
    const chip = document.createElement('div');
    chip.id = 'mp-chip';
    chip.innerHTML = '<span class="mp-dot"></span><span class="mp-label">联机</span>';
    chip.addEventListener('click', () => this.togglePanel());
    this.root.appendChild(chip);
    this.chip = chip;
  }

  #buildPanel() {
    const panel = document.createElement('div');
    panel.id = 'mp-panel';
    panel.style.display = 'none';
    panel.innerHTML = `
      <button class="mp-close" title="关闭">✕</button>
      <h3>双人联机</h3>

      <div class="mp-section mp-section-standalone">
        <div class="mp-hint">同一部游戏页面，两人各控一个角色。建议在大厅创建房间后通过链接邀请队友。</div>
        <div class="mp-choice">
          <button class="mp-btn mp-char" data-char="fb">我玩🔥火娃</button>
          <button class="mp-btn mp-char" data-char="wg">我玩💧水娃</button>
        </div>
        <div class="mp-row"><button id="mp-btn-create" class="mp-btn">创建房间</button></div>
        <div class="mp-joinrow">
          <input class="mp-input" id="mp-input-code" maxlength="4" placeholder="房间号" inputmode="latin" autocapitalize="characters" autocomplete="off">
          <button class="mp-btn" id="mp-btn-join">加入</button>
        </div>
      </div>

      <div class="mp-section mp-section-seated" style="display:none">
        <div class="mp-codewrap">
          <div class="mp-code" id="mp-room-code"></div>
          <div class="mp-state" id="mp-room-state"></div>
        </div>
        <div class="mp-slots" id="mp-slots"></div>
        <div class="mp-row mp-actions">
          <button class="mp-btn" id="mp-btn-ready">准备</button>
          <button class="mp-btn" id="mp-btn-swap">交换角色</button>
        </div>
        <div class="mp-row" id="mp-invite-row">
          <button class="mp-btn" id="mp-btn-copy">复制邀请链接</button>
          <button class="mp-btn" id="mp-btn-share">分享</button>
        </div>
        <div class="mp-row"><button class="mp-btn mp-btn-leave" id="mp-btn-leave">退出联机</button></div>
      </div>
    `;
    this.root.appendChild(panel);
    this.panel = panel;

    panel.querySelector('.mp-close').addEventListener('click', () => {
      this.togglePanel(false);
      this.handlers.onClosePanel?.();
    });
    panel.querySelector('#mp-btn-create').addEventListener('click', () => {
      this.handlers.onCreate?.(this.selectedChar ?? 'fb');
    });
    panel.querySelector('#mp-btn-join').addEventListener('click', () => {
      const code = panel.querySelector('#mp-input-code').value.trim();
      if (code) this.handlers.onJoin?.(code);
    });
    panel.querySelector('#mp-input-code').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') panel.querySelector('#mp-btn-join').click();
    });
    panel.querySelector('#mp-btn-leave').addEventListener('click', () => this.handlers.onLeave?.());
    panel.querySelector('#mp-btn-ready').addEventListener('click', () => this.handlers.onReadyToggle?.());
    panel.querySelector('#mp-btn-swap').addEventListener('click', () => this.handlers.onSwapTap?.());
    panel.querySelector('#mp-btn-copy').addEventListener('click', () => this.handlers.onCopyLink?.());
    panel.querySelector('#mp-btn-share').addEventListener('click', () => this.handlers.onShare?.());
    for (const btn of panel.querySelectorAll('.mp-char')) {
      btn.addEventListener('click', () => this.selectChar(btn.getAttribute('data-char')));
    }
    this.selectChar('fb');
  }

  #buildCountdown() {
    const el = document.createElement('div');
    el.id = 'mp-countdown';
    this.root.appendChild(el);
    this.countdownEl = el;
  }

  #buildVideo() {
    const video = document.createElement('video');
    video.id = 'mp-video';
    video.autoplay = true;
    video.playsInline = true;
    video.muted = false;
    this.root.appendChild(video);
    this.video = video;
  }

  #buildBanner() {
    const banner = document.createElement('div');
    banner.id = 'mp-banner';
    this.root.appendChild(banner);
    this.bannerEl = banner;
    this.bannerTimer = null;
  }

  // ---- state rendering -----------------------------------------------------

  selectChar(char) {
    this.selectedChar = char;
    for (const btn of this.panel.querySelectorAll('.mp-char')) {
      btn.classList.toggle('mp-on', btn.getAttribute('data-char') === char);
    }
  }

  togglePanel(force) {
    const show = force ?? this.panel.style.display === 'none';
    this.panel.style.display = show ? '' : 'none';
    if (show) this.#renderSession();
  }

  banner(text, ms = 0) {
    this.bannerEl.textContent = text;
    this.bannerEl.style.display = text ? 'block' : 'none';
    if (this.bannerTimer) clearTimeout(this.bannerTimer);
    if (text && ms) {
      this.bannerTimer = setTimeout(() => (this.bannerEl.style.display = 'none'), ms);
    }
  }

  /**
   * Synchronized countdown driven by the SERVER's startAt. The session owns
   * the clock math (serverNow - clientNow offset); main.js passes a closure
   * returning remaining ms (or null once finished) so this overlay stays
   * clock-agnostic. Renders 3…2…1 then a short GO!.
   */
  startCountdownClock(getRemainingMs) {
    this.hideCountdown();
    const render = () => {
      const remaining = getRemainingMs();
      if (remaining == null) {
        this.hideCountdown();
        return;
      }
      const label = remaining > 0 ? String(Math.ceil(remaining / 1000)) : 'GO!';
      this.countdownEl.textContent = label;
      this.countdownEl.style.display = 'block';
      if (remaining <= -600) {
        this.hideCountdown();
        return;
      }
      this.countdownTimer = setTimeout(render, 100);
    };
    render();
  }

  hideCountdown() {
    if (this.countdownTimer) clearTimeout(this.countdownTimer);
    this.countdownTimer = null;
    this.countdownEl.style.display = 'none';
  }

  setNetState(state, latencyMs) {
    this.netState = state;
    this.latency = latencyMs ?? this.latency;
    this.#renderNetState();
    this.#renderSession();
  }

  #renderNetState() {
    const label = this.chip.querySelector('.mp-label');
    const state = this.netState ?? 'disconnected';
    this.chip.setAttribute('data-state', state === 'connected' ? 'connected' : state === 'connecting' || state === 'loading-sdk' ? 'connecting' : 'disconnected');
    if (this.sessionInfo && this.roomState) {
      const st = this.roomState.state;
      const ping = this.latency != null ? ` · ${this.latency}ms` : '';
      label.textContent = `${STATE_TEXT[st] ?? st}${ping}`;
    } else {
      label.textContent = '联机';
    }
  }

  #slotHtml(player, mine, myLatency) {
    if (!player) {
      return `
        <div class="mp-slot">
          <div class="mp-slot-head"><span class="mp-slot-char">—</span></div>
          <div class="mp-slot-line mp-dim">等待玩家…</div>
          <div class="mp-slot-line mp-dim">邀请链接可分享</div>
        </div>`;
    }
    const label = CHAR_LABELS[player.char] ?? { zh: player.char, en: player.char };
    const icon = player.char === 'fb' ? '🔥' : '💧';
    const online = player.connected
      ? '<span class="mp-dot mp-dot-on"></span>在线'
      : '<span class="mp-dot mp-dot-off"></span>重连中';
    const latency = mine
      ? myLatency != null ? `${myLatency}ms` : '…'
      : player.latencyMs != null
        ? `${player.latencyMs}ms`
        : '—';
    const ready = player.ready ? '✓ 已准备' : '未准备';
    return `
      <div class="mp-slot${mine ? ' mp-slot-me' : ''}${player.connected ? '' : ' mp-slot-off'}">
        <div class="mp-slot-head"><span class="mp-slot-char">${icon} ${label.zh}</span><span class="mp-slot-you">${mine ? '你' : '对方'}</span></div>
        <div class="mp-slot-line">${online}</div>
        <div class="mp-slot-line">${ready} · ${latency}</div>
      </div>`;
  }

  #renderSession() {
    const seated = Boolean(this.sessionInfo?.code);
    this.panel.querySelector('.mp-section-standalone').style.display = seated ? 'none' : '';
    this.panel.querySelector('.mp-section-seated').style.display = seated ? '' : 'none';
    if (!seated) return;

    const { code, role, char } = this.sessionInfo;
    const state = this.roomState;
    this.panel.querySelector('#mp-room-code').textContent = code;

    const stateText = STATE_TEXT[state?.state] ?? state?.state ?? '…';
    this.panel.querySelector('#mp-room-state').textContent = stateText;

    // Player slots (fallback when no room:state yet).
    const me = state?.players?.[role] ?? { char, connected: true, ready: false, latencyMs: null };
    const peerRole = role === 'host' ? 'guest' : 'host';
    const peer = state?.players?.[peerRole] ?? null;
    this.panel.querySelector('#mp-slots').innerHTML =
      this.#slotHtml(me, true, this.latency) + this.#slotHtml(peer, false, null);

    // Ready button reflects my flag.
    const readyBtn = this.panel.querySelector('#mp-btn-ready');
    readyBtn.textContent = me.ready ? '取消准备' : '准备';
    readyBtn.classList.toggle('mp-btn-on', Boolean(me.ready));

    // Swap button reflects the offer situation.
    const swapBtn = this.panel.querySelector('#mp-btn-swap');
    const swap = state?.swap ?? null;
    if (swap && swap.from !== role) {
      swapBtn.textContent = '同意交换';
    } else if (swap && swap.from === role) {
      swapBtn.textContent = '取消交换请求';
    } else {
      swapBtn.textContent = '交换角色';
    }
    swapBtn.disabled = Boolean(state && (state.state === 'playing' || state.state === 'paused' || state.state === 'countdown'));

    // Invite row: the HOST shares the room; the guest sees a hint instead.
    const inviteRow = this.panel.querySelector('#mp-invite-row');
    if (role === 'host') {
      inviteRow.style.display = '';
      const url = this.inviteUrl?.();
      inviteRow.title = url ?? '';
    } else {
      inviteRow.style.display = 'none';
    }
    this.#renderNetState();
  }

  #renderHostStatus() {
    // Guest: reflect host phase in the banner while the room is live.
    const status = this.hostStatus;
    if (!this.sessionInfo || this.sessionInfo.role !== 'guest') return;
    if (!status) return;
    if (status.phase === 'level' && !status.paused) {
      this.banner('', 0);
    } else if (status.phase === 'level' && status.paused) {
      this.banner('游戏已暂停（房主）');
    } else if (status.phase === 'menu' || status.phase === 'level-menu') {
      this.banner('房主在菜单中选择关卡…');
    } else if (status.phase === 'end') {
      this.banner('本关结束');
    }
  }

  // ---- called by main.js to push state in -----------------------------------

  setSessionInfo(info) {
    this.sessionInfo = info; // { code, role, char, game, peerConnected } | null
    if (!info) {
      this.roomState = null;
      this.hideCountdown();
    }
    this.#renderSession();
  }

  setRoomState(state) {
    this.roomState = state;
    this.#renderSession();
  }

  setInviteUrl(fn) {
    this.inviteUrl = fn;
  }

  setHostStatus(status) {
    this.hostStatus = status;
    this.#renderHostStatus();
  }

  showGuestVideo() {
    document.body.classList.add('mp-guest-active');
  }
}
