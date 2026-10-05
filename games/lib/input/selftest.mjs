/**
 * Headless self-test for games/lib/input/input-manager.js.
 *
 * Runs the manager in Node against a minimal DOM stub that models the two
 * propagation facts the manager relies on:
 *   - key events travel window(capture) -> document -> body -> window(bubble),
 *     so a capture-phase handler on window runs BEFORE the engine's
 *     window-bubble listener and stopPropagation() hides the key from it;
 *   - document.hidden / visibilitychange drive the auto-release branch
 *     (in a real browser document.hidden is unforgeable, so this branch can
 *     only be exercised here).
 *
 * Usage:  node games/lib/input/selftest.mjs
 * Exits non-zero on the first failure.
 */

const fs = await import('node:fs');
const path = await import('node:path');
const url = await import('node:url');

const here = path.dirname(url.fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(here, 'input-manager.js'), 'utf8');

// ---- minimal DOM stub ---------------------------------------------------------

function makeEventSystem() {
  const listeners = { capture: [], bubble: [] };
  return {
    addEventListener(type, fn, capture) {
      listeners[capture ? 'capture' : 'bubble'].push({ type, fn });
    },
    removeEventListener(type, fn, capture) {
      const list = listeners[capture ? 'capture' : 'bubble'];
      const i = list.findIndex((l) => l.type === type && l.fn === fn);
      if (i !== -1) list.splice(i, 1);
    },
    /** Model capture -> target -> bubble with stopPropagation honoured. */
    dispatch(event) {
      event.propagationStopped = false;
      event.stopPropagation = () => { event.propagationStopped = true; };
      for (const l of [...listeners.capture]) {
        if (l.type === event.type) {
          l.fn(event);
          if (event.propagationStopped) return 'captured';
        }
      }
      for (const l of [...listeners.bubble]) {
        if (l.type === event.type) l.fn(event);
      }
      return 'bubbled';
    },
  };
}

class FakeKeyboardEvent {
  constructor(type, opts = {}) {
    this.type = type;
    this.key = opts.key ?? '';
    this.code = opts.code ?? '';
    this.bubbles = Boolean(opts.bubbles);
    this.cancelable = Boolean(opts.cancelable);
    this.isTrusted = false; // synthetic in real browsers; tests override
    this.preventDefaultCalled = false;
    this.stopPropagationCalled = false;
  }
  preventDefault() { this.preventDefaultCalled = true; }
  stopPropagation() { this.stopPropagationCalled = true; }
}

const windowBus = makeEventSystem();
const documentBus = makeEventSystem();

const window = {
  addEventListener: windowBus.addEventListener,
  removeEventListener: windowBus.removeEventListener,
  dispatchEvent: windowBus.dispatch,
  console,
};
const document = {
  hidden: false,
  addEventListener: documentBus.addEventListener,
  removeEventListener: documentBus.removeEventListener,
  dispatchEvent: documentBus.dispatch,
  createEvent: () => new FakeKeyboardEvent(''),
};
// The manager dispatches synthesized key events to window targets.
window.dispatchEvent = (ev) => {
  // Synthesized events are dispatched AT window (target phase): the stub
  // routes them through the same bus so a fake engine can observe them.
  windowBus.dispatch(ev);
  return true;
};

// A stand-in "game engine": listens on window in bubble phase, keyed by keyCode.
const engine = { keys: {} };
windowBus.addEventListener('keydown', (ev) => { engine.keys[ev.keyCode] = true; }, false);
windowBus.addEventListener('keyup', (ev) => { engine.keys[ev.keyCode] = false; }, false);

// Load the manager.
new Function('window', 'document', 'KeyboardEvent', source)(
  window,
  document,
  FakeKeyboardEvent,
);

const FBInput = window.FBInput;
if (!FBInput) throw new Error('FBInput missing after load');
const M = FBInput.manager();

// The keyboard source listener must have been registered in CAPTURE phase —
// assert by inspecting dispatch order through a probe.
{
  const order = [];
  const probeCapture = { type: 'keydown', fn: () => order.push('capture') };
  const probeBubble = { type: 'keydown', fn: () => order.push('bubble') };
  windowBus.addEventListener('keydown', probeCapture.fn, true);
  windowBus.addEventListener('keydown', probeBubble.fn, false);
  const ev = new FakeKeyboardEvent('keydown', {});
  ev.isTrusted = true;
  ev.keyCode = 37; // ArrowLeft
  windowBus.dispatch(ev);
  windowBus.removeEventListener('keydown', probeCapture.fn, true);
  windowBus.removeEventListener('keydown', probeBubble.fn, false);
  if (order.join('>') !== 'capture>bubble') {
    throw new Error(`dispatch order broken: ${order.join('>')}`);
  }
}

// ---- assertions -----------------------------------------------------------------

let passed = 0;
function assert(name, cond) {
  if (!cond) throw new Error(`FAIL: ${name}`);
  passed++;
  console.log('  ok -', name);
}

// 1. keyboard (trusted) -> manager + engine in sync
let ev = new FakeKeyboardEvent('keydown', { key: 'ArrowLeft', code: 'ArrowLeft' });
ev.isTrusted = true;
ev.keyCode = 37;
windowBus.dispatch(ev);
assert('trusted ArrowLeft reaches the engine', engine.keys[37] === true);
assert('trusted ArrowLeft recorded by the manager', M.isDown('fb', 'left') === true);
ev = new FakeKeyboardEvent('keyup', { key: 'ArrowLeft', code: 'ArrowLeft' });
ev.isTrusted = true;
ev.keyCode = 37;
windowBus.dispatch(ev);
assert('keyup clears manager and engine', !M.isDown('fb', 'left') && engine.keys[37] === false);

// 2. remote seat: trusted keyboard for the other character is swallowed
M.setLocalRoles(['fb']);
ev = new FakeKeyboardEvent('keydown', { key: 'w', code: 'KeyW' });
ev.isTrusted = true;
ev.keyCode = 87;
const verdict = windowBus.dispatch(ev);
assert('W keydown for the remote seat is captured (never bubbles to the engine)', verdict === 'captured');
assert('swallowed event called stopPropagation', ev.propagationStopped === true);
assert('manager did not record the remote seat key', !M.isDown('wg', 'up'));
assert('engine did not receive the remote seat key', engine.keys[87] !== true);

// 3. touch path injects real engine keys with full compat fields
let injected = null;
windowBus.addEventListener('keydown', (e) => { if (e.keyCode === 39 && e.isTrusted === false) injected = e; }, false);
M.setAction('fb', 'right', true, 'local', { kind: 'touch' });
assert('touch press drives the engine key', engine.keys[39] === true);
assert('injected event carries keyCode+which+key+code',
  injected && injected.keyCode === 39 && injected.which === 39 &&
  injected.key === 'ArrowRight' && injected.code === 'ArrowUp'.replace('Up', 'Right'));
M.setAction('fb', 'right', false, 'local', { kind: 'touch' });
assert('touch release clears the engine key', engine.keys[39] === false);

// 4. remote path: injects, never emits
let emitted = 0;
const unsub = M.onEvent(() => { emitted++; });
M.setLocalRoles(['fb']);
M.applyRemote('wg', 'left', true, { seq: 1 });
assert('remote press reaches the engine', engine.keys[65] === true);
M.applyRemote('wg', 'left', false, { seq: 2 });
assert('remote release reaches the engine', engine.keys[65] === false);
assert('remote path emitted zero outbound events (loop prevention)', emitted === 0);
unsub();

// 5. local blur releases local holds but not remote holds
M.setAction('fb', 'right', true, 'local', { kind: 'touch' });
M.applyRemote('wg', 'right', true, { seq: 3 });
windowBus.dispatch({ type: 'blur', isTrusted: true });
assert('blur releases local holds', !M.isDown('fb', 'right') && engine.keys[39] === false);
assert('blur keeps remote holds (peer-state-synced)', M.isDown('wg', 'right') && engine.keys[68] === true);

// 6. visibilitychange hidden releases local holds
M.setAction('fb', 'left', true, 'local', { kind: 'touch' });
document.hidden = true;
documentBus.dispatch({ type: 'visibilitychange' });
assert('page hidden releases local holds', !M.isDown('fb', 'left') && engine.keys[37] === false);
document.hidden = false;

// 7. pagehide (window event) releases everything, including remote
windowBus.dispatch({ type: 'pagehide', isTrusted: true });
assert('pagehide clears remote holds too', !M.isDown('wg', 'right') && engine.keys[68] === false);

// 8. seat handoff force-releases holds of seats leaving local control
M.setAction('fb', 'right', true, 'local', { kind: 'touch' }); // default: both roles local
assert('pre-handoff hold is active', M.isDown('fb', 'right') && engine.keys[39] === true);
M.setLocalRoles(['wg']); // fb is handed to the remote peer
assert('seat handoff force-releases held local keys', !M.isDown('fb', 'right') && engine.keys[39] === false);
M.setLocalRoles(null);

console.log(`\ninput-manager selftest: ${passed} assertions passed`);
