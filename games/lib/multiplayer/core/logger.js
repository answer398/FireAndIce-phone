/**
 * Tagged logger. Verbose output only when `?mpDebug=1` is set, so normal
 * players (and the disabled console.log of the game core) stay untouched.
 */
import { urlFlags } from '../config.js';

const PREFIX = '[mp]';

export const logger = {
  info(...args) {
    console.info(PREFIX, ...args);
  },
  warn(...args) {
    console.warn(PREFIX, ...args);
  },
  error(...args) {
    console.error(PREFIX, ...args);
  },
  debug(...args) {
    if (urlFlags.debug) console.debug(PREFIX, ...args);
  },
};
