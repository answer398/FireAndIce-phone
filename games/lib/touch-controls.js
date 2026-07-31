/**
 * Touch Controls for Fireboy & Watergirl
 * Adds virtual D-pad overlays for mobile/touch devices.
 *
 * Watergirl (left side, blue):  W=jump  A=left  D=right
 * Fireboy  (right side, red):   Up=jump Left=left Right=right
 *
 * Dispatches real KeyboardEvent on window so Phaser picks them up.
 */
(function () {
    'use strict';

    if (!('ontouchstart' in window) && !navigator.maxTouchPoints) return;

    var KEYS = {
        W: 87, A: 65, D: 68,
        UP: 38, LEFT: 37, RIGHT: 39
    };

    var pressed = {};

    function fireKey(code, type) {
        var ev = new KeyboardEvent(type, {
            key: code,
            code: '',
            bubbles: true,
            cancelable: true
        });
        try {
            Object.defineProperty(ev, 'keyCode', { value: code, writable: false });
            Object.defineProperty(ev, 'which', { value: code, writable: false });
        } catch (e) {
            ev.keyCode = code;
            ev.which = code;
        }
        window.dispatchEvent(ev);
    }

    function press(code) {
        if (pressed[code]) return;
        pressed[code] = true;
        fireKey(code, 'keydown');
    }

    function release(code) {
        if (!pressed[code]) return;
        pressed[code] = false;
        fireKey(code, 'keyup');
    }

    var css = document.createElement('style');
    css.textContent = [
        '.tc-pad {',
        '  position:fixed; bottom:12px; z-index:9998;',
        '  display:flex; flex-direction:column; align-items:center; gap:8px;',
        '  pointer-events:none;',
        '}',
        '.tc-pad-left  { left:10px; }',
        '.tc-pad-right { right:10px; }',
        '.tc-label {',
        '  pointer-events:none; text-align:center; width:100%;',
        '  font:bold 10px sans-serif; line-height:1;',
        '}',
        '.tc-label-water { color:rgba(51,204,255,0.5); }',
        '.tc-label-fire  { color:rgba(255,77,77,0.5); }',
        '.tc-row {',
        '  display:flex; gap:8px; justify-content:center;',
        '}',
        '.tc-btn {',
        '  pointer-events:auto; width:120px; height:120px; border-radius:20px;',
        '  border:2px solid; font:bold 28px/120px sans-serif; text-align:center;',
        '  user-select:none; -webkit-user-select:none; touch-action:none;',
        '  transition: background 0.08s, border-color 0.08s;',
        '}',
        '.tc-btn-water {',
        '  background:rgba(51,204,255,0.12); border-color:rgba(51,204,255,0.3);',
        '  color:rgba(51,204,255,0.65);',
        '}',
        '.tc-btn-water.active { background:rgba(51,204,255,0.35); border-color:rgba(51,204,255,0.55); }',
        '.tc-btn-fire {',
        '  background:rgba(255,77,77,0.12); border-color:rgba(255,77,77,0.3);',
        '  color:rgba(255,77,77,0.65);',
        '}',
        '.tc-btn-fire.active { background:rgba(255,77,77,0.35); border-color:rgba(255,77,77,0.55); }',
        '.tc-btn-jump {',
        '  width:120px; height:120px; border-radius:60px;',
        '  font-size:22px; line-height:120px;',
        '}',
        '@media (min-width:768px) {',
        '  .tc-pad { bottom:16px; gap:12px; }',
        '  .tc-pad-left  { left:16px; }',
        '  .tc-pad-right { right:16px; }',
        '  .tc-row { gap:12px; }',
        '  .tc-label { font-size:13px; }',
        '  .tc-btn { width:140px; height:140px; border-radius:24px; font-size:32px; line-height:140px; }',
        '  .tc-btn-jump { width:140px; height:140px; border-radius:70px; font-size:24px; line-height:140px; }',
        '}',
        '@media (min-width:900px) and (hover:hover) {',
        '  .tc-pad { display:none !important; }',
        '}'
    ].join('\n');
    document.head.appendChild(css);

    function makePad(side, colorClass, label, buttons) {
        var pad = document.createElement('div');
        pad.className = 'tc-pad tc-pad-' + side;

        var lbl = document.createElement('div');
        lbl.className = 'tc-label tc-label-' + colorClass;
        lbl.textContent = label;
        pad.appendChild(lbl);

        var jumpRow = document.createElement('div');
        jumpRow.className = 'tc-row';
        var jumpBtn = makeBtn(buttons.jump.text, buttons.jump.code, colorClass, true);
        jumpRow.appendChild(jumpBtn);
        pad.appendChild(jumpRow);

        var dirRow = document.createElement('div');
        dirRow.className = 'tc-row';
        dirRow.appendChild(makeBtn(buttons.left.text, buttons.left.code, colorClass, false));
        dirRow.appendChild(makeBtn(buttons.right.text, buttons.right.code, colorClass, false));
        pad.appendChild(dirRow);

        document.body.appendChild(pad);
    }

    function makeBtn(text, code, colorClass, isJump) {
        var btn = document.createElement('div');
        btn.className = 'tc-btn tc-btn-' + colorClass + (isJump ? ' tc-btn-jump' : '');
        btn.textContent = text;
        btn.setAttribute('data-key', code);

        btn.addEventListener('touchstart', function (e) {
            e.preventDefault();
            btn.classList.add('active');
            press(code);
        }, { passive: false });

        btn.addEventListener('touchmove', function (e) {
            e.preventDefault();
        }, { passive: false });

        btn.addEventListener('touchend', function () {
            btn.classList.remove('active');
            release(code);
        });

        btn.addEventListener('touchcancel', function () {
            btn.classList.remove('active');
            release(code);
        });

        btn.addEventListener('contextmenu', function (e) { e.preventDefault(); });

        return btn;
    }

    function init() {
        makePad('left', 'water', 'WATERGIRL', {
            jump:  { text: 'W',  code: KEYS.W },
            left:  { text: 'A',  code: KEYS.A },
            right: { text: 'D',  code: KEYS.D }
        });

        makePad('right', 'fire', 'FIREBOY', {
            jump:  { text: '\u25B2', code: KEYS.UP },
            left:  { text: '\u25C0', code: KEYS.LEFT },
            right: { text: '\u25B6', code: KEYS.RIGHT }
        });
    }

    if (document.body) {
        init();
    } else {
        document.addEventListener('DOMContentLoaded', init);
    }
})();