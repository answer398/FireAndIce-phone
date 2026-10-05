# Fireboy and Watergirl - Play Online

森林冰火人全系列 (1-6) 在线游玩

> **[Play Online / 在线玩](https://waterfire.p.wyf9.top/)**

## About

HTML5 version of the Fireboy and Watergirl game series (1-6), deployed as a static site. Supports both desktop keyboard and mobile touch controls.

基于 HTML5 的森林冰火人游戏全系列在线版，支持桌面键盘和移动端触屏操作。

## Games

| # | Name | Temple |
|---|------|--------|
| 1 | Forest Temple | 森林神庙 |
| 2 | Light Temple | 光明神庙 |
| 3 | Ice Temple | 寒冰圣殿 |
| 4 | Crystal Temple | 水晶殿 |
| 5 | Elements | 元素 |
| 6 | Fairy Tales | 童话 |

## Controls

**Desktop:**

| Character | Jump | Left | Right |
|-----------|------|------|-------|
| Watergirl | W | A | D |
| Fireboy | Arrow Up | Arrow Left | Arrow Right |

**Mobile:** Landscape is the default layout. Each character gets three large
semi-transparent buttons — left / jump / right — pinned to the screen corners
(Watergirl left, Fireboy right; no key names shown). Holding a direction while
jumping works (true multi-touch), and held keys are always released when the
page loses focus, is hidden, or a touch is interrupted. A rotate hint appears
in portrait.

All input — physical keyboard, touch buttons, and remote network input —
flows through one unified manager (`games/lib/input/input-manager.js`),
which translates everything into the exact key events the game engine
listens for. See [MULTIPLAYER.md](MULTIPLAYER.md) for the multiplayer input
path and loop-prevention rules.

## Project Structure

```
index.html              # Main game selection page
games/
  lib/
    require.js          # Shared module loader
    input/
      input-manager.js  # Unified InputManager (keyboard/touch/remote funnel)
      touch-pads.js     # Multi-touch pads UI + mobile viewport hardening
      selftest.mjs      # Headless tests (node games/lib/input/selftest.mjs)
    multiplayer/        # Online multiplayer extension layer
    platform-shim.js    # 4399 h5api stub (loading screen fix)
  sw.js                 # Service Worker (shared asset redirect)
  shared-assets/        # Deduplicated common assets
  1-forest-temple/      # Game 1
  2-light-temple/       # Game 2
  3-ice-temple/         # Game 3
  4-crystal-temple/     # Game 4
  5-elements/           # Game 5
  6-fairy-tales/        # Game 6
server/                 # Node static hosting + room/signaling server
tools/                  # Build & utility scripts
  restore-assets.sh     # Restore per-game asset copies (remove SW dependency)
  *.py                  # HAR extraction scripts
img/                    # Main page assets
```

## Shared Assets & Service Worker

Identical assets across games (audio, sprites, fonts, etc.) are stored once in `games/shared-assets/` to reduce repository size. A Service Worker (`games/sw.js`) transparently redirects asset requests to the shared location.

To restore standalone per-game copies and remove the Service Worker:

```bash
bash tools/restore-assets.sh
```

## Source Repositories

This project is based on game resources from:

- [1224HuangJin/Fireboy-and-Watergirl](https://github.com/1224HuangJin/Fireboy-and-Watergirl) - Game deployment & portal page
- [yezhiyi9670/fireboy-and-watergirl-grabber](https://github.com/yezhiyi9670/fireboy-and-watergirl-grabber) - Original HAR grabber scripts

See [README.original.md](README.original.md) for the original README.

## Disclaimer

This project is for non-commercial educational and testing purposes only. All game assets belong to their respective owners.

本项目仅供非商业性学习与研究使用。所有游戏资源版权归原作者所有。

## License

[MIT](LICENSE)
