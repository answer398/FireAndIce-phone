/**
 * Styles for the multiplayer overlay, injected once. Scoped under `.mp-*`
 * class names so they can never collide with game UI. Phone-first: big
 * touch targets, safe-area padding, no hover dependence.
 */
export const STYLES = `
.mp-root {
  --mp-accent: #ff4d4d;
  --mp-accent2: #33ccff;
  --mp-bg: rgba(10, 12, 18, 0.94);
  --mp-border: rgba(255, 255, 255, 0.12);
  --mp-ok: #35d07f;
  font-family: 'Segoe UI', system-ui, sans-serif;
  color: #fff;
}

#mp-chip {
  position: fixed; top: calc(8px + env(safe-area-inset-top, 0px)); left: 50%; transform: translateX(-50%);
  z-index: 2147480000;
  padding: 7px 15px; border-radius: 999px;
  background: var(--mp-bg); border: 1px solid var(--mp-border);
  font-size: 12px; letter-spacing: 0.5px; cursor: pointer;
  user-select: none; -webkit-user-select: none; white-space: nowrap;
  max-width: calc(100vw - 24px); overflow: hidden; text-overflow: ellipsis;
}
#mp-chip .mp-dot {
  display: inline-block; width: 8px; height: 8px; border-radius: 50%;
  background: #888; margin-right: 6px; vertical-align: 1px;
}
#mp-chip[data-state="connected"] .mp-dot { background: var(--mp-ok); }
#mp-chip[data-state="connecting"] .mp-dot { background: #ffb020; }
#mp-chip[data-state="disconnected"] .mp-dot { background: var(--mp-accent); }
#mp-chip[data-role="guest"] { top: auto; bottom: calc(14px + env(safe-area-inset-bottom, 0px)); }

#mp-panel {
  position: fixed; top: calc(46px + env(safe-area-inset-top, 0px)); left: 50%; transform: translateX(-50%);
  z-index: 2147480001;
  width: min(360px, calc(100vw - 20px));
  max-height: calc(100dvh - 70px); overflow-y: auto;
  background: var(--mp-bg); border: 1px solid var(--mp-border);
  border-radius: 16px; padding: 16px;
  box-shadow: 0 12px 40px rgba(0,0,0,0.5);
  box-sizing: border-box;
}
#mp-panel h3 { margin: 0 0 10px; font-size: 16px; }
#mp-panel .mp-row { display: flex; gap: 8px; margin: 10px 0; }
#mp-panel .mp-btn {
  flex: 1; padding: 12px 8px; border-radius: 12px; border: 1px solid var(--mp-border);
  background: rgba(255,255,255,0.06); color: #fff; font-size: 15px; cursor: pointer;
  min-height: 44px; box-sizing: border-box;
}
#mp-btn-create { background: rgba(255,77,77,0.25); border-color: rgba(255,77,77,0.5); }
#mp-panel .mp-btn:active { transform: translateY(1px); }
#mp-panel .mp-btn[disabled] { opacity: 0.45; pointer-events: none; }
#mp-btn-ready.mp-btn-on { background: rgba(53,208,127,0.25); border-color: rgba(53,208,127,0.6); }
.mp-btn-leave { background: rgba(255,77,77,0.12) !important; }
#mp-panel .mp-choice { display: flex; gap: 8px; margin-bottom: 6px; }
#mp-panel .mp-choice .mp-btn.mp-on { border-color: var(--mp-accent2); background: rgba(51,204,255,0.25); }
.mp-codewrap { text-align: center; margin-bottom: 10px; }
#mp-panel .mp-code {
  font-size: 34px; font-weight: 700; letter-spacing: 10px; text-align: center;
  padding: 4px 0 2px; color: var(--mp-accent2); user-select: all;
  text-indent: 10px; /* balance letter-spacing */
}
.mp-state { font-size: 13px; color: rgba(255,255,255,0.75); }
.mp-slots { display: flex; gap: 8px; margin: 8px 0; }
.mp-slot {
  flex: 1; border: 1px solid var(--mp-border); border-radius: 12px;
  padding: 9px 10px; font-size: 13px; line-height: 1.7; background: rgba(255,255,255,0.03);
}
.mp-slot-me { border-color: rgba(51,204,255,0.55); }
.mp-slot-off { opacity: 0.75; }
.mp-slot-head { display: flex; justify-content: space-between; align-items: baseline; font-weight: 600; }
.mp-slot-you { font-size: 11px; color: rgba(255,255,255,0.55); font-weight: 400; }
.mp-slot-line.mp-dim { color: rgba(255,255,255,0.45); }
.mp-dot-on, .mp-dot-off {
  display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 4px;
}
.mp-dot-on { background: var(--mp-ok); }
.mp-dot-off { background: #ffb020; animation: mp-blink 1s infinite; }
@keyframes mp-blink { 50% { opacity: 0.3; } }
#mp-panel .mp-hint { font-size: 12px; color: rgba(255,255,255,0.55); line-height: 1.55; }
#mp-panel .mp-joinrow { display: flex; gap: 6px; }
#mp-panel input.mp-input {
  flex: 1; padding: 12px 8px; border-radius: 12px; border: 1px solid var(--mp-border);
  background: rgba(255,255,255,0.08); color: #fff; font-size: 19px;
  letter-spacing: 5px; text-transform: uppercase; text-align: center; min-width: 0;
}
#mp-panel .mp-close { position: absolute; top: 8px; right: 10px; background: none; border: none;
  color: rgba(255,255,255,0.5); font-size: 20px; cursor: pointer; padding: 6px; }

/* Synchronized countdown layer (server-driven startAt). */
#mp-countdown {
  position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
  z-index: 2147480003; display: none;
  font-size: 88px; font-weight: 800; color: #fff;
  text-shadow: 0 0 24px rgba(51,204,255,0.9), 0 4px 18px rgba(0,0,0,0.6);
  pointer-events: none; user-select: none;
}

#mp-video {
  position: fixed; inset: 0; width: 100vw; height: 100vh;
  object-fit: contain; background: #000; z-index: 2147479000;
  display: none;
}
body.mp-guest-active #mp-video { display: block; }

/* Guest/host pads now come from games/lib/input/touch-pads.js (.tc-pad). */

#mp-banner {
  position: fixed; top: calc(46px + env(safe-area-inset-top, 0px)); left: 50%; transform: translateX(-50%);
  z-index: 2147480002; padding: 9px 15px; border-radius: 10px;
  background: var(--mp-bg); border: 1px solid var(--mp-border);
  font-size: 13px; display: none; white-space: nowrap;
  max-width: calc(100vw - 24px); overflow: hidden; text-overflow: ellipsis;
  box-sizing: border-box;
}

/* Full-screen reconnect mask (seat recovery): blocks the canvas so nobody
 * keeps playing against a frozen game, and makes the wait state obvious. */
#mp-mask {
  position: fixed; inset: 0; z-index: 2147480004;
  display: flex; align-items: center; justify-content: center;
  background: rgba(8, 10, 14, 0.78);
  user-select: none; -webkit-user-select: none; touch-action: none;
}
#mp-mask .mp-mask-box {
  display: flex; flex-direction: column; align-items: center; gap: 14px;
  padding: 26px 34px; border-radius: 16px;
  background: var(--mp-bg); border: 1px solid var(--mp-border);
}
#mp-mask .mp-mask-spinner {
  width: 34px; height: 34px; border-radius: 50%;
  border: 4px solid var(--mp-border); border-top-color: #33ccff;
  animation: mp-mask-spin 0.9s linear infinite;
}
@keyframes mp-mask-spin { to { transform: rotate(360deg); } }
#mp-mask .mp-mask-text {
  font-size: 15px; font-weight: 600; color: #fff; text-align: center;
  white-space: pre-line; line-height: 1.5;
}

@media (max-height: 460px) {
  #mp-chip { top: 4px; }
  #mp-panel { top: 36px; max-height: calc(100dvh - 50px); }
  #mp-countdown { font-size: 64px; }
}
`;
