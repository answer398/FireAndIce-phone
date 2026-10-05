/**
 * Multiplayer overlay UI: the floating chip, the room panel (create/join),
 * the guest video layer and status banners. Owns all DOM the player sees;
 * logic stays in main.js/roomSession — this module only renders state and
 * forwards clicks.
 */
import { CHAR_LABELS } from '../input/keys.js';
import { STYLES } from './styles.js';

export class Overlay {
  constructor({ bus, mount }) {
    this.bus = bus;
    this.root = document.createElement('div');
    this.root.className = 'mp-root';
    mount.appendChild(this.root);

    this.handlers = {}; // set by main.js: onCreate(char), onJoin(code), onLeave, onClosePanel, onTogglePause

    this.#injectStyles();
    this.#buildChip();
    this.#buildPanel();
    this.#buildVideo();
    this.#buildBanner();

    bus.on('session:joined', () => this.#renderSession());
    bus.on('session:left', () => this.#renderSession());
    bus.on('session:peer', () => this.#renderSession());
    bus.on('session:error', (err) => this.banner(err?.message ?? '联机错误', 4000));
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
      <div class="mp-hint">同一部游戏页面，两人各控一个角色。房主运行游戏画面，队友远程操控另一个角色。</div>
      <div class="mp-section mp-section-standalone">
        <div class="mp-choice">
          <button class="mp-btn mp-char" data-char="fb">我玩火娃</button>
          <button class="mp-btn mp-char" data-char="wg">我玩水娃</button>
        </div>
        <div class="mp-row"><button id="mp-btn-create" class="mp-btn">创建房间</button></div>
        <div class="mp-hint">创建后把自动带房间号的链接发给队友。</div>
        <div class="mp-joinrow" style="margin-top:10px">
          <input class="mp-input" id="mp-input-code" maxlength="4" placeholder="房间号" inputmode="latin">
          <button class="mp-btn" id="mp-btn-join" style="flex:0 0 84px">加入</button>
        </div>
      </div>
      <div class="mp-section mp-section-seated" style="display:none">
        <div class="mp-status" id="mp-room-line"></div>
        <div class="mp-code" id="mp-room-code"></div>
        <div class="mp-hint" id="mp-share-hint"></div>
        <div class="mp-row"><button class="mp-btn" id="mp-btn-leave">退出联机</button></div>
      </div>
    `;
    this.root.appendChild(panel);
    this.panel = panel;

    panel.querySelector('.mp-close').addEventListener('click', () => this.togglePanel(false));
    panel.querySelector('#mp-btn-create').addEventListener('click', () => {
      this.handlers.onCreate?.(this.selectedChar ?? 'fb');
    });
    panel.querySelector('#mp-btn-join').addEventListener('click', () => {
      const code = panel.querySelector('#mp-input-code').value.trim();
      if (code) this.handlers.onJoin?.(code);
    });
    panel.querySelector('#mp-btn-leave').addEventListener('click', () => this.handlers.onLeave?.());
    for (const btn of panel.querySelectorAll('.mp-char')) {
      btn.addEventListener('click', () => this.selectChar(btn.getAttribute('data-char')));
    }
    this.selectChar('fb');
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
    if (this.sessionInfo) {
      const peer = this.sessionInfo.peerConnected ? `● 已连接` : '○ 等待队友';
      const ping = this.latency != null ? ` · ${this.latency}ms` : '';
      label.textContent = `${peer}${ping}`;
    } else {
      label.textContent = '联机';
    }
  }

  #renderSession() {
    const seated = Boolean(this.sessionInfo?.code);
    this.panel.querySelector('.mp-section-standalone').style.display = seated ? 'none' : '';
    this.panel.querySelector('.mp-section-seated').style.display = seated ? '' : 'none';
    if (!seated) return;

    const { code, role, char, peerConnected } = this.sessionInfo;
    this.panel.querySelector('#mp-room-code').textContent = code;
    const roleName = role === 'host' ? '房主' : '队友';
    const charLabel = CHAR_LABELS[char] ? `${CHAR_LABELS[char].zh}` : char;
    this.panel.querySelector('#mp-room-line').innerHTML =
      `房间 <b>${code}</b> · 你是${roleName} · 操控 <b>${charLabel}</b>`;
    const shareHint = this.panel.querySelector('#mp-share-hint');
    if (role === 'host') {
      const url = new URL(location.href);
      url.searchParams.set('room', code);
      shareHint.innerHTML = peerConnected
        ? '队友已连接，开始吧！'
        : `把链接发给队友：<span style="user-select:all">${url.toString()}</span>`;
    } else {
      shareHint.textContent = peerConnected ? '已连接房主画面。' : '正在连接房主…';
    }
    this.#renderNetState();
  }

  #renderHostStatus() {
    // Guest: reflect host phase in the chip and banner.
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
    this.sessionInfo = info; // { code, role, char, peerConnected } | null
    this.#renderSession();
  }

  setHostStatus(status) {
    this.hostStatus = status;
    this.#renderHostStatus();
  }

  showGuestVideo() {
    document.body.classList.add('mp-guest-active');
  }
}
