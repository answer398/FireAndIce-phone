/**
 * Developer debug HUD (hidden unless ?mpDebug=1).
 *
 * One fixed panel that answers "is the sync actually working": connection
 * state, room/role, RTT, snapshot seq/ack in both directions, snapshot age,
 * correction counters and the adapter's view of the game. Reads only — every
 * number comes from the bus events the sync layer already emits, plus cheap
 * polls of the session/adapter references it is handed.
 */
import { logger } from '../core/logger.js';

const ROWS = [
  ['conn', '连接'],
  ['room', '房间'],
  ['role', '席位'],
  ['rtt', 'RTT'],
  ['phase', '游戏'],
  ['snap', '快照'],
  ['snapAge', '快照年龄'],
  ['input', '输入'],
  ['corr', '校正'],
  ['rate', '速率'],
];

export class DebugHud {
  constructor({ bus, net, session, adapter, P, visible = false }) {
    this.bus = bus;
    this.net = net;
    this.session = session;
    this.adapter = adapter;
    this.P = P;
    this.visible = visible;

    this.snapStats = null; // host: SnapshotSender / guest: applier stats
    this.isHostStats = null;
    this.corrections = { total: 0, soft: 0, hard: 0, discrete: 0, dropped: 0 };

    this.el = null;
    this.renderTimer = null;

    bus.on('sync:stats', (s) => {
      this.isHostStats = true;
      this.snapStats = s;
    });
    bus.on('sync:guest-stats', (s) => {
      this.isHostStats = false;
      this.snapStats = { seq: s.seq, ack: s.ack, ageMs: s.ageMs };
      this.corrections = {
        total: s.corrections ?? 0,
        soft: s.soft ?? 0,
        hard: s.hard ?? 0,
        discrete: s.discrete ?? 0,
        dropped: s.dropped ?? 0,
      };
    });

    if (visible) this.show();
  }

  /** Mount + start the 2Hz refresh. Safe to call repeatedly. */
  show() {
    if (this.el) return;
    const el = document.createElement('div');
    el.className = 'mp-hud';
    el.setAttribute('data-hidden', 'false');
    // The HUD is dev-only chrome: it must never intercept game input.
    el.style.cssText = [
      'position:fixed', 'top:8px', 'right:8px', 'z-index:2147483000',
      'font:11px/1.5 ui-monospace,Consolas,monospace', 'color:#0f0',
      'background:rgba(0,0,0,.72)', 'padding:8px 10px', 'border-radius:6px',
      'pointer-events:none', 'text-align:left', 'white-space:pre', 'display:none',
    ].join(';');
    document.body?.appendChild(el);
    this.el = el;
    this.renderTimer = setInterval(() => this.#render(), 500);
    this.#render();
    logger.info('debug HUD visible');
  }

  hide() {
    if (this.renderTimer) {
      clearInterval(this.renderTimer);
      this.renderTimer = null;
    }
    this.el?.remove();
    this.el = null;
    this.visible = false;
  }

  toggle() {
    if (this.el) this.hide();
    else {
      this.visible = true;
      this.show();
    }
  }

  #fmt(k, v) {
    return `${k}: ${v}`;
  }

  #render() {
    if (!this.el) return;
    const P = this.P;
    const values = {
      conn: this.net.state,
      room: this.session.code ?? '—',
      role: this.session.role ?? '—',
      rtt: this.net.lastLatencyMs != null ? `${this.net.lastLatencyMs}ms` : '—',
      phase: `${this.adapter?.getPhase?.() ?? '—'}${this.adapter?.isPaused?.() ? ' (paused)' : ''}`,
      snap: '—',
      snapAge: '—',
      input: '—',
      corr: '—',
      rate: '—',
    };

    if (this.snapStats) {
      const s = this.snapStats;
      if (this.isHostStats) {
        values.snap = `seq=${s.seq} ack=${s.ack}${s.same ? ' (same)' : ''}`;
        values.input = `lastSeq=${s.ack}`;
        values.rate = `${this.session && s.bytes != null ? s.bytes + 'B' : ''}${s.hz ? ` @${s.hz}Hz` : ''}`;
      } else {
        values.snap = `seq=${s.seq} ack=${s.ack}`;
        values.input = `hostAck=${s.ack}`;
        values.snapAge = s.ageMs != null ? `${Math.max(0, Math.round(s.ageMs))}ms` : '—';
        values.corr = `${this.corrections.total} (soft ${this.corrections.soft} / hard ${this.corrections.hard} / disc ${this.corrections.discrete}${this.corrections.dropped ? ` / drop ${this.corrections.dropped}` : ''})`;
        values.rate = s.received != null ? `recv=${s.received}` : '—';
      }
    }

    // Host-side: show the guest-reported correction count from input frames.
    if (this.isHostStats && this.lastGuestCorrections != null) {
      values.corr = `guest corr=${this.lastGuestCorrections}`;
    }

    this.el.textContent = ROWS.map(([k, label]) => this.#fmt(label, values[k])).join('\n');
  }

  /** Host side: the guest reports its correction totals on each input frame. */
  setGuestCorrections(n) {
    this.lastGuestCorrections = n;
  }
}
