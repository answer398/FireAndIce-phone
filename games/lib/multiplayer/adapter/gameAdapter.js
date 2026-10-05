/**
 * Game adapter — the seam between the extension layer and the untouched,
 * minified game core.
 *
 * Verified engine facts this module relies on (see MULTIPLAYER.md):
 *  - every game builds one Phaser.Game inside `<div id="container">`
 *  - the Level state class is the RequireJS module `States/Level/Level`
 *    (identical id in all six games) and assigns `game.level = this`
 *  - `game.state.current` reflects the phase (menu / levelMenu / level / …)
 *  - keyboard input is read from `window` keydown/keyup by `event.keyCode`
 *  - mouse input is read from canvas-attached listeners using clientX/Y
 *
 * The adapter never patches payloads or game logic — it only wraps two
 * prototype methods to OBSERVE state transitions and to grab a reference
 * to the live game instance. If the hooks are unavailable (module ids
 * changed, RequireJS context missing) it degrades to DOM-only behavior:
 * input injection and video keep working, phase reporting falls back to
 * 'unknown'.
 */
import { logger } from '../core/logger.js';
import { KEY_CODES } from '../input/keys.js';

const LEVEL_MODULE = 'States/Level/Level';
const LEVEL_MODULE_ALIASES = [LEVEL_MODULE, 'States/Level/LevelState'];

export const PHASE_MAP = {
  boot: 'booting',
  load: 'booting',
  menu: 'menu',
  levelMenu: 'level-menu',
  level: 'level',
  endGame: 'end',
  end: 'end',
  gameComplete: 'end',
};

export class GameAdapter {
  constructor({ bus, P }) {
    this.bus = bus;
    this.P = P;

    this.game = null; // live Phaser.Game once captured
    this.level = null; // live Level state instance (per level)
    this.canvas = null;
    this.phase = P.GAME_PHASES.BOOTING;
    this.paused = false;

    this.#watchCanvas();
    this.#installHooks();
    // Bootstraps differ per game (data-main vs version.js chain), so the
    // RequireJS modules appear at unpredictable times — poll until hooked.
    this.hookTimer = setInterval(() => this.#installHooks(), 500);
    setTimeout(() => clearInterval(this.hookTimer), 120_000);
  }

  // ---- observation --------------------------------------------------------

  #watchCanvas() {
    const find = () => {
      const canvas = document.querySelector('#container canvas');
      if (canvas && canvas !== this.canvas) {
        this.canvas = canvas;
        logger.info('game canvas found');
        this.bus.emit('adapter:canvas', canvas);
      }
    };
    find();
    const observer = new MutationObserver(find);
    observer.observe(document.body, { childList: true, subtree: true });
  }

  /**
   * Capture the live game and install level-lifecycle hooks.
   *
   * Primary capture path: the engine's own Phaser module export —
   * `require('Phaser').GAMES` holds every constructed Phaser.Game
   * (`c.GAMES.push(this)` in the Game constructor). This works regardless
   * of the Closure bindAll pattern, which rebinds most state methods as
   * instance properties and therefore defeats prototype wrapping for
   * per-frame calls.
   */
  #installHooks() {
    if (this.hooksInstalled) return;
    const req = window.require;
    if (!req || typeof req.defined !== 'function') return;

    // 1. Game instance via the Phaser module registry.
    let game = null;
    if (req.defined('Phaser')) {
      try {
        const Phaser = req('Phaser');
        game = Phaser?.GAMES?.[Phaser.GAMES.length - 1] ?? null;
      } catch {
        game = null;
      }
    }

    // 2. Level lifecycle: wrap prototype create/shutdown. These are invoked
    // through the StateManager property lookup, so the wrappers run unless
    // the constructor has already bound the method onto the instance BEFORE
    // our wrap — the game poll below covers that case.
    let Level = null;
    for (const id of LEVEL_MODULE_ALIASES) {
      if (req.defined(id)) {
        Level = req(id);
        break;
      }
    }
    if (Level?.prototype) {
      this.#wrapMethod(Level.prototype, 'create', (instance) => {
        this.level = instance;
        if (instance?.game) this.#captureGame(instance.game);
        logger.info('level state created');
        this.#reportPhase(true);
      });
      this.#wrapMethod(Level.prototype, 'shutdown', () => {
        this.level = null;
        logger.info('level state shut down');
        this.#reportPhase(true);
      });
    }

    if (game) {
      this.#captureGame(game);
    }

    if (this.game) {
      this.hooksInstalled = true;
      clearInterval(this.hookTimer);
      logger.info('game hooks installed');
    }
  }

  #wrapMethod(proto, name, after) {
    if (!proto || typeof proto[name] !== 'function') return;
    if (proto[name].__mpWrapped) return;
    const original = proto[name];
    const wrapped = function (...args) {
      const result = original.apply(this, args);
      after(this, args);
      return result;
    };
    wrapped.__mpWrapped = true;
    proto[name] = wrapped;
  }

  #captureGame(game) {
    if (this.game === game) return;
    this.game = game;
    logger.info('game instance captured');
    this.bus.emit('adapter:game', game);
    // Poll the engine's state machine; cheap and completely non-invasive.
    this.#startPhasePolling();
  }

  #startPhasePolling() {
    if (this.phaseTimer) return;
    this.phaseTimer = setInterval(() => this.#reportPhase(false), 300);
  }

  #reportPhase(force) {
    if (!this.game) return;
    const stateKey = this.game.state?.current ?? null;
    let phase = PHASE_MAP[stateKey] ?? this.P.GAME_PHASES.UNKNOWN;
    const paused = phase === 'level' && Boolean(this.game.paused);
    if (phase === this.phase && paused === this.paused && !force) return;
    this.phase = phase;
    this.paused = paused;
    this.bus.emit('adapter:phase', { phase, paused, stateKey });
  }

  // ---- commands used by the rest of the layer ------------------------------

  getCanvas() {
    return this.canvas;
  }

  /** Current game phase (or 'unknown' if hooks never attached). */
  getPhase() {
    return this.game ? this.phase : this.P.GAME_PHASES.UNKNOWN;
  }

  isPaused() {
    return this.paused;
  }

  /** Toggle the engine pause by tapping the same P key the engine binds. */
  togglePause() {
    const code = KEY_CODES.P;
    this.#dispatchKey(code, 'keydown');
    setTimeout(() => this.#dispatchKey(code, 'keyup'), 80);
  }

  #dispatchKey(keyCode, type) {
    const event = new KeyboardEvent(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'keyCode', { value: keyCode });
    Object.defineProperty(event, 'which', { value: keyCode });
    window.dispatchEvent(event);
  }
}
