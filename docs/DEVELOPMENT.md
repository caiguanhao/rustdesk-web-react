# 开发记录

本文件承接 README 中的仓库开发信息：当前状态、公开 API 入口、分阶段实现记录、
测试/验收结果与本机开发环境。使用说明与快速开始见 [README](../README.md)；
对外 API、部署、排错、性能与许可分别见 [API.md](API.md)、
[DEPLOYMENT.md](DEPLOYMENT.md)、[TROUBLESHOOTING.md](TROUBLESHOOTING.md)、
[PERFORMANCE.md](PERFORMANCE.md) 与 [AGPL.md](AGPL.md)。

## 当前状态（仓库开发信息，2026-11-20）

- 包脚手架/构建/测试已就绪：Vite library mode、tsconfig strict、Vitest、
  Playwright、`rustdesk-react copy-assets` CLI；公共入口为 `.`
  （`src/index.ts`）和 `./core`（`src/core.ts`）。
- `RustDeskViewer` 已可嵌入宿主 React 页面：canvas/letterbox、状态与密码
  覆盖层、错误重试、工具栏、输入/触摸/IME/剪贴板接线和 ref 命令均可用；
  真实 iOS/Android 触摸/软键盘/剪贴板已通过真机验收。
- 硬约束：仅 VP9、库内不使用 Flutter/CanvasKit/gstatic/FFmpeg WASM；最终验收只读连接用户现有 hbbs/client。

## API 入口

- `rustdesk-web-react`：`RustDeskViewer`（开箱 UI）、`useRustDeskSession`
  （headless React），并重导出 `core` 的全部公开 API。React 仅是 peerDependency。
- `rustdesk-web-react/core`：不依赖 React 的 `RustDeskSession`、配置、状态、
  错误、PeerInfo/权限/媒体/资源类型与 `assetUrl`/`resolveAssetBaseUrl` 工具。
  它**不**导出 `Message`/`Clipboard` 等协议 wire 类型；`SessionPermissions` 只以
  类型导出，宿主不能构造它。
- 完整字段/默认值/事件/错误码见 **[API.md](API.md)**。源码入口：
  `src/session/options.ts`（配置）、`src/session/state.ts`（状态）、
  `src/session/errors.ts`（错误码）。
- `npm run build` 后 `dist/` 同时包含 ESM（`index.js`、`core.js`）和对应的
  `.d.ts`；`core.js` 不 import React。


## 实现记录

以下按阶段保留协议/实现细节，供维护者参考；集成方优先阅读
[README](../README.md) 的快速开始与 `docs/`。Docker/真机测试脚本属于仓库开发工具，
不随 npm 包发布。

## 协议层（P1-1）

- `src/protocol/message.ts`、`rendezvous.ts`：直接复用 rustdesk-web v1 的
  ts-proto 生成代码（AGPL-3.0 only），并补上 MVP 所需的
  `Clipboard.format`、`MultiClipboards`、`KeyEvent.mode`、`VideoFrame.display`、
  `LoginRequest.version/my_platform`、`PublicKey.kx_version`、`Message.peer_info`
  （field 25，会话中 display 列表同步）。
- `proto/message.proto`、`proto/rendezvous.proto`：RustDesk 1.5.3
  (`d40e1da71`) 原样副本，仅作字段对照。
- 新增字段默认值都是 protobuf 零值且编码时省略，因此 v1 消息字节保持不变；
  `tests/protocol.test.ts` 用 `tests/fixtures/v1-protobuf.json`（由未修改的
  v1 模块生成）校验字节一致性与未知字段跳过。
- 来源、修改清单与 AGPL 声明：`NOTICE`、`src/protocol/NOTICE.md`、根 `LICENSE`。
- `src/protocol/url.ts`：与官方 v2 `getUriFromRs` 一致的 URL 构造
  （HTTPS 反代路径 `/ws/id`、`/ws/relay`；显式端口 +2 / relay +3 或 +2），
  并校验 `rendezvousUrl`/`relayUrl` 显式覆盖（仅 `ws(s)://`、HTTPS 页面禁止
  `ws://`）。
- `src/protocol/websock.ts`：二进制帧传输（一条 WS 消息 = 一个完整 protobuf，
  无长度前缀），Promise 队列 + open/next 超时，关闭码 1009 映射为
  `message-too-large`；`setCipher` 供 P1-5 安装 secretbox（只作用于
  `Message`，不含 rendezvous 帧）。
- `src/crypto/`：按需动态加载 libsodium（不进入首屏包）；Ed25519
  `crypto_sign_open` 验签、X25519 `crypto_box_easy`（24 字节零 nonce）、
  secretbox 小端计数 nonce（从 1 开始，收发独立，MAC 失败后密码器失效）、
  `SHA256(password||salt)` + `SHA256(h1||challenge)`；固定向量见
  `tests/crypto.test.ts`。
- `src/protocol/secure.ts`：relay 安全握手（kx_version 0）——验证 hbbs 签名的
  `IdPk`、再验证 peer `SignedId`、发送 sealed secretbox key 并安装计数
  secretbox；18s 时限，默认 fail-closed，`allowInsecureFallback` 时按 v1 发送
  空 `PublicKey` 并返回降级原因。错误码区分 server key 缺失/无效、peer 签名
  无效、id 不匹配、密钥长度；mock peer 双向加密验证见 `tests/secure.test.ts`。
- `src/protocol/connection.ts`：hbbs → hbbr 连接状态机——`PunchHoleRequest`
  （`nat_type=SYMMETRIC`）→ `RelayResponse`（校验 `refuse_reason`、版本、uuid、
  ID/offline/licence 失败枚举）→ 关闭 hbbs → 打开 hbbr（`relay_server` +2，
  回退 hbbs +3）→ `RequestRelay` → 安全握手。支持 12s 响应超时、`AbortSignal`
  取消；返回对象封装 `sendMessage`/`nextMessage`（后者把
  `Misc.close_reason` 映射为 `peer-closed`）和 `close()`。mock hbbs+hbbr 真实
  配对/转发测试见 `tests/connection.test.ts`。
- `src/protocol/login.ts`：登录流程——`Hash` → 最小 `LoginRequest`（默认不带
  `supported_decoding`/version/my_platform/session_id）→ `peer_info`。错误密码
  沿用同一 Hash 通过 `login()` 重试；`No Password Access` 视为等待远端点接受；
  60s 登录超时、3s 后 `awaiting-approval`、12s `TestDelay` 心跳与回显、`permission_info`
  （键盘/剪贴板/音频/文件）、提前视频帧 ack 与暂存。错误字符串映射为
  `wrong-password`/`two-factor-required`/`too-many-attempts`/`try-later`/
  `blocked`/`no-permission`/`peer-offline`/`peer-error`。mock peer 测试见
  `tests/login.test.ts`。
- 凭据与运行时 key：`password` 与 `passwordHash` 非空时互斥；`passwordHash` 是
  32 字节 h1 的 base64（或 `{ hash, salt? }`），只在本地参与
  `SHA256(h1 || challenge)`，不会发到网络或被解密成明文。`serverKeyProvider`
  （每次 `connect()` 取 key）优先于 `serverKeyVerifier`（`1000::<key>` 签名信封，
  payload 是明文，不是加密）和静态 `serverKey`；provider/verifier 解析失败
  fail-closed。见 [API.md](API.md) 和 [DEPLOYMENT.md](DEPLOYMENT.md)。
- `tests/mocks/rustdesk-mock.ts`：一套 Node mock 同时扮演 hbbs、hbbr 和受控端
  （SignedId/PublicKey/Hash/Login、合成 VP9 帧、输入记录），支持 `/ws/id`、
  `/ws/relay` 路径、uuid 配对转发、30s 配对/空闲超时、64KiB/64MiB 消息上限，
  以及成功/离线/拒绝/错误密码场景。`tests/mock-server.test.ts` 跑通
  connect+login+加密输入、路径模式、错误 key、配对/空闲/大小限制等集成用例。

## 开发

```bash
npm install
npm run typecheck    # tsc strict 检查（不产出文件）
npm run build        # Vite library mode + tsc 类型声明 → dist/，并复制 dist/notices/
npm run test         # Vitest
npm run test:canvas  # Playwright e2e 测试（10 个，明细见 P2-5）
npm run test:decoder # headless Chrome 解码器/渲染检查（需本机 Chrome）
npm run check-size   # 资源 + 初始 JS gzip 预算
npm run copy-assets  # 把 assets/ogv 复制到 demo/public/rustdesk-assets/
npm run dev          # demo，http://localhost:5173
```

资源复制 CLI 也可直接使用：`node bin/rustdesk-react.mjs copy-assets <publicDir>`
（安装包后为 `npx rustdesk-react copy-assets <publicDir>`）。

- 相对导入在 `src/` 内使用显式 `.js` 后缀（编译到 `.d.ts` 后兼容 NodeNext 消费者）。
- `npm run build` 不经 `vite-plugin-dts`：先 `vite build` 输出 ESM，再用
  `tsc -p tsconfig.build.json` 只产出 `.d.ts`。
- demo 通过别名直接引用 `src/`，修改库代码无需先 build。

## 目录

- `src/` — 库源码（`protocol/`、`crypto/`、`media/`、`input/`、`session/`、`react/`）
- `bin/` — `rustdesk-react copy-assets` CLI
- `docs/` — API、部署、故障排查、AGPL 文档
- `proto/` — RustDesk 1.5.3 protobuf 定义（参考）
- `assets/ogv/` — VP9 解码器资源及许可文件
- `demo/` — React demo（P4-4 表单）
- `tests/` — Vitest、Playwright、mock WS server 测试
- `scripts/` — 构建/资源/反代测试脚本
- `test-fixtures/` — 真连测试用的静态页面
- `THIRD_PARTY_NOTICES.md` — 第三方依赖许可

## 视频解码（P2-1）

- `src/media/vp9-decoder.ts`：从 `assetBaseUrl` 加载 ogv.js，用
  `wasm-feature-detect` 选择 SIMD（`OGVDecoderVideoVP9SIMDW`）或非 SIMD
  （`OGVDecoderVideoVP9W`）；SIMD 失败时自动回退非 SIMD。worker 解码、
  `threading:false`（不依赖 SharedArrayBuffer），加载/初始化 15s 超时。
- `Vp9Decoder.create()` 串行处理 `processFrame`；`decode()` 返回 YUV frame，
  绘制后必须 `recycle(frame)`；`rebuild()` 用于分辨率/WebGL context 变化
  （ogv 1.8.6 的 `close()` 是 no-op），`dispose()` 丢弃实例。
- 浏览器验收：`npm run test:decoder`（需要本机 Chrome）在 headless Chrome
  中用两套真实 WASM 各解码 200 个 VP9 keyframe；测试页面为
  `demo/decoder-check.html`。同一脚本还会用真实解码帧跑一遍渲染器
  （见下文 P2-3）。
- `src/media/video-pipeline.ts`：有界帧队列（默认 8）+ 单路串行解码；每批
  `VideoFrame` 都回 `Misc{video_received}`（含丢弃批次），丢帧/解码失败后进入
  `awaitingKeyframe` 并限频发送 `Misc{refresh_video}`，直到 keyframe 恢复；
  页面隐藏时停止解码，恢复时清队列并强制请求 keyframe。sink 的
  `draw(frame, release)` 绘制后调用 `release()`（幂等，pipeline 兜底回收）；
  非 VP9 帧报 `unsupportedCodec` 并建议重连。mock peer 集成测试验证 ack/
  refresh，见 `tests/mock-server.test.ts`。

## 渲染（P2-3）

- `src/media/renderer.ts` 的 `VideoRenderer` 实现 P2-2 的 `VideoSink`：
  `draw(frame, release)` 用 yuv-canvas 绘制，并在 `finally` 中调用
  `release()`。WebGL 优先，`WebGLFrameSink.isAvailable()` 为 false 或
  attach 失败时回退到 yuv-canvas 的软件 sink，`usingWebGL` 反映实际路径。
- yuv-canvas 拥有 `canvas.width/height`，会把它设为帧显示尺寸，因此 canvas
  保持帧分辨率，屏幕缩放完全交给 CSS：画布绝对定位，按
  `min(容器宽/帧宽, 容器高/帧高)` 计算宽高和居中偏移，实现不变形的
  letterbox。DPR/离屏 canvas 清晰度优化留待后续（规格允许）。
- `layout`/`onLayout` 只在容器或帧尺寸真正变化时更新；`draw()` 仅在帧尺寸
  变化时重排，容器变化由 `ResizeObserver`/`window.resize`/全屏事件驱动。
  容器为 0 或首帧前 `layout` 为 `null`。`vp9-decoder.ts` 导出的
  `frameSize()` 统一了 `format.displayWidth/displayHeight` 优先级。
- 坐标变换：`toRemote(clientX, clientY)` 把视口坐标映射为远端帧像素
  （画布外返回 `null`，右/下边界为开区间），`toClient(x, y)` 为逆变换；
  P3-1/P3-4 输入层负责取整/夹取。
- `ResizeObserver` + `window.resize` 回退；`fullscreenchange` /
  `webkitfullscreenchange` 触发重排。`requestFullscreen()` 以容器为目标，
  不支持或被拒绝时返回 `false`；`exitFullscreen()` 只退出本渲染器的容器。
  兼容 Safari/iPadOS 15 的 `webkit*` API；iPhone Safari 没有元素全屏，
  P4-3 的工具栏会禁用按钮。`fullscreenSupported`/`fullscreen` getter 与
  `onFullscreenChange` 让 P4-3 复用同一套探测/监听，不再自行判断前缀。
- 单测 `tests/renderer.test.ts`（24 项）覆盖 WebGL 选择/回退/失败、
  16:9/4:3/1:1/竖屏/裁剪显示尺寸、resize、0 尺寸、坐标边界、抛错仍释放、
  dispose 和全屏（标准/前缀/不支持/拒绝）。`npm run test:decoder` 额外
  用真实 VP9 帧验证 WebGL 像素回读 `(255,0,0,255)` 及两种容器比例下的
  CSS letterbox 几何；真机全屏/旋转已在 P5-1/P5-2 验收（iPhone Safari 走
  CSS 铺满回退，浏览器地址栏无法由网页隐藏）。

## 显示切换与分辨率（P2-4）

- `VideoPipelineOptions.initialDisplay` 来自登录 `PeerInfo.currentDisplay`；
  `currentDisplay` 表示当前目标 display。非零且与目标不同的
  `VideoFrame.display` 会 ack 后丢弃；`display=0` 兼容旧端（旧版本所有帧都为 0）。
- `pipeline.switchDisplay(index)` 发送 `Misc.switch_display{display}`
  （只带 index；MVP 不做自定义分辨率），立即清空队列并进入 suspended，
  后台等待在途解码、调用 `Vp9Decoder.rebuild()`、解除 suspended 并强制
  `refresh_video`。方法立即返回，避免阻塞 P4-1 的消息循环；`dispose()` 会
  等待重建结束。重建期间到达的多次切换合并为一次重建，最终 display 生效。
- 收到 `Misc.switch_display` 且 index 变化时按同样流程重置；同 index 只作为
  display 几何元数据忽略。分辨率变化以解码帧的 `frameSize()` 为准：尺寸变化
  时先绘制该帧（libvpx 已处理带内变化），随后清队列、重建 decoder、请求新
  keyframe，画面在新 keyframe 到达后恢复。
- suspended 或页面隐藏时到达的帧仍每批 ack，但不入队、不解码；隐藏期间不
  发送非强制 refresh，恢复可见时清队列并强制请求 keyframe。重建失败通过
  `onError` 报告并仍请求 keyframe（旧 worker 可能继续工作）。
- `Message.peer_info`（field 25）已支持解码；`clampDisplayIndex()` 修正越界
  `current_display`，`applyDisplayList()` 合并会话中的 display 列表且不覆盖
  本地选择（服务端同步会把 current_display 置 0）。P4-1 的消息循环应把
  `msg.peer_info` 交给它，并把 `msg.misc.switch_display` 交给
  `handleSwitchDisplay()`。
- 已知边界：MVP 不发送 `CaptureDisplays`/`refresh_video_display`，也不做用户
  发起的改分辨率；多显示器、版本感知的严格帧过滤与 P4-3 的显示器选择 UI
  留待后续。P4-1 需按 `PeerInfo.displays` 校验用户输入的下标（服务端对越界
  switch 静默忽略）。
- `tests/video-pipeline.test.ts`（17 项）覆盖 initialDisplay、切换消息、旧
  display 丢帧、在途帧不绘制、分辨率重建、入站 switch、重建失败、隐藏暂停；
  `tests/mock-server.test.ts` 通过真实 mock hbbs/hbbr/peer 验证切换与分辨率
  恢复；`tests/peer-info.test.ts` 覆盖下标 clamp 与 display 列表合并。

## Playwright 画布测试（P2-5）

- `npm run test:canvas` 启动 demo Vite（`127.0.0.1:5175`）和 headless
  Chromium/Chrome，当前跑 10 个 Playwright 测试：
  1. `demo/canvas-test.html` 解码 `test-fixtures/vp9.ts` 的 red/green 64x64
     无损 VP9 keyframe，通过 `VideoRenderer` 绘制，读回 canvas 像素（红/绿）
     证明非空，验证 640x360 与 360x640 容器下的 letterbox 几何
     （360x360、偏移 140），并输出 64x64 解码+绘制微基准 FPS；
  2. `demo/input-test.html` 用真实浏览器鼠标验证 mask/坐标/右键菜单/滚轮/
     拖拽（P3-1）；
  3. 同一页面用真实 `page.keyboard` 验证物理键码、修饰键、repeat、平台切换
     与 CtrlAltDel/LockScreen（P3-2）；
  4. 同一页面验证隐藏 textarea 的 insertText、合成 composition、paste、
     visualViewport 通知，以及 IME 聚焦时物理键仍走 Map 模式（P3-3）；
  5. 同一页面用 `hasTouch` + CDP 多指触摸验证 tap/双击/长按/拖动/双指滚动/
     捏合本地缩放、`touch-action:none` 不滚页面、禁用和画布黑边（P3-4）；
  6. `demo/clipboard-test.html` 授予 clipboard-read/write 权限，验证真实浏览器
     剪贴板的自动复制、压缩文本、点击读取本地剪贴板发送和失败后的手动复制（P3-5）；
  7. `demo/strict-test.html` 在 React 18 StrictMode 下挂载 `useRustDeskSession`，
     连接测试进程内的裸 WebSocket server，断言 StrictMode 双挂载后只有一个
     live socket，卸载后为 0（P4-2）；
  8. `demo/viewer-test.html` 在宿主 React 页面（StrictMode）中嵌入
     `<RustDeskViewer autoConnect={false} readOnly>`，验证 640×360 宿主
     尺寸、canvas/工具栏/自定义 labels、只读按钮门控、一个 IME textarea
     （StrictMode 首个挂载已清理）且宿主页面仍可交互（P4-3）；
  9. `demo/index.html` 填写 P4-4 表单并对裸 WS server 发起真实 rendezvous
     连接，验证只保留一个 live socket、非密码字段写入 localStorage、密码
     不出现在 storage/console，重载后非密码字段恢复（P4-4）。
  10. `demo/perf-test.html` 加载真实 ogv/WASM，解码 1280x720 synthetic
      keyframe，测首帧/解码器/FPS，并通过 CDP 强制 GC 记录 JS heap 增长
      （P5-3）。
- `demo/src/check-harness.ts` 抽取了 P2-1/P2-3/P2-5/P3 页面共用的状态、
  base64、像素回读、快照、renderer 与 decoder 工厂；
  `demo/src/decoder-check.ts` 与输入测试页也使用该模块与共享 fixture。
- 浏览器选择：优先使用本机 Google Chrome；可用 `CHROME_BIN` 指定其他路径。
  CI 上没有 Chrome 时先运行 `npx playwright install chromium`；
  `npm run test:canvas` 本身不需要网络。
- Playwright 产物 `test-results/`、`playwright-report/` 已 gitignore。该测试
  需要浏览器，故不在 `npm test` 中；`npm run test:decoder` 仍用轻量 CDP
  脚本验证两套 WASM 与 P2-3 渲染细节。真机触摸/输入测试仍属 P3/P5。

## 鼠标输入（P3-1，已完成）

- `src/input/mouse.ts` 的 `MouseInput` 把 DOM 鼠标事件编码成 RustDesk
  `MouseEvent`：低 3 位动作（move 0、down 1、up 2、wheel 3），按钮位左移 3
  （left 1、right 2、middle 4、back 8、forward 16）。down/up 坐标固定 0，
  发送前先发 move 确保光标落在点击位置；move 坐标来自
  `VideoRenderer.toRemote()`（CSS→帧像素）加当前 display 原点
  （`PeerInfo.displays[currentDisplay]`，由 P4-1 调 `setOrigin()` 更新），并
  四舍五入/夹取到显示范围内。
- 支持 move/down/up、左右中/后退/前进、Alt/Ctrl/Shift/Meta 修饰键、双击
  （两次普通 down/up，无额外协议字段）、右键菜单拦截、middle/侧键的本地
  auxclick 默认行为拦截、拖拽移出画布时贴边、`blur`/页面隐藏/禁用/卸载时
  释放所有按下按钮。`wheel` 使用原生 `{passive:false}` 监听并
  `preventDefault()`，避免页面滚动。
- 滚轮方向（重要纠正）：DOM `deltaY>0` 表示向下，但 RustDesk 线协议方向相反。
  官方 Flutter 客户端在发送前对每个轴取反，服务端又对非 Windows 的 y 取反，
  Windows 再乘 120；直接发 DOM 原始值会导致方向错误且幅度放大 120 倍。
  因此本实现发送主轴的 ±1 取反刻度（与官方 web v2 一致），而不是原始像素。
  plan/spec 里“原始 delta、不要手动取反”的旧备注只适用于已由 Flutter
  取反过的 web core bridge；真机方向仍待验收。
- `enabled`/`setEnabled()` 是 P3-6/readOnly 的本地开关；禁用时释放按钮并停止
  发送。P4-1 负责把 `PeerInfo` 的显示原点、会话 channel、切换期间的门控接上；
  P4-3 负责 canvas attach/detach。P3-4 触摸可与本模块并存（只处理非 mouse
  指针并通过 `preventDefault` 抑制兼容鼠标事件）；P4-3 的 viewOnly 仍需同时
  禁用两者。
- 验证：`tests/input-mouse.test.ts`（20 项 jsdom：mask/坐标/修饰键/滚轮/
  双击/拖拽/默认行为/启用禁用/清理/错误）、
  `tests/input-mouse-integration.test.ts`（Node 假 DOM + 真实 mock
  hbbs/hbbr/peer 加密链路）、`tests/e2e/input.spec.ts`（真实浏览器：
  letterbox/竖屏坐标、右键 contextmenu、滚轮且页面不滚动、拖出画布贴边、
  mask 序列）。`npm run test:canvas` 同时跑画布和鼠标测试。
- 真机验收（2026-11-20）：iPhone/Android 连接用户现有 hbbs 与 macOS 被控端，
  单击、拖动、长按右键、双指滚动方向均正确；P4-1/P4-3 接线已具备。

## 键盘输入（P3-2，已完成）

- `src/input/keymaps.ts` 收录 DOM `KeyboardEvent.code` → 对端平台位置键码：
  Windows scancode（扩展键 `0xE0xx`）、Linux X11 keycode（evdev+8）、
  Android keycode、macOS virtual keycode。数据来自 rustdesk-web v2
  `js/dist/index.js`（AGPL，见 `src/input/NOTICE.md`），支持 macOS ISO
  Backquote/IntlBackslash 交换与可选 Ctrl/Meta 交换。`KeyA` 在 macOS 是 0
  （合法值，不能用 falsy 判断）。
- `src/input/keyboard.ts` 的 `KeyboardInput` 使用 Map 模式：
  keydown/长按 repeat 都发送 `{chr, mode: Map, down:true, press:false}`，
  keyup 发送 `down:false`；`press:true` 是 Legacy 单击语义，不用于 Map。
  Ctrl/Alt/Shift/Meta 作为普通物理键事件发送，不放进 `modifiers`；
  CapsLock/NumLock 只作为可打印/小键盘键的 LED 同步提示（keyup 使用当前
  `getModifierState()`，合成释放沿用 keydown 快照）。
- 忽略 `isComposing`/keyCode 229/`Process`/`Unidentified`，不拦截输入法；
  启用时 keydown 默认 `preventDefault()`（可配置）。Android 软键盘常在
  `code` 为空时只给 `key`（如 SwiftKey 的 Backspace），此时用 key 名回退发送
  Backspace/Delete/Enter/Tab/Escape/方向键等控制键；可打印字符不在回退表中，
  仍只走 P3-3 的 `seq`，避免重复。`blur`、`focusout`、`pagehide`、页面隐藏、
  禁用和卸载都会释放所有已按下的键，避免远端卡键。
- 特殊动作走 Legacy `KeyEvent`（不是 `Misc`）：Windows 对端发
  `CtrlAltDel(100)`；其他平台发 `Delete` + `Alt/Ctrl` 且 `press:true`；
  `LockScreen(101)` 单发。P4-3 需根据 `PeerInfo.sas_enabled` 决定是否显示
  CtrlAltDel。
- 边界：Android 表的 Map 模式未真机验证（上游桌面客户端对 Android 对端
  禁用 Map），P4-1 应按 `PeerInfo.version >= 1.2.0`/平台决定是否启用并保留
  回退空间；IME/软键盘文本属于 P3-3。`test-fixtures/vp9.ts` 等与键盘无关。
- 验证：`tests/input-keymaps.test.ts`（17 项表/平台/ISO/swap/lock 测试）、
  `tests/input-keyboard.test.ts`（16 项 jsdom 事件序列/repeat/组合键/
  composition/软键盘无 code 控制键/释放/特殊键/错误）、
  `tests/input-keyboard-integration.test.ts`
  （Node 假 DOM + 真实 mock hbbs/hbbr/peer 加密链路）；Playwright
  `tests/e2e/keyboard.spec.ts` 用真实浏览器键盘验证。
- 真机验收（2026-11-20）：iPhone/Android 软键盘输入经 macOS 被控端验证，
  包括 Android 第三方 IME（Microsoft SwiftKey）的 Enter/Backspace。浏览器/OS
  保留快捷键（Cmd/Ctrl+W、Cmd+Tab 等）仍由浏览器拦截，任何普通网页都无法
  发送；这是平台边界，不是库缺陷。

## IME / 软键盘（P3-3，已完成）

- `src/input/ime.ts` 的 `ImeInput` 管理一个隐藏 textarea：1×1、opacity 0、
  fixed、`font-size:16px`（避免 iOS 自动缩放），不用 `display:none`；
  `focus({preventScroll:true})` 只在用户手势（P4-3 的键盘按钮/点按）调用，
  避免软键盘弹出时滚动画面。P4-3 应把 `container` 设为 viewer 根节点，并在
  焦点门控中把该 textarea 视为“viewer 仍有焦点”，否则聚焦 IME 会错误禁用
  P3-2 的物理键盘。
- 组合输入：`compositionend` 发送
  `KeyEvent{seq, mode: Translate, down:true, press:false}`；`input` 在
  composition 期间忽略，compositionend 后同步到达的尾随 input 用 0ms 抑制
  窗口去重。普通输入（软键盘/insertText/表情等）在非 composing 时只按
  `input.data` 发送 seq 并清空；`deleteContentBackward/Forward` 与
  `insertLineBreak/Paragraph` 不当作文本发送（删除由 P3-2 的控制键回退负责，
  换行由 Enter keydown 负责），避免把 textarea 剩余值重复发送。P3-2 的
  KeyboardInput 对 `isComposing`/229/Process 不发送也不拦截，物理键在 IME
  聚焦时仍走 Map。
- `paste` 同步读取 `clipboardData` 文本并发送 seq，同时
  `preventDefault`/`stopPropagation`，避免插入隐藏 textarea 或与未来
  document 级 P3-5 粘贴处理重复发送。P3-5 仍需按规范优先尝试
  `Clipboard{format:Text}`，并注意不要重复处理该事件。
- `onViewportChange` 在 `visualViewport` resize/scroll 与 window resize 时
  上报 `{width,height,offsetTop,offsetLeft,scale}`（相同值去重），供 P4-3
  在软键盘弹出时调整布局；无 `visualViewport` 时回退 `innerWidth/Height`。
- 验证：`tests/input-ime.test.ts`（15 项 jsdom：textarea 样式、plain input、
  composition 顺序/去重、删除/换行 inputType、paste、focus/blur、禁用/卸载、
  viewport、错误）、
  `tests/input-ime-integration.test.ts`（Node 假 DOM + 真实 mock 加密链路
  的 3 条 seq）、`tests/e2e/ime.spec.ts`（真实浏览器 insertText、合成
  composition、paste、viewport、禁用/启用，以及 IME 聚焦时物理 KeyA/
  Backspace 只发 Map 不发 seq）。
- 真机验收（2026-11-20）：iOS Safari 中文输入/删除、Android SwiftKey 中文
  输入/删除均通过。SwiftKey 不发 composition 事件，直接以
  `input{insertText}` 提交文本，并在删除时发
  `input{deleteContentBackward, data:null}`；`onInput` 因此只对插入类
  inputType 发送 `data`，删除/换行交给 P3-2 的按键回退，避免重复或错字。

## 触摸手势（P3-4，已完成）

- `src/input/touch.ts` 的 `TouchInput` 只监听 Pointer Events，忽略
  `pointerType === 'mouse'`，因此可与 P3-1 同时挂载（混合设备）。attach 时
  设置 `touch-action:none`（detach 恢复原 inline 值），对 pointer/touch/
  Safari gesture 事件使用非 passive 监听并 `preventDefault()`，阻止页面
  缩放/滚动和 Chromium 的兼容鼠标事件；Playwright 同时挂载 MouseInput 的
  场景验证一次 tap 仍只有 3 条 MouseEvent。
- 手势（桌面被控端，发送 `mouse_event`）：tap = move + left down/up；
  双击 = 两组 down/up（由对端 OS 识别）并额外回调 `double-tap`；长按 500ms
  = 右键 down/up；单指拖动 = 左键按下/移动/释放（`mode:'touch'`）；双指
  滚动 = wheel（复用 P3-1 的取反 ±1 刻度）；双指捏合 = 本地 CSS transform
  `translate(...) scale(...)`（origin 0 0，scale 1–4），不发任何远端消息。
  阈值均可配置：10 CSS px tap/drag slop（无死区）、300ms/30 CSS px 双击、
  24px 滚动刻度、10px 捏合阈值。
- `mode:'mouse'` 只移动光标、不按左键（点按仍点击，长按仍右键）；完整上游
  mouse mode（双指右键、按住拖动）与真机手感留待真机/P5 调整。长按右键是
  桌面被控端行为；Android 被控端的 `PointerDeviceEvent` 触控协议未在
  vendored codec 中实现，MVP 明确只面向桌面被控端，P4-1 不应把 TouchInput
  接到 Android 对端而假装原生触摸。
- 双指模式判定比较“沿初始两指连线方向的位移”和“质心位移”：前者超过 10px
  且大于后者才进入捏合，否则质心累计超过 24px 进入滚动。这样两指滚动时
  先动一根手指（交错的 pointermove）不会误判为捏合；已有单测覆盖，具体
  数值/优先级仍需真机调优。
- 坐标复用 `src/input/coordinates.ts` 的 `mapClientPoint`（P3-1 已抽出）并
  加 display 原点；拖出画布贴边。双指手势结束后剩余手指被抑制，不会补发
  tap/click；pointercancel/blur/页面隐藏/disable/detach 都会释放左键、清
  定时器并恢复样式。P4-3 应通过 `applyLocalZoom:false` + `onLocalZoom`
  接管 transform，并负责缩放后的平移/边界/重置 UI（当前“已缩放状态下新的
  双指拖动”仍是远端滚动，不会本地平移）以及 display/会话切换时重置。
- 验证：`tests/input-touch.test.ts`（16 项 jsdom：手势序列、双击 CSS 距离、
  交错滚动、模式、缩放、释放、样式恢复、默认行为、坐标/原点、错误）、
  `tests/input-touch-integration.test.ts`（Node 假 DOM + 真实 mock
  hbbs/hbbr/peer 加密链路，tap/drag/双指滚动）、`tests/e2e/touch.spec.ts`
  （Playwright `hasTouch` + CDP 多指：tap/双击/长按/拖动/捏合/双指滚动/
  禁用/黑边）。
- 真机验收（2026-11-20）：iPhone/Android 的单击、长按右键、单指拖动、
  双指滚动、双指捏合本地缩放、双击均符合预期；手势与软键盘共存正常。

## 剪贴板（P3-5，已完成）

- `src/input/clipboard.ts` 的 `ClipboardController` 是框架无关的消息处理器：
  P4-1 拥有 `nextMessage()` 循环并把每条消息交给 `handleMessage()`，本模块
  不注册任何 DOM 监听。
  - 远端→本地：只接受 `ClipboardFormat.Text`；默认登录不发送 `version`，
    对端会走旧版 `Message.clipboard`，同时防御性解析
    `Message.multi_clipboards` 的第一个 Text。`compress=true` 时用 zstddec
    解压（动态 import，首次压缩剪贴板才加载 WASM）；只接受带 content-size
    的 one-shot zstd 帧（RustDesk bulk compressor 的行为），校验声明长度并
    严格 UTF-8 解码。默认 `navigator.clipboard.writeText` 自动复制；无用户
    手势或权限被拒时回调 `{text, copied:false}`，P4-3 显示“复制”按钮并调用
    `copyRemoteText()`（必须在点击手势中）。HTTP 等非安全上下文没有
    Clipboard API 时，写入回退 `document.execCommand('copy')`（同样必须在
    点击手势中）；本地→远端的读取则打开可见粘贴框，用户长按粘贴后发送。
  - 本地→远端：`sendText(text)` 发送 `Clipboard{format:Text, content:utf8}`
    （对端 `update_clipboard`，不是逐字输入）；发送抛错时按规格降级
    `KeyEvent{seq, mode:Translate}`。`sendLocalClipboard()` 用
    `navigator.clipboard.readText()` 读取本地剪贴板（需用户手势）。
- 权限/门控：`enabled` 控制本地→远端（P4-1 应结合 `readOnly`、对端 clipboard
  与 keyboard 权限）；`receiveEnabled` 控制远端→本地（P4-1 应结合本地
  viewOnly/disable-clipboard）。上游对入站只看本地 viewOnly/disable，不看
  对端权限；P3-6 接线时按此设置。
- 去重/回环：单一 `lastSynced` 抑制对端回显和重复发送；空文本忽略（MVP
  不清空剪贴板）。上限 4 MiB（`maxTextBytes`；上游桌面端允许 256 MiB）防止
  浏览器内存被超大文本拖垮，超限报 `message-too-large`。
- 边界：seq 降级只在发送抛错（传输层）时触发；对端因权限静默忽略
  Clipboard 无法从协议观测，P4-1/P3-6 必须按权限选择消息类型。P3-3 的隐藏
  textarea `paste` 仍直接发送 seq 并 `stopPropagation`；P4-1 不要让 P3-5 与
  P3-3 重复处理同一 paste。
- 验证：`tests/clipboard.test.ts`（18 项：文本过滤/MultiClipboards/zstd
  1–8 字节长度头/声明长度不符/UTF-8/去重/双向发送/seq 降级/字节上限/
  浏览器权限失败/门控/释放）、`tests/clipboard-integration.test.ts`（mock
  hbbs/hbbr/peer 加密链路的双向文本）、`tests/clipboard-legacy.test.ts`
  （jsdom：无 `navigator.clipboard` 时 `execCommand` 回退、注入适配器仍权威）、
  `tests/e2e/clipboard.spec.ts`（真实 Chromium clipboard 权限：自动复制、
  压缩文本、点击读取本地剪贴板发送、自动复制失败后的手动复制）。
- 真机验收（2026-11-20）：iOS Safari/Android Chrome 与真实 macOS 被控端
  双向文本同步通过。HTTP 页面的自动写失败后显示手动 Copy；点击时用
  `execCommand` 回退写入。本地→远端点工具栏 Clipboard 打开粘贴框，
  长按粘贴 → Send 即可。新增覆盖见 `tests/clipboard-legacy.test.ts`。

## 权限与只读（P3-6，已完成）

- `src/session/permissions.ts` 的 `SessionPermissions` 把本地配置与对端
  `Misc.permission_info` 合成一个 `InputPolicy`：

  | 来源 | mouse | keyboard | touch | ime | clipboardSend | clipboardReceive |
  | --- | --- | --- | --- | --- | --- | --- |
  | 默认 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
  | `readOnly`（viewOnly） | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
  | `disableClipboard` | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ |
  | 对端 keyboard=false | ✗ | ✗ | ✗ | ✗ | ✗ | ✓ |
  | 对端 clipboard=false | ✓ | ✓ | ✓ | ✓ | ✗ | ✓ |

  上游 host 用 keyboard 权限统一 gate `MouseEvent`/`PointerDeviceEvent`/
  `KeyEvent`/IME（`peer_keyboard_enabled`），所以撤销键盘权限时本地同时禁用
  鼠标/触摸；`clipboardSend` 还要求 clipboard 权限（上游
  `is_text_clipboard_required`）。`clipboardReceive` 只受本地
  `readOnly`/`disableClipboard` 控制（上游行为；对端撤销后不会继续发送）。
  `readOnly` 是任务中 `viewOnly` 的公开名称（组件 prop/配置），不新增第二个
  开关。
- `bind({mouse, keyboard, touch, ime, clipboard})` 在控制器创建后调用一次：
  立即应用当前策略，并在每次变化时重新应用，避免 P4-1/P4-3 忘记初始门控。
  禁用会释放已按下的键/鼠标按钮、取消触摸手势、清空 IME 组合并关闭剪贴板
  对应方向，因此撤销后不会再发送输入。`applyInputPolicy(policy, targets)`
  仍可单独使用。
- `handleMessage(message)` 消费 `misc.permission_info`：登录期间由
  `LoginFlow.onPermission` 回调到 `apply`（初始快照，不作为错误）；登录后由
  P4-1 的循环喂入，keyboard/clipboard 从 true 变为 false 时通过 `onError`
  报 `no-permission`。若对应输入已被本地 `readOnly`/`disableClipboard` 禁用，
  则不报错（避免只读用户收到噪音）；未知枚举忽略。回调异常安全。
- P4-1 接线：在 login 前创建 `SessionPermissions`，把 `apply` 传给
  `LoginFlowOptions.onPermission`；登录后先处理 `takePendingMessages()`，再把
  每条新消息交给 `handleMessage`；控制器创建后 `bind()`，并把
  policy/permission 事件暴露给 P4-3。P4-3 用 `labels.readOnly` 显示只读状态
  并禁用不可用的按钮（键盘、剪贴板；CtrlAltDel 另受 `sas_enabled` 限制）。
- 注意：上游 view-only 还会在登录请求/`Misc.option` 中发送
  `disable_keyboard=Yes`、`disable_clipboard=Yes`、`show_remote_cursor=Yes`
  让 host 侧同步门控；当前只做本地门控，`disable_clipboard` 可在 P4-1 补上，
  `disable_keyboard` 字段未在 vendored codec 中生成。本地门控已保证“不发送”，
  所以不影响本任务验收。
- 验证：`tests/permissions.test.ts`（17 项：默认/登录时 keyboard、clipboard
  快照不报错/audio、file/去重与恢复/readOnly/disableClipboard/登录后撤销
  报错一次/本地禁用时抑制通知/未知消息/初始状态/`bind`/dispose/回调异常/
  `applyInputPolicy` 全目标）、`tests/permissions-integration.test.ts`（真实
  mock hbbs/hbbr/peer 加密链路撤销 keyboard：释放已按下的按键与鼠标按钮、
  后续按键/鼠标不发送、剪贴板发送被阻止；恢复后重新发送；readOnly 释放
  输入并阻止键盘/鼠标/剪贴板，恢复后重新发送）。
- 无需真机：permission_info 是协议消息，mock 黑盒已覆盖；真实对端撤销未在
  本次只读会话中触发（对端权限未变），但 P3-6 已按同一消息路径实现。

## 会话层（P4-1，已完成）

- `src/session/RustDeskSession.ts`：框架无关的 `RustDeskSession`，从
  `rustdesk-web-react/core` 导出。`new RustDeskSession(config, deps?)`（deps
  仅用于测试/Node 注入）；`connect(signal?)` 完成 rendezvous/relay/签名/登录并
  在 `peer_info` 时解析 `PeerInfo`。无密码时 Promise 保持 pending 并发出
  `password-required`；`login(password)` 复用同一 Hash 重试并返回同一个
  `connect` Promise。`disconnect()` 干净结束（可再次 `connect`）；`dispose()`
  关闭 socket/worker/定时器/监听并回到 `idle`。
- 状态：`connecting`（session）→ `securing`（`connectRelay` 新增的
  `onSecuring` hook）→ `authenticating`/`password-required`/
  `awaiting-approval`/`connected`（LoginFlow）→ `disconnected`（本地或对端
  关闭）或 `error`（类型化错误）；`dispose()` → `idle`。错误/已连接状态下
  `connect`/`login` 以 `invalid-state` 拒绝。
- 登录后循环：先处理 `takePendingMessages()`（登录期的视频已由 LoginFlow
  ack，重放用 `acked:true`），再持续 `nextMessage(30s)`；逐字回显
  `TestDelay{from_client:false}`，每 12s 发送 `TestDelay{from_client:true}` 测
  RTT；30s 无消息按上游语义报 `timeout`；`Misc.close_reason` 映射为
  `disconnected`（detail 为原因）。
- 消息路由：视频 → `VideoPipeline`（无 sink 时 ack 后丢弃；设置 sink 后懒加载
  `Vp9Decoder`、请求 keyframe；`setVideoSink(null)` 停止解码）；权限 →
  `SessionPermissions`；剪贴板 → `ClipboardController`（重连时清空去重/远端文本
  状态）；`Misc.switch_display`
  与 `Message.peer_info` → 更新 `PeerInfo`/当前显示并同步 input origin/
  platform；光标/音频/聊天等非 MVP 消息忽略。
- 事件（`on` 返回 unsubscribe）：`status`、`error`、`clipboard`、
  `permission`、`peerInfo`、`securityDowngraded`。方法：`sendMouse`/
  `sendKey`（按权限门控）、`sendText`（Clipboard 优先，seq 降级）、
  `sendLocalClipboard`/`copyRemoteText`、`switchDisplay`、`setReadOnly`/
  `setDisableClipboard`、`bindInputs({mouse,keyboard,touch,ime})`、
  `setVideoSink`。`sendMessage` 是供 DOM 编码器使用的低层 channel。
- 输入接线：DOM 控制器需要 P4-3 的 canvas/renderer，因此由 P4-3 构造并
  attach，再传给 `session.bindInputs`；它会应用权限策略，并在登录/显示切换时
  设置 Mouse/Touch `setOrigin` 与 Keyboard `setPlatform`。P4-3 必须调用它，
  否则控制器走低层 channel，不会被 readOnly/权限门控；P4-3 的焦点门控也必须
  与 policy 取交集，不能用 `setEnabled(true)` 覆盖权限门控。
- 安全：`secure=false` 时发 `securityDowngraded`；`readOnly`/
  `disableClipboard` 会让 LoginRequest 带 `disable_clipboard=Yes`
  （`disable_keyboard` 不在 vendored codec 中，本地门控是权威）。
- 验证：`tests/session.test.ts`（20 项：状态顺序/awaiting-approval/
  password-required 与错误密码重试/invalid-state/abort/error/disconnect+
  dispose/reconnect/pending 重放/权限/视频 ack/TestDelay+心跳/peer close/
  非 VP9/display 校验/securityDowngraded/video sink 与 decoder dispose/
  sendMouse+sendKey 门控/bindInputs origin+platform/unsubscribe/回调异常/
  读超时）、`tests/session-integration.test.ts`（真实 mock hbbs/hbbr/peer
  加密链路：完整连接、视频 ack、权限撤销、双向剪贴板、close_reason；错误密码
  同连接重试）。`tests/mocks/rustdesk-mock.ts` 新增 `sendCloseReason()`。
- 延迟项：`SessionStats`/fps 与 `onStats`（P4-3/P5-3；当前只暴露
  `latencyMs`）；光标形状/位置（`show_remote_cursor` 默认关）；无密码登录不发送
  空密码 LoginRequest，因此 click-to-accept/`No Password Access` 需要用户输入
  密码；本端关闭不发 `Misc.close_reason`（v1/v2 web 同，WebSocket 足够）；
  `disable_keyboard` 协议字段与运行中 `Misc.option` 切换；Android Map 模式/
  触摸对端策略（P5-2）。
- P4-1 验收为状态转换与 mock 集成；真实 hbbs/client 连接已在 P5-5 完成。

## React hook（P4-2，已完成）

- `src/react/useRustDeskSession.ts`（根入口导出）：`useRustDeskSession(config,
  options?)` 为每个挂载/连接配置代次创建一个 `RustDeskSession`，在 effect 中
  创建（不在 render，SSR 安全），订阅事件，并在配置变化/卸载时 `dispose()`。
- 返回值：`session`（P4-3 用于 `setVideoSink`/`bindInputs`/输入/剪贴板/工具
  方法）、`status`/`statusEvent`（含 `password-required` 的 `retry`/`detail`）、
  `peerInfo`、`error`、`clipboard`（含 `copied`）、`permission`（初始策略来自
  session）、`securityDowngrade`，以及 `connect(password?)`/`login(password)`/
  `disconnect()`。`connect(password)` 在 `password-required` 时用同一 Hash 登录；
  其他状态使用会话配置连接。
- StrictMode：第一个 effect 的 cleanup 会 `dispose()` 当前 session（同步
  abort/关闭 socket），第二个 effect 创建新 session；事件带 session 身份检查，
  旧 session 不会写 React state。jsdom 测试用真实 session + fake transport
  断言第一个连接对象已关闭；`demo/strict-test.html` + 裸 WebSocket server 的
  Playwright 用例在真实浏览器中验证同时只有一个 live socket、卸载后为 0。
- 卸载/配置变化：cleanup 取消订阅、清空进行中的 connect 引用并 `dispose`
  （WS/worker/timers/listeners）。`readOnly`/`disableClipboard` 通过 session
  setter 实时应用，不重连（P4-1 的 LoginRequest 选项也读取权限状态）；
  `autoConnect` 只在创建时读取；connection identity/login-time 配置变化会重建
  session，密码变化也会重建（P4-4 表单应保持草稿在组件内、提交时才作为配置
  传入）。
- SSR：render 期间不创建 session，首屏为 `idle`/`session:null`；
  `tests/use-rustdesk-session-ssr.test.tsx` 在 Node 环境用 `renderToString`
  验证。回调从 ref 读取，不触发重连；`createSession` 是稳定的测试注入点
  （默认 `new RustDeskSession`）。
- P4-3 已消费这些能力：`RustDeskViewer` 用返回的 `session` 完成
  `setVideoSink`/`bindInputs`/canvas/input/剪贴板/工具栏；把
  `statusEvent.detail` 映射为 `PasswordPrompt.error`、`clipboard.text` 映射为
  `onClipboard(text)`。`onStats`/fps 仍延迟（P5-3）。控制器焦点门控与权限
  policy 取交集（见下节）。
- 验证：`tests/use-rustdesk-session.test.tsx`（7 项：自动连接/事件转发、
  StrictMode 首连接关闭、password-required 后用 `connect(password)` 登录、
  `readOnly` 实时应用不重连、配置变化重建、disconnect 后 connect、错误回调）、
  `tests/use-rustdesk-session-ssr.test.tsx`（1 项）、
  `tests/e2e/strict-mode.spec.ts`（真实浏览器 StrictMode + 裸 WS server：仅
  1 个 live socket，卸载后 0）。`tests/mocks/fake-connection.ts` 抽取了 P4-1/
  P4-2 共用的 fake relay 与登录消息。
- P4-2 验收是 React 生命周期/清理与 SSR；真实 RustDesk 连接已在 P3 真机/
  P5-5 完成。

## Viewer 组件（P4-3，已完成）

- `src/react/RustDeskViewer.tsx`（根入口导出 `RustDeskViewer`、
  `RustDeskViewerProps`、`RustDeskViewerRef`、`RustDeskViewerLabels`、
  `PasswordPrompt`）：消费 P4-2 的 `useRustDeskSession`，每个挂载/连接配置
  代次一个 session；StrictMode 双挂载后只保留一个 session/socket，首个
  renderer/输入控制器/IME textarea 均在 cleanup 中释放。
- 视频：挂载时创建一次 `VideoRenderer(canvas, root)`，session 就绪后
  `setVideoSink(renderer)`；卸载/换 session 时 `setVideoSink(null)` 并 dispose
  renderer。jsdom/无 canvas 环境创建失败只报 `onError` + notice，不破坏状态/
  密码 UI。letterbox、全屏请求/退出、`fullscreenSupported`/`fullscreen` 与
  `onFullscreenChange` 都由 renderer 拥有，viewer 只镜像状态。
- 输入：创建 Mouse/Keyboard/Touch/Ime 并 attach，再调用
  `session.bindInputs({ mouse, keyboard, touch, ime })` 应用权限策略、display
  origin 与 peer platform。viewer 用 `applyInputPolicy` 应用唯一最终门控
  “policy ∩ status === connected ∩ focus”：键盘监听在 `document` 上，未聚焦/
  未连接时不会捕获按键；IME textarea 作为 viewer 子节点（`container`），其
  聚焦算 viewer 焦点，物理键盘仍可用。密码表单只在 password-required（未连接）
  出现，状态门控已禁用全部输入。
- 触摸：`applyLocalZoom:false` + `onLocalZoom`，viewer 直接把
  `translate/scale` 写到 `canvas.style`（绕过 React，避免每个 pointermove
  一次渲染）；session 离开 active 状态时 `resetLocalZoom()`。
  `VideoRenderer.toRemote` 读取变换后的 client rect，坐标映射保持一致。
- 状态/密码/错误：connecting/securing/authenticating 显示 connecting，
  awaiting-approval 显示等待接受；password-required 先调用
  `onPasswordRequired({ retry, error: statusEvent.detail })`，返回 string 则
  自动 `login`，返回 undefined（或 Promise 解析为 undefined）显示内置表单，
  错误密码重试时显示 detail；表单 Cancel、ref `disconnect()` 与工具栏断开
  共用一条清理路径。error 覆盖层显示 `RustDeskError.message`/
  `statusEvent.detail` 并提供 Retry；disconnected 可重新 Connect；idle 显示
  Connect。非致命 `no-permission`/安全降级显示 6 秒 notice，`onError` 照常
  转发给宿主。
- 剪贴板：远端文本自动复制成功回调 `onClipboard(text)`；`copied:false` 时
  显示手动 Copy 按钮（`copyRemoteText()`，用户手势）；工具栏剪贴板按钮
  （`labels.clipboard`，title `labels.paste`）调用 `sendLocalClipboard()`
  完成本地→远端粘贴，受 `clipboardSend` 门控。labels 新增 `copy`/`paste`；
  `connected` 用于读屏 live region。
- 工具栏：Ctrl+Alt+Del 仅当 `PeerInfo.sasEnabled` 且 keyboard 权限时显示/
  启用；全屏按钮按 `fullscreenSupported` 禁用（iPhone Safari 无元素全屏）；
  Keyboard 按钮调用 `ImeInput.focus()`（用户手势打开软键盘）；Clipboard；
  Disconnect；readOnly 显示 `labels.readOnly` 并禁用输入按钮。画质固定
  （MVP，无画质控件）。
- ref：`connect(password?)`（密码仅用于 session 已处于 password-required 时
  的同一 Hash 登录；新连接密码仍来自 config/`onPasswordRequired`）、
  `disconnect()`、`sendCtrlAltDel()`、`setFullscreen(enabled)`、
  `focusKeyboard()`。
- `onStats` 仍未产生（fps/decodeMs 延迟到 P5-3；session 只暴露
  `latencyMs`）。SSR：render 期间不创建 session/DOM，
  `tests/rustdesk-viewer-ssr.test.tsx` 断言首屏 `idle` shell。
- 验证：`tests/rustdesk-viewer.test.tsx`（11 项：宿主 labels/尺寸/工具栏、
  自动连接与 status/peerInfo、host 密码自动登录、内置表单/重试/取消、
  工具栏命令、readOnly 门控、focus ∩ policy 键盘门控、手动复制、错误 Retry
  重连、卸载清理、ref）、`tests/rustdesk-viewer-ssr.test.tsx`（1 项）、
  `tests/e2e/viewer.spec.ts`（真实 Chromium 宿主页面 + StrictMode）。
  `tests/mocks/fake-yuv-canvas.ts` 供 jsdom 共用。`npm test` 406 passed/
  1 skipped；P4-3 完成时 8 个 Playwright 测试通过；typecheck/build 通过。
- 真机验收：P4-3 的宿主嵌入由 jsdom、SSR 与真实 Chromium 覆盖；真实
  iOS/Android 的触摸/软键盘/剪贴板已在 P5-1/P5-2 通过（含 iOS CSS 全屏
  回退，见下文“真机验收”）。

## Demo 表单（P4-4，已完成）

- `demo/src/App.tsx`：Server/Server Key/Relay(可选)/Device ID/Password/
  Asset Base URL 表单。提交后以表单快照挂载 `<RustDeskViewer autoConnect/>`
  （viewer/protocol/renderer 代码懒加载，不进入表单首屏）；“Change
  settings”卸载 viewer（dispose session/socket）并回到表单。
- 持久化/密码：提交时只把非密码字段写入 localStorage，密码仅存在于 React
  state/session config，提交后清空，不写 storage/URL/console；
  `VITE_RD_*` 是首次默认值，模板见 `demo/.env.example`，用户复制为
  gitignored 的 `demo/.env.local`。HTTP/HTTPS/WSS、LAN、端口偏移、混合
  内容、安全上下文/剪贴板、资源同源与排错见
  [DEPLOYMENT.md](DEPLOYMENT.md) 与
  [TROUBLESHOOTING.md](TROUBLESHOOTING.md)。
- 验证：`tests/e2e/demo.spec.ts`（真实 Chromium；填表→viewer→裸 WS server
  一个 live client；只保存非密码字段；console 无密码；关闭后 socket 归零
  且密码框清空；重载恢复非密码字段）。`npm test` 406 passed/1 skipped；
  Playwright 9 passed；typecheck/build 通过。
- P4-4 验收是表单接线/持久化/密码卫生；完整 RustDesk 握手由 P1-8 mock、
  P1-9 隔离 Docker 真连与 P5-5 真实环境（已完成）覆盖。

## 性能与体积（P5-3，已完成）

- 预算：初始 JS gzip **<250 KiB（不含 React）**、运行时资源 **<1.5 MiB**。
  `npm run check-size` 同时执行资源校验与 `scripts/check-js-size.mjs`（Vite
  测量构建）；`npm run build` 的 prebuild 强制执行，当前余量很大。
- 启动/首帧/解码 FPS/页面 JS heap 的验收下限、实测数字、环境和方法见
  [PERFORMANCE.md](PERFORMANCE.md)；`tests/e2e/perf.spec.ts` 会断言
  这些下限。
- 数字来自本地合成 keyframe/管线；真实网络与解码路径已在 P5-1/P5-2/P5-5
  真机/授权会话中跑通，但这些帧率/内存数字仍以本机 harness 为准。

## 故障场景（P5-4，已完成）

7 类故障（密码错误/对端离线/server key 错误/不可达/close_reason/网络中断/
反代 1009）已用 mock hbbs/hbbr/peer 与实际 WebSocket close 覆盖；错误码、UI 与
测试映射见 [TROUBLESHOOTING.md](TROUBLESHOOTING.md)。真机侧另验证了
断网/恢复后的 Retry 重连（P5-1/P5-2）。

## 真机验收（P5-1/P5-2/P5-5，已完成 2026-11-20）

- 设备/环境：iPhone（iOS 26.6.2，Safari）、Android 15（Chrome
  156.0.8078.79，Microsoft SwiftKey）。被控端为用户的 macOS（RustDesk
  1.4.9），hbbs 为用户现有 `rd.example.com:21116`；会话在用户授权下进行，
  未读取或修改任何 RustDesk 客户端配置。
- 通过项（两端）：首屏、连接、画面、单击/拖动/长按右键/双指滚动/捏合/
  双击、软键盘中文输入与删除、剪贴板双向同步、飞行模式断线后的 Retry
  重连；`?simd=0` 强制非 SIMD VP9 路径也能连接和操控。
- 全屏：Android Chrome 使用原生 Fullscreen API；iPhone Safari 不支持普通
  元素的 Fullscreen API，viewer 使用 CSS 固定定位铺满可视区域。Safari 的
  地址栏无法由网页隐藏，横屏时仍占用高度；需要真正全屏时请“添加到主屏幕”
  以 standalone 模式打开，或在宿主 WKWebView/WebView 中嵌入。
- 资源：运行时无 gstatic/CanvasKit/Flutter 引用，VP9 解码器与 worker 均为
  同源资源（`src/assets.ts`）；真机会话未发出外部 CDN 请求。
- 验收中发现并修复：
  1. iPhone Safari 全屏按钮因缺少原生 API 而 disabled → 增加 CSS 铺满回退。
  2. HTTP 局域网页面没有 `navigator.clipboard` → 增加 `execCommand('copy')`
     写入回退和“长按粘贴 → Send”输入框；自动复制失败仍显示手动 Copy。
  3. Android SwiftKey 中文/退格异常 → IME 只按 `insertText` 的 `data` 发送，
     删除/换行交给 KeyboardInput；软键盘 `code` 为空时按 `key` 回退发送
     Backspace/Enter 等控制键。
- 自动化：`npm test` 422 passed + 1 real-server、`npm run test:real` 1 passed、
  `npm run test:canvas` 10 passed、`npm run test:decoder` OK、typecheck/build
  （含体积门禁）通过。`demo/ime-events.html` 可复现软键盘事件序列。

## 本机 Docker 真连环境（P1-9）

不依赖用户现有服务器/客户端，也不使用用户已安装的 RustDesk 配置：

```bash
npm run dev:server    # colima + 隔离 hbbs/hbbr（官方 1.1.16 二进制）
npm run dev:peer      # 隔离被控端，写入 .local/rustdesk-server/peer.json
npm run dev           # 打开 demo，填写 Server/Server Key/Device ID/Password
```

- 默认地址：hbbs `127.0.0.1:12116`（WS 12118），hbbr `127.0.0.1:12117`
  （WS 12119）；`npm run dev:server` 会打印 Server Key。
- 被控端 ID/密码从 `.local/rustdesk-server/peer.json` 读取（0600、已 gitignore），
  密码不会打印到终端或写入仓库。
- 只监听 loopback，容器名固定为 `rdw-hbbs`/`rdw-hbbr`，数据目录
  `.local/rustdesk-server/data`，与用户 RustDesk 完全隔离。
- Docker Hub 不可达时改用 GitHub Release 的官方静态二进制，本地 scratch
  image 不依赖任何 registry；arm64 校验和已固定，其他架构可用
  `RD_SERVER_AMD64_SHA256` 指定。
- UDP 注册需要 colima 的 gRPC port forwarder；脚本在 colima 未运行时以
  `colima start --port-forwarder grpc` 启动，若已在运行会提示手动重启。
- `npm run test:real` 用真实 hbbs/hbbr 跑完整 connect+login（默认 `npm test`
  会跳过该用例）。`npm run dev:server status|down|reset|logs` 管理环境。
- `npm run log-server` + `test-fixtures/remote-input-test.html`：被控端输入
  日志页（坐标网格/键盘/IME/剪贴板），事件写入
  `.local/remote-input-events.jsonl`；真实桌面输入验收留给 P5。

## 相关仓库

- `~/work/source/rustdesk` — 上游 RustDesk（只读）
- `~/work/source/rustdesk-web` — web v1/v2 构建产物（只读）

`demo/.env.local` 仅存在于本机，可能含密码，绝不提交；模板与用法见
`demo/README.md`。
