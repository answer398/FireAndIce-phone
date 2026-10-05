# 双人联机架构（Fireboy & Watergirl Online）

两个玩家各自用手机/电脑浏览器打开**同一部游戏**的页面，进入同一房间后各控一个角色。本层不改任何游戏核心文件（`games/*/js/game.js`、`games/*/game.js`），全部能力通过运行时扩展实现。

## 架构：房主权威 + 输入中继 + WebRTC 视频

```
┌─────────────── 房主（host）───────────────┐          ┌─────────────── 队友（guest）───────────────┐
│  运行真正的游戏（Box2D 物理 + Phaser 2.6）  │          │  同一游戏页面在后台空转（菜单态）              │
│  gameAdapter: 捕获 Phaser.Game 实例        │          │  videoChannel: 接收 WebRTC 流               │
│  videoChannel: canvas.captureStream ───────┼── RTC ──▶│  #mp-video 全屏显示房主画面                  │
│  remoteApplier: 合成 KeyboardEvent ─◀──────┼─ Socket ─┤  localPads: 触控垫/键盘 → InputFrame ───────▶│
│  statusSync: game:status（关卡/暂停）──────▶│          │  pads 仅在 phase=level 时启用               │
└────────────────────────────────────────────┘          └─────────────────────────────────────────────┘
                        ▲                                               ▲
                        └────────────── Node 服务端（Express + Socket.IO）──────────────┘
                            房间坐席 / token 重连 / 定向转发 / RTC 信令 / 静态托管
```

**为什么不用帧同步（lockstep）**：六部游戏的物理是 Box2D 浮点模拟，且代码里存在 `Date.now()`、`game.rnd` 随机数等非确定性来源；跨设备位级确定性需要 fork 游戏核心，违背"不修改原始核心"的约束。房主权威方案下 guest 看到的是真实画面，任何游戏机制（机关、箱子、传送门）天然同步。

## 目录

```
common/protocol/events.mjs        协议常量（事件名/角色/错误码/校验器）——两侧唯一事实来源
server/                           Node 服务端（独立 npm 包）
  src/index.js                    入口：HTTP + Socket.IO + 房间管理
  src/app.js                      静态托管 + 白名单封禁（.git/tools/server/HAR 不可达）
  src/rooms/{room,roomManager}.js 房间实体 / 坐席 / token 重连 / 宽限期
  src/realtime/socketServer.js    Socket.IO 装配：入座、定向转发、RTC 信令
  test/smoke.mjs                  协议级冒烟测试（npm run smoke）
games/lib/multiplayer/            浏览器扩展层（原生 ES Module，无构建步骤）
  boot.js                         入口（动态加载协议+main；静态托管下优雅禁用）
  main.js                         编排：模式选择、host/guest 装配
  config.js                       客户端配置（ICE、帧率、心跳）
  core/{bus,logger}.js            事件总线 / 日志
  net/socketClient.js             Socket.IO 封装（重连、延迟探测、AMD 冲突规避）
  net/videoChannel.js             WebRTC 视频 + 游戏音频捕获
  room/roomSession.js             创建/加入/重连/离开状态机（token 持久化）
  input/keys.js                   角色→键码映射（源自游戏 CharCursors 真实绑定）
  input/localPads.js              Guest 触控垫 + 物理键盘捕获 → InputFrame
  input/remoteApplier.js          Host：帧→合成 KeyboardEvent / MouseEvent 注入
  adapter/gameAdapter.js          运行时挂钩：捕获 Phaser 实例、阶段检测、暂停注入
  sync/statusSync.js              关卡/暂停状态广播（host→guest）
  ui/{overlay,styles}.js          联机 UI（房间面板、视频层、横幅、状态 chip）
scripts/{dev,start}.{sh,cmd}      开发/生产启动脚本
```

## 关键引擎事实（逆向确认，勿凭猜测改动）

- 每部游戏是一个约 2.2–2.4 MB 的 Closure 编译包：Phaser 2.6.2 + PIXI + Box2D + jQuery + RequireJS（AMD）内联。游戏 6 额外从 CDN 加载 Phaser/插件（`version.js`）。
- 输入默认 `settings.controls === "keyboard"`（`loadSettings` 两个分支都设 keyboard）。
  - Watergirl (`wg`)：`W/A/D`；Fireboy (`fb`)：`↑/←/→` —— `States/Level/CharCursors` 内 `input.keyboard.addKey`。
  - 暂停：`P` 键（Level 状态 `pauseKey.onDown → togglePause`，切换 `game.paused`）。
  - Phaser Keyboard 在 **window** 上监听 keydown/keyup，按 **`event.keyCode`** 匹配 → 合成 `KeyboardEvent`（`Object.defineProperty` 覆写 keyCode/which）即可注入，与仓库原有 `games/lib/touch-controls.js` 同一机制。
  - Phaser Mouse 在 **canvas** 上监听 mousedown/move/up（capture 阶段），读 `clientX/Y` → 合成 `MouseEvent` 即可远程点击菜单/暂停面板。
- 游戏实例捕获：`window.require('Phaser').GAMES` —— 引擎 `Game` 构造时 `GAMES.push(this)`；`game.state.current` 反映 `menu/levelMenu/level/endGame/…`，`game.level`、`game.paused` 直接可读。
  - 注意 Closure 的 bindAll 模式会把大多数 state 方法绑定为**实例属性**，包装原型方法对 per-frame 调用无效；`create/shutdown` 经 StateManager 属性查找仍可包装，但捕获实例一律以 `Phaser.GAMES` 为准。
- Service Worker（`games/sw.js`）只把 `/games/<name>/assets/<共享文件>` 重定向到 `games/shared-assets/`，无缓存逻辑；新增代码放在 `games/lib/multiplayer/`（不叫 assets）天然不受影响。
- Socket.IO 官方客户端是 UMD：在这些页面上直接 `<script>` 引入会被 RequireJS 的 `define.amd` 截获、**永远不会设置 `window.io`**。`socketClient.js` 因此 fetch 源码后在函数作用域里用捕获型 `define` 执行（不触碰全局 loader）。

## 房间与会话

- 房主选角色（火娃/水娃）→ 创建 4 位房间码 → 面板展示 `?room=CODE` 分享链接；队友打开即入座**对立角色**。
- 坐席以不透明 `token`（16 字节随机）标识，仅发给本人 socket：
  - 网络闪断：socket 自动重连后带 token `room:rejoin`，座位/角色/视频自动恢复。
  - 页面刷新：sessionStorage 里的 token 先走 rejoin；失败自动回退到 `?room=` 加入。
  - 队友断开：房主端横幅提示，座位保留；队友丢失 token 时可重新加入，服务端允许接管**已断开的 guest 座位**。
  - 房主断开：房间保活 `ROOM_GRACE_MS`（默认 60s，`server/.env` 可调），超时广播 `room:closed` 并销毁。
- 输入是**状态帧** `{up,left,right,seq}`（变更即发 + 1s 心跳），重连后下一帧即完成再同步；`seq` 单调，乱序旧帧被丢弃。

## 启动

```bash
# 开发（文件变更自动重启）
scripts/dev.cmd          # Windows
scripts/dev.sh           # bash

# 生产
scripts/start.cmd / scripts/start.sh

# 或直接
cd server && npm install && npm start     # http://0.0.0.0:8080
cd server && npm run smoke                # 19 项协议冒烟测试
```

配置：复制 `server/.env.example` → `server/.env`。所有新增代码必须复用 `common/protocol/events.mjs` 的事件名，禁止硬编码。

## 公网部署（HTTPS/WSS）

应用是同源架构（页面 + 静态资源 + `/socket.io` 全部由同一个 Node 进程提供），TLS 终结交给反向代理：

```nginx
server {
  listen 443 ssl;
  server_name fb.example.com;
  ssl_certificate     /etc/letsencrypt/live/fb.example.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/fb.example.com/privkey.pem;
  location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;      # WebSocket 升级
    proxy_set_header Connection "upgrade";
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  }
}
```

Caddy 等价配置只需两行（自动签发证书）。反向代理后设置 `TRUST_PROXY=1`；若前端域名与 API 不同源（不建议），用 `ALLOWED_ORIGINS` 白名单。

## 已知限制 / 风险

1. **NAT 穿透**：默认只配了 Google STUN。对称 NAT 下的队友可能连不上视频——在 `games/lib/multiplayer/config.js` 的 `iceServers` 里加 TURN（如 coturn）即可，代码无需改动。
2. **延迟**：guest 的操作延迟 ≈ 网络 RTT + 视频编码/解码（约 60–150ms 局域网/近距公网）。视频 30fps @canvas 分辨率，弱网下会掉帧。
3. **音频捕获是尽力而为**：通过 AudioContext 构造钩子挂 MediaStreamDestination；若游戏先于扩展层创建 AudioContext（罕见时序），guest 只有画面没有声音。
4. **菜单导航**：guest 通过远程点击（合成 MouseEvent）操作房主菜单，坐标经过 letterbox 换算；Phaser 的坐标换算在极端缩放比下可能偏移 1–2 像素。
5. **`new Function` 执行 socket.io 客户端**：部署若加严格 CSP（`script-src` 无 `unsafe-eval`）会禁用联机层（优雅降级为单机）。届时可自行 vendor 无 AMD 检测的 socket.io 构建。
6. **游戏 5（Elements）多神殿**：状态机一致，但关卡选择树更深，远程点击路径更长；无额外适配。
7. **房主窗口完全不可见时视频冻结**：浏览器对隐藏页停发 `requestAnimationFrame`，canvas 不再出帧。托管状态已禁用引擎的失焦自动暂停（`stage.disableVisibilityChange`，见下），窗口**可见但失焦**（如双人双窗口并排）完全正常；但最小化或被完全遮挡时视频会冻结——浏览器平台固有限制。
8. **首次访问与服务 Worker 时序**：GitHub-Pages 部署依赖 `games/sw.js` 把共享资源重定向到 `shared-assets/`；SW 激活前的窗口期浏览器直连请求可能 404（Firefox 上会直接让加载态崩溃）。**Node 服务器部署已内置同样的重写**（服务器启动时解析 `games/sw.js` 的共享清单，`app.js` 直接从 `shared-assets/` 回源），不再依赖 SW 激活时机。
