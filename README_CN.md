# rustdesk-web-react

[English](README.md) | **简体中文**

**在线演示：** [caiguanhao.github.io/rustdesk-web-react](https://caiguanhao.github.io/rustdesk-web-react/)

轻量 React + TypeScript 库：把 RustDesk 的远程画面与远程控制嵌入现有 React 后台。

> **非官方项目**：本项目是独立的社区实现，与 RustDesk 官方团队无隶属、赞助或
> 背书关系。`RustDesk` 名称仅用于说明协议兼容性，相关商标归其权利人所有。

> **AI 辅助开发**：本项目使用 [Claude Code](https://claude.com/claude-code)
> 和 DeepSeek-V4.1-Flash-1017 编写。

- 宿主应用提供 `server`、`serverKey`、`id`、`password`；库本身没有账号体系和设备列表。
- ✅ 支持：视频 + 鼠标/键盘 + iOS/Android 触控 + 双向文本剪贴板。
- ❌ 不支持：音频、多屏、文件传输。

## 快速开始

要求：Node.js >= 20.19、React 18/19；浏览器需支持 WebSocket、WebAssembly、
ES2020（iOS 15+）。本仓库当前是 `private: true`、版本 `0.0.0`，未发布到 npm；
从仓库或本地 tarball/workspace 引用。

在仓库中构建并复制 demo 资源：

```bash
npm install
npm run build
npm run copy-assets          # demo: demo/public/rustdesk-assets/
```

安装到宿主项目后：

```bash
npx rustdesk-react copy-assets <host-public-dir>
```

资源必须与页面**同源**（相对 `document.baseURI` 校验，建议固定
`base-uri 'self'`）；默认 `assetBaseUrl` 为 `/rustdesk-assets/`。

以下是最常见的三种组合；`readOnly`、`onStatusChange`、`onError` 等与凭据方式无关，
可按需加到任一示例。

**情况 1：连接前从认证 API 取 serverKey（推荐）**

`serverKey` 不进入静态 bundle，适合已有登录态的宿主后台。

```tsx
import { RustDeskViewer } from 'rustdesk-web-react';

export function RemotePanel() {
  return (
    <RustDeskViewer
      server="rd.example.com"                 // 或 host:21116
      serverKeyProvider={async () => {
        const res = await fetch('/api/rustdesk/key', { credentials: 'include' });
        return res.ok ? (await res.json()).serverKey : undefined;
      }}
      id="123456789"
      passwordHash={passwordHash}             // base64(SHA256(password || salt))
      assetBaseUrl="/rustdesk-assets/"
      onStatusChange={(event) => console.log('status', event.status)}
      onError={(error) => console.warn('rustdesk', error.code, error.message)}
    />
  );
}
```

**情况 2：静态 serverKey + 密码（可选）**

适合简单部署。不传或留空 `password` 时，由 viewer 弹出密码输入框；直接传明文
密码时，密码会出现在前端代码或构建产物中，仅用于受控/内部页面。后续示例省略
`import` 和外层组件，只展示 props。

```tsx
<RustDeskViewer
  server="rd.example.com"                   // 或 host:21116
  serverKey="<hbbs base64 公钥>"
  id="123456789"
  password="<设备密码>"                        // 可选，如果为空将弹出密码输入框
  assetBaseUrl="/rustdesk-assets/"
/>
```

**情况 3：签名信封 serverKeyVerifier + passwordHash**

兼容官方 web client verifier；由宿主后端生成签名信封。

```tsx
<RustDeskViewer
  server="rd.example.com"
  serverKeyVerifier={{ publicKey, verifier }}
  id="123456789"
  passwordHash={passwordHash}
/>
```

`serverKey` / `serverKeyProvider` / `serverKeyVerifier` 决定 key 来源，
内置表单 / `password` / `passwordHash` 决定密码来源，两者可以交叉组合。

**`passwordHash` 怎么生成**

`passwordHash` 是 RustDesk 的 h1（32 字节摘要，base64 后传入），由被控端的
`Hash.salt` 与设备密码计算（两者直接拼接，无分隔符）：

```text
h1 = base64( SHA256( UTF8(password) || UTF8(salt) ) )
```

登录时库只在本地计算 `SHA256(h1 || UTF8(challenge))` 发给对端，h1 本身不会上网。
传 `password` 明文时库内部也按同样公式计算；`passwordHash` 只是把这一步提前到宿主
侧。也可以传 `{ hash, salt }`：带上 salt 时库会先与对端下发的 `Hash.salt` 比对，
不一致会要求重新输入密码。

salt 不是密钥，但必须与被控端一致，可从被控端 `RustDesk.toml` 的 `salt = "..."`
复制：

- macOS：`~/Library/Preferences/com.carriez.RustDesk/RustDesk.toml`
- Linux：`~/.config/rustdesk/RustDesk.toml`

宿主后端生成示例（Node.js）：

```ts
import { createHash } from 'node:crypto';

const passwordHash = createHash('sha256')
  .update(password, 'utf8')
  .update(salt, 'utf8')
  .digest('base64');
```

h1 等同于该设备的登录凭据，salt 是公开的，弱密码可被离线猜测，因此不要把
h1/密码写进 URL、localStorage 或日志。`serverKeyVerifier` 的 payload 是明文
`1000::<serverKey>`，签名只保证完整性，浏览器仍可还原 key；需要真正对浏览器隐藏
key 时，只能把连接放到服务端网关。

Headless（自绘 UI）：从 `rustdesk-web-react/core` 导入 `RustDeskSession`；
`connect`/`setVideoSink`/`on`/`bindInputs` 的完整签名和事件见
[docs/API.md](docs/API.md#rustdesksession)。

本地 Demo（仓库 checkout）：`npm run dev` 打开表单；`VITE_RD_*` 模板见
`demo/.env.example`，说明见 `demo/README.md`。不要提交 `demo/.env.local`。
密码模式的静态演示见 <https://caiguanhao.github.io/rustdesk-web-react/>。

详细文档：

| 文档 | 内容 |
| --- | --- |
| [docs/API.md](docs/API.md) | Viewer props/ref/labels、hook、Session、配置、事件、错误码、限制 |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | 端口/URL、nginx/Caddy 反代、HTTP/HTTPS/LAN、资源复制、CSP、server key、超时 |
| [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) | 按阶段/错误码/反代/资源/移动端的排查 |
| [docs/AGPL.md](docs/AGPL.md) | 复用来源、NOTICE、源码可得性与宿主义务 |
| [docs/PERFORMANCE.md](docs/PERFORMANCE.md) | 初始 JS/资源预算、启动/首帧/FPS/内存实测与方法 |
| [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) | 开发状态、公开 API 入口、分阶段实现记录、测试/验收与本机开发环境 |
| [demo/README.md](demo/README.md) | demo 表单、env 模板、持久化与密码卫生 |

## 许可与源码

本项目的原创代码以 **AGPL-3.0-or-later** 提供；复用的 RustDesk web client
协议/键盘表文件是 **AGPL-3.0（only；上游快照未确认 or-later）**，组合分发按
AGPL-3.0 履行。请保留 LICENSE/NOTICE，并按 AGPL §4–§6（修改并以网络交互时还有
§13）提供对应源码。完整的打包清单、来源与宿主义务见
**[docs/AGPL.md](docs/AGPL.md)**；依赖许可见 `THIRD_PARTY_NOTICES.md`。这不是
法律意见。

