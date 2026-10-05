/**
 * Host-side remote input application.
 *
 * Turns network input frames into the exact synthetic events the game
 * engine already understands:
 *  - key frames  -> KeyboardEvent(keydown/keyup) on `window` (the engine's
 *    Phaser Keyboard manager listens there and matches by `event.keyCode`;
 *    this is the same proven mechanism games/lib/touch-controls.js uses)
 *  - pointer     -> MouseEvent(mousedown/move/up) on the game canvas
 *    (Phaser Mouse handlers are attached to the canvas in capture phase and
 *    read clientX/clientY, so synthetic events at canvas coordinates behave
 *    like a real mouse)
 *
 * A dedupe table keeps key state idempotent even if the network delivers
 * duplicate frames after a reconnect.
 */
import { logger } from '../core/logger.js';

export class RemoteApplier {
  constructor({ P }) {
    this.P = P;
    /** keyCode -> true while we hold it down on behalf of the remote peer. */
    this.heldKeys = new Map();
    this.lastSeq = -1;
    this.canvas = null;
  }

  attachCanvas(canvas) {
    this.canvas = canvas;
  }

  /** Apply a state frame from the guest. `charKeys` maps action->keyCode. */
  applyFrame(frame, charKeys) {
    if (typeof frame?.seq === 'number') {
      // Frames are state snapshots, not deltas: an out-of-order OLD frame
      // would fight the newer state. Only accept forward progress.
      if (frame.seq <= this.lastSeq) return;
      this.lastSeq = frame.seq;
    }
    for (const [action, keyCode] of Object.entries(charKeys)) {
      this.#setKey(keyCode, Boolean(frame[action]));
    }
  }

  /** Reset key state (guest left / level ended / room closed). */
  releaseAll() {
    for (const keyCode of [...this.heldKeys.keys()]) {
      this.#setKey(keyCode, false);
    }
    this.lastSeq = -1;
  }

  /** Tap the pause key (same key the engine binds in the Level state). */
  tapPause() {
    const code = 80; // KEY_CODES.P
    this.#dispatchKey(code, 'keydown');
    setTimeout(() => this.#dispatchKey(code, 'keyup'), 80);
  }

  #setKey(keyCode, down) {
    const isDown = this.heldKeys.get(keyCode) ?? false;
    if (down === isDown) return;
    this.heldKeys.set(keyCode, down);
    this.#dispatchKey(keyCode, down ? 'keydown' : 'keyup');
    logger.debug('remote key', keyCode, down ? 'down' : 'up');
  }

  #dispatchKey(keyCode, type) {
    const event = new KeyboardEvent(type, {
      bubbles: true,
      cancelable: true,
    });
    // The engine reads `event.keyCode` / `event.which`, which the
    // KeyboardEvent constructor does not set — define them explicitly
    // (same approach as games/lib/touch-controls.js).
    Object.defineProperty(event, 'keyCode', { value: keyCode });
    Object.defineProperty(event, 'which', { value: keyCode });
    window.dispatchEvent(event);
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
