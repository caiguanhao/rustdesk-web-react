# API 参考

本文覆盖 `rustdesk-web-react` 的公开入口。协议实现细节见
[DEVELOPMENT.md](DEVELOPMENT.md) 的“实现记录”与源码；部署/排错见
[DEPLOYMENT.md](DEPLOYMENT.md) 与 [TROUBLESHOOTING.md](TROUBLESHOOTING.md)。

## 包入口

| 入口 | 内容 | React |
| --- | --- | --- |
| `rustdesk-web-react` | `RustDeskViewer`、`useRustDeskSession`，并重导出 `./core` 的全部公开 API | 需要 |
| `rustdesk-web-react/core` | `RustDeskSession`、配置/状态/错误/类型、资源 URL 工具；不含任何 React 代码 | 不需要 |

- React 18/19 是 peerDependency，库不打包 React。
- 仅 ESM（`import`）；相对源码导入使用 `.js` 后缀的声明由构建产物提供。
- 库不读取全局配置、环境变量或 localStorage；`server`/`serverKey`/`id`/
  `password`/`passwordHash`/`serverKeyProvider`/`serverKeyVerifier` 全部由宿主传入。
  密码/h1 只在内存中使用。

```tsx
import { RustDeskViewer } from 'rustdesk-web-react';
import type {
  RustDeskViewerProps,
  RustDeskViewerRef,
  RustDeskViewerLabels,
  PasswordPrompt,
} from 'rustdesk-web-react';
import {
  RustDeskSession,
  RustDeskError,
  DEFAULT_ASSET_BASE_URL,
  type RustDeskSessionConfig,
  type RustDeskStatusEvent,
  type PeerInfo,
} from 'rustdesk-web-react/core';
```

## 配置：`RustDeskSessionConfig`

`<RustDeskViewer>` 的 props 继承此配置；`RustDeskSession` 构造函数接收同一对象。

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `server` | `string` | 必填 | hbbs 地址，`host` 或 `host:port`。HTTPS 页面且无端口时走 `wss://<host>/ws/id`；带端口时端口 +2（如 `21116` → `21118`）。见[部署](DEPLOYMENT.md)。 |
| `serverKey` | `string?` | 无 | hbbs Ed25519 公钥（base64），静态回退。`serverKeyProvider`/`serverKeyVerifier` 优先；缺失/不匹配默认 fail-closed。 |
| `serverKeyProvider` | `() => string \| undefined \| Promise<string \| undefined>` | 无 | 每次 `connect()` 在打开任何 socket 前调用；非空结果优先。返回空值继续回退，抛错则以 `server-key-missing` fail-closed。hook 通过 ref 读取最新 prop（React 可传 inline）；直接用 `RustDeskSession` 时传稳定函数。 |
| `serverKeyVerifier` | `{ publicKey: string; verifier: string }` | 无 | 兼容官方 web client verifier 的签名信封。payload 为 `1000::<serverKey>` 或原始 key；验签失败 `server-key-invalid`，不回退 static。**payload 是明文，不是加密**。 |
| `id` | `string` | 必填 | 被控设备 ID。 |
| `password` | `string?` | 无 | 设备密码，仅内存。省略时进入 `password-required`，由 viewer 表单或 `onPasswordRequired` 提供。与 `passwordHash` 非空时互斥。 |
| `passwordHash` | `string \| { hash: string; salt?: string }` | 无 | RustDesk h1（base64 的 32 字节 `SHA256(password \|\| salt)`）。库只在本地计算 `SHA256(h1 \|\| challenge)`，不会解密成明文。对象可带 `salt` 与对端 `Hash.salt` 校验。 |
| `relayServer` | `string?` | 无 | 可选 relay 回退：`RelayResponse.relay_server` 优先；无该字段时使用此值，relay 端口 +2；两者都没有才回退 hbbs +3。 |
| `rendezvousUrl` | `string?` | 无 | 显式 rendezvous WebSocket URL（mock/非标准反代）。优先于 `server`。 |
| `relayUrl` | `string?` | 无 | 显式 relay WebSocket URL。优先于其他来源。 |
| `assetBaseUrl` | `string?` | `/rustdesk-assets/` | ogv.js VP9 资源基址，相对 `document.baseURI` 解析且要求同源。 |
| `decoderSimd` | `boolean?` | 自动检测 | 强制 SIMD/非 SIMD VP9 解码器；省略时 feature-detect 并回退非 SIMD。用于真机诊断（如 `?simd=0` 覆盖 iOS 15/16.3 路径）。 |
| `imageQuality` | `'low' \| 'balanced' \| 'best'` | `'balanced'` | 请求的捕获质量（RustDesk image quality）。 |
| `readOnly` | `boolean?` | `false` | 只读：禁止鼠标/键盘/触摸/IME/剪贴板发送，也不应用远端剪贴板；viewer 显示只读徽标。 |
| `disableClipboard` | `boolean?` | `false` | 双向关闭剪贴板；鼠标/键盘/触摸仍可用。 |
| `allowInsecureFallback` | `boolean?` | `false` | 签名握手失败时是否允许 v1 明文回退；默认失败关闭。开启后会发 `securityDowngraded`。 |
| `advertiseWebClientVersion` | `boolean?` | `false` | 是否发送官方 web client 的 `version`/`my_platform`（1.3.7/web）；默认不发送以避免对端启用 MultiClipboards 等新行为。 |

`assetBaseUrl` 为空字符串时按默认值处理。密码、h1、server key 不会被库持久化或写日志。

### 凭据与 server key 语义

- 密码来源优先级/互斥：
  - `password` 非空且 `passwordHash` 存在 → `connect()` 前以 `invalid-config` 拒绝。
  - 仅 `passwordHash` → 使用 h1；裸字符串按 base64 h1 解释，对象是 `{ hash, salt? }`。
  - 仅 `password` → 现有明文路径。
  - `password: ''` 视为未提供，可与 `passwordHash` 共存。
- `passwordHash` 裸字符串只按 **base64 h1** 解释；`onPasswordRequired`/`login`/`connect`
  的裸字符串仍是 **明文密码**，只有对象才是 h1。
- h1 不会发到网络，也不会被解密：库只把它与 challenge 做 `SHA256(h1 || challenge)`。
  h1 是 bearer credential；salt 公开且密码弱时可被离线猜测，不能当作“安全哈希”。
- 初始 hash 的 salt 与对端 `Hash.salt` 不一致时：发
  `password-required{retry:false, detail:'Password hash salt mismatch'}`，不发
  LoginRequest；之后 `login(hash)` 的 salt 仍不一致则抛 `invalid-config`（viewer
  会回退内置表单）。
- server key 每次 `connect()` 解析一次，优先级：
  `serverKeyProvider` 非空结果 → `serverKeyVerifier` → 静态 `serverKey`。
  provider 返回值非字符串/抛错 → `server-key-missing`；verifier 无效 →
  `server-key-invalid`（不回退）。解析失败不受 `allowInsecureFallback` 影响。
- `serverKeyVerifier` 的 publicKey 只有独立 pin/trust 时才是信任锚；若与 verifier
  由同一认证响应下发，只是编码格式。payload 是明文 `1000::<serverKey>`，浏览器可
  还原，**不是**对用户隐藏 key 的手段。

## `<RustDeskViewer>`

### Props

在配置字段之外：

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `className` | `string?` | 无 | 根节点 class。 |
| `style` | `CSSProperties?` | 无 | 合并到根节点；默认 `width:100%`、`aspect-ratio:16/9`、黑底。 |
| `autoConnect` | `boolean?` | `true` | 挂载/创建 session 时自动连接；创建后修改不会重连。 |
| `showToolbar` | `boolean?` | `true` | 是否显示内置工具栏。 |
| `labels` | `Partial<RustDeskViewerLabels>?` | 英文默认 | 覆盖任意 UI 字符串。 |
| `onStatusChange` | `(event: RustDeskStatusEvent) => void` | 无 | 每次状态变化。 |
| `onPasswordRequired` | `(prompt: PasswordPrompt) => RustDeskPasswordCredential \| undefined \| Promise<RustDeskPasswordCredential \| undefined>` | 无 | 返回 string（明文）或 `{ hash, salt? }`（h1）自动登录；返回 `undefined`/抛错/拒绝则显示内置表单。密码被拒会带 `retry:true` 再次调用。 |
| `onError` | `(error: RustDeskError) => void` | 无 | 所有 session `error` 事件，包括非致命错误（`no-permission` 等）。 |
| `onClipboard` | `(text: string) => void` | 无 | 已解压的远端文本；自动复制失败也会调用。手动复制按钮由 viewer 显示。 |
| `onPeerInfo` | `(info: PeerInfo) => void` | 无 | 首次 `peer_info` 及后续显示列表/当前显示更新。 |
| `onStats` | `(stats: SessionStats) => void` | 无 | 仅为 API 兼容保留；当前**不会调用**（fps/decode 统计尚未实现）。 |

### `PasswordPrompt`

```ts
interface PasswordPrompt {
  retry: boolean;   // 上次密码被拒后为 true
  error?: string;   // 非敏感详情，如 "Wrong Password" / "Password hash salt mismatch"
}
```

返回的 credential 可以是明文 `string`，也可以是预哈希对象：

```ts
{ hash: '<base64 32-byte h1>', salt?: '<对端 Hash.salt>' }
```

### Ref

```ts
interface RustDeskViewerRef {
  connect(credential?: RustDeskPasswordCredential): Promise<PeerInfo>;
  disconnect(): void;
  sendCtrlAltDel(): void;
  setFullscreen(enabled: boolean): Promise<void>;
  focusKeyboard(): void;
}
```

- `connect(credential?)`：credential 只在 session 已处于 `password-required` 时用于
  同一 Hash 重试（string=明文，`{ hash, salt? }`=h1）；新连接的凭据来自
  config/`onPasswordRequired`，此参数会被忽略。已有进行中的连接时返回同一个
  Promise；session 尚未挂载时以 `invalid-state` 拒绝。
- `disconnect()`：隐藏密码表单并断开；session 可再次 `connect`。
- `sendCtrlAltDel()`：仅在已连接、非只读、`PeerInfo.sasEnabled` 且键盘权限允许时发送，否则 no-op。
- `setFullscreen(enabled)`：调用 renderer 的全屏 API；无 renderer 时 resolve。返回值不表示浏览器是否接受请求（`requestFullscreen` 的 false 被吞掉）。
- `focusKeyboard()`：移动端用户手势中调用，聚焦隐藏 IME textarea 打开软键盘；未连接/只读/无 IME 权限时 no-op。

### 内置行为

- 状态覆盖层：连接中/等待接受/密码表单/错误重试/断开后重连/idle 连接按钮。
- 工具栏：Ctrl+Alt+Del（仅 `sasEnabled`）、全屏、软键盘、剪贴板（本地→远端粘贴）、
  断开。画质在 MVP 固定，无控件。
- 输入门控：`policy ∩ status === 'connected' ∩ focus`。键盘监听在 `document` 上，
  viewer 未聚焦时不捕获；IME textarea 聚焦视为 viewer 聚焦。`readOnly` 时输入按钮禁用。
- 触摸：tap/双击/长按/拖动/双指滚动/捏合本地缩放；缩放只改画布 CSS transform，不发送协议。
- 剪贴板：远端文本默认自动复制；浏览器拒绝时显示手动 Copy 按钮。工具栏“Clipboard”
  调用 `sendLocalClipboard()`（需要用户手势与 clipboardSend 权限）。
- 安全降级/无权限提示：非致命 notice，6 秒自动消失。
- CSS 全部内联（无全局样式表）；根节点带 `data-rustdesk-viewer`/`data-status` 等钩子。
- SSR：render 期间不创建 session/DOM，首屏为 idle shell；StrictMode 双挂载只保留第二个 session/socket。

### 自定义 labels

`RustDeskViewerLabels` 的键（默认值）：

`connect`/`disconnect`/`retry`/`fullscreen`/`keyboard`/`clipboard`/`paste`/`copy`/
`ctrlAltDel`/`passwordPrompt`/`passwordPlaceholder`/`submit`/`cancel`/`connecting`/
`awaitingApproval`/`connected`/`disconnected`/`readOnly`。

`connected` 用于读屏 live region；`clipboard` 是工具栏按钮文本，`paste` 是它的
title；`copy` 是手动复制按钮。

## `useRustDeskSession(config, options?)`

Headless React 绑定；与 viewer 共用同一 session 生命周期。

### Options

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `autoConnect` | `boolean?`（默认 true） | 在创建 session 的 effect 中读取，修改不会重连。 |
| `createSession` | `(config) => RustDeskSession` | 测试注入点，必须稳定；默认 `new RustDeskSession(config)`。 |
| `onStatusChange` | `(event) => void` | 最新回调从 ref 读取，不触发重连。 |
| `onError` | `(error) => void` | |
| `onClipboard` | `(event: RemoteClipboardEvent) => void` | 含 `{ text, copied }`。 |
| `onPeerInfo` | `(info) => void` | |
| `onPermission` | `(event: PermissionEvent) => void` | |
| `onSecurityDowngraded` | `(error) => void` | |

### Result

`session`（首帧/卸载后为 `null`）、`status`、`statusEvent`、`peerInfo`、`error`、
`clipboard`、`permission`、`securityDowngrade`，以及稳定的 `connect(credential?)`、
`login(credential)`、`disconnect()`。

- `connect(credential?)`：无 session 时以 `invalid-state` 拒绝；`credential` 且状态为
  `password-required` 时登录；否则复用进行中的连接或新建连接。credential 为
  `string`（明文）或 `{ hash, salt? }`（h1）。
- `passwordHash`/`serverKeyVerifier` 的内容（字符串）进入 effect 依赖；相同内容的
  新对象不会重建 session。`serverKeyProvider` 通过 ref 读取最新 prop，不重建
  session。
- session 在 effect 中创建；StrictMode 第一个 effect 的 cleanup 会同步 dispose
  第一个 session（关闭 socket），第二个 effect 新建。配置字段变化会重建 session；
  `readOnly`/`disableClipboard` 实时应用不重连。
- 回调通过 ref 读取，不进入 effect 依赖；`createSession`/`autoConnect` 只在创建时读取。
- 适合自绘 UI；需要开箱组件时用 viewer。

## `RustDeskSession`

框架无关的会话类，从 `core` 导出。

```ts
const session = new RustDeskSession(config);
const off = session.on('status', (event) => { ... });
session.setVideoSink(renderer);
const peer = await session.connect(abort.signal);
session.bindInputs({ mouse, keyboard, touch, ime });
await session.dispose();
```

### 构造与依赖

`new RustDeskSession(config, deps?)`。`deps` 是测试/Node 注入点，普通宿主不要传：
`connectRelay`、`createDecoder`、`createSocket`、`autoCopyClipboard`（默认 true）、
`secure`（默认按页面协议）、`approvalAfterMs`（默认 3000）、`heartbeatIntervalMs`
（默认 12000）。登录预算固定 60s，安全握手 18s。

### Getters

| 成员 | 说明 |
| --- | --- |
| `status` | 当前 `RustDeskStatus`，初始 `idle`。 |
| `connected` | `status === 'connected'`。 |
| `peerInfo` | 首次 `peer_info` 及后续显示更新；连接前/清理后 `undefined`。 |
| `permissions` | `SessionPermissions` 实例（policy/readOnly/disableClipboard）。 |
| `currentDisplay` | 当前显示下标。 |
| `latencyMs` | 最近一次 TestDelay RTT（ms），初始 0。 |

### 方法

| 方法 | 说明 |
| --- | --- |
| `on(type, listener)` | 类型化订阅，返回 unsubscribe；listener 异常被吞掉。 |
| `connect(signal?)` | rendezvous → securing → 登录；在首次 `peer_info` resolve。`disconnected`/`error` 后可重连；active 状态重连以 `invalid-state` 拒绝。dispose 后以 `aborted` 拒绝。 |
| `login(credential)` | 仅在 `password-required` 且持有登录 flow 时有效；复用同一 Hash 返回原 connect Promise。credential 为 `string`（明文）或 `{ hash, salt? }`（h1）；salt 不匹配抛 `invalid-config`。省略 config 密码时不会自动发送空密码 LoginRequest；不要用 `login('')` 代替 click-to-accept，对端可能返回 `Empty Password` 并继续等待。 |
| `disconnect()` | 仅 active 状态生效；发 `disconnected`，关闭连接并清理视频。 |
| `dispose()` | 幂等异步清理 socket/worker/timer/listener，状态回到 `idle`。 |
| `setVideoSink(sink \| null)` | 设置/移除画帧接收器；连接中设置会懒加载 VP9 decoder/pipeline 并请求关键帧；null 会按序 dispose pipeline/decoder。 |
| `bindInputs({mouse,keyboard,touch,ime})` | 绑定权限策略、显示 origin、peer 键盘平台；控制器重建后需再次调用。自定义输入必须走它，否则绕过只读/权限。 |
| `setReadOnly(boolean)` / `setDisableClipboard(boolean)` | 实时修改策略，不重连。 |
| `sendMessage(payload)` | 低层通道（DOM 编码器使用）；未连接抛 `connection-lost`，**不**做权限门控。 |
| `sendMouse(event)` / `sendKey(event)` | 按当前 `policy.mouse`/`policy.keyboard` 丢弃或发送。 |
| `sendText(text)` | 已连接时本地→远端文本（优先 Clipboard，失败/策略要求时 KeyEvent.seq）。 |
| `sendLocalClipboard()` | 读取浏览器剪贴板并发送；需用户手势；未连接返回 false。 |
| `copyRemoteText()` | 复制最近一次远端文本；不检查连接状态，直到 dispose/reset。 |
| `switchDisplay(index)` | 校验 `peerInfo.displays` 后切换当前显示并通知 pipeline；多显示器 UI 不在 MVP。 |

### 事件

| 事件 | Payload | 时机 |
| --- | --- | --- |
| `status` | `RustDeskStatusEvent` | 每次状态变化（dispose 发 `idle`）。 |
| `error` | `RustDeskError` | 致命错误（随后 status=error）及非致命错误（`no-permission`、无 pipeline 的 `unsupported-codec`、decoder 初始化失败、剪贴板错误等）。 |
| `clipboard` | `RemoteClipboardEvent` | 接受远端文本并尝试自动复制后；空/重复文本不发。 |
| `permission` | `PermissionEvent` | 本地 setter、登录时权限快照或登录后 `permission_info` 引起的策略变化。 |
| `peerInfo` | `PeerInfo` | 首次登录、显示列表同步、本地/远端切换显示。 |
| `securityDowngraded` | `RustDeskError` | `allowInsecureFallback` 跳过签名握手时。 |

### 状态

`idle | connecting | securing | authenticating | awaiting-approval | password-required | connected | disconnected | error`

正常路径：`connecting` → `securing` → `authenticating` →（3s 后仍等待则
`awaiting-approval`）→ `connected`。无密码时停在 `password-required`；错误密码为
`password-required{retry:true, detail:'Wrong Password'}`；初始 h1 的 salt 不匹配为
`password-required{retry:false, detail:'Password hash salt mismatch'}`。致命错误 → `error`；
**登录后**对端 `close_reason` → `disconnected`（登录/握手前收到 close_reason 则
是 `error` + `peer-closed`）；本地断开 → `disconnected`；dispose → `idle`。登录后
30s 无任何消息以 `timeout` 失败。

### 视频 sink

```ts
interface VideoSink {
  draw(frame: Vp9Frame, release: () => void): void;
}
```

`release` 必须且只能调用一次（实现可幂等）。没有 sink 时帧会 ack 后丢弃，不会创建
decoder；有 sink 且已连接时懒加载 ogv.js VP9。非 VP9 帧报 `unsupported-codec`，
应重连。`setVideoSink(null)` 会按 pipeline → decoder 顺序释放。

### 自定义输入控制器

`bindInputs` 接受以下结构（`InputTarget` 只需 `setEnabled(boolean)`）：

- `mouse`/`touch`：额外可选 `setOrigin({x,y})`（当前显示 origin）。
- `keyboard`：额外可选 `setPlatform(string)`（PeerInfo.platform）。
- `ime`：`setEnabled`。

绑定后 session 会在登录、显示切换、权限变化时更新 origin/platform/setEnabled。
控制器的 enabled 还必须与 viewer/session 的连接状态和焦点取交集；不要在未连接或
未聚焦时强制 `setEnabled(true)`。

## 类型

### 状态/统计

```ts
type RustDeskStatus =
  | 'idle' | 'connecting' | 'securing' | 'authenticating'
  | 'awaiting-approval' | 'password-required' | 'connected'
  | 'disconnected' | 'error';

type RustDeskStatusEvent =
  | { status: 'password-required'; detail?: string; retry: boolean }
  | { status: Exclude<RustDeskStatus, 'password-required'>; detail?: string };

interface SessionStats { fps: number; latencyMs: number; decodeMs: number }
```

`SessionStats.fps`/`decodeMs` 当前没有生产者；`onStats` 不会被调用。`latencyMs` 可从
`RustDeskSession.latencyMs` 读取。

### PeerInfo

```ts
interface DisplayInfo {
  x: number; y: number; width: number; height: number;
  name: string; online: boolean;
}
interface PeerInfo {
  username: string;
  hostname: string;
  platform: string;       // "Windows" | "Linux" | "Mac OS" | "Android" | ...
  displays: DisplayInfo[];
  currentDisplay: number;
  sasEnabled: boolean;    // viewer 的 Ctrl+Alt+Del 门控
  version: string;
  connectionId: number;
  privacyMode: boolean;
}
```

### 剪贴板

```ts
interface RemoteClipboardEvent {
  text: string;
  copied: boolean; // 自动写入浏览器剪贴板成功
}
```

文本格式仅支持 `Text`；最多 4 MiB；空文本忽略；相同文本去重。远端→本地自动复制
失败时 `copied:false`，viewer 显示手动 Copy 按钮。本地→远端需要用户手势。

### 权限

```ts
type PermissionName = 'keyboard' | 'clipboard' | 'audio' | 'file';
interface InputPolicy {
  mouse: boolean; keyboard: boolean; touch: boolean; ime: boolean;
  clipboardSend: boolean; clipboardReceive: boolean;
}
interface PermissionEvent {
  policy: InputPolicy;
  permissions: Readonly<Record<PermissionName, boolean>>;
  change?: { permission: PermissionName; enabled: boolean };
}
```

策略规则：

- `mouse = keyboard = touch = ime = !readOnly && peerKeyboard`
- `clipboardSend = !readOnly && !disableClipboard && peerClipboard && peerKeyboard`
- `clipboardReceive = !readOnly && !disableClipboard`（对端 clipboard 权限不门控入站）

对端的键盘权限同时也门控鼠标/触摸（与上游 host 行为一致）。登录后撤销键盘/剪贴板会
通过 `error` 报 `no-permission`（本地已读只读/禁用剪贴板时不报），viewer 显示 notice。
`SessionPermissions` 只作为类型导出，宿主不能从包内构造它。

## 错误码

`RustDeskError extends Error`，带 `readonly code` 和可选 `cause`。

| 类别 | 代码 | 含义 |
| --- | --- | --- |
| 配置 | `invalid-config` | server/URL/端口/公开 URL 非法、HTTPS 页面使用 ws://、`password` 与 `passwordHash` 同时非空、h1 非 base64/非 32 字节，或 retry h1 的 salt 不匹配。 |
| 状态 | `invalid-state` | 在错误状态调用 connect/login（如 active 状态再次 connect、无 flow 时 login）。 |
| 取消 | `aborted` | AbortSignal/dispose 取消。 |
| 网络 | `server-unreachable` | hbbs 或 hbbr 的 WebSocket 无法打开（含 TLS/握手前的 HTTP 失败）。 |
| | `timeout` | WebSocket 打开 12s 超时，或登录后 30s 无消息等通用读超时；登录/安全握手分别映射为 `login-timeout`/`handshake-timeout`。 |
| | `connection-lost` | 已断开的连接上发送/Proxy 关闭。 |
| rendezvous | `rendezvous-refused` | PunchHoleResponse 拒绝。 |
| | `id-not-found` | 对端 ID 不存在。 |
| | `peer-offline` | 对端离线。 |
| | `unsupported-version` | RelayResponse 缺少版本（服务端/协议版本不受支持）。 |
| | `message-too-large` | WebSocket close 1009 / 剪贴板超 4 MiB。 |
| 安全 | `server-key-missing` | 无 serverKey、`serverKeyProvider` 抛错/返回非字符串，或 hbbs 无签名私钥。 |
| | `server-key-invalid` | 静态 serverKey 或 `serverKeyVerifier` 无法解析/验签/提取 32 字节 key。 |
| | `peer-signature-invalid` | 对端签名无效。 |
| | `peer-id-mismatch` | SignedId.id 与目标 ID 不一致。 |
| | `peer-key-invalid` | 对端公钥格式/长度错误。 |
| | `handshake-timeout` | 18s 安全握手预算耗尽。 |
| 登录 | `login-timeout` | 60s 登录预算耗尽。 |
| | `wrong-password` | 密码错误（通常先表现为 password-required retry）。 |
| | `too-many-attempts` | 对端限制重试。 |
| | `try-later` | 对端要求稍后再试。 |
| | `two-factor-required` | 对端要求 2FA（当前无 2FA UI）。 |
| | `blocked` | ID/IP 被封禁。 |
| | `no-permission` | 对端拒绝权限（登录/会话中）。 |
| 媒体 | `unsupported-codec` | 非 VP9 帧；需重连协商 VP9。 |
| | `asset-load-failed` | ogv/wasm 资源加载或初始化失败。 |
| | `clipboard-unavailable` | 浏览器剪贴板不可用/被拒。 |
| 协议 | `peer-closed` | 对端 `close_reason`。 |
| | `protocol-error` | 协议消息/状态不合预期。 |
| | `peer-error` | 对端返回其他错误文本。 |

浏览器控制台/宿主日志不要打印 config/password；`RustDeskError.message` 已是
非敏感文本，但宿主仍应自行过滤。

## 限制（MVP）

- 仅 VP9；不支持 H.264/AV1，非 VP9 帧要求重连。
- 远端/本地均只支持文本剪贴板；最多 4 MiB。
- 无音频、文件传输、聊天或多显示器切换 UI；`switchDisplay()` 仅提供编程接口。
- 无远端光标形状/位置绘制；`show_remote_cursor=No`。
- 无密码登录不会发送空密码 LoginRequest，因此 click-to-accept/“No Password
  Access” 需要用户输入任意密码；对端返回 `Empty Password` 时仍停在密码提示。
- `onStats`/fps/decodeMs 尚未实现；`latencyMs` 可用。
- `passwordHash`（h1）是 bearer credential：拿到它即可登录该设备，直到密码/salt
  变化；salt 公开且密码弱时可被离线快速猜测。它防的是明文密码泄露/复用，不是
  “凭证被盗后不可用”。
- `serverKeyProvider`/`serverKeyVerifier` 只避免 key 进入静态 bundle 和非授权接口，
  **不**对浏览器用户隐藏 serverKey；verifier 的 payload 是明文 `1000::<key>`，
  签名只提供完整性。需要浏览器完全接触不到 key 时，必须使用服务端网关。
- provider 没有独立超时参数；`connect()` 的 AbortSignal/disconnect 会取消等待，
  provider 自身仍应设置超时。
- 真机 iOS/Android 的触摸/软键盘/剪贴板仍需真机验收；自动化测试通过不等于真机
  通过。
- 复用的 RustDesk 协议/键盘表是 AGPL-3.0（only）；本项目原创代码为
  AGPL-3.0-or-later。见 [AGPL 与来源](AGPL.md)。
