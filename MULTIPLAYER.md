# 双人联机架构（Fireboy & Watergirl Online）

两个玩家各自用手机/电脑浏览器打开**同一部游戏**的页面，进入同一房间后各控一个角色。本层不改任何游戏核心文件（`games/*/js/game.js`、`games/*/game.js`），全部能力通过运行时扩展实现。

## 架构：房主权威 + 输入中继 + WebRTC 视频

```
┌─────────────── 房主（host）───────────────┐          ┌─────────────── 队友（guest）───────────────┐
│  运行真正的游戏（Box2D 物理 + Phaser 2.6）  │          │  同一游戏页面在后台空转（菜单态）              │
│  gameAdapter: 捕获 Phaser.Game 实例        │          │  videoChannel: 接收 WebRTC 流               │
│  videoChannel: canvas.captureStream ───────┼── RTC ──▶│  #mp-video 全屏显示房主画面                  │
│  remoteApplier: 经 FBInput 注入 ─◀──────────┼─ Socket ─┤  localPads: FBInput 本地事件 → InputFrame ─▶│
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
  src/rooms/{room,roomManager}.js 房间状态机 / 坐席 / token 重连 / 频控 / 清理
  src/rooms/rateLimiter.js        创建/加入请求频控（固定窗口，按 IP）
  src/realtime/socketServer.js    Socket.IO 装配：严格校验、角色授权、定向转发、RTC 信令
  test/rooms.test.mjs             35 项协议测试（npm test，覆盖建房→开局→断线→清理全链路）
games/lib/lobby/                  大厅联机模块（index.html 加载，原生 ES Module）
  lobby.js                        建房/加入/邀请链接/分享/双方状态/准备/交换/进入游戏
  lobby.css                       手机优先样式（.lbp-* 命名空间）
games/lib/multiplayer/            浏览器扩展层（原生 ES Module，无构建步骤）
  boot.js                         入口（动态加载协议+main；静态托管下优雅禁用）
  main.js                         编排：模式选择、host/guest 装配、room:state 门控
  config.js                       客户端配置（ICE、帧率、心跳；?room=/游戏 id 解析）
  core/{bus,logger}.js            事件总线 / 日志
  net/socketClient.js             Socket.IO 封装（重连、延迟探测、AMD 冲突规避）
  net/videoChannel.js             WebRTC 视频 + 游戏音频捕获
  room/roomSession.js             创建/加入/重连/离开 + room:state/countdown/start 镜像（token 持久化）
  input/keys.js                   角色→键码映射（复用统一 InputManager 的唯一事实表）
  input/localPads.js              Guest 输入桥：FBInput 本地事件 → InputFrame（不再自行捕获输入）
  input/remoteApplier.js          Host：帧→FBInput.applyRemote 注入；保留 seq 去重与画布鼠标
  adapter/gameAdapter.js          运行时挂钩：捕获 Phaser 实例、阶段检测、暂停注入
  sync/statusSync.js              关卡/暂停状态广播（host→guest；服务端据此驱动 paused/finished）
  ui/{overlay,styles}.js          联机 UI（房间面板、双方席位卡、倒计时、视频层、横幅）
games/lib/input/                  统一输入层（经典脚本，无依赖，所有页面共用）
  input-manager.js                InputManager：键盘/触屏/远程三源同入口注入引擎
  touch-pads.js                   多点触控按钮 UI + 移动端视口/手势加固
  selftest.mjs                    无头自测（node games/lib/input/selftest.mjs）
scripts/{dev,start}.{sh,cmd}      开发/生产启动脚本
```

## 关键引擎事实（逆向确认，勿凭猜测改动）

- 每部游戏是一个约 2.2–2.4 MB 的 Closure 编译包：Phaser 2.6.2 + PIXI + Box2D + jQuery + RequireJS（AMD）内联。游戏 6 额外从 CDN 加载 Phaser/插件（`version.js`）。
- **平台 API 依赖**：游戏核心原生于 4399 平台，游戏 1–4 的加载进度回调调用全局 `h5api.progress(...)`，而仓库内无人定义它。缺失时每个资源完成都会抛 ReferenceError——Chromium 的加载时序恰好能兜住，Firefox 上异常经图片 onload 路径逃逸、打断加载队列，游戏永远停在黑屏。`games/lib/platform-shim.js` 在游戏 bundle 之前提供无操作存根（所有六个页面已接入）；若未来接入真实平台，它会让位于已有定义。
- 输入默认 `settings.controls === "keyboard"`（`loadSettings` 两个分支都设 keyboard）。
  - Watergirl (`wg`)：`W/A/D`；Fireboy (`fb`)：`↑/←/→` —— `States/Level/CharCursors` 内 `input.keyboard.addKey`。
  - 暂停：`P` 键（Level 状态 `pauseKey.onDown → togglePause`，切换 `game.paused`）。
  - Phaser Keyboard 在 **window** 上监听 keydown/keyup，按 **`event.keyCode`** 匹配 → 合成 `KeyboardEvent`（同时带 `keyCode/which/key/code` 兼容字段）即可注入。统一由 `games/lib/input/input-manager.js` 派发到已验证的监听目标。
  - Phaser Mouse 在 **canvas** 上监听 mousedown/move/up（capture 阶段），读 `clientX/Y` → 合成 `MouseEvent` 即可远程点击菜单/暂停面板。

## 统一输入层（games/lib/input/）

所有本地输入（物理键盘、触屏按钮）与远程网络输入最终都通过同一个入口进入游戏：

```
物理键盘(可信事件, 观察不注入) ─┐
触屏按钮(pointer events)      ─┼─▶ FBInput.setAction(role, action, pressed, source) ─▶ 合成 KeyboardEvent ─▶ 引擎(window)
远程帧(FBInput.applyRemote)   ─┘
```

- **来源标签**：`source` 区分 `'local' | 'remote'`。远程注入**永不**再作为本地事件发出——网络桥只订阅 `onLocalEvent()`，且管理器直接不 emit 远程事件，双重防回环。键盘观察路径只处理 `event.isTrusted` 事件，注入的合成事件不可能被误当物理输入。
- **角色座位**：`setLocalRoles(['fb'])` 后，本机键盘/触屏只能驱动该角色；**另一方角色的可信键盘事件在 window 捕获阶段被拦截**（`preventDefault + stopPropagation`，先于引擎的 window 冒泡监听），远程座位只由网络帧驱动。角色由房间分配决定，不存在"远程玩家操作另一角色"。
- **标准事件接口**：`onEvent(cb)` 收到 `{type:'pressed'|'released', role, action, source, inputKind, seq, timestamp}`；`snapshot()` 输出各角色 `{up,left,right}` 状态。
- **防卡键**：`blur` / `visibilitychange(hidden)` 释放全部本地按住（远程按住保留——它由对端状态帧同步）；`pagehide` 全部释放；角色移交（`setLocalRoles`）时强制释放离席角色的残留按键。触屏按钮在 `pointerup/pointercancel/lostpointercapture`、document 级安全网、窗口失焦等所有异常路径都会自动释放。
- **注入目标**：`keyTargets` 默认 `[window]`（六个游戏引擎的键盘监听实测位置），可按需注册 document/元素目标，不凭猜测派发。
- **触控 UI**（`touch-pads.js`）：每个角色只有"左 / 跳 / 右"三个半透明大按钮（不显示键名），Pointer Events + `setPointerCapture` 实现真多点（按住方向同时跳跃）；移动端默认横屏，处理 Safe Area（`viewport-fit=cover` + `env(safe-area-inset-*)`）、100dvh、全屏+横屏锁定、地址栏变化、双击缩放/页面拖动/长按菜单/文字选择抑制，且所有全局拦截只作用于按钮 UI，不影响游戏 Canvas 事件。触控组件不含任何 Socket.IO 代码。
- 游戏实例捕获：`window.require('Phaser').GAMES` —— 引擎 `Game` 构造时 `GAMES.push(this)`；`game.state.current` 反映 `menu/levelMenu/level/endGame/…`，`game.level`、`game.paused` 直接可读。
  - 注意 Closure 的 bindAll 模式会把大多数 state 方法绑定为**实例属性**，包装原型方法对 per-frame 调用无效；`create/shutdown` 经 StateManager 属性查找仍可包装，但捕获实例一律以 `Phaser.GAMES` 为准。
- Service Worker（`games/sw.js`）只把 `/games/<name>/assets/<共享文件>` 重定向到 `games/shared-assets/`，无缓存逻辑；新增代码放在 `games/lib/multiplayer/`（不叫 assets）天然不受影响。
- Socket.IO 官方客户端是 UMD：在这些页面上直接 `<script>` 引入会被 RequireJS 的 `define.amd` 截获、**永远不会设置 `window.io`**。`socketClient.js` 因此 fetch 源码后在函数作用域里用捕获型 `define` 执行（不触碰全局 loader）。

## 房间与会话

### 大厅流程（手机优先）

1. **创建**：在大厅（`/`）选游戏 → 选角色（默认火娃）→ 创建房间。服务器生成 4 位无易混字符房间码（无 I/L/1/O/0）与邀请链接 `/?room=CODE`。
2. **加入**：队友打开邀请链接即自动入座**对立角色**（无需手输）；大厅同时保留房间码手输入口。
3. **准备**：大厅展示双方席位卡（角色/在线/准备/延迟），双方点「准备」；进入游戏页后资源加载完成自动上报 `room:load`。
4. **开局**：双方**就绪 + 已加载**后，服务器统一发出带服务器时间戳的倒计时（`room:countdown`）与开始指令（`room:start`）——两端禁止自行开始。大厅页若收到开始指令会自动跳入游戏。
5. **游玩**：host 运行游戏画面（WebRTC 视频推流），guest 远程操控对立角色；换角色需双方同意（`room:swap`），本关结束（finished）后重新准备即自动开下一局。

### 房间状态机（服务器是唯一写者，客户端只渲染）

```
waiting ── 双方入座+已加载+已准备 ──▶ ready ──▶ countdown(默认3s) ──▶ playing
   ▲                                                                  │
   │── guest 席位释放（主动退出/宽限超时）◀────── reconnecting ◁───────┤
   │                                      playing ⇄ paused           │
   └──────── 双方重新准备开下一局 ◀──────────── finished ◀── phase=end ─┘
```

- **countdown 随时可中止**：任一方取消准备/断线/发出换角色请求 → 回到 waiting，绝不带伤开局。
- **服务器时间戳**：`room:countdown`/`room:start` 均携带 `serverNow` 与 `startAt`，客户端用 `serverNow - 本地时钟` 求偏移渲染倒计时，杜绝两端时差。
- **`playing/paused/reconnecting/finished` 才放行输入中继**（`PLAY_RELAY_STATES`），开局前 guest 的输入帧在服务器侧直接丢弃。
- **paused/finished 由事实驱动**：host 的 `game:status`（paused / phase=end）由服务器消费并推进状态机；关卡结束自动清空双方 ready，必须重新准备。

### 身份与重连

- 坐席以不透明 `token`（16 字节 crypto 随机）标识，仅发给本人 socket；`room:state` 广播永不携带 token。**角色/席位只能来自服务器分配**，任何 payload 里的 `role/char` 都被忽略。
- token 存 **sessionStorage**（每标签页独立身份，按房间码为键，`/`→`/games/...` 导航不丢）：网络闪断 socket 自动重连后 `room:rejoin` 恢复席位；页面刷新/从大厅进入游戏页同理，loaded/ready 事实一并保留。
- **断线席位保留 45s**（`SEAT_GRACE_MS`，30–60s 可调）：对方看到「正在重连」横幅；超时才真正释放席位（guest 位可被新玩家加入，host 位释放即关房）。
- **重复标签页**：同 token 的新连接胜出接管席位，旧连接收到 `duplicate-tab` 错误并被移出广播；旧连接随后的断线不会误伤新连接的席位。

### 服务端防护

- **频控**：按 IP 固定窗口（默认创建 6/min、加入/重连 20/min、延迟上报 20/min），超限回 `rate-limited`。
- **容量**：房间总数上限（默认 200），超限回 `server-busy`。
- **校验**：所有事件 payload 严格校验（房间码格式、布尔标志、交换动作、延迟范围、帧形状、信令大小）；房间游戏 id 与服务器扫描到的目录白名单匹配。
- **清理**：席位宽限定时器、空房 TTL（默认 10min）、关闭即回收全部定时器与 token 索引；sweeper 兜底扫描，测试套件结束时 rooms/tokens 归零。

### 错误码与 UI

`room-not-found`（房间码错误）/ `room-full`（含宽限期占位）/ `room-closed`（房间已结束）/ `bad-token`（会话过期）/ `duplicate-tab`（重复标签页）/ `char-taken` / `already-in-room` / `invalid-state` / `bad-payload` / `protocol-version-mismatch` / `rate-limited` / `server-busy` / `game-not-found` —— 大厅与游戏页 overlay 均映射为中文提示展示。

### 协议事件表

| 事件 | 方向 | 载荷 | 说明 |
| --- | --- | --- | --- |
| `room:create` | C→S (ack) | `{game, char?, protocol?}` | 建房；创建者默认火娃，char 必须在枚举内 |
| `room:created` | S→C | `{code, game, role, char, token, protocol, state}` | 入座成功；**token 仅发给本人** |
| `room:join` | C→S (ack) | `{code, protocol?}` | 加入；角色由服务器派发（host 的对立角色） |
| `room:joined` | S→C | 同 created | 入座成功 |
| `room:rejoin` | C→S (ack) | `{token, protocol?}` | 断线/刷新/换页后按 token 恢复原席位 |
| `room:rejoined` | S→C | 同 created | 恢复成功 |
| `room:leave` | C→S | `{}` | 主动退出：guest 释放席位，host 关房 |
| `room:load` | C→S | `{loaded}` | 本页游戏资源加载完成（自动上报） |
| `room:ready` | C→S | `{ready}` | 玩家手动准备/取消 |
| `room:swap` | C→S | `{action: request\|accept\|decline\|cancel}` | 协商换角色；结果经 room:state 广播 |
| `room:state` | S→双方 | `{code, game, state, hostChar, serverNow, players:{host,guest}, swap, countdown}` | **每次变更全量广播**，唯一权威投影 |
| `room:countdown` | S→双方 | `{serverNow, startAt, durationMs}` | 双方就绪后统一倒计时 |
| `room:start` | S→双方 | `{serverNow, startAt}` | 到点开局；唯一的开始路径 |
| `room:peer:joined` / `room:peer:left` | S→对方 | `{role, char}` / `{role, graceMs, state}` | 对端上下线的即时信号（状态以 room:state 为准） |
| `room:error` | S→C | `{code, message}` | 见错误码表 |
| `room:closed` | S→双方 | `{code, reason}` | host-left / host-timeout / expired / destroyed |
| `net:ping` | C→S (ack) | echo | RTT 探测 |
| `net:latency` | C→S | `{ms}` | 自报延迟（仅展示用，进 room:state） |
| `input:frame` | guest→host | `{up,left,right,seq}` | 状态帧；仅 PLAY_RELAY_STATES 放行 |
| `input:pointer` | guest→host | `{phase,nx,ny}` | 远程菜单点击；同上 |
| `game:command` | guest→host | `{type}` | 如 pause-toggle；同上 |
| `game:status` | host→guest | `{phase, paused?}` | 阶段广播；服务器消费 paused/finished 事实 |
| `rtc:signal` | 双向中继 | `{kind, …}` | WebRTC offer/answer/ICE |

### 启动与测试

```bash
# 开发（文件变更自动重启）
scripts/dev.cmd          # Windows
scripts/dev.sh           # bash

# 生产
scripts/start.cmd / scripts/start.sh

# 或直接
cd server && npm install && npm start     # http://0.0.0.0:8080
cd server && npm test                     # 35 项房间协议测试（别名 npm run smoke）
```

配置：复制 `server/.env.example` → `server/.env`。所有新增代码必须复用 `common/protocol/events.mjs` 的事件名，禁止硬编码。

测试矩阵（`server/test/rooms.test.mjs`，真实 server 栈 + socket.io-client）：静态封禁、建房/加入/满房/宽限占位、角色与 payload 越权（伪造 role/char/status/帧）、就绪→倒计时→开始（含单侧不开始、取消中止、时间戳断言）、换角色（请求/同意/拒绝/过期/阻塞开局）、关卡结束→重准备、断线→reconnecting→token 重连→事实保留、重复标签页接管、坏 token、席位宽限释放/补位、host 宽限关房、主动退场、paused 中继、空房 TTL、频控、容量上限；结束时 rooms/tokens 归零（无泄漏）。

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