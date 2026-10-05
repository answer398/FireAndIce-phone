/**
 * Styles for the multiplayer overlay, injected once. Scoped under `.mp-*`
 * class names so they can never collide with game UI.
 */
export const STYLES = `
.mp-root {
  --mp-accent: #ff4d4d;
  --mp-accent2: #33ccff;
  --mp-bg: rgba(10, 12, 18, 0.92);
  --mp-border: rgba(255, 255, 255, 0.12);
  font-family: 'Segoe UI', system-ui, sans-serif;
  color: #fff;
}

#mp-chip {
  position: fixed; top: 8px; left: 50%; transform: translateX(-50%);
  z-index: 2147480000;
  padding: 6px 14px; border-radius: 999px;
  background: var(--mp-bg); border: 1px solid var(--mp-border);
  font-size: 12px; letter-spacing: 0.5px; cursor: pointer;
  user-select: none; -webkit-user-select: none; white-space: nowrap;
}
#mp-chip .mp-dot {
  display: inline-block; width: 8px; height: 8px; border-radius: 50%;
  background: #888; margin-right: 6px; vertical-align: 1px;
}
#mp-chip[data-state="connected"] .mp-dot { background: #35d07f; }
#mp-chip[data-state="connecting"] .mp-dot { background: #ffb020; }
#mp-chip[data-state="disconnected"] .mp-dot { background: var(--mp-accent); }
#mp-chip[data-role="guest"] { top: auto; bottom: 14px; left: 50%; }

#mp-panel {
  position: fixed; top: 46px; left: 50%; transform: translateX(-50%);
  z-index: 2147480001;
  width: min(340px, calc(100vw - 24px));
  background: var(--mp-bg); border: 1px solid var(--mp-border);
  border-radius: 14px; padding: 16px;
  box-shadow: 0 12px 40px rgba(0,0,0,0.5);
}
#mp-panel h3 { margin: 0 0 10px; font-size: 15px; }
#mp-panel .mp-row { display: flex; gap: 8px; margin: 10px 0; }
#mp-panel .mp-btn {
  flex: 1; padding: 10px 8px; border-radius: 10px; border: 1px solid var(--mp-border);
  background: rgba(255,255,255,0.06); color: #fff; font-size: 14px; cursor: pointer;
}
#mp-btn-create { background: rgba(255,77,77,0.25); border-color: rgba(255,77,77,0.5); }
#mp-panel .mp-btn:active { transform: translateY(1px); }
#mp-panel .mp-choice { display: flex; gap: 8px; margin-bottom: 6px; }
#mp-panel .mp-choice .mp-btn.mp-on { border-color: var(--mp-accent2); background: rgba(51,204,255,0.25); }
#mp-panel .mp-code {
  font-size: 30px; font-weight: 700; letter-spacing: 8px; text-align: center;
  padding: 10px 0 6px; color: var(--mp-accent2); user-select: all;
}
#mp-panel .mp-hint { font-size: 12px; color: rgba(255,255,255,0.55); line-height: 1.5; }
#mp-panel .mp-status { font-size: 13px; margin: 6px 0; }
#mp-panel .mp-status b { color: var(--mp-accent2); }
#mp-panel .mp-joinrow { display: flex; gap: 6px; }
#mp-panel input.mp-input {
  flex: 1; padding: 10px; border-radius: 10px; border: 1px solid var(--mp-border);
  background: rgba(255,255,255,0.08); color: #fff; font-size: 18px;
  letter-spacing: 4px; text-transform: uppercase; text-align: center; min-width: 0;
}
#mp-panel .mp-close { position: absolute; top: 8px; right: 10px; background: none; border: none;
  color: rgba(255,255,255,0.5); font-size: 18px; cursor: pointer; }

#mp-video {
  position: fixed; inset: 0; width: 100vw; height: 100vh;
  object-fit: contain; background: #000; z-index: 2147479000;
  display: none;
}
body.mp-guest-active #mp-video { display: block; }

.mp-pad {
  position: fixed; bottom: 16px; z-index: 2147480002;
  display: flex; flex-direction: column; align-items: center; gap: 10px;
}
.mp-pad-left { left: 12px; }
.mp-pad-right { right: 12px; }
.mp-pad-title { font-size: 11px; opacity: 0.65; letter-spacing: 1px; }
.mp-pad-row { display: flex; gap: 10px; }
.mp-pad-btn {
  width: 76px; height: 76px; border-radius: 18px;
  background: rgba(51,204,255,0.10); border: 2px solid rgba(51,204,255,0.35);
  color: rgba(51,204,255,0.85); font-size: 24px; font-weight: 700;
  display: flex; align-items: center; justify-content: center;
  user-select: none; -webkit-user-select: none; touch-action: none;
}
.mp-pad-right .mp-pad-btn {
  background: rgba(255,77,77,0.10); border-color: rgba(255,77,77,0.35);
  color: rgba(255,77,77,0.85);
}
.mp-pad-btn.active { background: rgba(255,255,255,0.22); }
.mp-pad-btn[data-action="up"] { border-radius: 50%; }

#mp-banner {
  position: fixed; top: 46px; left: 50%; transform: translateX(-50%);
  z-index: 2147480002; padding: 8px 14px; border-radius: 10px;
  background: var(--mp-bg); border: 1px solid var(--mp-border);
  font-size: 13px; display: none; white-space: nowrap;
}

@media (max-height: 420px) {
  .mp-pad-btn { width: 64px; height: 64px; border-radius: 14px; }
  #mp-chip { top: 4px; }
  #mp-panel { top: 38px; }
}
@media (min-width: 900px) and (hover: hover) {
  .mp-pad { display: none !important; }
}
`;
