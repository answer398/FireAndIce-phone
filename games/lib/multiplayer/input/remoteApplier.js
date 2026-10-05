/**
 * Host-side remote input application.
 *
 * All remote KEY input is applied through the unified InputManager
 * (`FBInput.applyRemote`): it is source-tagged 'remote', injected into the
 * engine as synthetic KeyboardEvents on the verified targets, and NEVER
 * re-emitted as local events — so remote frames can never loop back onto
 * the network. This module keeps only the protocol-side concerns:
 *
 *  - seq ordering/dedupe: frames are state snapshots, so an out-of-order
 *    OLD frame would fight the newer state; only forward progress applies.
 *  - the canvas pointer (mouse) events the menu/pause UI needs — those are
 *    not role-based input, so they stay here: Phaser Mouse listens on the
 *    canvas in capture phase reading clientX/Y (verified per game bundle).
 *
 * Idempotency: the manager dedupes no-op transitions, so duplicate frames
 * after a reconnect cannot double-fire keys into the engine.
 */
import { logger } from '../core/logger.js';

const FBInput = window.FBInput;

export class RemoteApplier {
  constructor({ P }) {
    this.P = P;
    // The manager is the single input funnel; FBInput only exposes tables.
    this.manager = FBInput ? FBInput.manager() : null;
    this.lastSeq = -1;
    this.canvas = null;
    /** Character seat the remote peer controls (frames arrive for it). */
    this.role = null;
  }

  attachCanvas(canvas) {
    this.canvas = canvas;
  }

  /**
   * Apply a state frame from the guest. `role` is the peer's character
   * ('fb' | 'wg'); the manager maps actions to that role's real key codes.
   */
  applyFrame(frame, role) {
    if (!this.manager) throw new Error('games/lib/input/input-manager.js must load first');
    if (typeof frame?.seq === 'number') {
      if (frame.seq <= this.lastSeq) return;
      this.lastSeq = frame.seq;
    }
    this.role = role;
    for (const action of Object.values(this.P.INPUT_ACTIONS)) {
      this.manager.applyRemote(role, action, Boolean(frame[action]), { seq: frame.seq });
    }
    logger.debug('remote frame applied', role, frame);
  }

  /** Reset key state (guest left / level ended / room closed). */
  releaseAll() {
    if (this.manager) this.manager.releaseAll({ source: 'remote' });
    this.lastSeq = -1;
  }

  /** Tap the pause key (same key the engine binds in the Level state). */
  tapPause() {
    const code = FBInput ? FBInput.KEY_CODES.P : 80;
    this.#tapKey(code);
  }

  #tapKey(code) {
    if (this.manager) {
      this.manager.injectKey(code, true);
      setTimeout(() => this.manager.injectKey(code, false), 80);
      return;
    }
    // Fallback if the unified manager is unavailable (should not happen —
    // the game pages load input-manager.js first).
    const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'keyCode', { value: code });
    Object.defineProperty(event, 'which', { value: code });
    window.dispatchEvent(event);
    setTimeout(() => {
      const up = new KeyboardEvent('keyup', { bubbles: true, cancelable: true });
      Object.defineProperty(up, 'keyCode', { value: code });
      Object.defineProperty(up, 'which', { value: code });
      window.dispatchEvent(up);
    }, 80);
  }

  /**
   * Apply a remote pointer event. `nx`/`ny` are normalized coordinates
   * within the video content box (letterbox already removed by the guest),
   * mapped here onto the canvas client rect.
   */
  applyPointer({ phase, nx, ny }) {
    const canvas = this.canvas;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const clientX = rect.left + nx * rect.width;
    const clientY = rect.top + ny * rect.height;
    const type =
      phase === this.P.POINTER_PHASES.DOWN
        ? 'mousedown'
        : phase === this.P.POINTER_PHASES.UP
          ? 'mouseup'
          : 'mousemove';
    canvas.dispatchEvent(
      new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        clientX,
        clientY,
        button: 0,
        // Phaser tracks press state from the down/up event pair itself;
        // move events only need plausible coordinates.
        buttons: phase === this.P.POINTER_PHASES.DOWN ? 1 : 0,
      }),
    );
  }
}
