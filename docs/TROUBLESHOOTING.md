# 故障排查

先看浏览器 Console 和 viewer 覆盖层/`onError` 的 `RustDeskError.code`，再看
hbbs/hbbr/反代日志。不要打印 config（尤其 password/serverKey）或完整 env 文件。

## P5-4 自动验证矩阵

除密码错误外，失败都产生 `status:error` + `error` 事件的 `RustDeskError.code`；
viewer 使用通用覆盖层：错误消息 + Retry、断开 + detail + Connect、密码表单 +
retry detail。UI 由 `tests/rustdesk-viewer.test.tsx` 的 error/disconnected/password
用例覆盖（不按 code 定制）。这些场景由 mock hbbs/hbbr/peer 与实际 WebSocket 关闭
码驱动，不需要真机。

| 场景 | 类型化结果 | 测试 |
| --- | --- | --- |
| 密码错误 | `password-required{retry:true, detail}`（不是 `error`，同一 Hash 重试） | `tests/login.test.ts`（same Hash）、`tests/session-integration.test.ts`、viewer 表单 |
| h1 salt 不匹配 | `password-required{retry:false, detail:'Password hash salt mismatch'}`，不发 LoginRequest | `tests/login.test.ts`、`tests/session.test.ts`、`tests/session-integration.test.ts` |
| 对端离线 | `peer-offline` | `tests/mock-server.test.ts`、`tests/session-integration.test.ts` |
| server key 错误 | `server-key-invalid`（静态 key 或 verifier） | `tests/mock-server.test.ts`、`tests/secure.test.ts`、`tests/server-key.test.ts`、session failure |
| server key provider 失败 | `server-key-missing`（socket 未打开） | `tests/server-key.test.ts`、`tests/session.test.ts`、`tests/session-integration.test.ts` |
| 服务器不可达 | `server-unreachable`（或静默丢包时 `timeout`） | `tests/websock.test.ts`、`tests/session-integration.test.ts` |
| 对端 close_reason | 登录后 `disconnected{detail}`；登录前 `error`+`peer-closed` | `tests/session-integration.test.ts`、`tests/session.test.ts`（登录后）、`tests/login.test.ts`/`tests/secure.test.ts`（登录前）、viewer disconnected |
| 网络中断 | 收到 close → `connection-lost`；无 close 的静默丢包 → `timeout` | `tests/session-integration.test.ts`（server shutdown）、`tests/session.test.ts`（read timeout）、`tests/websock.test.ts` |
| 反代 1009 | `message-too-large` | `tests/websock.test.ts`、`tests/mock-server.test.ts`（hbbr）、`tests/session-integration.test.ts`（mid-session） |

密码错误被设计为状态而非错误，以便同一连接/同一 Hash 重试；其余失败都可在宿主的
`onError` 中按 code 记录（不要记录密码/key）。

## 第一步：区分阶段

| 现象 | 通常阶段 | 先检查 |
| --- | --- | --- |
| 立即 `invalid-config` | 配置/URL/凭据 | `server` 是否 `host[:port]`、HTTPS 页面是否用了 `ws://`、`password` 与 `passwordHash` 是否同时非空、h1 是否 base64 32 字节 |
| `server-unreachable` / `timeout` | WebSocket 打开前 | hbbs 21118 / hbbr 21119 地址/端口、防火墙、反代 502/504、TLS；静默丢包常是 `timeout` |
| 卡在 `connecting` | rendezvous 或 key 解析 | hbbs WS 21118、PunchHoleResponse、对端 ID；若用了 `serverKeyProvider`，检查它是否卡住/超时 |
| 卡在 `securing`（约 18s 后 `handshake-timeout`） | relay/安全握手 | hbbr WS 21119、首腿配对、serverKey、对端在线；客户端 18s 上限，hbbr 可能等 30s |
| 卡在 `authenticating` / `awaiting-approval` | 登录 | 对端是否等待接受、密码、2FA、登录 60s 预算 |
| `password-required` | 登录 | 密码/重试；detail 为 `Password hash salt mismatch` 时检查 h1 的 salt，不是网络错误 |
| 已连接但黑屏 | 解码/资源 | `asset-load-failed`、CSP、`.wasm` MIME、非 VP9 |
| 输入无反应 | 权限/焦点 | `readOnly`、对端权限、viewer 是否聚焦、Android 对端 |
| 剪贴板失败 | 浏览器权限/安全上下文 | HTTPS/localhost、用户手势、`clipboard-unavailable` |

## 错误码

| 代码 | 常见原因 | 处理 |
| --- | --- | --- |
| `invalid-config` | server 为空/格式错误、端口越界、显式 URL 非 ws(s)、HTTPS 页面用 ws://、`password`+`passwordHash` 冲突、h1 非 base64/非 32 字节、retry h1 salt 不匹配 | 按[部署](DEPLOYMENT.md)修正；HTTPS 全部用 wss 或反代路径；凭据问题见[API](API.md#凭据与-server-key-语义)。 |
| `invalid-state` | active 状态重复 connect；无登录 flow 时 login；session 尚未挂载就调 ref.connect | 等当前连接结束/卸载完成；用 `status` 判断。 |
| `aborted` | AbortSignal/dispose 取消 | 预期（组件卸载/取消）；不要当故障。 |
| `server-unreachable` | hbbs 21118 或 hbbr 21119 的 WS 打不开：未监听、反代缺 Upgrade、TLS 失败 | 先查反代 error.log/`ss -ltnp`；浏览器拿不到 HTTP 502/504 状态。静默丢包常表现为下面的 `timeout`。 |
| `timeout` | WebSocket 打开 12s、RelayResponse 12s、或登录后 30s 无消息 | 查服务端/网络；登录/安全握手超时分别见 `login-timeout`/`handshake-timeout`。 |
| `connection-lost` | 已建立后被关闭：反代超时/1006、hbbr 空闲、服务重启、网络中断 | 反代超时设 120s；查 hbbr 日志；客户端会自动断开会话。 |
| `rendezvous-refused` | PunchHoleResponse 拒绝、licence 超限 | 查 hbbs 日志/licence。 |
| `id-not-found` / `peer-offline` | 被控端 ID 未注册/离线 | 在对端启动 RustDesk 并确认 ID；等待注册。 |
| `unsupported-version` | RelayResponse 缺少版本字段（服务端/协议版本不受支持） | 检查 hbbs/hbbr 版本与兼容性；不要绕过安全校验。 |
| `message-too-large` | WebSocket close 1009；剪贴板 >4 MiB | 查 hbbr/CDN/WAF 上限；降低画质；不要拆视频帧。 |
| `server-key-missing` | 未提供 serverKey、`serverKeyProvider` 抛错/返回非字符串、或 hbbs 无签名私钥（RelayResponse.pk 空） | 自建服务器填 base64 公钥或修 provider；确认 hbbs 数据目录有完整密钥对。provider 错误不会降级。 |
| `server-key-invalid` | key 格式错误、与 hbbs 不匹配、licence 不匹配，或 `serverKeyVerifier` 验签/提取失败 | 用同一 hbbs 的 `id_ed25519.pub`（去掉换行）；verifier 检查 publicKey/签名和 `1000::<key>` payload。 |
| `peer-signature-invalid` / `peer-id-mismatch` / `peer-key-invalid` | 对端身份/签名/公钥异常 | 确认连的是目标 ID；重试/升级对端；不要开启不安全的回退。 |
| `handshake-timeout` | 18s 内没完成安全握手（含 hbbr 首腿配对等待）：对端未配对、relay 不通、反代缓冲/超时 | 查 21119、hbbr 日志、反代超时/缓冲；对端是否在线。hbbr 服务端可能等 30s，但客户端 18s 就会放弃。 |
| `login-timeout` | 60s 内未拿到 peer_info | 对端是否等待接受；2FA；密码；反代是否断开。 |
| `wrong-password` / `too-many-attempts` / `try-later` / `two-factor-required` | 密码或对端策略 | viewer 会显示密码重试/详情；2FA 当前无 UI，需要用户在对端处理。 |
| `blocked` | ID/IP 被封禁 | 在对端/服务端解除。 |
| `no-permission` | 对端撤销键盘/剪贴板，或登录被拒绝 | 只读/权限策略；viewer 显示 notice；不要重试刷屏。 |
| `unsupported-codec` | 收到非 VP9 帧 | 重连以重新协商 VP9；本库不发送 `supported_decoding`。 |
| `asset-load-failed` | ogv.js/.wasm 404、CSP、跨域、MIME、初始化失败 | 见“资源/CSP”；播放前需要同源资源。 |
| `clipboard-unavailable` | 浏览器剪贴板被拒/非安全上下文/无手势 | 用 HTTPS/localhost；点击 viewer 的 Copy/Clipboard 按钮；或接受手动复制。 |
| `peer-closed` | 对端 `close_reason`（含空闲/被踢）；登录后映射为 `disconnected`，登录/握手前为 `error` | 看 detail；重新连接并检查对端。 |
| `protocol-error` / `peer-error` | 消息/对端错误文本 | 查对端版本/日志；必要时升级。 |

## 资源、Worker 与 CSP

- 404：资源没复制或路径不对。运行 `npx rustdesk-react copy-assets <publicDir>`，
  确认产物在 `<publicDir>/rustdesk-assets/`，URL 同源。
- `resolveAssetBaseUrl` 会拒绝跨域/非 http(s) 基址（`AssetUrlError`）；CDN 不可用。
- CSP 缺项：ogv.js 需要 `script-src 'self'`；blob worker 需要
  `worker-src 'self' blob:`（iOS 15.0–15.4 用 `child-src`）；worker 内 fetch 和
  XHR 需要 `connect-src 'self'`；WebAssembly 需要 `'wasm-unsafe-eval'`
  （iOS 15.x 可能要 `'unsafe-eval'`）。完整基线见[部署](DEPLOYMENT.md#cspworkerwasm)。
- 压缩剪贴板额外需要 `connect-src data:`（zstddec 的 data: wasm）；否则
  `disableClipboard` 可避免。
- `.wasm` 必须是 `application/wasm`；否则会回退 ArrayBuffer 实例化（可用但更慢）。
- 只分发 `dist/` 时，注意 `dist/notices/` 是构建生成的许可/NOTICE；资源仍需复制。

## 反代/网络

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| nginx 502 | 连不到 hbbs 21118/hbbr 21119 | 检查 proxy_pass、监听地址、Docker 网络、防火墙。 |
| nginx 504/WS 打不开 | 上游未及时响应 | 检查服务健康、proxy_connect_timeout。 |
| 15–30s 断开（常在 securing） | `proxy_read_timeout` 太短 | 设为 120s+；确保 Upgrade/Connection、HTTP/1.1。 |
| 约 60s 空闲断开 | nginx 默认 60s read timeout | 设为 120s+；心跳 12s 从 `authenticating` 起就会发送。 |
| 1009 | hbbr/CDN/WAF 消息上限 | 查 hbbr 限制；降低画质；不要拆帧。 |
| 1001/1002/1006 | 配对/空闲/协议/网络 | 查 hbbr 与反代日志、网络质量。 |
| TLS/WSS 失败 | `wss://host:21118` 指向明文 hbbs、证书不受信 | 用 443 反代路径或有效证书；HTTPS 页面写 `host:port` 会直连 +2 端口。 |
| HTTPS 页面报 `invalid-config` | 显式 `ws://` 混合内容 | 改 wss 或把 WS 放到同源 443 反代。 |

## 密码、2FA 与只读

- `password-required` 不是错误：没有 config 密码时先等用户输入；错误密码后
  `retry:true` 在同一连接/同一 Hash 重试。
- 对端“No Password Access”/点击接受：本库无密码时不会发送空密码 LoginRequest，
  需要输入任意密码才能继续（已知限制）。
- 2FA 无内置 UI；`two-factor-required` 需在对端完成。
- `passwordHash` 是 32 字节 h1 的 base64（`SHA256(password || salt)`），不是明文；
  库只计算 `SHA256(h1 || challenge)`，不会还原密码。salt 不匹配时状态 detail 为
  `Password hash salt mismatch`；retry hash 的 salt 不匹配会抛 `invalid-config`。
- h1 仍是 bearer credential；salt 公开且密码弱时可离线猜测，按密码级别保管。
- 只读：viewer 显示 “View only” 并禁用输入；`readOnly` 也阻止入站剪贴板。
  对端撤销键盘权限时鼠标/触摸也会禁用（上游 host 语义）。
- 不要把密码/h1/serverKey 写进 URL/localStorage/日志；排查时只记录错误码/状态。

## 输入/移动端

- 桌面：先点击画面让 viewer 聚焦；键盘监听在 `document` 上，未聚焦不捕获。
  浏览器/OS 保留快捷键可能被拦截或无法发送。
- iOS/Android（2026-11-20 真机通过：iOS 26.6.2 Safari、Android 15 Chrome
  156）：软键盘通过工具栏 Keyboard 按钮（用户手势）聚焦隐藏 textarea；中文
  IME、Backspace/Enter、双击/长按/双指手势、自动复制/手动复制均已验证。
- Android 第三方 IME（如 Microsoft SwiftKey）可能不发 composition 事件，而是
  用 `input{insertText}` 提交文本、用 `input{deleteContentBackward}` 删除；
  库只对插入类 inputType 发送 `data`，删除/换行交给按键回退。若某 IME 仍异常，
  用 `demo/ime-events.html` 抓事件序列。
- iPhone Safari 对普通元素没有 Fullscreen API，viewer 用 CSS 固定定位铺满；
  浏览器地址栏无法由网页隐藏。需要真正全屏时用“添加到主屏幕”/standalone 或
  宿主 WKWebView。
- 被控端是 Android 时，本库按桌面 peer 发送鼠标事件；Android 原生触摸协议
  （PointerDeviceEvent）未实现，MVP 目标是桌面被控端。
- 剪贴板工具栏按钮是“本地→远端粘贴”；HTTPS 下读取系统剪贴板（需手势/权限），
  纯 HTTP 下浏览器不提供 `navigator.clipboard`，按钮改为打开粘贴框；远端→本地
  自动复制失败时显示 Copy 按钮，点击后用 `execCommand` 回退写入。

## 画面

- 黑屏但状态 connected：检查 `asset-load-failed`、CSP、资源 404、`.wasm` MIME；
  非 VP9 会报 `unsupported-codec`。
- 分辨率/旋转变化后短暂黑屏：pipeline 会重建 decoder 并请求关键帧；持续黑屏看
  Console 错误。
- 只有单屏：MVP 一次只捕获当前显示；`switchDisplay()` 是编程接口，无多屏 UI。
- 没有远端光标绘制/音频/文件传输/聊天：规格明确不在 MVP。

## React/SSR

- StrictMode 双挂载：第一个 session 的 socket 会同步关闭，只保留第二个；Playwright
  有专门用例。看到一次短暂连接是预期。
- SSR：viewer/hook 在 render 期间不创建 session/DOM，首屏 idle；样式属性输出需要
  CSP `style-src-attr 'unsafe-inline'`。
- 配置字段（server/key/id/password/URL/quality/fallback/version）变化会重建
  session；`readOnly`/`disableClipboard` 实时生效不重连；`autoConnect` 只在创建时读取。
- 卸载/换配置时 WebSocket、worker、定时器、监听器、IME textarea 应全部清理；
  若宿主看到泄漏，先升级到本版本并提供最小复现。

## 诊断清单

1. 记录 `status`/`RustDeskError.code`/`message`/`cause`（不要记录密码/key）。
2. 浏览器 DevTools → Network → WS：看握手 URL、是否 101、关闭码/原因。
3. 反代访问/错误日志：502/504、Upgrade、超时。
4. hbbs/hbbr 日志与端口监听（21116/21118/21117/21119）。
5. 资源：Network 中 `rustdesk-assets/*` 是否 200，Content-Type 是否正确。
6. 宿主 CSP/安全头：按[部署](DEPLOYMENT.md#cspworkerwasm)逐项比对。
7. 仍无法定位时，用本仓库的 mock/隔离 Docker 环境复现（README 的 P1-9 节），
   避免连接用户的生产客户端。
