# 部署与集成

本文面向把 `rustdesk-web-react` 嵌入现有 React 后台的开发者。API 见
[API.md](API.md)，故障排查见 [TROUBLESHOOTING.md](TROUBLESHOOTING.md)。

## 拓扑与端口

浏览器只与 **hbbs/hbbr 的 WebSocket** 通信；被控端仍通过 RustDesk 自己的
TCP/UDP 端口注册和转发。

| 服务 | 端口 | 用途 |
| --- | --- | --- |
| hbbs | 21115/TCP | NAT 类型测试（与被控端） |
| hbbs | 21116/UDP + TCP | ID 注册/心跳/rendezvous |
| hbbs | 21118/TCP | **浏览器 rendezvous WebSocket** |
| hbbr | 21117/TCP | 中继（被控端） |
| hbbr | 21119/TCP | **浏览器 relay WebSocket** |

hbbs/hbbr 本身不终止 TLS。HTTPS 后台页面必须通过 nginx/Caddy 等反向代理提供
`wss://`，并把 `/ws/id`、`/ws/relay` 分别转发到 21118/21119。HTTP 页面可直接
连 `ws://<host>:21118` 和 `ws://<host>:21119`（见“局域网/HTTP”）。

## URL 推导规则

客户端根据 `server`（`host` 或 `host:port`）和页面协议推导：

| 页面 | `server` | rendezvous | relay（无 RelayResponse 时） |
| --- | --- | --- | --- |
| HTTPS | `rd.example.com`（无端口） | `wss://rd.example.com/ws/id` | `wss://rd.example.com/ws/relay` |
| HTTPS | `rd.example.com:21116` | `wss://rd.example.com:21118` | `wss://rd.example.com:21119` |
| HTTP | `rd.example.com`（无端口） | `ws://rd.example.com:21118` | `ws://rd.example.com:21119` |
| HTTP | `rd.example.com:12116` | `ws://rd.example.com:12118` | `ws://rd.example.com:12119` |

- 带显式端口时：rendezvous 端口 +2。relay 优先级是
  `RelayResponse.relay_server` → 配置 `relayServer`（端口 +2）→ hbbs 端口 +3；
  显式 `relayUrl` 覆盖全部，显式 `rendezvousUrl` 覆盖 `server`。
- 端口必须与 URL 中完全一致（CSP 也按端口匹配）。
- 推荐生产形态：一个 TLS 域名同时服务后台页面和 `/ws/id`、`/ws/relay`，页面里
  `server="rd.example.com"`（无端口），无需暴露 21118/21119 到公网。
- HTTPS 页面不能连 `ws://`（混合内容）；库对显式 `ws://` 覆盖会在发起前以
  `invalid-config` 拒绝。HTTPS 页面写 `server="host:21116"` 会尝试
  `wss://host:21118`，若 21118 是明文 hbbs 则表现为 TLS 失败
  （`server-unreachable`），不是“连接成功但黑屏”。

## nginx 反向代理示例

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

server {
    listen 443 ssl;
    http2 on;                         # nginx 1.25.1+；旧版用 listen 443 ssl http2;
    server_name rd.example.com;

    ssl_certificate     /etc/letsencrypt/live/rd.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/rd.example.com/privkey.pem;

    # 可选：后台静态文件。也可以由另一个 server/应用提供。
    root /var/www/admin;
    try_files $uri /index.html;

    location = /ws/id {
        proxy_pass http://127.0.0.1:21118;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;
        proxy_connect_timeout 10s;
        proxy_read_timeout 120s;      # 必须 > 18s securing 和 30s pairing
        proxy_send_timeout 120s;
    }

    location = /ws/relay {
        proxy_pass http://127.0.0.1:21119;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;
        proxy_connect_timeout 10s;
        proxy_read_timeout 120s;
        proxy_send_timeout 120s;
    }
}
```

- WebSocket 握手必须有 `Upgrade`/`Connection`、HTTP/1.1 上游和准确的
  `proxy_pass`；否则浏览器侧只会看到 `server-unreachable`，真实原因在 nginx
  error.log（502/504）。
- `proxy_read_timeout`/`proxy_send_timeout` 低于 18s 会在安全握手期间断开；
  低于 30s 可能打断 hbbr 首腿配对。设 120s 或更高；登录后客户端每 12s 心跳。
- **消息大小**：hbbr 配对后允许 64MiB/message、16MiB/frame；客户端不拆分视频帧。
  若出现 WebSocket close 1009，检查 hbbr/CDN/WAF 的限制，而不是把
  nginx `client_max_body_size` 当成唯一开关；必要时降低画质。参考规格
  `client_max_body_size`、buffer 与 `proxy_read_timeout`。
- 把 21118/21119 绑定在 loopback 或内网，只通过反代暴露；hbbs 的 21116/21115
  仍需对被控端可达。
- `X-Real-IP`/`X-Forwarded-For` 便于服务端日志；不要依赖它们做安全决策。

## Caddy 示例

```caddyfile
rd.example.com {
    handle /ws/id {
        reverse_proxy 127.0.0.1:21118 {
            header_up X-Real-IP {remote_host}
        }
    }
    handle /ws/relay {
        reverse_proxy 127.0.0.1:21119 {
            header_up X-Real-IP {remote_host}
        }
    }
    handle {
        root * /var/www/admin
        try_files {path} /index.html
        file_server
    }
}
```

Caddy 自动处理 WebSocket 升级、HSTS 和证书；默认没有 read/write timeout，
不会打断 18–30s 的阶段。若显式配置 transport 超时，保持 `>=120s`。Caddy 的
配置 reload 默认会关闭 WebSocket（`stream_close_delay` 可延后），这属于预期断开。

## 局域网/HTTP

- 后台、hbbs、hbbr 在同一可信局域网时可以直接用 HTTP + `ws://`：
  - `server="192.168.1.10"`（无端口）→ `ws://192.168.1.10:21118`;
  - `server="192.168.1.10:12116"`（本地 Docker 基端口）→
    `ws://192.168.1.10:12118`。
- 浏览器设备必须能访问 **21118 和 21119**，不仅是 21116/21117；被控端仍需
  21116 TCP/UDP 与 21117。
- **剪贴板**：`navigator.clipboard` 只在安全上下文（HTTPS 或
  `localhost`/`127.0.0.1`）可用。纯 HTTP 局域网页面仍可看画面/输入；自动复制
  会被拒绝，viewer 显示手动 “Copy” 按钮，并在点击手势中回退
  `document.execCommand('copy')`；本地→远端不读取系统剪贴板（浏览器不允许），
  而是打开粘贴框，用户长按粘贴后点 Send 发送。生产或不可信网络请使用
  HTTPS + WSS。
- 明文局域网会暴露页面与 rendezvous 报文（relay 载荷在安全握手后由应用层加密，
  但 rendezvous 本身不加密）。不要在不可信网络使用。
- 使用本仓库的 Docker 环境跨机测试时（仅仓库 checkout；宿主请用现有
  hbbs/hbbr），设置 `RD_BIND_HOST=0.0.0.0 RD_PUBLIC_HOST=<局域网IP>` 再启动
  `npm run dev:server`，否则服务端会向浏览器通告 `127.0.0.1` 的 relay 地址。
  端口为 `12116` 基址（WS 12118/12119）。

## 资源复制（ogv.js VP9）

资源必须由**同源**提供；Worker/WASM 跨域会失败，`resolveAssetBaseUrl` 会在请求
前拒绝跨域基址。同源判断基于 `document.baseURI` 的 origin：如果页面允许跨域
`<base>`，相对 `assetBaseUrl` 可能被改到另一 origin 并通过校验；请固定
`base-uri 'self'` 或使用绝对同源 URL。包内自带 `assets/ogv/` 的 SIMD 与非 SIMD
文件。

安装包后：

```bash
npx rustdesk-react copy-assets <host-public-dir>
# 本仓库 demo（产物在 demo/public/rustdesk-assets/）：
npm run copy-assets
```

产物：

```text
public/rustdesk-assets/
  ogv.js
  ogv-worker-video.js
  ogv-decoder-video-vp9-wasm.js / .wasm
  ogv-decoder-video-vp9-simd-wasm.js / .wasm
  COPYING
  LICENSE-vpx.txt
  PATENTS-vpx.txt
  manifest.json
```

- 默认 `assetBaseUrl=/rustdesk-assets/`。后台挂在子路径（如 `/app/`）时，把
  public 目录挂到 `/app/` 并设 `assetBaseUrl="rustdesk-assets/"`（相对
  `document.baseURI`）或绝对同源 `/app/rustdesk-assets/`。
- 确保 `.wasm` 以 `application/wasm` 提供；否则 Emscripten 会回退到
  ArrayBuffer 实例化（可用但更慢/有控制台告警）。
- 不要删除 `COPYING`、`LICENSE-vpx.txt`、`PATENTS-vpx.txt`；CLI 会一并复制。
- 资源目录必须完整；缺失时 video 初始化报 `asset-load-failed`。`manifest.json`
  可用于构建校验，运行时不需要。

## CSP（Worker/WASM）

ogv.js 通过 XHR 读取 worker/decoder 源码，用 `URL.createObjectURL` + `new Worker`
创建 blob worker，worker 内再 fetch `.wasm`；libsodium 与 zstddec 也使用
WebAssembly。以下是最小基线（按实际 WS 主机调整）：

```http
Content-Security-Policy:
  default-src 'none';
  script-src 'self' 'wasm-unsafe-eval';
  worker-src 'self' blob:;
  child-src 'self' blob:;
  connect-src 'self' data: wss://rd.example.com;
  style-src 'self';
  img-src 'self' data:;
  object-src 'none';
  base-uri 'self';
  frame-ancestors 'self';
```

逐项说明：

- `script-src 'self'`：库会动态插入同源 `ogv.js`（无 nonce）；nonce-only 策略需
  加 `'strict-dynamic'`，否则视频资源被拒绝，报 `asset-load-failed`。
- `script-src 'wasm-unsafe-eval'`：ogv VP9、libsodium（握手）、zstddec（压缩剪贴板）
  与 `wasm-feature-detect` 都需要。缺它会表现为连接握手失败/视频失败；JS 本身
  不需要 `'unsafe-eval'`（库源码无 eval；protobuf 使用静态生成代码）。
- `worker-src 'self' blob:`：blob worker 必需；`'self'` 不匹配 `blob:`。
  `child-src 'self' blob:` 兼容 Safari/iOS 15.0–15.4（它们忽略 `worker-src`，
  回退到 `child-src`）。不需要 iframe 时可再加 `frame-src 'none'`。
- `connect-src 'self'`：ogv.js 的 XHR 与 worker 内 `.wasm` fetch；缺它资源加载超时。
- `connect-src data:`：zstddec 用 `fetch('data:application/wasm;base64,...')`；
  `'self'` 不匹配 `data:`。禁用剪贴板（`disableClipboard`）可去掉这一项，但压缩
  剪贴板会失败。
- `connect-src wss://rd.example.com`：WebSocket。即使同源也显式列出（Safari 14/15
  对 `'self'` 匹配 WS 有已知问题）。若使用不同 relay 主机，必须列出
  `RelayResponse.relay_server` 推导出的主机/端口，例如
  `wss://relay.example.com:21119`；`wss://*.example.com` 不匹配裸 `example.com`。
  带端口的 server 还需要 `wss://rd.example.com:21118` 与 `:21119`。
- `style-src 'self'`：viewer 的样式通过 React style props/CSSOM 设置，不受
  style-src 限制。**SSR** 时 `renderToString` 会输出 style 属性；严格 CSP 下需要
  `style-src-attr 'unsafe-inline'`（或整体 `style-src 'self' 'unsafe-inline'`）。
  宿主自己的内联样式同样需要。
- `img-src`：库本身不加载图片；按宿主图标/头像需要调整，viewer-only 页面可用
  `img-src 'none'`。
- `base-uri 'self'`：相对 `assetBaseUrl` 以 `document.baseURI` 为基准，同源
  校验也基于它的 origin；允许跨域 `<base>` 可能让相对路径通过校验。固定
  `base-uri 'self'` 或使用绝对同源 URL。
- `'unsafe-eval'` 兼容：iOS 15.x 的部分版本不识别 `'wasm-unsafe-eval'`，需要
  `'unsafe-eval'` 才能运行 WebAssembly；请按目标 iOS 实测选择。`worker-src`
  也是 iOS 15.5 起才被识别，早期用 `child-src`。
- 若启用 Trusted Types（`require-trusted-types-for 'script'`），动态 script.src
  和 blob worker 需要宿主提供默认策略；本库未内置。

## 安全与 server key

- `serverKey` 是 hbbs 的 **Ed25519 公钥**（base64，不是私钥、不是设备密码）。
  自建 hbbs 首次启动在数据目录生成 `id_ed25519`/`id_ed25519.pub`；私钥绝不要
  分发或提交。缺失/不匹配时默认 fail-closed（`server-key-missing`/
  `server-key-invalid`）；`allowInsecureFallback=true` 才会降级为明文并发出
  `securityDowngraded`，仅用于兼容旧对端/调试。
- 运行时下发 server key：推荐由认证的同源 HTTPS API 返回，并通过
  `serverKeyProvider` 在每次 `connect()` 前获取；也可用官方 web client verifier
  格式的 `serverKeyVerifier`（`{ publicKey, verifier }`）。优先级是 provider 非空结果 →
  verifier → 静态 `serverKey`。provider 抛错以 `server-key-missing` 结束，
  verifier 无效以 `server-key-invalid` 结束，均 fail-closed，不受
  `allowInsecureFallback` 影响。
- `serverKeyVerifier` 的 payload 是 `signature || "1000::<serverKey>"`：`crypto_sign_open`
  验签后返回明文 key。它只提供完整性，不提供机密性；base64 解码后跳过 64 字节
  签名也能直接读到 key。`publicKey` 只有独立 pin/trust 时才是信任锚；与 verifier
  由同一认证响应下发时只是编码格式。需要浏览器完全接触不到 key 时，必须把
  rendezvous/relay/handshake 放到服务端网关。
- 预哈希密码：后台计算 `h1 = base64(SHA256(UTF8(password) || UTF8(salt)))`，通过
  `passwordHash`（字符串或 `{ hash, salt }`）传入；库只计算
  `SHA256(h1 || challenge)`，不会还原明文。h1 是 bearer credential，salt 公开且
  密码弱时可离线猜测；不要写日志、localStorage 或 URL。
- 密码只在内存中；不要写日志、localStorage 或 URL。后台应从自己的权限系统取出
  设备密码并作为 prop 传入，或使用 viewer 的密码表单/`onPasswordRequired`。
- `readOnly` 在本地阻止所有输入与入站剪贴板；`disableClipboard` 只关剪贴板。
  对端 `permission_info` 的键盘撤销同时禁用鼠标/触摸（上游 host 行为）。
- 端口/反代限制只应放宽到必要范围；不要为了绕过混合内容把 HTTPS 页面降级成 HTTP。

## 超时与消息

| 阶段 | 客户端预算 |
| --- | --- |
| WebSocket 打开 | 12s → `timeout` |
| RelayResponse | 12s |
| 安全握手（含 hbbr 配对等待） | 18s → `handshake-timeout` |
| 登录 | 60s（3s 后提示等待接受）→ `login-timeout` |
| 心跳 | 12s（`authenticating` 起即启动） |
| 登录后无消息 | 30s → `timeout` |

hbbr 服务端可能把首腿停放最多 30s 等待配对，但客户端的安全握手上限是 18s；配对
慢于 18s 会在客户端表现为 `handshake-timeout`，而不是等到 30s。反代/负载均衡/
云 WAF 的超时必须覆盖客户端预算。WebSocket close 1009 映射为
`message-too-large`；1006/1001 等映射为 `connection-lost`，详情见
[TROUBLESHOOTING.md](TROUBLESHOOTING.md)。

## 许可

复用的 RustDesk 协议/键盘表是 AGPL-3.0（only），本项目原创代码为
AGPL-3.0-or-later；组合分发按 AGPL-3.0 履行。宿主必须保留 LICENSE/NOTICE，并按
AGPL §4–§6（修改并以网络交互时还有 §13）提供 Corresponding Source。完整打包
清单、来源与义务见 [AGPL.md](AGPL.md)。
