/**
 * Character -> key-code mapping.
 *
 * These are not guesses: the game engine registers exactly these keys per
 * character in `States/Level/CharCursors` (`game.input.keyboard.addKey`):
 *   - Watergirl ('wg'): W (up) / A (left) / D (right)
 *   - Fireboy  ('fb'): Up / Left / Right arrows
 * The engine's Phaser keyboard listens on `window` and matches handlers by
 * `event.keyCode`, which is why injection works with synthetic events.
 */
export const KEY_CODES = {
  W: 87,
  A: 65,
  D: 68,
  UP: 38,
  LEFT: 37,
  RIGHT: 39,
  /** Level-state pause key (`pauseKey = addKey(Phaser.Keyboard.P)`). */
  P: 80,
};

/** Per-character action -> key code, mirroring CharCursors. */
export const CHAR_KEYS = {
  wg: { up: KEY_CODES.W, left: KEY_CODES.A, right: KEY_CODES.D },
  fb: { up: KEY_CODES.UP, left: KEY_CODES.LEFT, right: KEY_CODES.RIGHT },
};

export const CHAR_LABELS = {
  wg: { zh: '水娃', en: 'Watergirl', side: 'left' },
  fb: { zh: '火娃', en: 'Fireboy', side: 'right' },
};
