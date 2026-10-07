/**
 * GameAdapter — the seam between the extension layer and the untouched,
 * minified game core. This is the ONLY module allowed to reach into the
 * game's runtime objects; everything above it speaks the snapshot schema.
 *
 * ═══ How the real game objects are found (verified across all six games) ═══
 *
 * 1. ENGINE + GAME INSTANCE
 *    Every game is one RequireJS (AMD) bundle: Phaser 2.6.2 (games 1–5) or
 *    2.6.15 from CDN (game 6) + Box2D + jQuery. The engine registers every
 *    constructed Phaser.Game in `require('Phaser').GAMES` (c.GAMES.push(this)
 *    in the Game constructor), so the live instance is always
 *    `require('Phaser').GAMES[GAMES.length - 1]`.
 *
 * 2. LEVEL STATE INSTANCE
 *    The Level state class is the AMD module `States/Level/Level` (identical
 *    id in all six games). Its `init(levelData)` stores the descriptor in
 *    `this.levelData` and `create()` assigns `game.level = this` (verified:
 *    `this.game.level = this` at game.js:44791 in game 1). So while the level
 *    runs: `game.level` is the live Level (a Phaser.State), and
 *    `game.level.levelData` = {id, filename, type, ...} — the level identity.
 *    Level lifecycle hooks (prototype create/shutdown wrap) tell us when the
 *    instance rotates; `game.state.current` gives the phase.
 *
 * 3. CHARACTERS
 *    `game.level.pers1` (fireboy, char 'fb') and `game.level.pers2` (watergirl,
 *    char 'wg') — instances of AMD module `States/Level/character`. Each is a
 *    Phaser Group with a Box2D body:
 *      - position (px):        char.body.sprite.x / .y      (wrapper accessors;
 *                              the game itself writes these in animateStairs)
 *      - velocity (px/s):      char.body.velocity.x / .y    (read-only mirror of
 *                              the raw body; write via the raw body instead)
 *      - raw box2d body:       char.body.data  (b2Body: GetPosition/SetPositionXY/
 *                              GetLinearVelocity/SetLinearVelocity/SetAwake)
 *      - px ↔ m conversion:    box2d ptmRatio = 32, BOTH axes mirrored:
 *                              m.x = -px/32, m.y = -py/32 (Device.mpx/pxm)
 *      - input state:          char.cursors.{up,left,right}.isDown
 *      - death state:          char.dying / .dead / .isDead (set by kill() chain)
 *      - collection counters:  char.data.diamonds / .silverDiamond
 *      - facing:               char.facing ('idle' | 'left' | 'right')
 *
 * 4. MECHANISMS (devices)
 *    `game.level.objects` — created by Level.createObjects in tilemap order
 *    (deterministic from the level file, identical on both sides). Each device
 *    is a Phaser Group with:
 *      - identity:  options.type ('pusher'|'lever'|'platform'|'box'|'portal'|…)
 *                   + options.x/options.y (tilemap px — unique per level)
 *      - state:     `state` int, driven by checkState()/deviceChanged; visuals
 *                   + physics re-derive via `_updateState()`
 *      - body:      device.body (Box2D wrapper like the characters) for
 *                   movable types (platform/box/pusher/ball/pulley…)
 *      - lever:     device.joint (b2RevoluteJoint; GetJointAngleRadians)
 *    `game.MechManager.deviceGroups[group]` links signal devices (lever/pusher)
 *    to driven devices (platform/door…) — state propagates through
 *    deviceChanged(): driven.state = OR of the group's signal states.
 *
 * 5. DOORS (level exits)
 *    `game.level.door1` (char 'fb') / `game.level.door2` (char 'wg') — sprites
 *    with a sensor body: `isOpen` (a matching character is inside),
 *    `currentFrac` (0..21 opening animation), `isUp` (fully open — both doors
 *    isUp ⇒ Level.checkEndGame wins the level).
 *
 * 6. GEMS (diamonds)
 *    Diamond instances (AMD module `States/Level/Devices/Diamond`) live in the
 *    stage's display tree — found by scanning `game.stage` children for
 *    `instanceof Diamond`. Identity: data.char ('fb'|'wg'|'silver'|'fbwg') +
 *    spawn x/y; `gem.grabbed(character)` plays the sound, bumps the counter and
 *    destroys the gem (gem.exists → false). Collected gems must be cached at
 *    level start: the scan can no longer see destroyed instances.
 *
 * 7. LEVEL META / TEMPLE RESOLUTION
 *    `game.currentTemple` is set by the LevelMenu state init (templeData) and
 *    read by Level.baseLoadComplete for the TempleAssets atlas path. The list
 *    of temple data paths per game is `game.gameConfig.temples`
 *    (['forest'] for game 1 … ['elements/fire', 'elements/water', …] for game
 *    5); each is served at `data/<path>/temple.json`. The adapter fetches them
 *    once and maps templeData.id → path, which is what level descriptors need
 *    to travel across the wire (guest side fetches the same file and calls the
 *    menu's own `skipToLevel(levelDesc)` — the same code path a click uses).
 *
 * 8. PAUSE / RESTART
 *    Pause is the Level state's P-key toggle (game.paused + pause menu);
 *    restart is `game.level.retry()` (re-fades the level with the same
 *    levelData). Both are invoked through the game's own code paths.
 *
 * The adapter never patches game logic; it only wraps two Level prototype
 * methods to OBSERVE lifecycle and holds references to live objects. If the
 * hooks are unavailable it degrades: input/video keep working, sync reports
 * 'unknown' phase and getState() returns null (the layer then refuses to
 * pretend it is synchronized).
 */
import { logger } from '../core/logger.js';
import { KEY_CODES } from '../input/keys.js';

const LEVEL_MODULE_ALIASES = ['States/Level/Level', 'States/Level/LevelState'];
const DIAMOND_MODULE = 'States/Level/Devices/Diamond';

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

/** Snapshot correction thresholds (px / px-per-second / radians). */
export const CORRECTION = {
  /** Below this distance the local sim is left alone (avoids jitter). */
  softMin: 2,
  /** Up to this distance: fractional position correction (smooth). */
  softMax: 48,
  /** Beyond this: immediate hard snap to the authoritative state. */
  hard: 96,
  /** Fraction of the remaining error applied per snapshot in the soft zone. */
  softFraction: 0.35,
  /** Lever joint angle: correct beyond this many radians. */
  leverAngle: 0.35,
  /** ptm ratio of the bundled box2d build (verified: game.physics.box2d.ptmRatio). */
  ptm: 32,
};

/** Level-end reasons (snapshot lv.e). */
export const LEVEL_END = { NONE: 0, WIN: 1, DEAD: 2 };

export class GameAdapter {
  constructor({ bus, P }) {
    this.bus = bus;
    this.P = P;

    this.game = null; // live Phaser.Game once captured
    this.level = null; // live Level state instance (per level)
    this.canvas = null;
    this.phase = P.GAME_PHASES.BOOTING;
    this.paused = false;
    /** How the LAST level ended ('win' | 'dead'), captured at shutdown. */
    this.lastLevelEnd = null;

    /** @type {Map<string, string>} templeData.id -> data path (e.g. 'forest'). */
    this.templePaths = new Map();
    this.#templeIndexPromise = null;
    /** b2Vec2 constructor for raw velocity writes (module 'box2d'). */
    this.B2Vec2 = null;
    /** Gem cache for the current level: stable identity + live refs. */
    this.#gemCache = null;

    this.#watchCanvas();
    this.detect();
    // Bootstraps differ per game (data-main vs version.js chain), so the
    // RequireJS modules appear at unpredictable times — poll until hooked.
    this.hookTimer = setInterval(() => this.detect(), 500);
    setTimeout(() => clearInterval(this.hookTimer), 120_000);
    /** Set when WE force a state.start('level') — the fade chain normally
     * calls Level.start() (intro camera + physics unpause) and our direct
     * path must do it from the create hook instead. */
    this.#needsManualLevelStart = false;
    /** In-flight startLevel promise — concurrent callers share it. */
    this.#levelNavPromise = null;
  }

  #needsManualLevelStart;
  #levelNavPromise;

  #templeIndexPromise;
  #gemCache;

  // ---- detection ------------------------------------------------------------

  /**
   * Capture the live game and install level-lifecycle hooks. Idempotent; the
   * constructor polls it until the engine shows up. Also resolves the module
   * references the sync layer needs (b2Vec2, Diamond class).
   */
  detect() {
    if (this.hooksInstalled && this.B2Vec2) return;
    const req = window.require;
    if (!req || typeof req.defined !== 'function') return;

    // 1. Game instance via the engine's own module registry.
    if (req.defined('Phaser')) {
      try {
        const Phaser = req('Phaser');
        const game = Phaser?.GAMES?.[Phaser.GAMES.length - 1] ?? null;
        if (game) this.#captureGame(game);
      } catch {
        /* engine not ready yet */
      }
    }

    // 2. b2Vec2 for raw velocity writes (games expose the box2d port as AMD
    //    module 'box2d'; the Door/Lever code also uses the global `box2d`).
    if (!this.B2Vec2) {
      try {
        if (req.defined('box2d')) this.B2Vec2 = req('box2d').b2Vec2 ?? null;
      } catch { /* ignore */ }
      if (!this.B2Vec2 && typeof window.box2d?.b2Vec2 === 'function') this.B2Vec2 = window.box2d.b2Vec2;
    }

    // 3. Level lifecycle: wrap prototype create/shutdown. These are invoked
    //    through the StateManager property lookup, so the wrappers run unless
    //    the constructor already bound the method onto the instance BEFORE our
    //    wrap — the poll above covers that case.
    if (!this.hooksInstalled) {
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
          this.#gemCache = null;
          this.lastLevelEnd = null;
          if (instance?.game) this.#captureGame(instance.game);
          logger.info('level state created');
          if (this.#needsManualLevelStart) {
            // Our forced state.start bypassed the fade chain that normally
            // invokes Level.start (intro camera + physics unpause schedule).
            this.#needsManualLevelStart = false;
            setTimeout(() => {
              try { instance.start?.(); } catch (err) { logger.warn('manual Level.start failed', err?.message ?? err); }
            }, 0);
          }
          // Lifecycle observers (roundSync): a NEW Level instance means the
          // game (re-)entered a level — same id twice in a row is a restart.
          this.bus.emit('adapter:level-created', {
            level: this.getLevel(),
            instance,
          });
          this.#reportPhase(true);
        });
        this.#wrapMethod(Level.prototype, 'shutdown', () => {
          // Capture how the level ended BEFORE dropping the instance: the
          // end screen (win/dead) is reported through this fact.
          if (this.level?.ended) {
            const dead = Boolean(
              this.level.pers1?.isDead || this.level.pers2?.isDead ||
              this.level.pers1?.dead || this.level.pers2?.dead,
            );
            this.lastLevelEnd = dead ? 'dead' : 'win';
          }
          this.level = null;
          this.#gemCache = null;
          logger.info('level state shut down');
          this.bus.emit('adapter:level-destroyed', {});
          this.#reportPhase(true);
        });
      }

      if (this.game) {
        this.hooksInstalled = true;
        clearInterval(this.hookTimer);
        logger.info('game hooks installed');
        this.bus.emit('adapter:ready', this);
      }
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
    // Resolve temple id -> data path so getLevel() can report the descriptor
    // the guest needs (critical for game 5's nested temple paths).
    void this.#ensureTempleIndex();
    // Keep the simulation alive on throttled pages (see #watchLoop).
    this.#watchLoop(game);
    // Poll the engine's state machine; cheap and completely non-invasive.
    this.#startPhasePolling();
  }

  /**
   * Browsers stop requestAnimationFrame for occluded/hidden pages, which
   * FREEZES the whole simulation (a covered host stops snapshotting; a
   * backgrounded guest stops following). Phaser's RAF driver has an official
   * setTimeout fallback — switch to it as soon as the loop clock stalls
   * while the game is not paused. Timers on hidden pages run slower (throttled
   * to ~1Hz) but the sim degrades to slow-motion instead of freezing.
   *
   * Liveness signal: game.time.time is refreshed on EVERY loop update
   * (game.time.frames only ticks when the game enabled advancedTiming).
   */
  #watchLoop(game) {
    if (this.loopWatch) return;
    let last = -1;
    this.loopWatch = setInterval(() => {
      if (!this.game || this.game !== game) {
        clearInterval(this.loopWatch);
        this.loopWatch = null;
        return;
      }
      const now = game.time?.time ?? 0;
      if (now === last) {
        try {
          const raf = game.raf;
          if (raf && typeof raf.stop === 'function' && typeof raf.start === 'function' && !raf.isSetTimeOut?.()) {
            raf.forceSetTimeOut = true;
            raf.stop();
            raf.start();
            logger.warn('rAF starved — game loop switched to setTimeout');
          }
        } catch { /* engine without raf hook */ }
      }
      last = now;
    }, 2000);
  }

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

  // ---- basic queries / commands (pre-existing surface) -----------------------

  getCanvas() {
    return this.canvas;
  }

  /**
   * Host mode: keep the simulation running when the host's window loses
   * focus. The engine auto-pauses on window blur (`Game.focusLoss` →
   * `gamePaused` unless `stage.disableVisibilityChange`), which would
   * freeze the game out from under a remotely-connected guest the moment
   * the host clicks into another window. The flag is checked at event
   * time, so setting it on the live instance is effective immediately.
   */
  setHostMode(enabled) {
    if (!this.game?.stage) return;
    this.game.stage.disableVisibilityChange = Boolean(enabled);
    logger.info(`host mode ${enabled ? 'enabled (no auto-pause on blur)' : 'disabled'}`);
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
    // Route through the unified InputManager so the pause key uses the same
    // verified dispatch targets as every other injected key.
    const fb = window.FBInput;
    if (fb) {
      fb.manager().injectKey(keyCode, type === 'keydown');
      return;
    }
    const event = new KeyboardEvent(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'keyCode', { value: keyCode });
    Object.defineProperty(event, 'which', { value: keyCode });
    window.dispatchEvent(event);
  }

  // ---- unified sync interface ------------------------------------------------

  /**
   * Current level identity, or null outside a level. `temple` is the data
   * path segment (e.g. 'forest', 'elements/fire') the guest must fetch.
   */
  getLevel() {
    const level = this.level;
    const templeData = this.game?.currentTemple;
    if (!level?.levelData || !templeData) return null;
    return {
      temple: this.templePaths.get(templeData.id) ?? templeData.id,
      id: level.levelData.id,
      filename: level.levelData.filename,
      type: level.levelData.type ?? null,
    };
  }

  /**
   * Enter a specific level through the menu's own skip path (the same code a
   * click uses): fetch the temple data, assign it the way LevelMenu.init does
   * (`game.currentTemple = templeData`), then `menu.skipToLevel(levelDesc)`.
   * No-op when that level is already running.
   *
   * Reentrancy: the snapshot applier AND the round follower can request the
   * same navigation within milliseconds of each other. Two overlapping
   * fades would kill each other's tween (state change clears tweens) and
   * wedge `state.fading` — so concurrent callers share one navigation.
   */
  startLevel({ temple, id }) {
    if (this.#levelNavPromise) return this.#levelNavPromise;
    this.#levelNavPromise = this.#doStartLevel({ temple, id }).finally(() => {
      this.#levelNavPromise = null;
    });
    return this.#levelNavPromise;
  }

  async #doStartLevel({ temple, id }) {
    const req = window.require;
    if (!this.game || !req) throw new Error('adapter: game not captured');
    if (this.phase === 'level' && this.level?.levelData?.id === id) return false; // already there
    // The game registers itself in Phaser.GAMES mid-construction — the state
    // manager may not exist yet when the very first snapshot races the boot.
    for (let i = 0; i < 50 && !this.game.state; i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    if (!this.game.state) throw new Error('adapter: game state manager not ready');

    let templeData;
    if (this.game.currentTemple?.id && this.templePaths.get(this.game.currentTemple.id) === temple) {
      templeData = this.game.currentTemple; // right temple already loaded
    } else {
      const res = await fetch(`data/${temple}/temple.json`);
      if (!res.ok) throw new Error(`temple.json fetch failed: ${res.status}`);
      templeData = await res.json();
      // Cache the path so getLevel() can report it back verbatim.
      this.templePaths.set(templeData.id, temple);
    }
    this.game.currentTemple = templeData;
    const levelDesc = templeData.levels?.find((l) => l.id === id);
    if (!levelDesc) throw new Error(`level ${id} not in temple ${temple}`);
    this.game.stage.disableVisibilityChange = true;
    const menu = this.game.state.states['menu'];
    if (!menu || typeof menu.skipToLevel !== 'function') throw new Error('menu skipToLevel unavailable');
    // skipToLevel reads `this.game` — but the engine nulls a retired state's
    // game reference once another state took over, and we call it cross-state.
    // Bind the call to a shim whose game is OUR live instance.
    this.#navigateToLevel(levelDesc, () => menu.skipToLevel.call({ game: this.game }, levelDesc));
    logger.info('startLevel', temple, id);
    return true;
  }

  /**
   * Drive the state machine to the 'level' state and VERIFY it got there.
   *
   * The game's own fade (`state.fade`) is guarded by `state.fading` and
   * completes through a tween + ad-callback chain; if that chain is ever
   * interrupted (page hidden, tween killed) the flag stays true and every
   * later fade silently no-ops, leaving a frozen loading overlay. Since the
   * fade's only real action is `state.start('level', true, false, desc)`, we
   * verify shortly after the request and, if the transition did not happen,
   * clear the stuck flag/overlay and perform that same engine call directly.
   */
  #navigateToLevel(levelDesc, requestNavigation) {
    const game = this.game;
    const alreadyRegistered = Boolean(game.state?.states?.['level']);
    if (alreadyRegistered) {
      // Deterministic path: skip the cosmetic fade entirely and perform the
      // exact engine call the fade completion makes. Level.start() is invoked
      // from our create hook (see #needsManualLevelStart).
      this.#clearStuckFade(game);
      this.#needsManualLevelStart = true;
      game.state.start('level', true, false, levelDesc);
      return;
    }
    // First registration must go through the menu (it registers the class).
    requestNavigation();
    setTimeout(() => {
      if (this.game === game && game.state?.current !== 'level') {
        logger.warn('level fade did not complete — forcing state.start(level)');
        this.#clearStuckFade(game);
        this.#needsManualLevelStart = true;
        game.state.start('level', true, false, levelDesc);
      }
    }, 2500);
  }

  /** Clear an interrupted fade: its flag blocks all future fades. */
  #clearStuckFade(game) {
    const sm = game.state;
    if (sm?.fading) {
      sm.fading = false;
      try { sm.overlay?.kill?.(); } catch { /* overlay gone */ }
      sm.overlay = null;
      logger.warn('cleared stuck state fade');
    }
  }

  /**
   * Index the game's temple data paths (`game.gameConfig.temples`) once, so
   * getLevel() can map currentTemple.id -> data path even on game 5 where the
   * paths are nested ('elements/fire', …).
   */
  async #ensureTempleIndex() {
    if (!this.game?.gameConfig?.temples) return;
    if (!this.#templeIndexPromise) {
      this.#templeIndexPromise = (async () => {
        for (const path of [].concat(this.game.gameConfig.temples)) {
          try {
            const res = await fetch(`data/${path}/temple.json`);
            if (!res.ok) continue;
            const data = await res.json();
            if (data?.id) this.templePaths.set(data.id, path);
          } catch { /* offline temple: level sync simply unavailable */ }
        }
        logger.info('temple index built', [...this.templePaths.entries()]);
      })();
    }
    await this.#templeIndexPromise;
  }

  /**
   * Read the authoritative world state (host side). Returns null when no
   * level is live. See the snapshot schema in common/protocol/events.mjs.
   */
  getState() {
    const level = this.level;
    if (!level || this.phase !== 'level' || !level.pers1 || !level.pers2) return null;

    const r1 = (v) => (typeof v === 'number' ? Math.round(v * 10) / 10 : null);
    const r3 = (v) => (typeof v === 'number' ? Math.round(v * 1000) / 1000 : null);

    // -- characters (pers1=fb, pers2=wg; order is fixed by the engine) --
    const ch = [level.pers1, level.pers2].map((c) => [
      r1(c.body?.sprite?.x ?? c.sprite?.x),
      r1(c.body?.sprite?.y ?? c.sprite?.y),
      r1(c.body?.velocity?.x ?? 0),
      r1(c.body?.velocity?.y ?? 0),
      !(c.dying || c.dead || c.isDead),
      Math.max(0, c.data?.diamonds ?? 0),
      Math.max(0, c.data?.silverDiamond ?? 0),
      typeof c.facing === 'string' ? c.facing : null,
    ]);

    // -- devices: tilemap-ordered identity + mutable values --
    const di = [];
    const dv = [];
    for (const d of level.objects ?? []) {
      if (!d?.options) continue;
      di.push([String(d.options.type ?? ''), r1(d.options.x), r1(d.options.y)]);
      let ja = null;
      if (d.joint && typeof d.joint.GetJointAngleRadians === 'function') {
        try { ja = r3(d.joint.GetJointAngleRadians()); } catch { ja = null; }
      }
      dv.push([
        Number(d.state) || 0,
        d.body?.sprite ? r1(d.body.sprite.x) : null,
        d.body?.sprite ? r1(d.body.sprite.y) : null,
        d.body?.velocity ? r1(d.body.velocity.x) : null,
        d.body?.velocity ? r1(d.body.velocity.y) : null,
        ja,
      ]);
    }

    // -- gems: stable identity cached per level instance --
    const gems = this.#gemInstances();
    const gi = gems.map((g) => [String(g.data?.char ?? ''), r1(g.x), r1(g.y)]);
    const dm = [];
    gems.forEach((g, i) => {
      if (!g.exists || !g.alive) dm.push(i);
    });

    // -- doors --
    const dr = [level.door1, level.door2].filter(Boolean).map((d) => [
      Boolean(d.isOpen),
      r1(d.currentFrac ?? 0),
      Boolean(d.isUp),
    ]);

    // -- level flags --
    const dead = Boolean(level.pers1.isDead || level.pers2.isDead || level.pers1.dead || level.pers2.dead);
    const lv = {
      s: Boolean(level.levelStarted),
      e: level.ended ? (dead ? LEVEL_END.DEAD : LEVEL_END.WIN) : LEVEL_END.NONE,
      p: Boolean(this.game.paused),
    };

    return {
      lvl: this.getLevel(),
      ch, di, dv, gi, dm, dr, lv,
    };
  }

  /** Scan the stage for live Diamond instances (cached per level instance). */
  #gemInstances() {
    if (!this.level) return [];
    if (!this.#gemCache || this.#gemCache.level !== this.level) {
      const req = window.require;
      let Diamond = null;
      try {
        if (req?.defined?.(DIAMOND_MODULE)) Diamond = req(DIAMOND_MODULE);
      } catch { /* module missing on some build */ }
      const gems = [];
      if (Diamond && this.game?.stage) {
        const scan = (node, depth) => {
          if (!node || depth > 6 || gems.length > 96) return;
          if (Array.isArray(node.children)) {
            for (const child of node.children) {
              if (child instanceof Diamond) gems.push(child);
              else scan(child, depth + 1);
            }
          }
        };
        scan(this.game.stage, 0);
      }
      this.#gemCache = { level: this.level, gems };
    }
    return this.#gemCache.gems;
  }

  /**
   * Apply an authoritative snapshot to the local sim (guest side).
   *
   * Correction policy (thresholds in CORRECTION):
   *   - characters/devices with a body: dist ≤ softMin → leave the sim alone;
   *     dist ≤ softMax → move a fraction of the error (smooth); beyond → hard
   *     snap of position AND velocity (Box2D SetAwake so it keeps moving).
   *   - discrete facts (gem collection, device state, door opening, death,
   *     counters) are applied exactly whenever they differ.
   *   - lever joint angles snap beyond the lever threshold; smaller drift is
   *     left to the guest's own physics.
   *
   * @returns {{ok?:boolean, soft:number, hard:number, discrete:number,
   *            levelMismatch?:boolean}} correction counters for the HUD.
   */
  applyState(snap) {
    const level = this.level;
    const out = { ok: false, soft: 0, hard: 0, discrete: 0 };
    if (!snap?.snap || !level || this.phase !== 'level') return out;

    const s = snap.snap;

    // Level identity must match, or the caller has to navigate first.
    if (s.lvl && level.levelData && s.lvl.id !== level.levelData.id) {
      out.levelMismatch = true;
      return out;
    }
    // Device identities come from the same tilemap; any mismatch means we are
    // not in the same level after all.
    const objects = (level.objects ?? []).filter((d) => d?.options);
    if (Array.isArray(s.di) && s.di.length !== objects.length) {
      out.levelMismatch = true;
      return out;
    }

    const r = CORRECTION;

    // ---- characters ---------------------------------------------------------
    const chars = [level.pers1, level.pers2];
    s.ch?.forEach((target, i) => {
      const c = chars[i];
      if (!c?.body) return;
      const [x, y, vx, vy, alive, diamonds, silver, facing] = target;

      // Death is authoritative: run the game's own kill chain once.
      if (!alive && !(c.dying || c.dead || c.isDead)) {
        c.kill?.();
        out.discrete++;
      }
      // Collection counters (gems already destroyed stay destroyed).
      if (c.data && typeof diamonds === 'number' && c.data.diamonds < diamonds) {
        c.data.diamonds = diamonds;
        out.discrete++;
      }
      if (c.data && typeof silver === 'number' && c.data.silverDiamond < silver) {
        c.data.silverDiamond = silver;
        out.discrete++;
      }
      if (facing && c.facing !== facing) c.facing = facing;

      const px = c.body.sprite?.x ?? 0;
      const py = c.body.sprite?.y ?? 0;
      const dx = x - px;
      const dy = y - py;
      const dist = Math.hypot(dx, dy);
      if (dist > r.hard) {
        // Hard snap: position through the wrapper accessors (the same writes
        // animateStairs performs), velocity through the raw b2Body (both axes
        // mirrored, ptm 32).
        c.body.x = x;
        c.body.y = y;
        this.#setRawVelocity(c.body, vx ?? 0, vy ?? 0);
        out.hard++;
      } else if (dist > r.softMax) {
        c.body.x = x;
        c.body.y = y;
        this.#setRawVelocity(c.body, vx ?? 0, vy ?? 0);
        out.hard++;
      } else if (dist > r.softMin) {
        c.body.x = px + dx * r.softFraction;
        c.body.y = py + dy * r.softFraction;
        out.soft++;
      }
    });

    // ---- devices ------------------------------------------------------------
    objects.forEach((d, i) => {
      const identity = s.di?.[i];
      const value = s.dv?.[i];
      if (!identity || !value) return;
      // Identity check guards against applying another level's snapshot.
      if (identity[0] !== String(d.options.type) || identity[1] !== d.options.x || identity[2] !== d.options.y) {
        out.levelMismatch = true;
        return;
      }
      const [state, bx, by, bvx, bvy, ja] = value;
      if (d.state !== state) {
        d.state = state;
        try { d._updateState?.(); } catch { /* visual-only */ }
        out.discrete++;
      }
      // Lever joint angle: snap beyond threshold (small drift self-corrects).
      if (ja != null && d.joint && typeof d.joint.GetJointAngleRadians === 'function') {
        try {
          if (Math.abs(d.joint.GetJointAngleRadians() - ja) > r.leverAngle) {
            if (typeof d.joint.SetJointAngleRadians === 'function') d.joint.SetJointAngleRadians(ja);
            d.joint.GetBodyA?.()?.SetAwake?.(true);
            d.joint.GetBodyB?.()?.SetAwake?.(true);
            out.hard++;
          }
        } catch { /* joint gone mid-frame */ }
      }
      // Movable bodies: same threshold policy as characters.
      if (bx != null && by != null && d.body?.sprite) {
        const px = d.body.sprite.x;
        const py = d.body.sprite.y;
        const dx = bx - px;
        const dy = by - py;
        const dist = Math.hypot(dx, dy);
        if (dist > r.hard) {
          d.body.x = bx;
          d.body.y = by;
          this.#setRawVelocity(d.body, bvx ?? 0, bvy ?? 0);
          out.hard++;
        } else if (dist > r.softMax) {
          d.body.x = bx;
          d.body.y = by;
          this.#setRawVelocity(d.body, bvx ?? 0, bvy ?? 0);
          out.hard++;
        } else if (dist > r.softMin) {
          d.body.x = px + dx * r.softFraction;
          d.body.y = py + dy * r.softFraction;
          out.soft++;
        }
      }
    });
    if (out.levelMismatch) return out;

    // ---- gems -----------------------------------------------------------------
    const gems = this.#gemInstances();
    if (Array.isArray(s.dm) && gems.length === (s.gi?.length ?? -1)) {
      for (const idx of s.dm) {
        const gem = gems[idx];
        if (!gem || !gem.exists || !gem.alive) continue; // already collected here
        // Match the gem to the character whose counter it bumps.
        const char = gem.data?.char;
        const pers = char === 'wg' ? level.pers2 : char === 'fb' ? level.pers1 : level.pers1;
        try { gem.grabbed?.(pers); out.discrete++; } catch { /* sensor racing */ }
      }
    }

    // ---- doors ------------------------------------------------------------------
    const doors = [level.door1, level.door2].filter(Boolean);
    s.dr?.forEach((target, i) => {
      const d = doors[i];
      if (!d) return;
      const [isOpen, frac, isUp] = target;
      if (Boolean(d.isOpen) !== isOpen) {
        d.isOpen = isOpen;
        out.discrete++;
      }
      if (Math.abs((d.currentFrac ?? 0) - frac) > 0.6) {
        d.currentFrac = frac;
        try { d.sprite.animations.frame = Math.round(frac); } catch { /* anim gone */ }
        out.discrete++;
      }
      // A door the host has fully opened must count as up for checkEndGame.
      if (isUp && !d.isUp) {
        d.isUp = true;
        try { d.sprite.animations.frame = 21; d.currentFrac = 21; } catch { /* ignore */ }
        out.discrete++;
      }
    });

    // ---- level flags -------------------------------------------------------------
    if (s.lv) {
      // Win on the host: force the doors open so the guest's own
      // checkEndGame runs the real finish sequence.
      if (s.lv.e === LEVEL_END.WIN && !level.ended) {
        for (const d of doors) {
          d.isOpen = true;
          d.isUp = true;
          try { d.sprite.animations.frame = 21; d.currentFrac = 21; } catch { /* ignore */ }
        }
        out.discrete++;
      }
      // Death on the host already flowed through the character path above;
      // the guest's checkEndGame sees isDead and runs gameOver itself.
      if (s.lv.e === LEVEL_END.NONE && level.ended) {
        out.endedMismatch = true; // guest ended but host still playing → recovery
      }
      // Pause parity (the guest mirrors the host's pause).
      if (typeof s.lv.p === 'boolean' && this.game.paused !== s.lv.p) {
        this.togglePause();
        out.discrete++;
      }
    }

    out.ok = true;
    return out;
  }

  /**
   * Write a px/s velocity through the raw b2Body. Both axes are mirrored
   * (wrapper px/s = -raw m/s × 32, verified against Device.mpx/pxm).
   */
  #setRawVelocity(body, vxPx, vyPx) {
    const data = body?.data;
    if (!data || typeof data.SetLinearVelocity !== 'function') return;
    try {
      if (this.B2Vec2) data.SetLinearVelocity(new this.B2Vec2(-vxPx / CORRECTION.ptm, -vyPx / CORRECTION.ptm));
      data.SetAwake?.(true);
    } catch { /* body removed mid-frame */ }
  }

  /** Restart the current level through the game's own retry path. */
  restart() {
    const level = this.level;
    if (!level) return false;
    const game = this.game;
    if (typeof level.retry === 'function') {
      // A wedged fade flag would silently swallow the retry's state.fade.
      this.#clearStuckFade(game);
      level.retry();
      logger.info('level restart via retry()');
      this.#verifyLevelEntry(game, level.levelData);
      return true;
    }
    // Fallback: re-enter with the stored descriptor (same fade path).
    if (level.levelData && game?.state?.states?.['menu']?.skipToLevel) {
      game.state.states['menu'].skipToLevel(level.levelData);
      logger.info('level restart via skipToLevel');
      this.#verifyLevelEntry(game, level.levelData);
      return true;
    }
    return false;
  }

  /**
   * fade-based navigation self-heal (see #navigateToLevel): if the requested
   * transition never landed, force it so a stuck fade can never wedge the
   * multiplayer lifecycle.
   */
  #verifyLevelEntry(game, levelDesc) {
    setTimeout(() => {
      if (this.game === game && game.state?.current !== 'level') {
        logger.warn('level transition did not complete — forcing state.start(level)');
        this.#clearStuckFade(game);
        this.#needsManualLevelStart = true;
        game.state.start('level', true, false, levelDesc);
      }
    }, 2500);
  }

  /**
   * Leave the level back to the temple hall (level menu). The game's own quit
   * path fades to the 'levelMenu' state — but that state class is only
   * registered once the player has actually visited the temple hall, and a
   * remote-following guest may never have. Route through the menu's own
   * startTemple (register + fade), which is where the game itself goes when
   * entering the hall from the main menu.
   */
  exitLevel() {
    const game = this.game;
    if (!game || this.phase !== 'level') return false;
    const menu = game.state?.states?.['menu'];
    if (typeof menu?.startTemple === 'function') {
      this.#clearStuckFade(game);
      // startTemple also reads `this.game` — same cross-state shim as above.
      menu.startTemple.call({ game }, game.currentTemple);
      logger.info('level exit via menu.startTemple');
      setTimeout(() => {
        if (this.game === game && game.state?.current === 'level') {
          logger.warn('level exit did not complete — forcing state.start(levelMenu)');
          this.#clearStuckFade(game);
          if (game.state.states['levelMenu']) game.state.start('levelMenu', true, false, game.currentTemple);
        }
      }, 2500);
      return true;
    }
    if (typeof game.state?.fade !== 'function') return false;
    // Stop the level music the way Level.quit does, then fade out.
    try { game.level?.sounds?.levelMusic?.stop?.(); } catch { /* audio gone */ }
    this.#clearStuckFade(game);
    game.state.fade('levelMenu', true, false, game.currentTemple);
    logger.info('level exit via state.fade(levelMenu)');
    return true;
  }

  /** Mirror the host's pause state (idempotent; uses the engine's P key). */
  setPaused(paused) {
    if (!this.game || this.phase !== 'level') return false;
    if (Boolean(this.game.paused) === Boolean(paused)) return false;
    this.togglePause();
    return true;
  }

  pause() {
    return this.setPaused(true);
  }

  resume() {
    return this.setPaused(false);
  }
}
