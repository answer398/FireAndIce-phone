/**
 * Touch pads UI for the unified input system (all six games).
 *
 * Renders the on-screen pads described by FBInput.manager().getLocalRoles():
 *   - Watergirl ('wg') pad on the LEFT edge  (blue)  — the engine's own seat side
 *   - Fireboy  ('fb') pad on the RIGHT edge  (red)
 * Each pad shows exactly three big, semi-transparent buttons — left / jump /
 * right — with NO key names: the role->key mapping stays inside the manager.
 *
 * Multi-touch: built on Pointer Events with per-pointer setPointerCapture, so
 * holding a direction while tapping jump works, a thumb sliding off a button
 * still releases it, and every finger is tracked independently. Browsers
 * without PointerEvent fall back to touch events (implicit per-target
 * capture gives the same behaviour). Releases are wired to pointerup,
 * pointercancel, lostpointercapture, a document-level safety net, and the
 * manager's blur/visibility/pagehide flush — every abnormal path ends with
 * all keys released so a character can never keep walking.
 *
 * The pads never talk to the network: they only call
 * FBInput.manager().setAction(role, action, pressed, 'local', {kind:'touch'}).
 * Forwarding local events to the remote peer is the multiplayer layer's job.
 *
 * Mobile environment hardening (viewport, gestures, safe areas) is installed
 * here too — it is what makes the landscape layout usable on phones:
 *   - viewport meta gains maximum-scale=1 / user-scalable=no /
 *     viewport-fit=cover (so env(safe-area-inset-*) works in landscape)
 *   - pinch gestures, double-tap zoom, pull-to-refresh, page drag,
 *     long-press menus and text selection are suppressed
 *   - none of it ever swallows events targeted at the game canvas — global
 *     handlers check the event target and only act inside the pad/hint UI
 *
 * This file is a classic script with no dependencies besides input-manager.js.
 */
(function () {
    'use strict';

    if (!window.FBInput) {
        if (window.console) console.error('[FBInputPads] input-manager.js must load first');
        return;
    }

    var manager = window.FBInput.manager();
    var ROLE_INFO = {
        wg: { side: 'left', color: 'water', label: '水娃' },
        fb: { side: 'right', color: 'fire', label: '火娃' },
    };

    // ---- environment --------------------------------------------------------------

    /** True when the device has touch capability (phones, tablets, hybrids). */
    function isTouchDevice() {
        return ('ontouchstart' in window) || (navigator.maxTouchPoints || 0) > 0;
    }

    var touchDevice = isTouchDevice();
    /** Desktop guests can request pads explicitly (mouse-operable). */
    var padsForced = false;
    /** Multiplayer bridge may hide the pads (e.g. host still in the menu). */
    var padsVisible = true;

    /**
     * Patch (never duplicate) the viewport meta: add fullscreen-landscape
     * essentials without touching whatever the page already set.
     */
    function hardenViewport() {
        var meta = document.querySelector('meta[name="viewport"]');
        if (!meta) {
            meta = document.createElement('meta');
            meta.name = 'viewport';
            (document.head || document.documentElement).appendChild(meta);
        }
        var wanted = {
            'maximum-scale': '1',
            'user-scalable': 'no',
            'viewport-fit': 'cover',
        };
        var parts = (meta.getAttribute('content') || '')
            .split(',')
            .map(function (s) { return s.trim(); })
            .filter(Boolean);
        var seen = {};
        parts.forEach(function (p) { seen[p.split('=')[0]] = true; });
        Object.keys(wanted).forEach(function (k) {
            if (!seen[k]) parts.push(k + '=' + wanted[k]);
        });
        meta.setAttribute('content', parts.join(', '));
    }

    /** Global gesture/drag suppression — canvas events are never touched. */
    function hardenGestures() {
        // iOS pinch zoom (Safari ignores user-scalable=no since iOS 10).
        ['gesturestart', 'gesturechange', 'gestureend'].forEach(function (type) {
            document.addEventListener(type, function (e) { e.preventDefault(); });
        });
        // Double-tap zoom belt-and-braces for browsers without touch-action.
        document.addEventListener('dblclick', function (e) { e.preventDefault(); });

        // Rubber-band / pull-to-refresh: CSS overscroll-behavior covers modern
        // browsers; inside the pad UI itself, swallow touches so a thumb
        // sliding across buttons can never drag the page. Targets outside the
        // pad/hint UI (above all: the game canvas) pass through untouched.
        document.addEventListener('touchmove', function (e) {
            var t = e.target;
            if (t && t.closest && t.closest('.tc-pad, .tc-rotate')) e.preventDefault();
        }, { passive: false });

        document.addEventListener('dragstart', function (e) {
            if (e.target && e.target.closest && e.target.closest('.tc-pad, .tc-rotate')) {
                e.preventDefault();
            }
        });
    }

    // ---- styles ---------------------------------------------------------------------

    var css = [
        '/* injected by games/lib/input/touch-pads.js */',
        'html, body {',
        '  overscroll-behavior: none;',             /* no pull-to-refresh / rubber band */
        '  touch-action: manipulation;',            /* kills double-tap zoom, keeps taps */
        '  -webkit-tap-highlight-color: transparent;',
        '}',
        'body {',
        '  user-select: none; -webkit-user-select: none;',
        '  -webkit-touch-callout: none;',           /* no iOS long-press menu */
        '}',
        'canvas { touch-action: manipulation; }',   /* canvas events themselves untouched */
        '',
        '.tc-pad {',
        '  position: fixed;',
        '  bottom: calc(10px + env(safe-area-inset-bottom, 0px));',
        '  z-index: 2147480002;',                   /* above the guest video layer */
        '  display: flex; flex-direction: column; align-items: center; gap: 8px;',
        '  pointer-events: auto;',                  /* dead zone swallows stray thumbs */
        '  touch-action: none;',
        '  user-select: none; -webkit-user-select: none;',
        '}',
        '.tc-pad-left  { left:  calc(10px + env(safe-area-inset-left, 0px)); }',
        '.tc-pad-right { right: calc(10px + env(safe-area-inset-right, 0px)); }',
        '.tc-label {',
        '  pointer-events: none; text-align: center; width: 100%;',
        '  font: bold 10px/1 sans-serif; letter-spacing: 1px;',
        '}',
        '.tc-label-water { color: rgba(51,204,255,0.5); }',
        '.tc-label-fire  { color: rgba(255,77,77,0.5); }',
        '.tc-row { display: flex; gap: 8px; justify-content: center; }',
        '.tc-btn {',
        '  width: 92px; height: 92px; border-radius: 18px;',
        '  border: 2px solid; box-sizing: border-box;',
        '  display: flex; align-items: center; justify-content: center;',
        '  font: bold 26px/1 sans-serif; text-align:center;',
        '  touch-action: none; user-select: none; -webkit-user-select: none;',
        '  transition: background 0.08s, border-color 0.08s;',
        '}',
        '.tc-btn-jump { border-radius: 50%; }',
        '.tc-btn-water {',
        '  background: rgba(51,204,255,0.12); border-color: rgba(51,204,255,0.30);',
        '  color: rgba(51,204,255,0.65);',
        '}',
        '.tc-btn-water.active { background: rgba(51,204,255,0.38); border-color: rgba(51,204,255,0.60); }',
        '.tc-btn-fire {',
        '  background: rgba(255,77,77,0.12); border-color: rgba(255,77,77,0.30);',
        '  color: rgba(255,77,77,0.65);',
        '}',
        '.tc-btn-fire.active { background: rgba(255,77,77,0.38); border-color: rgba(255,77,77,0.60); }',
        '',
        '/* tablets / large screens: roomier pads */',
        '@media (min-width: 768px) {',
        '  .tc-pad { bottom: calc(16px + env(safe-area-inset-bottom, 0px)); gap: 12px; }',
        '  .tc-pad-left  { left:  calc(16px + env(safe-area-inset-left, 0px)); }',
        '  .tc-pad-right { right: calc(16px + env(safe-area-inset-right, 0px)); }',
        '  .tc-row { gap: 12px; }',
        '  .tc-label { font-size: 13px; }',
        '  .tc-btn { width: 120px; height: 120px; border-radius: 24px; font-size: 32px; }',
        '}',
        '/* landscape phones: compact pads. Declared AFTER the width rule so a',
        '   phone that matches both (e.g. 844x390 iPhone landscape) gets the',
        '   compact size, not the tablet size. */',
        '@media (max-height: 480px) {',
        '  .tc-pad { bottom: calc(8px + env(safe-area-inset-bottom, 0px)); gap: 6px; }',
        '  .tc-row { gap: 6px; }',
        '  .tc-btn { width: 68px; height: 68px; border-radius: 14px; font-size: 20px; }',
        '}',
        '/* desktop with a mouse: pads off unless explicitly requested */',
        '@media (min-width: 900px) and (hover: hover) {',
        '  body:not(.tc-force) .tc-pad { display: none !important; }',
        '}',
        'body.tc-pads-hidden .tc-pad { display: none !important; }',
        '',
        '/* portrait rotate hint (touch devices only, see JS) */',
        '.tc-rotate {',
        '  position: fixed; inset: 0; z-index: 2147480003;',
        '  width: 100vw; height: 100vh; height: 100dvh;',
        '  display: none; align-items: center; justify-content: center;',
        '  background: rgba(0,0,0,0.72);',
        '}',
        '.tc-rotate.tc-show { display: flex; }',
        '.tc-rotate-card { text-align: center; color: #fff; font-family: sans-serif; }',
        '.tc-rotate-icon { font-size: 54px; line-height: 1; animation: tc-spin 2.4s ease-in-out infinite; }',
        '@keyframes tc-spin { 0%,100% { transform: rotate(0); } 50% { transform: rotate(90deg); } }',
        '.tc-rotate-text { margin-top: 14px; font-size: 16px; opacity: 0.9; }',
        '.tc-rotate-fs {',
        '  margin: 16px auto 0; display: block; padding: 10px 22px;',
        '  font-size: 14px; color: #fff; border-radius: 999px;',
        '  background: rgba(255,255,255,0.14); border: 1px solid rgba(255,255,255,0.35);',
        '}',
        '.tc-rotate-hint { margin-top: 10px; font-size: 12px; opacity: 0.55; }',
        '@media (orientation: landscape) { .tc-rotate { display: none !important; } }',
    ].join('\n');

    function injectStyles() {
        var style = document.createElement('style');
        style.textContent = css;
        document.head.appendChild(style);
    }

    // ---- rotate hint -------------------------------------------------------------------

    var rotateHint = null;
    var rotateDismissed = false;

    function buildRotateHint() {
        rotateHint = document.createElement('div');
        rotateHint.className = 'tc-rotate';
        rotateHint.innerHTML = [
            '<div class="tc-rotate-card">',
            '  <div class="tc-rotate-icon">&#10227;</div>',
            '  <div class="tc-rotate-text">建议横屏游玩</div>',
            '  <button class="tc-rotate-fs" type="button">全屏并锁定横屏</button>',
            '  <div class="tc-rotate-hint">点按任意位置继续</div>',
            '</div>',
        ].join('');

        rotateHint.addEventListener('click', function () { dismissRotateHint(); });
        rotateHint.querySelector('.tc-rotate-fs').addEventListener('click', function (e) {
            e.stopPropagation();
            requestLandscapeFullscreen();
            dismissRotateHint();
        });
        document.body.appendChild(rotateHint);
    }

    function dismissRotateHint() {
        rotateDismissed = true;
        if (rotateHint) rotateHint.classList.remove('tc-show');
    }

    function updateRotateHint() {
        if (!touchDevice || rotateDismissed || !rotateHint) return;
        var portrait = window.matchMedia('(orientation: portrait)').matches;
        var small = Math.min(window.innerWidth, window.innerHeight) <= 500;
        var show = Boolean(portrait && small);
        rotateHint.classList.toggle('tc-show', show);
        if (show) {
            // Never trap anyone in portrait: continue automatically.
            setTimeout(function () {
                if (rotateHint) rotateHint.classList.remove('tc-show');
            }, 5000);
        }
    }

    /**
     * Fullscreen + orientation lock; must run inside a user gesture. Every
     * step degrades silently where unsupported (e.g. iOS Safari).
     */
    function requestLandscapeFullscreen() {
        var el = document.documentElement;
        var req = el.requestFullscreen || el.webkitRequestFullscreen;
        if (!req) return;
        try {
            var p = req.call(el);
            Promise.resolve(p).then(function () {
                try {
                    if (screen.orientation && screen.orientation.lock) {
                        screen.orientation.lock('landscape').catch(function () {});
                    }
                } catch (err) { /* orientation lock unsupported */ }
            }).catch(function () { /* fullscreen refused */ });
        } catch (err) { /* requestFullscreen unsupported */ }
    }

    // ---- pads -----------------------------------------------------------------------------

    var padRoot = null; // container div holding one .tc-pad per local role

    /**
     * Registry of live pointer holds across ALL buttons:
     * { pointerId, release } — the document-level safety net walks it when a
     * pointerup/pointercancel escapes the owning button.
     */
    var pointerHolds = [];

    /** Pointer-event binding with per-pointer capture. */
    function bindButton(btn, role, action) {
        var heldPointer = null; // pointerId currently holding this button, or null

        var release = function (e) {
            if (heldPointer === null) return;
            if (e && e.pointerId !== undefined && e.pointerId !== heldPointer) return;
            var id = heldPointer;
            heldPointer = null;
            dropHold(id);
            manager.setAction(role, action, false, 'local', { kind: 'touch' });
        };

        btn.addEventListener('pointerdown', function (e) {
            if (heldPointer !== null) return; // already held by another finger
            e.preventDefault();
            heldPointer = e.pointerId;
            pointerHolds.push({ pointerId: e.pointerId, release: release });
            try {
                btn.setPointerCapture(e.pointerId);
            } catch (err) { /* capture unavailable: the document net still catches */ }
            manager.setAction(role, action, true, 'local', { kind: 'touch' });
        });
        btn.addEventListener('pointerup', release);
        btn.addEventListener('pointercancel', release);
        btn.addEventListener('lostpointercapture', function (e) {
            // Capture vanished (element moved/hidden, pointer aborted): if this
            // button is still held, release it now.
            if (heldPointer !== null && (e.pointerId === undefined || e.pointerId === heldPointer)) {
                release(null);
            }
        });
        btn.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    }

    function dropHold(pointerId) {
        for (var i = pointerHolds.length - 1; i >= 0; i--) {
            if (pointerHolds[i].pointerId === pointerId) {
                pointerHolds.splice(i, 1);
                return;
            }
        }
    }

    // Document-level safety net: if a pointerup/pointercancel for a held
    // pointer ever escapes the owning button (capture failed, button rebuilt
    // mid-hold), release the hold anyway. Runs in capture phase so nothing
    // can swallow it first; the button's own release() is idempotent.
    ['pointerup', 'pointercancel'].forEach(function (type) {
        document.addEventListener(type, function (e) {
            for (var i = pointerHolds.length - 1; i >= 0; i--) {
                if (pointerHolds[i].pointerId === e.pointerId) {
                    var entry = pointerHolds[i];
                    pointerHolds.splice(i, 1);
                    entry.release(e);
                }
            }
        }, true);
    });

    /** Touch-event fallback for browsers without PointerEvent. */
    function bindButtonTouchFallback(btn, role, action) {
        var held = false;
        btn.addEventListener('touchstart', function (e) {
            e.preventDefault();
            held = true;
            manager.setAction(role, action, true, 'local', { kind: 'touch' });
        }, { passive: false });
        var release = function () {
            if (!held) return;
            held = false;
            manager.setAction(role, action, false, 'local', { kind: 'touch' });
        };
        btn.addEventListener('touchend', release);
        btn.addEventListener('touchcancel', release);
        // Mouse fallback for hybrid/forced-desktop use.
        btn.addEventListener('mousedown', function (e) {
            e.preventDefault();
            held = true;
            manager.setAction(role, action, true, 'local', { kind: 'touch' });
        });
        btn.addEventListener('mouseup', release);
        btn.addEventListener('mouseleave', release);
        btn.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    }

    function makeButton(role, action, text) {
        var info = ROLE_INFO[role];
        var btn = document.createElement('div');
        btn.className = 'tc-btn tc-btn-' + info.color + (action === 'up' ? ' tc-btn-jump' : '');
        btn.setAttribute('data-role', role);
        btn.setAttribute('data-action', action);
        btn.innerHTML = '<span>' + text + '</span>';
        if (window.PointerEvent) {
            bindButton(btn, role, action);
        } else {
            bindButtonTouchFallback(btn, role, action);
        }
        return btn;
    }

    function buildPad(role) {
        var info = ROLE_INFO[role];
        var pad = document.createElement('div');
        pad.className = 'tc-pad tc-pad-' + info.side;

        var label = document.createElement('div');
        label.className = 'tc-label tc-label-' + info.color;
        label.textContent = info.label;
        pad.appendChild(label);

        // Jump sits above the direction row: a thumb rests on left/right and
        // slides straight up to jump — hold direction + jump works natively
        // because every button tracks its own pointer.
        var jumpRow = document.createElement('div');
        jumpRow.className = 'tc-row';
        jumpRow.appendChild(makeButton(role, 'up', '跳'));
        pad.appendChild(jumpRow);

        var dirRow = document.createElement('div');
        dirRow.className = 'tc-row';
        dirRow.appendChild(makeButton(role, 'left', '◀'));
        dirRow.appendChild(makeButton(role, 'right', '▶'));
        pad.appendChild(dirRow);

        // Dead-zone swallow: a touch landing on the pad's gaps must not reach
        // the game canvas (prevents accidental in-game clicks).
        ['pointerdown', 'touchstart', 'mousedown'].forEach(function (type) {
            pad.addEventListener(type, function (e) {
                if (e.target === pad) e.preventDefault();
            });
        });

        return pad;
    }

    /** (Re)build pads for the manager's current local roles. */
    function renderPads() {
        if (!padRoot) return;
        // Buttons about to be destroyed must not leave holds behind: release
        // everything still pressed (the manager state stays authoritative).
        pointerHolds.slice().forEach(function (entry) { entry.release(null); });
        pointerHolds.length = 0;
        while (padRoot.firstChild) padRoot.removeChild(padRoot.firstChild);
        manager.getLocalRoles().forEach(function (role) {
            padRoot.appendChild(buildPad(role));
        });
        applyVisibility();
    }

    function applyVisibility() {
        var show = (touchDevice || padsForced) && padsVisible;
        document.body.classList.toggle('tc-pads-hidden', !show);
        document.body.classList.toggle('tc-force', padsForced);
    }

    /** Keep button visuals in sync with the authoritative manager state. */
    manager.onEvent(function (ev) {
        if (ev.source !== 'local' || !padRoot) return;
        var btn = padRoot.querySelector(
            '.tc-btn[data-role="' + ev.role + '"][data-action="' + ev.action + '"]'
        );
        if (!btn) return;
        if (ev.type === 'pressed' && ev.inputKind === 'touch') btn.classList.add('active');
        if (ev.type === 'released') btn.classList.remove('active');
    });

    manager.onRolesChanged(function () { renderPads(); });

    // ---- init -------------------------------------------------------------------------------

    function init() {
        injectStyles();
        hardenViewport();
        hardenGestures();

        padRoot = document.createElement('div');
        padRoot.id = 'tc-pads';
        document.body.appendChild(padRoot);
        renderPads();

        if (touchDevice) {
            buildRotateHint();
            updateRotateHint();
            window.addEventListener('orientationchange', updateRotateHint);
            if (window.visualViewport) {
                window.visualViewport.addEventListener('resize', updateRotateHint);
            }
        }
    }

    window.FBInputPads = {
        /** Render pads even without touch capability (desktop guests). */
        forceVisible: function (on) {
            padsForced = on !== false;
            applyVisibility();
        },
        /** Show/hide the pads without destroying them (multiplayer gating). */
        setVisible: function (on) {
            padsVisible = on !== false;
            applyVisibility();
        },
        /** Fullscreen + landscape lock; call from a user gesture. */
        requestLandscapeFullscreen: requestLandscapeFullscreen,
        /** Show the portrait hint on demand (diagnostics; normally gated on
         * touch capability + portrait orientation at init/rotate time). */
        showRotateHint: function () {
            if (!rotateHint) buildRotateHint();
            rotateHint.classList.add('tc-show');
        },
        /** Re-render pads from current roles (diagnostics). */
        refresh: renderPads,
    };

    if (document.body) {
        init();
    } else {
        document.addEventListener('DOMContentLoaded', init);
    }
})();
