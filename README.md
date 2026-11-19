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
