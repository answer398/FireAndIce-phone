/**
 * Unified InputManager for Fireboy & Watergirl (all six games).
 *
 * ONE funnel for every input that reaches the game engine:
 *
 *   physical keyboard  ─┐
 *   touch pads (UI)     ├─▶ FBInput.setAction(role, action, pressed, source) ─▶ game engine
 *   remote player (net) ─┘
 *
 * Roles follow the engine's own binding (verified in every game bundle,
 * `States/Level/CharCursors`, default `settings.controls === "keyboard"`):
 *   - Fireboy  ('fb') -> ArrowUp / ArrowLeft / ArrowRight
 *   - Watergirl('wg') -> W / A / D
 *
 * Sources
 *   'local'  this device: physical keyboard + on-screen touch pads.
 *            Emitted through onEvent()/onLocalEvent() so the network layer
 *            can forward them.
 *   'remote' input that arrived from the network on behalf of the peer
 *            (the seat's assigned character). Injected into the engine but
 *            NEVER re-emitted — loop-prevention contract: the network
 *            bridge subscribes to local events only, and the manager
 *            additionally refuses to emit remote ones.
 *
 * How the engine actually listens (verified per game bundle, do not guess):
 *   - Keyboard: Phaser Keyboard attaches keydown/keyup/keypress to
 *     `window` (bubble phase) and matches by `event.keyCode`. No game
 *     listens on `document` or any element for keys. Synthetic
 *     KeyboardEvents are therefore dispatched to every target in
 *     `keyTargets` (default [window]).
 *   - Mouse: canvas-attached listeners reading clientX/Y (remote pointer
 *     injection lives in the multiplayer layer, see remoteApplier.js).
 *
 * Injection carries full legacy-compatible fields: keyCode + which (what
 * the engine matches on) plus standard `key` / `code`.
 *
 * Seat safety: when this device owns only one character (multiplayer
 * seat), trusted keyboard events for the OTHER character are intercepted
 * before they reach the engine — the room-assigned remote player is the
 * only one who may drive that character, so a stray WASD press on the
 * host keyboard can never fight the peer's input.
 *
 * Stuck-key safety: window blur, document hidden and pagehide release
 * every held action (keyup injected + released event emitted), so a
 * character never keeps walking after a tab switch, a phone call, or an
 * interrupted touch. Remote-held keys are intentionally NOT flushed on
 * local blur — they are state-synced from the peer's frames
 * (change-driven + heartbeat); flushing them would fight the peer's
 * still-held key. Full release happens only on pagehide.
 *
 * This file is a classic script (no module system, no dependencies) so it
 * loads identically in every game page, before the multiplayer layer.
 */
(function () {
    'use strict';

    /** Character identifiers — the literal values the engine uses internally. */
    var ROLES = { FIREBOY: 'fb', WATERGIRL: 'wg' };

    /** Semantic actions, shared by keyboard / touch / network. */
    var ACTIONS = ['up', 'left', 'right'];

    /**
     * keyCode -> { key, code } legacy-compat table for every key this layer
     * synthesizes. Values mirror the engine's CharCursors bindings and its
     * pause key (P).
     */
    var KEY_META = {
        38: { key: 'ArrowUp', code: 'ArrowUp' },
        37: { key: 'ArrowLeft', code: 'ArrowLeft' },
        39: { key: 'ArrowRight', code: 'ArrowRight' },
        87: { key: 'w', code: 'KeyW' },
        65: { key: 'a', code: 'KeyA' },
        68: { key: 'd', code: 'KeyD' },
        80: { key: 'p', code: 'KeyP' },
    };

    var KEY_CODES = {
        UP: 38, LEFT: 37, RIGHT: 39,
        W: 87, A: 65, D: 68,
        P: 80,
    };

    /** Per-role action -> keyCode, mirroring CharCursors exactly. */
    var CHAR_KEYS = {
        fb: { up: KEY_CODES.UP, left: KEY_CODES.LEFT, right: KEY_CODES.RIGHT },
        wg: { up: KEY_CODES.W, left: KEY_CODES.A, right: KEY_CODES.D },
    };

    /** Reverse map keyCode -> { role, action }, derived from CHAR_KEYS. */
    var KEY_TO_ACTION = (function () {
        var map = {};
        Object.keys(CHAR_KEYS).forEach(function (role) {
            Object.keys(CHAR_KEYS[role]).forEach(function (action) {
                map[CHAR_KEYS[role][action]] = { role: role, action: action };
            });
        });
        return map;
    })();

    function InputManager() {
        /** Roles this device controls. Default: both (single-player local). */
        this.localRoles = [ROLES.FIREBOY, ROLES.WATERGIRL];

        /**
         * Authoritative action state. Key "role:action" ->
         * { pressed, source, kind } where kind is
         * 'keyboard' | 'touch' | 'network'.
         */
        this.state = {};

        /**
         * Dispatch targets for synthesized key events. Verified listener
         * locations only — today that is `window` in all six games (Phaser
         * Keyboard, bubble phase, matched by event.keyCode). If a future
         * game listens on document/element, register that target here
         * instead of guessing a single global.
         */
        this.keyTargets = [window];

        this.seq = 0;
        this.listeners = [];
        this.roleListeners = [];
        this.destroyed = false;

        this._onKeyDown = this._handleKeyEvent.bind(this, true);
        this._onKeyUp = this._handleKeyEvent.bind(this, false);
        window.addEventListener('keydown', this._onKeyDown, true);
        window.addEventListener('keyup', this._onKeyUp, true);

        // Stuck-key safety nets: every way a page can lose an input stream.
        this._onBlur = function () { this.releaseAll({ source: 'local' }); }.bind(this);
        this._onVisibility = function () {
            if (document.hidden) this.releaseAll({ source: 'local' });
        }.bind(this);
        this._onPageHide = function () { this.releaseAll({}); }.bind(this);
        window.addEventListener('blur', this._onBlur);
        document.addEventListener('visibilitychange', this._onVisibility);
        window.addEventListener('pagehide', this._onPageHide);
    }

    // ---- configuration --------------------------------------------------------

    /**
     * Declare which roles THIS device controls.
     *   null / ['fb','wg']  -> single-player local (keyboard + both pads)
     *   ['fb'] or ['wg']    -> multiplayer seat: keyboard and pads may only
     *                          drive the assigned character; the other
     *                          character is fed exclusively by the network.
     * Locally-held actions of roles leaving our control are force-released
     * (keyup injected) so they cannot stick down under the new owner.
     */
    InputManager.prototype.setLocalRoles = function (roles) {
        var next = roles && roles.length
            ? roles.filter(function (r) { return CHAR_KEYS[r]; })
            : [ROLES.FIREBOY, ROLES.WATERGIRL];
        if (!next.length) next = [ROLES.FIREBOY, ROLES.WATERGIRL];
        var same = next.length === this.localRoles.length &&
            next.every(function (r) { return this.localRoles.indexOf(r) !== -1; }, this);
        if (same) return;
        this.localRoles = next;
        var keep = {};
        next.forEach(function (r) { keep[r] = true; });
        Object.keys(this.state).forEach(function (key) {
            var parts = key.split(':');
            var entry = this.state[key];
            if (entry.pressed && entry.source === 'local' && !keep[parts[0]]) {
                this._forceRelease(parts[0], parts[1], entry);
            }
        }, this);
        this._notifyRolesChanged();
    };

    InputManager.prototype.getLocalRoles = function () {
        return this.localRoles.slice();
    };

    /** Extend the verified dispatch-target list (e.g. document or a canvas). */
    InputManager.prototype.addKeyTarget = function (target) {
        if (target && this.keyTargets.indexOf(target) === -1) this.keyTargets.push(target);
    };

    // ---- the single input funnel ----------------------------------------------

    /**
     * THE entry point every source converges on.
     *
     * @param {string} role    'fb' | 'wg'
     * @param {string} action  'up' | 'left' | 'right'
     * @param {boolean} pressed
     * @param {'local'|'remote'} source
     * @param {{kind?: 'keyboard'|'touch'|'network', seq?: number, timestamp?: number}} [meta]
     *
     * Behaviour per source:
     *   keyboard  observer only — the engine already received the trusted
     *             DOM event; only record state + emit. Never re-inject.
     *   touch     inject the key events the engine needs, record + emit.
     *   remote    inject + record — and DO NOT emit (loop prevention: the
     *             frame came FROM the network; re-emitting would feed it
     *             straight back).
     *
     * Transitions are idempotent: pressing an already-pressed action is a
     * no-op, so duplicate network frames after a reconnect cannot
     * double-fire into the engine.
     */
    InputManager.prototype.setAction = function (role, action, pressed, source, meta) {
        if (this.destroyed) return;
        if (!CHAR_KEYS[role] || ACTIONS.indexOf(action) === -1) return;
        if (source !== 'local' && source !== 'remote') return;
        meta = meta || {};
        var kind = meta.kind || (source === 'remote' ? 'network' : 'unknown');

        // A local source (keyboard, pads) may only drive roles this device
        // controls — the remote seat's character is exclusively the peer's.
        if (pressed && source === 'local' && this.localRoles.indexOf(role) === -1) return;

        var key = role + ':' + action;
        var entry = this.state[key];
        if (entry && entry.pressed === pressed) return; // idempotent

        this.state[key] = { pressed: pressed, source: source, kind: kind };

        if (kind !== 'keyboard') {
            // Touch and remote input must become real engine key events.
            this._injectKey(CHAR_KEYS[role][action], pressed);
        }

        if (source === 'local') {
            this._emit({
                type: pressed ? 'pressed' : 'released',
                role: role,
                action: action,
                source: 'local',
                inputKind: kind,
                seq: ++this.seq,
                timestamp: Date.now(),
            });
        }
    };

    /** Remote (network) input entry — explicit, never re-emitted outbound. */
    InputManager.prototype.applyRemote = function (role, action, pressed, meta) {
        this.setAction(role, action, pressed, 'remote', meta);
    };

    // ---- keyboard observation (trusted events only) ----------------------------

    /**
     * Real keyboard handling. The `isTrusted` filter is half of loop
     * prevention: every key event this manager synthesizes (for touch or
     * remote input) is untrusted, so it can never re-enter here and be
     * mistaken for physical input.
     *
     * Our listener is registered on window in the CAPTURE phase and fires
     * before the engine's window-bubble listeners, so intercepting a key
     * here (seat owned by the remote player) reliably keeps it away from
     * the game.
     */
    InputManager.prototype._handleKeyEvent = function (down, event) {
        if (this.destroyed || !event.isTrusted) return;
        var mapped = KEY_TO_ACTION[event.keyCode];
        if (!mapped) return;
        if (this.localRoles.indexOf(mapped.role) === -1) {
            // Remote seat's character: this device's keyboard must not
            // fight the peer's input — swallow it before the engine sees it.
            event.preventDefault();
            event.stopPropagation();
            return;
        }
        if (down && event.repeat) return; // OS auto-repeat is not a new press
        this.setAction(mapped.role, mapped.action, down, 'local', { kind: 'keyboard' });
    };

    // ---- release safety nets -----------------------------------------------------

    /**
     * Release held actions. Options:
     *   { source: 'local' }  blur / page hidden — release local holds only;
     *                        remote holds stay (they are peer-state-synced).
     *   { source: 'remote' } peer left / level ended — drop the peer's holds.
     *   { role: 'fb' }       narrow the flush to one role.
     *   {}                   everything (pagehide best effort).
     *
     * Always injects the keyup even for keyboard-sourced holds: if the
     * browser swallowed the physical keyup (alt-tab while holding), this
     * clears the engine's stuck key; if it did not, the extra keyup is
     * deduped by the engine's own isDown check.
     */
    InputManager.prototype.releaseAll = function (opts) {
        opts = opts || {};
        Object.keys(this.state).forEach(function (key) {
            var entry = this.state[key];
            if (!entry || !entry.pressed) return;
            if (opts.source && entry.source !== opts.source) return;
            var parts = key.split(':');
            if (opts.role && parts[0] !== opts.role) return;
            this._forceRelease(parts[0], parts[1], entry);
        }, this);
    };

    /** Internal: release one action unconditionally (inject + emit if local). */
    InputManager.prototype._forceRelease = function (role, action, entry) {
        this.state[role + ':' + action] = { pressed: false, source: entry.source, kind: entry.kind };
        this._injectKey(CHAR_KEYS[role][action], false);
        if (entry.source === 'local') {
            this._emit({
                type: 'released',
                role: role,
                action: action,
                source: 'local',
                inputKind: entry.kind,
                seq: ++this.seq,
                timestamp: Date.now(),
            });
        }
    };

    // ---- introspection -------------------------------------------------------------

    InputManager.prototype.isDown = function (role, action) {
        var entry = this.state[role + ':' + action];
        return Boolean(entry && entry.pressed);
    };

    /** Snapshot of per-role action state, e.g. { fb: {up:false,left:true,right:false} }. */
    InputManager.prototype.snapshot = function () {
        var out = {};
        [ROLES.FIREBOY, ROLES.WATERGIRL].forEach(function (role) {
            out[role] = {
                up: this.isDown(role, 'up'),
                left: this.isDown(role, 'left'),
                right: this.isDown(role, 'right'),
            };
        }, this);
        return out;
    };

    // ---- events -----------------------------------------------------------------

    /**
     * Subscribe to semantic input events. Only local-source events are ever
     * emitted (the source field exists for diagnostics). Returns an
     * unsubscribe function.
     *
     * Event shape (the standard interface for the network layer):
     *   { type:'pressed'|'released', role, action, source:'local',
     *     inputKind:'keyboard'|'touch', seq, timestamp }
     */
    InputManager.prototype.onEvent = function (cb) {
        this.listeners.push(cb);
        var self = this;
        return function () {
            var i = self.listeners.indexOf(cb);
            if (i !== -1) self.listeners.splice(i, 1);
        };
    };

    /** Convenience for the network bridge: local events only, pre-filtered. */
    InputManager.prototype.onLocalEvent = function (cb) {
        return this.onEvent(function (ev) {
            if (ev.source === 'local') cb(ev);
        });
    };

    /** Subscribe to control-scheme changes (touch-pads re-render). */
    InputManager.prototype.onRolesChanged = function (cb) {
        this.roleListeners.push(cb);
        var self = this;
        return function () {
            var i = self.roleListeners.indexOf(cb);
            if (i !== -1) self.roleListeners.splice(i, 1);
        };
    };

    InputManager.prototype._emit = function (ev) {
        for (var i = 0; i < this.listeners.length; i++) {
            try {
                this.listeners[i](ev);
            } catch (err) {
                // A broken subscriber must never break input delivery.
                if (window.console) console.warn('[FBInput] listener error', err);
            }
        }
    };

    InputManager.prototype._notifyRolesChanged = function () {
        var roles = this.localRoles.slice();
        for (var i = 0; i < this.roleListeners.length; i++) {
            try {
                this.roleListeners[i](roles);
            } catch (err) {
                if (window.console) console.warn('[FBInput] role listener error', err);
            }
        }
    };

    // ---- engine injection -----------------------------------------------------------

    /**
     * Synthesize a real keydown/keyup for the engine and dispatch it to
     * every verified target. Carries the full compat set:
     *   keyCode / which  — what the Phaser engine matches on
     *   key / code       — standard KeyboardEvent fields, for anything else
     */
    InputManager.prototype._injectKey = function (keyCode, down) {
        var meta = KEY_META[keyCode] || { key: '', code: '' };
        var type = down ? 'keydown' : 'keyup';
        for (var i = 0; i < this.keyTargets.length; i++) {
            var ev;
            try {
                ev = new KeyboardEvent(type, {
                    key: meta.key,
                    code: meta.code,
                    bubbles: true,
                    cancelable: true,
                });
            } catch (err) {
                // Ancient browsers without the KeyboardEvent constructor.
                ev = document.createEvent('KeyboardEvent');
                ev.initKeyboardEvent(type, true, true, window, meta.key, 0, '', false, '');
            }
            try {
                Object.defineProperty(ev, 'keyCode', { value: keyCode });
                Object.defineProperty(ev, 'which', { value: keyCode });
            } catch (err) {
                ev.keyCode = keyCode;
                ev.which = keyCode;
            }
            this.keyTargets[i].dispatchEvent(ev);
        }
    };

    /** Low-level shared injection (e.g. the P pause key). Not role-based. */
    InputManager.prototype.injectKey = function (keyCode, down) {
        this._injectKey(keyCode, down);
    };

    InputManager.prototype.destroy = function () {
        this.destroyed = true;
        this.releaseAll({});
        window.removeEventListener('keydown', this._onKeyDown, true);
        window.removeEventListener('keyup', this._onKeyUp, true);
        window.removeEventListener('blur', this._onBlur);
        document.removeEventListener('visibilitychange', this._onVisibility);
        window.removeEventListener('pagehide', this._onPageHide);
        this.listeners.length = 0;
        this.roleListeners.length = 0;
    };

    // ---- singleton export -------------------------------------------------------------

    var singleton = null;
    window.FBInput = {
        ROLES: ROLES,
        ACTIONS: ACTIONS,
        KEY_CODES: KEY_CODES,
        CHAR_KEYS: CHAR_KEYS,
        KEY_META: KEY_META,
        /** Access the manager singleton (created lazily). */
        manager: function () {
            if (!singleton) singleton = new InputManager();
            return singleton;
        },
    };
})();
