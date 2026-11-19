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

## 相关仓库

- `~/work/source/rustdesk` — 上游 RustDesk（只读）
- `~/work/source/rustdesk-web` — web v1/v2 构建产物（只读）

`demo/.env.local` 仅存在于本机，可能含密码，绝不提交。
