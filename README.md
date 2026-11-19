# rustdesk-web-react

轻量 React + TypeScript 库：把 RustDesk 的远程画面与远程控制嵌入现有 React 后台。

- 宿主应用提供 `server`、`serverKey`、`id`、`password`；库本身没有账号体系和设备列表。
- MVP：视频 + 鼠标/键盘 + iOS/Android 触控 + 双向文本剪贴板。
- 非 MVP：音频、多屏、文件传输。

## 当前状态 (2026-11-20)

- 包脚手架已就绪：Vite library mode、tsconfig strict、Vitest、demo 骨架；
  公共入口为 `.`（`src/index.ts`）和 `./core`（`src/core.ts`）。
- 硬约束：仅 VP9、库内不使用 Flutter/CanvasKit/gstatic/FFmpeg WASM；最终验收只读连接用户现有 hbbs/client。

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
