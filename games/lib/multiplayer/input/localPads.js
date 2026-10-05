/**
 * Guest-side input capture.
 *
 * Two sources feed one state frame { up, left, right, seq }:
 *  - on-screen touch pads (landscape phone layout, one pad for the guest's
 *    character) built here — independent of games/lib/touch-controls.js,
 *    which stays in charge of the LOCAL game's pads on the host screen
 *  - a physical keyboard, so a guest on a laptop can play with the real
 *    keys of their character (W/A/D or arrows) without sending the other
 *    character's keys by accident
 *
 * The resulting frame goes over the network (host applies it); it is never
 * injected into the guest's own page.
 */
import { CHAR_KEYS } from './keys.js';
import { logger } from '../core/logger.js';

export class LocalPads {
  constructor({ bus, char }) {
    this.bus = bus;
    this.char = char;
    this.charKeys = CHAR_KEYS[char];

    this.state = { up: false, left: false, right: false };
    this.seq = 0;
    this.heartbeat = null;
    this.enabled = false;
    this.elements = [];

    this.#installKeyCapture();
  }

  /** Pads respond (and frames flow) only while the host is in a level. */
  setEnabled(enabled) {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    if (!enabled) {
      // Release everything so the host does not keep a stuck key.
      this.state = { up: false, left: false, right: false };
      this.#sendFrame(true);
      this.#stopHeartbeat();
    } else {
      this.#startHeartbeat();
    }
    this.bus.emit('pads:enabled', enabled);
    for (const el of this.elements) {
      el.style.display = enabled ? '' : 'none';
    }
  }

  destroy() {
    this.setEnabled(false);
    for (const el of this.elements) el.remove();
    this.elements = [];
    window.removeEventListener('keydown', this.#onKeyDown, true);
    window.removeEventListener('keyup', this.#onKeyUp, true);
  }

  // ---- frame production ---------------------------------------------------

  #sendFrame(force = false) {
    if (!this.enabled && !force) return;
    this.seq += 1;
    this.bus.emit('pads:frame', { ...this.state, seq: this.seq });
  }

  #startHeartbeat() {
    this.#stopHeartbeat();
    this.heartbeat = setInterval(() => this.#sendFrame(true), 1000);
  }

  #stopHeartbeat() {
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
  }

  #applyAction(action, down) {
    if (this.state[action] === down) return;
    this.state[action] = down;
    this.#sendFrame();
  }

  // ---- physical keyboard ----------------------------------------------------

  #onKeyDown = (event) => {
    if (!this.enabled || event.repeat) return;
    const action = this.#actionForKey(event.keyCode ?? event.which);
    if (action) {
      event.preventDefault();
      this.#applyAction(action, true);
    }
  };

  #onKeyUp = (event) => {
    const action = this.#actionForKey(event.keyCode ?? event.which);
    if (action) {
      if (this.enabled) event.preventDefault();
      this.#applyAction(action, false);
    }
  };

  #installKeyCapture() {
    window.addEventListener('keydown', this.#onKeyDown, true);
    window.addEventListener('keyup', this.#onKeyUp, true);
  }

  #actionForKey(code) {
    for (const [action, keyCode] of Object.entries(this.charKeys)) {
      if (keyCode === code) return action;
    }
    return null;
  }

  // ---- on-screen pads -------------------------------------------------------

  /**
   * Build one touch pad for this character, pinned to the screen edge the
   * engine itself uses for that character (watergirl left, fireboy right).
   */
  buildPad(mount) {
    const actions = [
      { action: 'up', label: '跳' },
      { action: 'left', label: '←' },
      { action: 'right', label: '→' },
    ];
    const side = this.char === 'wg' ? 'left' : 'right';

    const pad = document.createElement('div');
    pad.className = `mp-pad mp-pad-${side}`;
    pad.innerHTML = [
      `<div class="mp-pad-title">${this.char === 'wg' ? '水娃' : '火娃'}</div>`,
      `<div class="mp-pad-row">`,
      ...actions.map(
        (a) =>
          `<div class="mp-pad-btn" data-action="${a.action}"><span>${a.label}</span></div>`,
      ),
      `</div>`,
    ].join('');

    for (const btn of pad.querySelectorAll('.mp-pad-btn')) {
      const action = btn.getAttribute('data-action');
      const down = (event) => {
        event.preventDefault();
        btn.classList.add('active');
        this.#applyAction(action, true);
      };
      const up = (event) => {
        event.preventDefault();
        btn.classList.remove('active');
        this.#applyAction(action, false);
      };
      btn.addEventListener('touchstart', down, { passive: false });
      btn.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });
      btn.addEventListener('touchend', up);
      btn.addEventListener('touchcancel', up);
      // Mouse fallback for desktop guests testing the pads.
      btn.addEventListener('mousedown', down);
      btn.addEventListener('mouseup', up);
      btn.addEventListener('mouseleave', () => {
        if (btn.classList.contains('active')) {
          btn.classList.remove('active');
          this.#applyAction(action, false);
        }
      });
      btn.addEventListener('contextmenu', (e) => e.preventDefault());
    }

    mount.appendChild(pad);
    this.elements.push(pad);
    pad.style.display = this.enabled ? '' : 'none';
    logger.debug('pad built for', this.char);
    return pad;
  }
}
