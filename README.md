# rustdesk-web-react

轻量 React + TypeScript 库：把 RustDesk 的远程画面与远程控制嵌入现有 React 后台。

- 宿主应用提供 `server`、`serverKey`、`id`、`password`；库本身没有账号体系和设备列表。
- MVP：视频 + 鼠标/键盘 + iOS/Android 触控 + 双向文本剪贴板。
- 非 MVP：音频、多屏、文件传输。

## 当前状态 (2026-11-20)

- 包脚手架已就绪：Vite library mode、tsconfig strict、Vitest、demo 骨架；
  公共入口为 `.`（`src/index.ts`）和 `./core`（`src/core.ts`）。
- 公共类型/错误/组件骨架已导出（P0-4）；`RustDeskViewer` 目前只渲染布局
  外壳，ref 方法在 P4-3 之前会抛出明确错误。
- 硬约束：仅 VP9、库内不使用 Flutter/CanvasKit/gstatic/FFmpeg WASM；最终验收只读连接用户现有 hbbs/client。

## 公共 API 骨架

```tsx
import { RustDeskViewer } from 'rustdesk-web-react';
import type {
  RustDeskViewerProps,
  RustDeskViewerRef,
  RustDeskErrorCode,
  PeerInfo,
  RustDeskStatusEvent,
} from 'rustdesk-web-react';
import { RustDeskError, DEFAULT_ASSET_BASE_URL } from 'rustdesk-web-react/core';
```

- `rustdesk-web-react`：React 组件与 hook（后续任务），React 仅为 peerDependency。
- `rustdesk-web-react/core`：不依赖 React 的会话/协议类型与错误类，可用于
  Node/Worker 测试。
- 配置字段见 `src/session/options.ts`；状态机取值见 `src/session/state.ts`；
  错误码见 `src/session/errors.ts`。
- `npm run build` 后 `dist/` 同时包含 ESM（`index.js`、`core.js`）和对应的
  `.d.ts`；`core.js` 不 import React。

## 协议层（P1-1）

- `src/protocol/message.ts`、`rendezvous.ts`：直接复用 rustdesk-web v1 的
  ts-proto 生成代码（AGPL-3.0-or-later），并补上 MVP 所需的
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
- `tests/mocks/rustdesk-mock.ts`：一套 Node mock 同时扮演 hbbs、hbbr 和受控端
  （SignedId/PublicKey/Hash/Login、合成 VP9 帧、输入记录），支持 `/ws/id`、
  `/ws/relay` 路径、uuid 配对转发、30s 配对/空闲超时、64KiB/64MiB 消息上限，
  以及成功/离线/拒绝/错误密码场景。`tests/mock-server.test.ts` 跑通
  connect+login+加密输入、路径模式、错误 key、配对/空闲/大小限制等集成用例。

## 开发

```bash
npm install
npm run typecheck  # tsc strict 检查（不产出文件）
npm run build      # Vite library mode + tsc 类型声明 → dist/
npm run test         # Vitest
npm run test:canvas  # Playwright 画布/鼠标测试（需 Chrome 或 npx playwright install chromium）
npm run test:decoder # headless Chrome 解码器/渲染检查（需本机 Chrome）
npm run dev          # demo，http://localhost:5173
```

- 相对导入在 `src/` 内使用显式 `.js` 后缀（编译到 `.d.ts` 后兼容 NodeNext 消费者）。
- `npm run build` 不经 `vite-plugin-dts`：先 `vite build` 输出 ESM，再用
  `tsc -p tsconfig.build.json` 只产出 `.d.ts`。
- demo 通过别名直接引用 `src/`，修改库代码无需先 build。

## 目录

- `src/` — 库源码（`protocol/`、`crypto/`、`media/`、`input/`、`session/`、`react/`）
- `proto/` — RustDesk 1.5.3 protobuf 定义（参考）
- `assets/ogv/` — VP9 解码器资源
- `demo/` — React demo
- `tests/` — Vitest + mock WS server 测试
- `test-fixtures/` — 真连测试用的静态页面

部分目录由后续任务（P0/P1）创建。

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
  P4-3 应隐藏/禁用按钮。
- 单测 `tests/renderer.test.ts`（23 项）覆盖 WebGL 选择/回退/失败、
  16:9/4:3/1:1/竖屏/裁剪显示尺寸、resize、0 尺寸、坐标边界、抛错仍释放、
  dispose 和全屏（标准/前缀/不支持/拒绝）。`npm run test:decoder` 额外
  用真实 VP9 帧验证 WebGL 像素回读 `(255,0,0,255)` 及两种容器比例下的
  CSS letterbox 几何；真机全屏/旋转列入 P5-1/P5-2。

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
  Chromium/Chrome，加载 `demo/canvas-test.html`：解码
  `test-fixtures/vp9.ts` 的 red/green 64x64 无损 VP9 keyframe，通过
  `VideoRenderer` 绘制，读回 canvas 像素（红/绿）证明非空，验证 640x360
  与 360x640 容器下的 letterbox 几何（360x360、偏移 140），并输出 64x64
  解码+绘制微基准 FPS（非远端视频吞吐）。
- `demo/src/check-harness.ts` 抽取了 P2-1/P2-3/P2-5 页面共用的状态、base64、
  像素回读、快照与 decoder 工厂；`demo/src/decoder-check.ts` 也使用该模块
  与共享 fixture。
- 浏览器选择：优先使用本机 Google Chrome；可用 `CHROME_BIN` 指定其他路径。
  CI 上没有 Chrome 时先运行 `npx playwright install chromium`；
  `npm run test:canvas` 本身不需要网络。
- Playwright 产物 `test-results/`、`playwright-report/` 已 gitignore。该测试
  需要浏览器，故不在 `npm test` 中；`npm run test:decoder` 仍用轻量 CDP
  脚本验证两套 WASM 与 P2-3 渲染细节。真机触摸/输入测试仍属 P3/P5。

## 鼠标输入（P3-1，⏳ 真机待验）

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
  P4-3 负责 canvas attach/detach；P3-4 触摸必须与本模块互斥或过滤触摸合成
  的鼠标事件。
- 验证：`tests/input-mouse.test.ts`（20 项 jsdom：mask/坐标/修饰键/滚轮/
  双击/拖拽/默认行为/启用禁用/清理/错误）、
  `tests/input-mouse-integration.test.ts`（Node 假 DOM + 真实 mock
  hbbs/hbbr/peer 加密链路）、`tests/e2e/input.spec.ts`（真实浏览器：
  letterbox/竖屏坐标、右键 contextmenu、滚轮且页面不滚动、拖出画布贴边、
  mask 序列）。`npm run test:canvas` 同时跑画布和鼠标测试。
- ⏳ 真机待验：尚无 P4-1/P4-3 的会话/Viewer 输入接线，也没有获授权的真实
  RustDesk 被控端，因此真实点击/拖动/滚轮方向未验证；已通过 通知并记录
  在 plan。P3-1 暂不勾选。

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

`demo/.env.local` 仅存在于本机，可能含密码，绝不提交。
