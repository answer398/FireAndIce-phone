# 双人联机架构（Fireboy & Watergirl Online）

两个玩家各自用手机/电脑浏览器打开**同一部游戏**的页面，进入同一房间后各控一个角色。本层不改任何游戏核心文件（`games/*/js/game.js`、`games/*/game.js`），全部能力通过运行时扩展实现。

## 架构：房主权威 + 本地模拟 + 状态快照

两个端**都完整运行游戏**：房主是该房间的模拟权威（sim 权威端），队友本地实时模拟自己的画面获得零延迟反馈，并周期性接收房主的世界快照做阈值校正。没有任何一端观看另一端的视频画面。

```
┌─────────────── 房主（host）＝模拟权威 ───────────────┐        ┌────────────── 队友（guest）＝本地预测 ──────────────┐
│  运行真正的游戏（Box2D 物理 + Phaser 2.6）             │        │  运行同一部游戏（完整本地模拟，画面即时响应）           │
│  gameAdapter: getState() 采样世界真值                  │        │  gameAdapter: applyState() 阈值校正                  │
│  snapshotSender: 15Hz 快照 + 输入ack ─────────────────┼─Socket─▶│  snapshotApplier: 软/硬校正 + 关卡跟随 + 断线恢复      │
│  remoteApplier: guest 输入帧 → FBInput 注入 ─◀────────┼─ Socket ┤  localPads: 本地输入 → InputFrame(seq) ────────────▶│
│  statusSync: 关卡/暂停播报（game:status）─────────────▶│        │  以 host 快照为最终真值（本地死亡也以 host 为准恢复）    │
└──────────────────────────────────────────────────────┘        └────────────────────────────────────────────────────┘
                          ▲                                               ▲
                          └──────────── Node 服务端（Express + Socket.IO）────────────┘
                              房间坐席 / token 重连 / 定向转发 / 快照校验加戳 / 静态托管
```

**为什么不用帧同步（lockstep）**：六部游戏的物理是 Box2D 浮点模拟，且代码里存在 `Date.now()`、`game.rnd` 随机数等非确定性来源；跨设备位级确定性需要 fork 游戏核心，违背"不修改原始核心"的约束。

**为什么不用视频串流**：旧方案里 guest 观看 host 的 WebRTC 视频流——操作延迟 = RTT + 编解码（局域网也有 60–150ms），弱网掉帧。现在 guest 本地跑游戏，自己的操作零延迟生效；host 快照只负责消除两套模拟之间的漂移。`config.videoRelay`（默认关）保留旧链路做调试/降级。

**校正策略**（`adapter/gameAdapter.js` 的 `CORRECTION`，实测数据见下文测试节）：
- 角色与可动装置（有 Box2D body）：偏差 ≤ 2px 不干预；≤ 48px 按比例平滑拉回（每快照 35%）；超过 96px 立即硬复位位置+速度（经 Box2D 原生 `SetPosition/SetLinearVelocity`，双向唤醒）。
- 离散事实精确同步：宝石拾取、装置 state（机关输出组）、门开合动画、死亡（走游戏自己的 kill 链）、宝石计数、关卡结束。
- 摇杆（lever）状态由物理关节角决定，不可直接写 state——同步关节角，超过 0.35rad 才校正。
- 快照不变时发送 ~30 字节的 `same` 心跳（skip-unchanged），世界无变化时几乎零流量。

## 目录

```
common/protocol/events.mjs        协议常量（事件名/角色/错误码/校验器/快照 schema）——两侧唯一事实来源
server/                           Node 服务端（独立 npm 包）
  src/index.js                    入口：HTTP + Socket.IO + 房间管理
  src/app.js                      静态托管 + 白名单封禁（.git/tools/server/HAR 不可达）
  src/rooms/{room,roomManager}.js 房间状态机 / 坐席 / token 重连 / 频控 / 清理
  src/rooms/rateLimiter.js        创建/加入请求频控（固定窗口，按 IP）
  src/realtime/socketServer.js    Socket.IO 装配：严格校验、角色授权、定向转发、快照中继（校验+服务器时间戳）
  test/rooms.test.mjs             36 项协议测试（npm test，含快照中继鉴权/校验/加戳）
games/lib/lobby/                  大厅联机模块（index.html 加载，原生 ES Module）
  lobby.js                        建房/加入/邀请链接/分享/双方状态/准备/交换/进入游戏
  lobby.css                       手机优先样式（.lbp-* 命名空间）
games/lib/multiplayer/            浏览器扩展层（原生 ES Module，无构建步骤）
  boot.js                         入口（动态加载协议+main；静态托管下优雅禁用）
  main.js                         编排：host/guest 装配、快照收发、房间门控、?mpDebug=1 暴露 __mpDebug
  config.js                       客户端配置（snapshotHz、videoRelay、心跳；?room=/游戏 id 解析）
  core/{bus,logger}.js            事件总线 / 日志
  net/socketClient.js             Socket.IO 封装（重连、延迟探测、AMD 冲突规避）
  net/videoChannel.js             WebRTC 视频 + 音频捕获（仅 videoRelay=true 时使用）
  room/roomSession.js             创建/加入/重连/离开 + room:state/countdown/start 镜像（token 持久化）
  input/keys.js                   角色→键码映射（复用统一 InputManager 的唯一事实表）
  input/localPads.js              Guest 输入桥：FBInput 本地事件 → InputFrame（含校正数上报字段 c）
  input/remoteApplier.js          Host：帧→FBInput.applyRemote 注入；保留 seq 去重与画布鼠标
  adapter/gameAdapter.js          ★ GameAdapter：六部游戏共用的运行时适配层（detect/getLevel/startLevel/
                                    getState/applyState/restart/exitLevel/pause/resume）——对象定位方法见下文专节
  sync/roundSync.js               游戏生命周期 round 同步：HostRoundReporter（观察真实游戏的进关/重开/退关/结束，
                                    上报 round:event）+ GuestRoundFollower（只跟随服务器 round:update 导航本地游戏）
  sync/snapshotSync.js            SnapshotSender（host 15Hz 采样/去重/ack，载荷带 roundId）
                                  + GuestSnapshotApplier（校正、关卡跟随、same 心跳期跟随重试、结束错位恢复）
  sync/statusSync.js              关卡/暂停播报（game:status，携带 roundId；服务端据此驱动 paused/finished）
  ui/{overlay,styles}.js          联机 UI（房间面板、席位卡、倒计时、横幅）
  ui/hud.js                       调试 HUD（仅 ?mpDebug=1 显示：连接/房间/席位/RTT/快照 seq/ack/校正数）
games/lib/input/                  统一输入层（经典脚本，无依赖，所有页面共用）
  input-manager.js                InputManager：键盘/触屏/远程三源同入口注入引擎
  touch-pads.js                   多点触控按钮 UI + 移动端视口/手势加固
  selftest.mjs                    无头自测（node games/lib/input/selftest.mjs）
scripts/{dev,start}.{sh,cmd}      开发/生产启动脚本
scripts/smoke-lifecycle.mjs       六部游戏 × 双真实浏览器页面的生命周期 smoke test（详见「测试」节）
tools/ … + 仓库外 testbed          双浏览器上下文 E2E（延迟/抖动/断线注入）见「测试」节
```

## 关键引擎事实（逆向确认，勿凭猜测改动）

- 每部游戏是一个约 2.2–2.4 MB 的 Closure 编译包：Phaser 2.6.2 + PIXI + Box2D + jQuery + RequireJS（AMD）内联。游戏 6 额外从 CDN 加载 Phaser/插件（`version.js`）。
- **平台 API 依赖**：游戏核心原生于 4399 平台，游戏 1–4 的加载进度回调调用全局 `h5api.progress(...)`，而仓库内无人定义它。缺失时每个资源完成都会抛 ReferenceError——Chromium 的加载时序恰好能兜住，Firefox 上异常经图片 onload 路径逃逸、打断加载队列，游戏永远停在黑屏。`games/lib/platform-shim.js` 在游戏 bundle 之前提供无操作存根（所有六个页面已接入）；若未来接入真实平台，它会让位于已有定义。
- 输入默认 `settings.controls === "keyboard"`（`loadSettings` 两个分支都设 keyboard）。
  - Watergirl (`wg`)：`W/A/D`；Fireboy (`fb`)：`↑/←/→` —— `States/Level/CharCursors` 内 `input.keyboard.addKey`。
  - 暂停：`P` 键（Level 状态 `pauseKey.onDown → togglePause`，切换 `game.paused`）。
  - Phaser Keyboard 在 **window** 上监听 keydown/keyup，按 **`event.keyCode`** 匹配 → 合成 `KeyboardEvent`（同时带 `keyCode/which/key/code` 兼容字段）即可注入。统一由 `games/lib/input/input-manager.js` 派发到已验证的监听目标。
  - Phaser Mouse 在 **canvas** 上监听 mousedown/move/up（capture 阶段），读 `clientX/Y` → 合成 `MouseEvent` 即可远程点击菜单/暂停面板。

## GameAdapter：运行时对象定位手册（六部游戏实测）

`games/lib/multiplayer/adapter/gameAdapter.js` 是扩展层与游戏核心之间**唯一**允许接触运行时对象的模块。以下每一条都在六部游戏（1-forest / 2-light / 3-ice / 4-crystal / 5-elements / 6-fairy-tales）的无头 Chromium 实机上验证过；改代码前先读这节，不要凭猜测。

### 1. 引擎与游戏实例

- 每部游戏是一个 2.2–2.4 MB 的 Closure/RequireJS(AMD) 包：Phaser 2.6.2（游戏 6 从 CDN 加载 2.6.15）+ Box2D + jQuery 内联。
- 引擎把每个 `Phaser.Game` 构造实例 push 进模块注册表：**`require('Phaser').GAMES[len-1]`** 即存活实例（Game 构造器内 `c.GAMES.push(this)`）。与 Closure bindAll 无关、任何阶段都能拿到。
- `game.state.current` 反映阶段（`menu / levelMenu / level / endGame …`）；适配层 300ms 轮询映射为协议 phase。

### 2. 关卡状态实例

- Level 状态类是 AMD 模块 **`States/Level/Level`**（六部同名）。`create()` 里 **`game.level = this`**（游戏 1 bundle 实测 game.js:44791）——关卡运行期 `game.level` 就是活的 Level（Phaser.State）。
- `game.level.levelData` = `{id, filename, type, …}`（关卡身份，即菜单 temple.json 里的描述符）。
- 生命周期：适配层只**包装 Level.prototype 的 create/shutdown 两个方法**用于观察实例轮换（Closure bindAll 把多数方法绑成实例属性、原型包装对 per-frame 方法无效，但 create/shutdown 经 StateManager 属性查找仍走原型）。
- Level 实例上实测存在的关键字段：`pers1 / pers2`（角色）、`door1 / door2`（出口）、`objects`（装置数组）、`mapData`（tilemap）、`levelState`（宝石计数）、`levelStarted`、`ended`、`ui.clock`、`groundBody`。
- **注意关卡开场**：`Level.start` 把 `physics.box2d.paused = true` 做镜头飞行（约 3.4s，`camFreeze`），随后才解除——这段时间输入无效是**游戏自身设计**，不是同步 bug。

### 3. 角色（pers1=fb 火娃 / pers2=wg 水娃）

`States/Level/character` 的实例，Phaser Group + Box2D body：

| 数据 | 访问路径 | 说明 |
| --- | --- | --- |
| 位置(px) | `char.body.sprite.x / .y` | 包装器访问器，**可直接写**（游戏自己的 `animateStairs` 就这么写） |
| 速度(px/s) | `char.body.velocity.x / .y` | 只读镜像；**写入走原始 body**（见下） |
| 原始 b2Body | `char.body.data` | `GetPosition/SetPositionXY/GetLinearVelocity/SetLinearVelocity/SetAwake` |
| 像素↔米换算 | `ptmRatio = 32`，**双轴镜像**：`m.x = -px/32, m.y = -py/32`（Device.mpx/pxm 与实测 `GetPosition()` 双重确认） | 写速度：`SetLinearVelocity(new b2Vec2(-vx/32, -vy/32))`；`b2Vec2` 取自 AMD 模块 `box2d`（或全局 `window.box2d`） |
| 输入态 | `char.cursors.{up,left,right}.isDown` | `CharCursors` 实例，引擎每帧读它施加力 |
| 死亡 | `char.kill()` → `dying` → `_doKill`（烟雾动画）→ `dead / isDead`，随后 Level.checkEndGame 走 gameOver | 死亡同步走游戏自己的链 |
| 计数 | `char.data.diamonds / .silverDiamond` | 宝石拾取计数 |
| 朝向 | `char.facing`（'idle'\|'left'\|'right'） | 纯表现 |

### 4. 装置（机关）

- `game.level.objects` 由 tilemap 的 Objects 层顺序创建（同一关卡文件 → 两端顺序一致，可按下标对齐；快照同时携带身份做二次校验）。
- 身份：`options.type`（'pusher'|'lever'|'platform'|'box'|'portal'|'ball'|'pulley'|'slider'|…，全集见 `game.MechManager.classNames`）+ `options.x/y`（tilemap 像素，关卡内唯一）。
- 状态：**`device.state`**（整数）+ `_updateState()` 重演视觉/物理；`checkState()` 每帧从物理重新推导（推杆/摇杆等**输入型装置的 state 不可直接写**——写了下帧就被物理覆盖，因此摇杆同步的是关节角 `device.joint.GetJointAngleRadians()`）。
- 联动：**`game.MechManager.deviceGroups[group]`**——带 `signal` 的输入装置（推杆/摇杆）状态变化经 `deviceChanged()` 把组内其它装置的 state 置为组内 OR，再逐个 `_updateState()`。
- 可动装置（platform/box/pusher/ball…）有 `device.body`（同角色 body 的包装器），位置同上可读可写。

### 5. 门与宝石

- `level.door1`（`data.char='fb'`）/ `door2`（'wg'）：`isOpen`（对应角色进入传感器）、`currentFrac`（0..21 开门动画帧）、`isUp`（完全打开；**两门同时 isUp ⇒ checkEndGame 判胜**）。写 `isOpen=true` 后引擎 Door.update 会自行播放开门动画并置 isUp。
- 宝石：`States/Level/Devices/Diamond` 实例散布在舞台显示树（适配层扫描 `game.stage` 收集，**按关卡实例缓存**——被拾取的宝石会 destroy，缓存保住身份数组）。身份 = `data.char`（'fb'|'wg'|'silver'|'fbwg'）+ 出生坐标；拾取 = `gem.grabbed(character)`（放音效、给对应角色计数、destroy）。快照只传"已拾取下标集合"，guest 补拾取。

### 6. 关卡身份与神殿解析

- `game.currentTemple` 由 LevelMenu 状态的 init 赋值（`this.game.currentTemple = templeData`），Level.baseLoadComplete 用 `currentTemple.id` 拼贴图路径。
- 每部游戏的神殿清单在 **`game.gameConfig.temples`**（如游戏 1 为 `['forest']`，游戏 5 为 `['elements/fire','elements/water',…]`），各神殿数据在 **`data/<path>/temple.json`**（含 `levels[]` 描述符）。
- 适配层启动时拉取全部神殿 JSON 建 `id → path` 映射，于是 `getLevel()` 能回报 `{temple: 'elements/fire', id, filename}`；guest 端 `startLevel({temple, id})` 拉同一份 temple.json、按 LevelMenu 的方式赋 `game.currentTemple`，再调菜单自己的 **`menu.skipToLevel(levelDesc)`** 进关卡——与真人点击同一条代码路径（AdManager.showAd 在页面上按原样执行）。

### 7. 统一接口与降级

```
detect()                 捕获 Phaser 实例 + Level 生命周期钩子 + b2Vec2（幂等，500ms 轮询）
getLevel()               {temple, id, filename, type} | null
startLevel({temple, id}) guest 跟随进关（走菜单 skipToLevel；同关已运行则幂等；导航后校验落地，
                         fade 链卡死时清 stuck fading 并直呼 state.start 兜底；重入共享同一导航 promise）
getState()               世界快照（schema 见 common/protocol/events.mjs）| null（不在关卡内）
applyState(snap)         阈值校正（软/硬/离散），返回计数与 levelMismatch/endedMismatch
restart()                level.retry()（同一条 fade 路径，同样带落地校验）
exitLevel()              经 menu.startTemple 回选关界面（levelMenu 状态类未注册时也有效）
pause()/resume()/setPaused(b)  引擎 P 键路径（幂等：状态一致时不动作）
getPhase()/isPaused()    阶段与暂停查询；setHostMode(b) 关闭失焦自动暂停
```

钩子不可用时优雅降级：输入/房间流程照常，`getState()` 返回 null——同步层**拒绝假装已同步**，快照不发、校正不做，横幅与 HUD 如实显示 phase=unknown。

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
5. **游玩**：host 进入关卡后，guest 通过快照自动跟随进入**同一关**并在本地完整模拟；双方各自操作自己的角色（输入帧经服务器中继到 host 权威模拟）。换角色需双方同意（`room:swap`），本关结束（finished）后重新准备即自动开下一局。

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
- **任何游玩态断线（含 finished）→ reconnecting**：席位保留期间房间冻结在 reconnecting；断线者回来后恢复原状态（finished 恢复到 finished，其余按 hostPaused 恢复 playing/paused）。

## 游戏生命周期与 Round 同步（协议 v4）

### Round 状态图

**Round = 同一关卡的一次尝试**。roundId 由服务器按房间单调分配，两端永远跟随同一个 round：

```
（服务器房间状态机之上的关卡层生命周期）
         ┌──────────────────────────────────────────────────────────┐
         │   round N                        round N+1               │
         │                                                            │
 idle ──▶│ playing ─── 玩家死亡 ──▶ ended(idle) ── retry/re-enter ──▶│playing(new id)
  ▲      │    │                                                      │
  │      │    └── 双门开 ──▶ ended(win) ── 下一关(enter) ────────────┘
  │      │                                                          
  └──────┴── leave（回选关界面，id 保留，旧包继续可丢弃）                  
```

- **谁报告**：只有 host。`HostRoundReporter` 观察真实引擎（Level 原型 create/shutdown 钩子 + endGame 阶段）并上报 `round:event`：
  - `enter`（进入某关：首关/下一关/换神殿）
  - `restart`（同一关再次进入 = 重开，必定分配新 roundId）
  - `leave`（退出关卡回选关界面，roundId 保留，旧 round 的包继续可丢弃）
  - `end`（win|dead，取自 adapter 在 shutdown 时捕获的 `lastLevelEnd`）
- **谁分配**：服务器（`room.hostRoundEvent`）。guest 永远不能发 round 事件，也永远不自行切关——只消费 `round:update`。
- **谁跟随**：guest 的 `GuestRoundFollower`：新 round + 新关卡 → `startLevel`；新 round + 同关卡 → `restart()`（本地旧局不能活过一次重开）；round 离开 → `exitLevel()`。
- **确认规则**：重开按明确规则**直接同步**（host 是模拟权威，重开即时生效），guest 端以横幅提示「对方重开了本关」并经 round:update 自动跟随；guest 主动请求重开仍走 `game:command level-restart` 由 host 执行。最终两端必然处于同一游戏、同一关卡、同一 roundId（smoke 断言）。

### 旧包隔离（绝不污染新关卡）

- **协议层面**：`input:frame`、`sync:snapshot`、`game:status` 都必须携带 `r`（roundId，校验器强制）。服务器中继时：
  - `r < 当前 round.id` → **丢弃**（旧 round 的迟到包）；
  - `r > 当前 round.id` → 视作 host 的隐式进关（adoption），开出该 round 并广播 `round:update` 后放行（防 round:event 丢包死锁）；
  - `r === 当前 round.id` → 放行。
- **客户端层面**：guest 快照应用器对 `r < 本地 round.id` 的包再次过滤；round 变更时 host 侧 `forceFull()` 立即推全量快照，guest `lastSeq` 重置，避免快照流断档。
- 输入帧同理：round 未建立时 guest 的帧在服务器直接丢弃（真实客户端此时 pads 尚未开启，帧率不受影响，状态帧 + 1s 心跳自愈）。

### 身份与版本校验

- `PROTOCOL_VERSION = 4`：建/加/重连时校验，不匹配即拒。
- `room:state` 携带 `sid`（房间生命周期内稳定的 sessionId）、`rev`（房间投影单调版本，客户端丢弃乱序回退状态）、`round`（当前 `{id, level, phase}`）与 `policy: { pauseOnDisconnect: true }`。

### 断线恢复（房间策略 pauseOnDisconnect）

- **guest 断线**：房间进入 reconnecting → host 客户端自动暂停游戏、`releaseAll()` 释放 guest 全部按键、两端显示全屏重连遮罩。guest 在保留期内回来：Socket.IO 重连 → `room:rejoin`（token 恢复席位/round/事实）→ host `forceFull()` 推送完整权威快照 → 自动解除暂停（先快照后恢复，顺序固定）。
- **host 断线**：guest 不接管权威（永远不升级为 host）；同样策略暂停 + 遮罩，等待 host 恢复。host 席位宽限到期 → 房间关闭（`room:closed host-timeout`）＝显式结束该 round；**不做 host 迁移**（状态无法完整导出恢复，宁可明确结束也不制造错误状态）。
- **finished 态断线**：同样进入 reconnecting，恢复后回到 finished（不会误回 playing）。
- **重连身份**：`room:rejoin` 允许在会话未清空时发起（中途断线不清 session）——修复了原版「断线重连必须刷新页面」的缺陷；陈旧连接由服务器 duplicate-tab 策略裁决（新连接胜出）。

### 页面生命周期（锁屏/切后台/网络切换）

- 监听 `visibilitychange` / `pagehide` / `pageshow` / `online` / `offline`；**普通短暂隐藏绝不离开房间、不销毁任何状态**（服务器席位宽限 + token 是恢复机制）。
- 任何断连/隐藏路径都会释放本端按住的键（统一 InputManager 的 hidden/pagehide 钩子 + pads 门控关闭）。
- 恢复可见 / `online` / bfcache `pageshow` 时主动 `socket.connect()` 撤底重连，重连后自动 rejoin。
- 引擎循环兜底：页面被浏览器停发 rAF 时（遮挡/后台），adapter 检测循环停摆并切到 Phaser 的 setTimeout 驱动——模拟降速为慢动作而非冻结（host 冻结意味着快照断流）。
- 自身传输断开且房间在游玩态时显示遮罩；重连成功后自动揭开。

### 身份与重连

- 坐席以不透明 `token`（16 字节 crypto 随机）标识，仅发给本人 socket；`room:state` 广播永不携带 token。**角色/席位只能来自服务器分配**，任何 payload 里的 `role/char` 都被忽略。
- token 存 **sessionStorage**（每标签页独立身份，按房间码为键，`/`→`/games/...` 导航不丢）：网络闪断 socket 自动重连后 `room:rejoin` 恢复席位；页面刷新/从大厅进入游戏页同理，loaded/ready 事实与当前 round 一并保留。
- **断线席位保留 45s**（`SEAT_GRACE_MS`，30–60s 可调）：对方看到「正在重连」横幅与遮罩；超时才真正释放席位（guest 位可被新玩家加入，host 位释放即关房＝显式结束 round）。
- **重复标签页**：同 token 的新连接胜出接管席位，旧连接收到 `duplicate-tab` 错误并被移出广播；旧连接随后的断线不会误伤新连接的席位。

## GameAdapter：运行时对象定位手册（六部游戏实测）

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
| `room:state` | S→双方 | `{code, game, state, sid, rev, hostChar, round, policy, serverNow, players:{host,guest}, swap, countdown}` | **每次变更全量广播**，唯一权威投影（round/版本/策略随行） |
| `room:countdown` | S→双方 | `{serverNow, startAt, durationMs}` | 双方就绪后统一倒计时 |
| `room:start` | S→双方 | `{serverNow, startAt}` | 到点开局；唯一的开始路径 |
| `room:peer:joined` / `room:peer:left` | S→对方 | `{role, char}` / `{role, graceMs, state}` | 对端上下线的即时信号（状态以 room:state 为准） |
| `room:error` | S→C | `{code, message}` | 见错误码表 |
| `room:closed` | S→双方 | `{code, reason}` | host-left / host-timeout / expired / destroyed |
| `net:ping` | C→S (ack) | echo | RTT 探测 |
| `net:latency` | C→S | `{ms}` | 自报延迟（仅展示用，进 room:state） |
| `input:frame` | guest→host | `{up,left,right,seq,r, c?}` | 输入状态帧（seq 单调递增；**r=roundId**，旧 round 帧在服务器丢弃；可选 c=快照校正数）。仅 PLAY_RELAY_STATES 放行 |
| `input:pointer` | guest→host | `{phase,nx,ny}` | 远程菜单点击（仅 videoRelay 模式使用）；同上 |
| `game:command` | guest→host | `{type}` | `pause-toggle` / `level-restart`；同上 |
| `round:event` | host→S | `{type: enter\|restart\|leave\|end, level?, result?}` | **host 上报生命周期事实**；guest 席位被拒；服务器分配 roundId |
| `round:update` | S→双方 | `{code, sid, round:{id, level, phase}, reason, serverNow}` | **round 变更的唯一通知**；两端据此保持同游戏/同关/同 roundId |
| `game:status` | host→guest | `{phase, paused?, r, level?}` | 阶段广播（r=roundId；服务器据此驱动 paused/finished，旧 round 的 end 被丢弃） |
| `sync:snapshot` | host→guest | `{seq, ack, r, same?, snap?, st?}` | **房主权威世界快照**（15Hz，schema 见 events.mjs；r=roundId；ack=已处理的 guest 输入 seq；same=跳过未变化的最小心跳；st=服务器中继时刻） |
| `rtc:signal` | 双向中继 | `{kind, …}` | WebRTC offer/answer/ICE（仅 videoRelay 模式） |

### 启动与测试

```bash
# 开发（文件变更自动重启）
scripts/dev.cmd          # Windows
scripts/dev.sh           # bash

# 生产
scripts/start.cmd / scripts/start.sh

# 或直接
cd server && npm install && npm start     # http://0.0.0.0:8080
cd server && npm test                     # 41 项房间协议测试（别名 npm run smoke）

# 生命周期 smoke（六部游戏 × 双真实浏览器页面，需 chrome-headless-shell）
node scripts/smoke-lifecycle.mjs          # 全部六部（游戏 1 跑深度生命周期）
node scripts/smoke-lifecycle.mjs 1-forest-temple   # 单部 + 深度
```

配置：复制 `server/.env.example` → `server/.env`。所有新增代码必须复用 `common/protocol/events.mjs` 的事件名，禁止硬编码。

测试矩阵（`server/test/rooms.test.mjs`，真实 server 栈 + socket.io-client）：静态封禁、建房/加入/满房/宽限占位、角色与 payload 越权（伪造 role/char/status/帧/round 事件）、就绪→倒计时→开始（含单侧不开始、取消中止、时间戳断言）、换角色（请求/同意/拒绝/过期/阻塞开局）、关卡结束→重准备、断线→reconnecting→token 重连→事实保留、**round 生命周期（host enter 开 round 并双端广播、guest 上报被拒、重复 enter 幂等、restart 必分配新 roundId、不同关 = 新 round、leave 保留 id、status/快照 adoption、无 r 载荷拒收、旧 round 快照/输入帧/end 事件全部丢弃、当前 round end → finished）**、断线→reconnecting→token 重连→事实保留、重复标签页接管、坏 token、席位宽限释放/补位、host 宽限关房、主动退场、paused 中继、**快照中继（guest 席位不可发、非游玩态不放行、坏载荷丢弃、same 心跳直通、服务器时间戳必附）**、空房 TTL、频控、容量上限；结束时 rooms/tokens 归零（无泄漏）。

### 六部游戏生命周期 smoke（`scripts/smoke-lifecycle.mjs`）

起真实 Node 服务器 + 两个独立 headless 浏览器进程（=两台设备），只走生产路径（大厅面板同款 session API、邀请链接入座、适配器导航），断言两端始终处于**同游戏/同关卡/同 roundId**。最近一轮实测 **59/59 全绿**：

| 验收点 | 结果 |
| --- | --- |
| 六部游戏加载、建房、邀请链接入座、服务器统一开局（2/3/4/5/6 为基础集，1 为深度集） | 59/59 ok |
| host 进入第 1 关，guest 经 `round:update` 跟随进同一关，两端 roundId 相等（六部游戏各验证一次） | ok |
| guest 收到 host 权威快照流（15Hz，含 same 心跳） | ok |
| host 暂停 → guest 镜像暂停；恢复 → 镜像恢复（游戏 1） | ok |
| host 杀角色 → 真实引擎链：`checkEndGame → gameOver → endGame`，房间 finished 广播两端，roundId 保留；**确认无自动重生**（原作死亡 = 结算屏 + 手动 retry） | ok |
| guest 本地模拟经权威校正进入结束态 | ok |
| 过关后双方重新准备 → 服务器开启下一局（finished→countdown→playing） | ok |
| 重开（endGame retry）→ 新 roundId，两端同关同步重进（round 1→2） | ok |
| 切换下一关（level 2）→ 新 roundId，guest 自动跟随（round 3） | ok |
| guest 刷新页面 → token 重连恢复席位 + round + 快照拉回 + 重新跟随关卡 | ok |
| host 短断线 → guest 策略暂停（pauseOnDisconnect）+ 全屏重连遮罩 + 输入门控关闭 | ok |
| host 恢复 → rejoin 恢复席位 → round 保持一致 → 双端回 playing、遮罩解除、自动解除暂停 | ok |
| 旧 round 包隔离 / 伪造 round 事件 / 无 r 载荷拒收（协议层，41 项测试覆盖） | ok |

### 双浏览器上下文 E2E（同步链路验收）

仓库外测试台（Playwright + 双 browser context + 延迟代理）跑通**全部生产代码路径**：真 UI 建房/加入/准备、`__mpDebug.adapter`（仅 `?mpDebug=1` 暴露）进关、FBInput 本地输入路径注键。中间是两个可编程代理（HTTP+WS 转发，按 chunk 注入单向延迟/抖动，可瞬间黑洞流量模拟断网）。

最近一轮实测（17 项断言全过）：

| 验收点 | 结果 |
| --- | --- |
| 建房→加入→倒计时→playing（真 UI 点击） | ok |
| host 进第 1 关，guest 经快照**自动跟随**进同一关 | ok |
| 双向注入 100ms±25 单向延迟后 RTT | 232–244ms |
| 快照流（15Hz，sent/recv/输入 ack） | 39/37/ack=4 持续递增 |
| guest 本地输入（水娃右行 1.5s）在 host 模拟生效 | 位移 434–438px |
| 100–180ms 延迟+抖动下双侧采样位置漂移 | **0.2–6.8px**（硬阈值 96px） |
| 校正统计（软/硬占比） | 12–16 次校正，硬复位仅 2 次 |
| guest 断网 2.5s（黑洞）→ 自动重连/重入座 → 快照恢复 | ok，状态回 playing |
| host 断网 2s → 恢复 | ok |
| 全程扰动后漂移 | 6.8px（无累积发散） |

复现（需 Node 18+ 与 chromium_headless_shell，`npx playwright-core install chromium`）：测试台目录下 `node e2e.mjs`（自起 8180 服务器 + 9181/9182 代理）。


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

1. **页面隐藏时模拟降速（浏览器固有限制）**：浏览器对 `document.hidden` 的页面停发 `requestAnimationFrame`，该页的游戏模拟会停摆。adapter 的 `#watchLoop` 会在循环停摆时把引擎切到 Phaser 的 setTimeout 驱动——模拟从「完全冻结」降级为「定时器节流的慢动作」（后台页定时器被浏览器节流到 ~1Hz，且锁屏后的移动端浏览器可能进一步冻结）。双人并排双窗口（都可见）完全正常。
2. **关卡开场镜头**：每关开始时游戏自身把 Box2D 暂停约 3.4 秒做镜头飞行（`camFreeze`），期间输入无效——两端一致，非同步问题。
3. **输入型装置 state 不可直接写**：推杆/摇杆的状态由物理接触/关节角每帧重新推导（`checkState`），快照写 `state` 会被覆盖。当前策略：摇杆同步关节角（阈值 0.35rad），推杆等由两端各自的物理重推导——角色位置精确校正后接触事件基本对齐。极端时序下推杆 state 可能短暂不同，随后自愈。
4. **宝石不可"取消拾取"**：拾取即 destroy。guest 本地模拟若抢先拾取了 host 尚未拾取的宝石，该宝石在 guest 侧保持消失（计数会被 host 快照纠正）；关卡胜负判定只看门，不影响结局。
5. **`new Function` 执行 socket.io 客户端**：部署若加严格 CSP（`script-src` 无 `unsafe-eval`）会禁用联机层（优雅降级为单机）。届时可自行 vendor 无 AMD 检测的 socket.io 构建。
6. **游戏 5（Elements）多神殿**：适配层经 `gameConfig.temples` 建立神殿索引，guest 跟随时按 host 播报的 `temple` 路径拉取对应 temple.json；大厅的选殿界面不在同步范围内（host 选哪座神殿，guest 自动跟随进关）。
7. **快照频率与体积**：默认 15Hz（`config.snapshotHz`，建议 10–20）。满载世界（~60 装置+宝石上限）单帧 < 2KB JSON；静止时退化为 ~30B 的 `same` 心跳。`maxHttpBufferSize` 8KB，服务器侧全量校验后加时间戳转发。
8. **首次访问与服务 Worker 时序**：GitHub-Pages 部署依赖 `games/sw.js` 把共享资源重定向到 `shared-assets/`；SW 激活前的窗口期浏览器直连请求可能 404（Firefox 上会直接让加载态崩溃）。**Node 服务器部署已内置同样的重写**（服务器启动时解析 `games/sw.js` 的共享清单，`app.js` 直接从 `shared-assets/` 回源），不再依赖 SW 激活时机。
9. **WebRTC 视频链路（legacy）**：`config.videoRelay` 默认关闭；重新打开时其 NAT 穿透仍只配了 Google STUN（对称 NAT 需自加 TURN）。