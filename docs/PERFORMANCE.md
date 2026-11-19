# 性能与体积（P5-3）

目标（规格 §3.2/P5-3）：**初始 JS gzip < 250 KiB（不含 React）**；VP9 解码资源按需
加载；**运行时资源 < 1.5 MiB**。启动、首帧、解码帧率、内存记录环境与方法如下；
数字是一次代表性结果，会随机器/浏览器/负载波动。

## 预算与实测

| 项目 | 验收下限/预算 | 实测 | 说明 |
| --- | --- | --- | --- |
| 初始 JS gzip（不含 React） | < 250 KiB | **70.4 KiB（28%）** | Vite/Rollup 打包 `src/index.ts`，React + 动态-only 依赖 external，静态 import 图计入 |
| 运行时资源（ogv.js + 两套 VP9 WASM + 许可） | < 1.5 MiB | **661,894 B ≈ 646.4 KiB（42%）** | `assets/ogv/` 9 个文件；`npm run check-size` |
| 首帧（页面导航 → 720p VP9 解码并绘制） | < 2000 ms | **129 ms** | 本地 Vite dev + 合成 testsrc2 keyframe；并行跑全量时约 160–210 ms |
| 解码器初始化 | < 1000 ms | **17 ms** | 同一次运行；资源本地缓存/本地服务；并行时约 27–44 ms |
| 首个 720p 帧解码+绘制 | < 500 ms | **18 ms** | 并行时约 17–21 ms |
| 720p 解码+绘制 FPS | ≥ 30 fps | **160.3 fps** | 60 帧，5 帧预热；并行跑全量时约 135–140 fps；64x64 微基准见 `npm run test:canvas` |
| 页面 JS heap（强制 GC 前后） | < 16 MiB | **+0.3 MiB（3.4→3.7）** | CDP `JSHeapUsedSize`；仅页面 target，不含 decoder worker/WASM/GPU |

环境：2026-11-20，headless Chrome（Playwright，`--enable-unsafe-swiftshader`；
本次 `WebGL=true`），本地 Vite dev server，1280x720 合成 testsrc2 VP9 keyframe。
`tests/e2e/perf.spec.ts` 会断言上表的运行时下限（数值来自一次独立运行；全量
Playwright 并行运行会慢一些，但仍在阈值内）。测量的是 decoder/renderer 本地
管线，不包含 `RustDeskViewer`/React 挂载、连接/网络或远程 peer 首帧；后者由
初始 JS 预算、P5-1/P5-2 真机和 P5-5 最终验收覆盖。

## 如何复现

```bash
npm run check-size        # assets (ogv) + initial JS gzip
npm run check-js-size     # JS gzip only (iterating on imports)
npm run build             # prebuild runs check-size; output dist/notices
npm run test:canvas       # includes tests/e2e/perf.spec.ts
# 或只跑性能页:
npx playwright test tests/e2e/perf.spec.ts
```

- `scripts/check-size.mjs` 校验 `assets/ogv/manifest.json` 的大小/SHA-256/多余文件
  并强制 1.5 MiB 资产预算。
- `scripts/check-js-size.mjs` 用 Vite 构建公共入口，React/ReactDOM（peer）与
  `libsodium-wrappers`/`zstddec`（动态-only）external，统计入口 chunk 与静态
  imports 的 gzip 和；超过 250 KiB 会让 `npm run build` 失败。该测量包含
  protobufjs/yuv-canvas 等静态运行时依赖，是宿主打包首屏的保守上界；它是独立
  的 Vite 测量构建，不是 `dist/` 的原样大小。
- `demo/perf-test.html` + `tests/e2e/perf.spec.ts`：加载真实 ogv/WASM，解码
  720p keyframe，测首帧/FPS；Playwright 通过 CDP 在强制 GC 前后读
  `JSHeapUsedSize`，并断言上表下限。
- 720p fixture 是合成的 `testsrc2` keyframe（`test-fixtures/vp9-perf.ts`），生成命令
  在 `test-fixtures/README.md`；不随库发布，不影响运行时资源预算。

## 解释与限制

- “初始 JS”按规格不含 React；宿主自己的 React/其他依赖另计。宿主如果动态
  `import('rustdesk-web-react')`（如 demo 表单在 Connect 后懒加载），实际首屏更小。
- 总资源包含 `COPYING`/`LICENSE-vpx.txt`/`PATENTS-vpx.txt`；两套 decoder/WASM
  都必须在包内（SIMD/非 SIMD 回退），但运行时通常只按需取一套。
- FPS/首帧是合成单关键帧循环，不代表真实桌面内容复杂度/交错帧、网络抖动或
  移动设备；它更接近“每帧关键帧解码+绘制”的保守 microbenchmark，不是持续流。
  P5-1/P5-2 真机需复测并记录，不能把本页数字当作真机通过。
- 页面 JS heap 不包含 VP9 decoder worker/WASM 与 GPU 内存；16 MiB 下限只是页面
  target 的 sanity，不能证明 worker 无泄漏。长期/多分辨率内存仍需真机或
  worker-target 测量。
- 本页使用本地 dev server（未压缩模块），首帧包含 dev 模块加载开销；生产构建
  通常更快，但未单独构建 perf 页面测量。
- 初始 JS 与资源是两个独立预算（规格分别给出）；当前总和约 717 KiB，但脚本
  没有断言 1.5 MiB 的聚合值，因为“总资源”按规格指 VP9 静态资源。
