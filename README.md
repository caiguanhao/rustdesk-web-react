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
  `LoginRequest.version/my_platform`、`PublicKey.kx_version`。
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
npm run test       # Vitest
npm run dev        # demo，http://localhost:5173
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
  `demo/decoder-check.html`。
- `src/media/video-pipeline.ts`：有界帧队列（默认 8）+ 单路串行解码；每批
  `VideoFrame` 都回 `Misc{video_received}`（含丢弃批次），丢帧/解码失败后进入
  `awaitingKeyframe` 并限频发送 `Misc{refresh_video}`，直到 keyframe 恢复；
  页面隐藏时停止解码，恢复时清队列并强制请求 keyframe。sink 的
  `draw(frame, release)` 绘制后调用 `release()`（幂等，pipeline 兜底回收）；
  非 VP9 帧报 `unsupportedCodec` 并建议重连。mock peer 集成测试验证 ack/
  refresh，见 `tests/mock-server.test.ts`。

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
