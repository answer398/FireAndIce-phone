import path from 'node:path';
import fs from 'node:fs';
import express from 'express';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// Manifest paths already start with `assets/`, mirroring the SW's URL join.
const sharedAssetsDir = path.join(repoRoot, 'games', 'shared-assets');

/**
 * Shared-asset manifest. `games/sw.js` is the single source of truth (it
 * powers the GitHub-Pages deployment); the server parses its lists so the
 * same redirect happens WITHOUT a service worker. This matters because a
 * first-time visitor on a fresh browser profile hits the game before the
 * SW activates — on Firefox that window reliably 404s PreloaderAssets and
 * crashes the boot state (`can't access property "x", this._frame is null`).
 */
function parseSwAssetLists() {
  const all = new Set();
  const g1234 = new Set();
  try {
    const sw = fs.readFileSync(path.join(repoRoot, 'games', 'sw.js'), 'utf8');
    const extract = (name) => {
      const match = sw.match(new RegExp(`var ${name} = \\[([\\s\\S]*?)\\]`));
      if (!match) return [];
      return [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
    };
    for (const p of extract('ALL_GAMES')) all.add(p);
    for (const p of extract('GAMES_1234')) g1234.add(p);
  } catch (err) {
    console.warn('[server] could not parse games/sw.js shared lists:', err?.message);
  }
  return { all, g1234 };
}

const SHARED_ALL = parseSwAssetLists();
const GAMES_1234_DIRS = new Set([
  '1-forest-temple',
  '2-light-temple',
  '3-ice-temple',
  '4-crystal-temple',
]);
const GAME_ASSET_RE = /^\/games\/([^/]+)\/(assets\/.+)$/;

/** Allowlist guard — sits BEFORE express.static so nothing outside the
 * production surface (landing page, games/, img/, shared protocol module)
 * is ever read from disk: no .git, tools/, server/, .env, HAR files, docs. */
const ALLOWED_ROOT = new Set(['index.html', 'img', 'games', 'CNAME']);

function isAllowedStaticPath(relPath) {
  const [first] = relPath.split(/[/\\]/);
  if (!ALLOWED_ROOT.has(first)) {
    // Exception: the shared protocol module is part of the browser bundle.
    return /^common[/]protocol[/][^/\\]+[.]mjs$/.test(relPath);
  }
  return true;
}

export function createApp() {
  const app = express();
  app.disable('x-powered-by');

  // Health probe for reverse proxies / uptime checks.
  app.get('/healthz', (req, res) => {
    res.type('text/plain').send('ok');
  });

  // Shared-asset rewrite: /games/<name>/assets/<p> that lives in the SW's
  // shared lists is served straight from games/shared-assets/. Internal
  // (sendFile, no HTTP redirect) so it works identically before the
  // service worker ever activates.
  app.get(GAME_ASSET_RE, (req, res, next) => {
    const [, gameDir, assetPath] = req.path.match(GAME_ASSET_RE);
    const shared = SHARED_ALL.all.has(assetPath) || (SHARED_ALL.g1234.has(assetPath) && GAMES_1234_DIRS.has(gameDir));
    if (!shared) return next();
    const filePath = path.join(sharedAssetsDir, assetPath);
    if (!filePath.startsWith(sharedAssetsDir)) return next();
    res.sendFile(filePath, (err) => {
      if (err) {
        // Fall through to the normal static handling (404 with a clear log).
        if (!res.headersSent) next('route');
      }
    });
  });

  app.use((req, res, next) => {
    let rel;
    try {
      rel = decodeURIComponent(req.path).replace(/^\/+/, '');
    } catch {
      return res.status(400).type('text/plain').send('Bad request');
    }
    if (rel === '' || isAllowedStaticPath(rel)) return next();
    return res.status(403).type('text/plain').send('Forbidden');
  });

  app.use(
    express.static(repoRoot, {
      index: 'index.html',
      dotfiles: 'deny',
      extensions: ['html'],
      setHeaders(res, filePath) {
        // Minified game cores and binary assets are content-stable and go
        // through the Service Worker; everything under lib/ (the multiplayer
        // extension layer) and the shared protocol must always revalidate —
        // ETags keep that cheap (304) while keeping deploys instantly live.
        if (/[.](html|js|mjs)$/i.test(filePath) && /[\\/](lib|common)[\\/]/.test(filePath)) {
          res.setHeader('Cache-Control', 'no-cache');
        } else if (/[.](js|mjs|json|fnt)$/i.test(filePath)) {
          res.setHeader('Cache-Control', 'public, max-age=86400');
        } else if (/[.](png|jpe?g|mp3)$/i.test(filePath)) {
          res.setHeader('Cache-Control', 'public, max-age=86400');
        } else if (filePath.endsWith('.html')) {
          res.setHeader('Cache-Control', 'no-cache');
        }
      },
    }),
  );

  return app;
}

export { repoRoot };
