/**
 * Character -> key-code mapping (multiplayer side).
 *
 * The single source of truth is games/lib/input/input-manager.js (FBInput),
 * whose tables mirror the engine's CharCursors bindings exactly. This module
 * re-exports them for the ES-module side of the multiplayer layer so the
 * classic-script world and the module world can never drift apart.
 */
const FBInput = window.FBInput;
if (!FBInput) {
  throw new Error('games/lib/input/input-manager.js must load before the multiplayer layer');
}

export const KEY_CODES = FBInput.KEY_CODES;

/** Per-character action -> key code, mirroring CharCursors. */
export const CHAR_KEYS = FBInput.CHAR_KEYS;

export const CHAR_LABELS = {
  wg: { zh: '水娃', en: 'Watergirl', side: 'left' },
  fb: { zh: '火娃', en: 'Fireboy', side: 'right' },
};
