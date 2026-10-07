/* Shared mobile shell for all six game pages. The legacy game renderer keeps
 * ownership of its canvas; this layer only supplies viewport policy and safe UI. */
(function () {
  'use strict';
  var BUILD = 'mobile-shell-2026-10-07';
  var root = document.documentElement;
  var body = document.body;
  var viewportMeta = document.querySelector('meta[name="viewport"]');
  if (viewportMeta) {
    viewportMeta.setAttribute('content', 'width=device-width, initial-scale=1, viewport-fit=cover, maximum-scale=1, user-scalable=no');
  }
  if (new URLSearchParams(location.search).has('room')) body.classList.add('fb-room');

  root.classList.add('fb-mobile-shell');
  root.style.setProperty('--fb-safe-top', 'env(safe-area-inset-top, 0px)');
  root.style.setProperty('--fb-safe-right', 'env(safe-area-inset-right, 0px)');
  root.style.setProperty('--fb-safe-bottom', 'env(safe-area-inset-bottom, 0px)');
  root.style.setProperty('--fb-safe-left', 'env(safe-area-inset-left, 0px)');

  var style = document.createElement('style');
  style.textContent = [
    'html.fb-mobile-shell, html.fb-mobile-shell body { width:100%; min-height:100%; height:100%; overflow:hidden; overscroll-behavior:none; background:#000; }',
    'html.fb-mobile-shell body { -webkit-user-select:none; user-select:none; -webkit-touch-callout:none; }',
    '#container { position:fixed !important; inset:0; display:grid; place-items:center; overflow:hidden; background:#000; }',
    '#container canvas { display:block !important; margin:auto !important; max-width:100% !important; max-height:100% !important; width:auto !important; height:auto !important; object-fit:contain; }',
    'body.fb-room #btn-back { display:none !important; }',
    '#fb-rotate { position:fixed; inset:0; z-index:2147483646; display:none; place-items:center; padding:24px; text-align:center; background:#080a0f; color:#fff; font:600 18px/1.5 system-ui,sans-serif; }',
    '#fb-rotate.show { display:grid; } #fb-rotate span { display:block; margin:8px auto 0; color:#aab3c1; font-size:14px; font-weight:400; }',
    '#fb-shell-tools { position:fixed; z-index:2147483000; top:calc(8px + var(--fb-safe-top)); right:calc(8px + var(--fb-safe-right)); display:flex; gap:6px; }',
    '#fb-shell-tools button { min-width:40px; min-height:36px; padding:7px 10px; border:1px solid rgba(255,255,255,.18); border-radius:9px; background:rgba(0,0,0,.55); color:#fff; font:600 12px system-ui,sans-serif; }',
    'body.fb-ios-browser #fb-fullscreen { font-size:11px; opacity:.82; }',
    '@media (orientation:landscape) { #fb-rotate.show { display:none; } }',
  ].join('');
  document.head.appendChild(style);

  var rotate = document.createElement('div');
  rotate.id = 'fb-rotate';
  rotate.setAttribute('role', 'status');
  rotate.innerHTML = '请旋转手机至横屏<span>横屏后会自动继续游戏</span>';
  body.appendChild(rotate);

  var tools = document.createElement('div');
  tools.id = 'fb-shell-tools';
  tools.innerHTML = '<button type="button" id="fb-fullscreen" aria-label="进入全屏">全屏</button>';
  body.appendChild(tools);

  function portrait() { return matchMedia('(orientation: portrait)').matches; }
  function updateOrientation() { rotate.classList.toggle('show', portrait() && Math.min(innerWidth, innerHeight) <= 700); }
  addEventListener('resize', updateOrientation, { passive: true });
  addEventListener('orientationchange', updateOrientation, { passive: true });
  updateOrientation();

  var fullscreenButton = document.getElementById('fb-fullscreen');
  var canFullscreen = Boolean(document.documentElement.requestFullscreen || document.documentElement.webkitRequestFullscreen);
  var isIosBrowser = /iPhone|iPad|iPod/i.test(navigator.userAgent) && !navigator.standalone;
  if (isIosBrowser) {
    body.classList.add('fb-ios-browser');
    fullscreenButton.textContent = '加入主屏幕';
    fullscreenButton.title = 'iPhone/iPad 请使用“加入主屏幕”获得无地址栏体验';
  } else if (!canFullscreen) {
    fullscreenButton.style.display = 'none';
  }
  fullscreenButton.addEventListener('click', function () {
    if (isIosBrowser && !canFullscreen) {
      fullscreenButton.textContent = '请从分享菜单加入主屏幕';
      setTimeout(function () { fullscreenButton.textContent = '加入主屏幕'; }, 3000);
      return;
    }
    var el = document.documentElement;
    var request = el.requestFullscreen || el.webkitRequestFullscreen;
    if (!request) return;
    try {
      Promise.resolve(request.call(el)).then(function () {
        try { if (screen.orientation && screen.orientation.lock) screen.orientation.lock('landscape').catch(function () {}); } catch (_) {}
      }).catch(function () {});
    } catch (_) {}
  });

  function unlockAudio() {
    try {
      var Ctx = window.AudioContext || window.webkitAudioContext;
      if (Ctx && Ctx.prototype && Ctx.prototype.resume) {
        document.dispatchEvent(new CustomEvent('fb-audio-unlock'));
      }
      document.querySelectorAll('audio').forEach(function (audio) {
        if (audio.paused) { var p = audio.play(); if (p && p.catch) p.catch(function () {}); }
        audio.muted = audio.muted;
      });
    } catch (_) {}
    removeEventListener('pointerdown', unlockAudio, true);
    removeEventListener('keydown', unlockAudio, true);
  }
  addEventListener('pointerdown', unlockAudio, true);
  addEventListener('keydown', unlockAudio, true);
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) document.dispatchEvent(new CustomEvent('fb-audio-resume'));
  });

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/games/sw.js?v=' + encodeURIComponent(BUILD), { scope: '/games/' }).then(function (reg) {
      if (reg.waiting) reg.waiting.postMessage({ type: 'SKIP_WAITING', build: BUILD });
      reg.addEventListener('updatefound', function () {
        var worker = reg.installing;
        if (worker) worker.addEventListener('statechange', function () { if (worker.state === 'installed' && navigator.serviceWorker.controller) worker.postMessage({ type: 'SKIP_WAITING', build: BUILD }); });
      });
    }).catch(function () {});
  }
})();
