import path from 'node:path';
import express from 'express';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Allowlist guard — sits BEFORE express.static so nothing outside the
 * production surface (landing page, games/, img/, shared protocol module)
 * is ever read from disk: no .git, tools/, server/, .env, HAR files, docs.
 */
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
