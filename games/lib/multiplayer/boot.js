/**
 * Boot entry, loaded by every game page as `<script type="module">`.
 *
 * The shared protocol module is served by the Node server; on a
 * static-only host (no server) its import fails and the layer quietly
 * disables itself instead of breaking the game. Same for any unexpected
 * runtime error: the game must always keep working standalone.
 */
import { config } from './config.js';

(async () => {
  try {
    const [P, { bootstrap }] = await Promise.all([
      import(config.protocolUrl),
      import('./main.js'),
    ]);
    bootstrap(P);
  } catch (err) {
    console.warn('[mp] multiplayer layer unavailable:', err?.message ?? err);
  }
})();
