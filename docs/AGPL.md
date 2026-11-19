# 许可、来源与 AGPL

本项目的**原创代码**以 **GNU Affero General Public License v3.0 or later**
（`AGPL-3.0-or-later`）提供；完整文本见仓库根目录 `LICENSE`。但下面复用的
RustDesk web-client 文件只能按 **AGPL-3.0（only）** 处理：上游快照没有明确的
“or later”声明，不能替它们假定 or-later。组合分发时应按 AGPL-3.0 遵守较严格的
义务。这不是法律意见；AGPL 文本本身为准。

## 复用的协议代码

| 本地文件 | 来源 | 许可 | 说明 |
| --- | --- | --- | --- |
| `src/protocol/message.ts` | RustDesk web client v1（`rustdesk-web-v1` 分支） | **AGPL-3.0（only；未验证 or-later）** | ts-proto 生成代码加少量手写字段；来源/修改见 `src/protocol/NOTICE.md` |
| `src/protocol/rendezvous.ts` | 同上 | **AGPL-3.0（only）** | 来源见 `src/protocol/NOTICE.md` |
| `src/input/keymaps.ts` | RustDesk web client v2（`rustdesk-web-v2` 分支） | **AGPL-3.0（only）** | 键盘 position-keycode 表转录；来源见 `src/input/NOTICE.md` |
| `proto/*.proto` | RustDesk 1.5.3 参考 | **AGPL-3.0（only）** | 仅字段对照，运行时不使用 |
| `assets/ogv/` | ogv.js 1.8.6 | MIT（wrapper）+ BSD-3-Clause（libvpx）+ patent grant | `COPYING`、`LICENSE-vpx.txt`、`PATENTS-vpx.txt` |

RustDesk 及其 web client 的版权归 RustDesk 项目及其贡献者所有；本项目保留其
NOTICE/版权声明。来源通知保留上游仓库名/分支；本项目使用的只读参考 checkout
和完整派生源码都随包提供在 `src/`（上游 web-client 的旧仓库地址可能已不可访问，
以包内源码和通知为准）。`src/crypto/handshake.ts`、`src/protocol/secure.ts`、
`src/protocol/url.ts` 等文件在头部注明了所参考的上游行为；如后续确认其中包含
逐字转录的代码，应补充到相应 NOTICE。若上游/法律确认了 or-later 授权，再把
对应表项升级；在此之前不要这样标注。

根目录 `NOTICE`、`THIRD_PARTY_NOTICES.md`、`src/protocol/NOTICE.md` 和
`src/input/NOTICE.md` 随包提供（见下）。打包时不要把 NOTICE、LICENSE 或资源
许可文件删掉。

## 第三方运行时依赖

完整列表与许可标识见根目录 `THIRD_PARTY_NOTICES.md`。运行时依赖由宿主项目安装，
其 npm 包自带许可文本；`yuv-canvas` 的 npm 包未附带 LICENSE 文件，因此 MIT 文本
在 `THIRD_PARTY_NOTICES.md` 中重现。ogv.js/libvpx 的许可文本随 `assets/ogv/` 提供。

## 宿主的 AGPL 义务（概要）

如果把本库打包进一个通过浏览器访问的 Web 应用：

- 保留本库和复用组件的版权/NOTICE/许可文本，不额外施加限制。
- 复用的 RustDesk 协议/键盘表文件按 AGPL-3.0（only）遵守；原创代码的
  or-later 选项不改变这些文件的许可。
- 按 AGPL §4–§6 提供你实际部署版本的 **Corresponding Source**，包括构建/安装
  所需的脚本和修改。
- 如果你修改了本库并通过网络让用户与之交互，AGPL §13 要求在服务器上向这些用户
  显著提供获取修改版 Corresponding Source 的方式（免费）。
- 源码提供方式可以是随分发附带源码、在可达的服务器上提供，或书面要约；必须覆盖
  你部署的确切版本和你的修改。
- 最终用户的 RustDesk 客户端/服务端是独立程序，其许可与配置由用户负责；本库不会
  读取或修改它们。

以上是工程说明，不构成法律意见。对外分发/商用前请让合规/法律同事确认具体部署方式。

## 本仓库的源码可得性

- 本仓库包含完整的 TypeScript 源码、构建配置、`proto/` 参考和资源许可文件。
- `package.json` 的 `files` 是打包内容的唯一权威：当前包含 `dist`、`assets`、
  `docs`、`src`、`proto`、构建配置、`scripts/lib`、`scripts/check-size.mjs`、
  `scripts/check-js-size.mjs`、`scripts/copy-notices.mjs`、demo 的 README/env
  模板、`NOTICE` 和 `THIRD_PARTY_NOTICES.md`；可执行 bin 由 `bin` 字段自动包含，
  `LICENSE`/`README` 由 npm 自动包含。`npm pack` 会把这些一起打包。
- `dist/notices/` 在构建后按仓库相对路径镜像 `LICENSE`、`NOTICE`、
  `THIRD_PARTY_NOTICES.md`、`docs/AGPL.md`、`src/protocol/NOTICE.md`、
  `src/input/NOTICE.md` 和 `assets/ogv/` 的许可文件，方便只分发 `dist/` 的宿主
  保留声明。`npm pack` 前的 `prepack` 会先构建。
- 当前 `package.json` 仍是 `private: true`、版本 `0.0.0`，没有发布到 npm；内部
  分发时请连同上述源码/NOTICE 一起提供。若将来公开发布，需移除 `private`、设置
  版本并确保源码提供方式可达。

## 第三方服务端

部署文档中的 hbbs/hbbr 是 RustDesk 服务端程序（或兼容实现），它们有自己的
AGPL 义务和配置；本库只作为客户端连接。若复制第三方服务端的配置/文档，请在
部署文档或 `THIRD_PARTY_NOTICES.md` 中注明来源与许可。
