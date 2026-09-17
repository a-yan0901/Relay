# Relay 独立 Windows 与 Android 客户端设计

**日期：** 2026-09-17

**状态：** 已按独立客户端方向修订；原生实现尚未交付。

## 产品边界

Relay 的目标是多端、多平台独立客户端。Windows 与 Android 安装后分别拥有本地数据、Vault、SSH/SFTP 执行能力；用户填写目标 SSH 主机即可连接，不需要先部署或填写 Relay 服务地址。账号及云端服务只用于后续跨设备加密同步，不参与 SSH 连接、SFTP 或本地工作区的基本流程。本期交付范围是 Windows 桌面版与 Android app；云端同步服务只保留可选接口和数据格式，不作为本期验收项。

当前 Web 继续使用既有 Relay 服务端执行 SSH。此前 [平台 shell 草案](./2026-09-16-relay-platform-shell-design.md) 的“Android 首版 server-mediated”及本文件上一版的“Android 配置 Relay 服务”属于已被本次产品决定取代的方案。历史文档保留决策记录；本期实施以本文件为准。

## 现有基础与缺口

[跨平台架构](../../architecture/cross-platform.md) 中 `src/shared/core` 已有领域模型、状态机、错误码、Host/Workspace/Session/File/Command 等 ports、capability 和 runtime；Web 有 `src/web/platform/web-adapters.ts` 及 React 页面。现有 `ssh2`、SFTP、Vault 和 SQLite 实现在 `src/server`，依赖 Node，不能直接在 Android 上运行。因此“核心统一”目前指统一业务契约与规则，尚不意味着 SSH 协议引擎是一份可在 Android 原生环境直接执行的代码。本期要补齐 Android 本地执行 adapter，并让两端通过同一 `CoreRuntime` 契约呈现一致行为。

## 架构决定

| 层 | Web 现状 | Windows 本期 | Android 本期 |
| --- | --- | --- | --- |
| UI | React 页面和主题 | 同一 React 页面，桌面窗口/菜单适配 | 同一 React 页面，手机导航/触控/软键盘适配 |
| 领域核心 | `src/shared/core` | 复用同一 TypeScript 核心 | WebView 中复用同一 TypeScript 核心 |
| SSH/SFTP | Node `ssh2` 服务端 | Electron 主进程/utility process 中复用 Node `ssh2` 服务类，不启动 HTTP 服务 | Android 原生 SSH/SFTP adapter，通过受限 bridge 实现 shared ports |
| 数据/Vault | 当前 Relay 实例的 SQLite/Vault | 用户设备上的独立 SQLite/Vault 目录 | Android app 私有存储中的本地库/Vault，密钥由 Keystore 保护 |
| 账号/云同步 | 现有 Web/自托管切片 | 可选接口保留，首版不依赖账号 | 可选接口保留，首版不依赖账号 |

选择共用 React UI 与平台 shell，保留当前 Web 视觉与交互语义；Windows 采用 Electron，Android 采用 Capacitor 与原生插件。本设计不要求在不同 CPU/运行时直接运行同一份 `ssh2` 二进制。统一的是领域规则、DTO、状态、错误码、测试契约、页面和设计 token；协议实现经 `SessionTransport`、`FileTransport`、`SecretStore` 等端口适配。Android 原生层仍须再次执行 Host Key 与路径等安全校验，不能只信任 WebView UI。

Windows Electron 的 main/renderer 分离见 [官方进程模型](https://www.electronjs.org/docs/latest/tutorial/process-model)；Capacitor 提供 Android 原生插件与 Web UI 桥接，见 [官方文档](https://capacitorjs.com/docs)。Android SSH 库须先在真实 Android 环境验证密码、私钥、PTY、Host Key、ProxyJump 和 SFTP。候选 Apache MINA SSHD 官方明确表示未正式验证 Android 兼容性，不能把它的存在当成已通过的技术选型，见 [Android 支持说明](https://github.com/apache/mina-sshd/blob/master/docs/android.md)。若候选库无法满足本期能力矩阵，应在选择库前以原生 PoC 比较替代方案，不改变独立客户端要求。

### Windows 本机执行边界

安装包内的 Electron renderer 只加载随包发布的静态 React 资源；`src/web/api.ts` 的 HTTP fetch 和 `src/web/hooks/use-terminal-session.ts` 的 WebSocket 只供 Web adapter 使用。Windows adapter 通过受限 preload IPC 调用主进程；主进程可将 SSH、Vault、SQLite、SFTP 和批量任务放在 utility process 中，复用 `src/server` 的服务类与仓储实现，但不启动 Fastify、不监听任何 TCP 端口、不设置 Web session cookie。应从 `src/server/app.ts` 的路由组合中抽出可复用服务构造，Web 的 HTTP 路由继续消费同一服务，不复制业务规则。

IPC 只允许枚举的操作名和经 shared schema 校验的参数；每个请求有 `requestId`、版本和最大载荷，响应映射 shared 错误码。renderer 只能访问自身窗口对应的 preload，不能直接导入 Node 模块、获取 SQLite 文件路径或执行任意进程命令。Shell 输出、诊断和传输进度通过按会话/任务订阅的事件通道推送；窗口销毁、Vault 锁定或 utility process 退出时取消订阅、释放句柄并重查真实任务状态。文件大流在主进程/utility process 与系统文件句柄之间传输，renderer 只持有进度和有限预览；不以无限 base64 消息搬运整个文件。Electron renderer 保持 sandbox、context isolation 和禁用 Node integration，见 [Electron 安全指南](https://www.electronjs.org/docs/latest/tutorial/security)。

桌面 IPC 的首个契约版本为 `1`。请求操作按 `vault.*`、`hosts.*`、`identities.*`、`groups.*`、`workspace.*`、`terminalProfiles.*`、`sessions.*`、`files.*`、`commands.*`、`snippets.*`、`activity.*`、`imports.*` 分组；每组只开放对应 `CoreRuntime` port 中已声明的方法。`account/devices/sync` 在本期不注册。每次调用检查当前窗口身份、Vault 状态和 DTO schema；任意 operation 名、原生路径或任意 JS 对象不作为通用转发接口。终端输出按会话顺序到达，文件大流由进程侧处理；进程死亡返回稳定 `interrupted`，下次启动从持久数据恢复，不假装原 Shell 可接续。打包后的 CSP 禁止远程脚本，外链交由系统浏览器打开。

### Android 原生 bridge 契约

Android React UI 通过 `CoreRuntime` 调用 TypeScript adapter；adapter 调用 Capacitor 插件中的本地数据、Vault、SSH、SFTP 与系统文件能力。bridge 按 `version + requestId + operation + payload` 编码，原生层验证类型、大小、权限和 Host ID；稳定错误码返回 shared `AppError`。秘密只因用户动作一次性传到受信原生方法，插件不得将其放入事件、日志、通知或 WebView 持久化。Android 的 `SecretStore.get()` 不向 WebView 返回明文（同现有 Web adapter 的只返回 `null` 模式）；SSH 连接由原生层通过 Host/Identity 引用读取秘密，UI 只收非敏感 metadata。

Shell 使用 `sessionId` 和单调 `sequence` 发送输出/状态/退出事件；订阅先建立再启动连接，迟到事件按会话代际丢弃，`close` 和取消幂等。`SessionHandle.write/resize/close` 的同步签名在 adapter 中入队，原生失败通过 `diagnostic`/`close` 事件回传；队列有上限，满时不能静默丢输入。Host Key 首次/变化逐跳暂停认证，只有用户确认当前挑战的指纹后才继续；事件重放或旧挑战不能放行新连接。进程被回收后旧句柄失效，恢复必须查询本地持久任务状态，Shell 显示 `needs-reopen`。

文件选择由系统 URI 授权；SFTP 数据在原生插件与 URI 流之间传输，WebView 不接收整文件或无限 base64 队列。`FileTransport` 的 `BinarySource`/`ByteStream` 需要经受限分块协议适配：首版上限 64 KiB/块、最多 8 个未确认块，按 `transferId + sequence + ack` 控制背压，取消/失败时释放 URI 和 SSH 句柄；如平台插件使用原生到原生流，应保持同等有界内存和取消语义。Android 原生层同时执行 Host Key、ProxyJump、远端路径规范化及任务限制，返回 shared 状态，不以 UI 隐藏按钮代替授权。

两个原生 adapter 对 UI 暴露相同 `SessionEvent` 文本与诊断语义：原生输出字节以持续的 UTF-8 decoder 解码，避免分块切断多字节字符；`exit`、`close` 每会话至多一次，收到 `close` 后不得再发 `data`。所有长任务使用独立 task id，重试必须能解释是继续还是从头开始；缺少断点能力时不广告 `transfer.resume`。进程被系统杀死或窗口重建时，只有持久的传输/命令状态可重新查询，Shell 不承诺跨进程恢复。此行为在 Web/Windows/Android 任务矩阵中使用相同文案与下一步动作。

## 本地数据与未来同步

两端安装后即提供 Local 模式：Host、Identity、Group、Snippet、Workspace、终端主题、Host Key 信任和 Vault 保存在本机；断开互联网但目标 SSH 主机在局域网可达时仍能连接。普通应用数据与秘密分层：Windows 使用现有加密 Vault 和用户专属数据目录，Android 使用 app 私有库加 Keystore 包装的密钥；主密码、私钥和 passphrase 不进入 WebView 的 localStorage、日志或普通备份。

跨端便携格式以当前 `src/server/workspace/vault-bundle-service.ts` 的 Vault bundle v1 为互操作基线；其现有 payload 只覆盖 Host、Identity、Group、终端 profile/default profile，Host Key 信任随 Host 字段携带，**不包含 Snippet 或 Workspace**。本期两端必须支持这部分 v1 正反向导入导出；Snippet、Workspace 和其他偏好仅在各自设备本地可用，跨设备迁移留给后续版本化 bundle 扩展或云同步，不得暗示 v1 已覆盖。Android 可采用不同内部表结构，但 v1 的格式版本、Argon2id 参数、salt、AES-256-GCM nonce/tag/AAD、字段编码、冲突策略和错误码由共享格式说明及正反向测试向量固定，不能仅凭“都用 AES”宣称兼容。Android Keystore 保护设备本地密钥；用户导出的加密 bundle 独立使用导出密码，Keystore 密钥不进入 bundle。默认系统备份排除凭据、Vault key 和临时传输文件；迁移失败不得覆盖原设备数据。云同步仍是后续能力。

保留 `CoreRuntime` 的可选 `account`、`devices`、`sync` ports、设备标识与版本化加密快照格式。云服务未接入时不实例化这些 ports、不发任何云请求，UI 显示“仅此设备”并隐藏不可用的登录/同步动作。已有 Web/自托管同步实现不得被误写为本期独立云服务已经部署。未来登录并解锁 Vault 后才允许同步 Host、Identity、Group、Snippet、工作区模板/偏好及经确认的 Host Key；live Shell、终端输出、SFTP 文件和任务运行态仍不上传。未来云服务必须独立于两个客户端，客户端本地 SSH 不依赖其在线状态。

## 一致体验与平台适配

共享 Host grid/list、搜索、连接状态、主题、终端、全屏 SFTP、传输中心和错误文案。Windows 保持左侧分组、快捷键、右键菜单、多标签/分屏；Android 使用搜索优先、单 pane、触控长按菜单、软键盘工具条和系统返回。两者由相同 React 组件与设计 token 派生，允许布局与输入方式变化；Host Key、批量命令预览、重连和传输终态保持相同业务语义。移动端必须验证字体缩放、旋转、软键盘避让、终端最后一行与 SFTP 滚动。

UI 一致性的可检验规则：同一动作使用同一名称、图标语义、确认内容和结果状态；桌面右键与 Android 长按进入同一命令定义；Host Key、删除、批量命令和粘贴保持同级确认；错误均显示阶段、原因、下一步。主题卡、终端配色、字体/字号和 grid/list 偏好跨重启保留，但本期仅存本机。建立一份三端任务矩阵及屏幕基线：Host 搜索/收藏、连接/重连、终端复制粘贴、SFTP 过滤/上传下载、Vault 锁定、主题切换；在 Web、Windows、Android 上逐项记录状态和截图，不要求像素完全一致。手机屏幕密度、系统返回和软键盘可适配，但不能改变业务结果。

现有 `App.tsx` 与 `TerminalPanel.tsx` 的 `window.confirm`、浏览器下载、`/api/transfers`、`window.open`、焦点/全屏、`theme.ts` 的 `localStorage` 及 `app-state.ts` 的 `sessionStorage` 都需要逐项审计。与业务或持久化相关的调用迁入平台端口或 UI shell hook；纯 DOM 渲染可以保留在共享 React 组件。Web 原行为先由测试固定，迁移后在三端验证。Windows/Android 的持久化偏好与终端恢复意图使用各自本地存储，不能误用 Web origin 存储作唯一来源。

共享层不得导入 DOM、Node、Electron 或 Android API。Windows renderer 无 Node 权限，原生功能经 allowlist preload/IPC；Web 的 HTTP 服务保持独立部署，不嵌入桌面进程。Android bridge 仅暴露明确操作，不允许任意文件路径、网络地址或命令透传；文件选择使用系统授权 URI，传输结束释放权限。Android 连接、Shell、SFTP 和批量任务全部在设备上执行；网络切换或 app 进后台后先查询本地真实状态，再显示 `reconnecting`、`interrupted` 或 `needs-reopen`。任何平台不得凭 UI 缓存伪造 `connected`。

## 验收

在未部署 Relay 云服务、未登录账号、未填写 Relay 服务地址的条件下，Windows 与 Android 各自完成：创建 Host 和凭据、首次 Host Key 确认与变更拒绝、SSH Shell 输入/复制/重连、SFTP 浏览与上传下载、Vault 锁定/重新打开、主题选择与本地数据持久化。Windows 安装包不监听本地/公网 HTTP 端口；Web 原服务依旧独立可用。两端断开账号网络但目标 SSH 主机仍可达时，基本操作继续可用。Web/Windows/Android 的加密 Vault bundle v1 既有字段正反向导入导出测试通过，错误输入不破坏原数据。共享 contract 与原生真实设备走查都要通过；Android 的原生 SSH 库、Keystore、文件 URI 和后台恢复必须有设备证据。云同步仅验证可选 port 缺席时本地工作完整，不把云服务当作本期交付。

本期不做云端同步服务、团队 Vault、跨设备 live session 迁移、Android 后台常驻 SSH 或 Windows 第二套 SSH 引擎。发布签名与应用商店上架作为后续发布流程单列。
