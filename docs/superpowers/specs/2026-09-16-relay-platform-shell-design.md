# Relay PWA、桌面与 Android 平台 Shell 设计规范

**Date:** 2026-09-16
**Status:** 历史草案；Android server-mediated 首版方案已被 2026-09-17 独立客户端设计取代。

> 当前 Windows/Android 实施以 [独立客户端设计](./2026-09-17-relay-windows-android-unified-experience-design.md) 为准：两端本地 SSH/SFTP 和本地数据，云端同步服务后续实现。本草案保留为历史决策记录。
**Scope:** X-02；只定义跨端产品化边界、平台适配契约、生命周期和威胁模型，不在本任务创建原生工程或交付平台实现。

## 1. 设计结论

Relay 采用“统一 shared core + 平台 shell + 可替换 adapter”的跨端方案：

1. Web/PWA、Windows/Linux Desktop 和 Android 共享领域模型、状态机、错误码、Host Key policy、SFTP 路径规则、批量目标快照、任务终态、并发/超时/输出上限和审计脱敏语义。
2. Web/PWA 和 Android 首版以 server-mediated SSH 为基线。浏览器和移动端不直接持有服务器凭据，也不在离线时新建 SSH/SFTP/命令请求。
3. Desktop 首版同样支持 server-mediated transport；后续可在完成安全评审后增加 local SSH transport。local SSH 只替换 transport 和 secret store，不改变 Host Key、任务状态和恢复语义。
4. PWA 的离线能力只覆盖 app shell、非敏感本地工作区意图、已知状态和恢复提示；“已安装”不等于“离线 SSH 客户端”。
5. 账号与云同步是可选扩展。未登录时始终完整支持 Local-only；登录且 Vault 解锁后才启用加密同步，遵循 [`relay-account-and-encrypted-sync-design.md`](./2026-09-16-relay-account-and-encrypted-sync-design.md)。

这是一份边界规范，不是桌面或 Android 的实现承诺。任何原生工程、manifest、service worker、系统 keychain 接入或新的平台 UI 都必须在本规范通过后另立 implementation plan。

## 2. 用户任务基线与目标

所有平台都围绕同一条可跟踪任务链设计：

```text
找 Host → 查看 Host Key/连接 → 输入命令 → 浏览/传输文件 → 锁定或恢复
```

### 2.1 目标

- 用户能够在任一平台判断当前连接、传输或命令处于什么阶段、是否会自动恢复以及下一步动作。
- 用户在桌面大屏上高效管理 Host、分组、多个 pane、SFTP 和批量任务；在手机上以单 pane 和底部操作完成同一任务，不把桌面布局机械缩小。
- 平台能力不足时使用统一 capability 协商和明确降级，不出现“按钮可点但请求必然失败”或“看起来已连接但实际已失效”。
- 离线、后台挂起、窗口关闭、进程回收和网络切换均有可解释的状态，不把未完成任务伪装成成功。
- 凭据、主密码、私钥、session token、终端原始内容和敏感路径不因跨端复用而进入不安全存储、日志、剪贴板或通知。

### 2.2 非目标

- X-02 不实现 Tauri、Electron、Android 工程、PWA manifest 或 service worker。
- X-02 不决定桌面框架、移动 UI 框架、账号 provider、云厂商或部署拓扑。
- X-02 不把本地 SSH、后台常驻连接、离线命令队列、终端录制、团队 Vault 或 Agent/MCP 作为默认能力。
- X-02 不复制 Termius、Netcatty 或其他产品的品牌、页面结构和视觉资产；只吸收现代、简洁、低认知负担的交互原则。

## 3. 术语与不变量

| 术语 | 定义 |
| --- | --- |
| Server-mediated transport | 客户端通过 Relay 的 HTTPS/WSS 请求，由服务端 Vault、SSH/SFTP adapter 执行远端操作。 |
| Local SSH transport | 仅允许受控桌面 adapter 直接调用本机 SSH 实现；凭据来自系统安全存储。 |
| Local-only | 未登录账号或同步不可用时，当前设备上的本地 Vault 和工作区仍可使用；不产生同步请求。 |
| Platform shell | 平台 UI、窗口/导航、系统能力和生命周期编排；不拥有 Host Key 或任务规则。 |
| Adapter | 把平台能力转换为 shared ports、稳定错误码和 capability；不得把平台对象泄露到 shared core。 |
| active session | 连接、可输入且仍受 transport 监控的会话；仅 UI 显示“Connected”不足以定义该状态。 |

以下不变量适用于所有平台：

- 每一跳都必须独立校验 Host Key；首次或变更时先进入 `awaiting-host-key`，用户确认前不得继续认证。
- 远端 SFTP 路径先规范化和校验；拒绝控制字符、越界 `..` 和把本地路径误当远端路径。
- 批量执行使用确认时的完整目标快照、展开命令、并发、超时和输出限制；结果按 Host 隔离。
- 任务终态只能由 core/server 状态语义产生。取消、失败、中断、恢复和重新打开不由平台 UI 改写。
- 原始终端输出、私钥、passphrase、主密码、token 和凭据不进入工作区 JSON、普通日志、遥测、通知或系统剪贴板。
- shared core 不导入 DOM、React、Node、浏览器存储、WebSocket、HTTP、`ssh2`、桌面 keychain 或 Android API。

## 4. 平台职责矩阵

| 维度 | Web/PWA | Windows/Linux Desktop | Android |
| --- | --- | --- | --- |
| UI shell | 浏览器响应式 shell；安装后复用同一 Web UI | 侧栏 + workspace + pane；鼠标、键盘和窗口管理优先 | 单 pane；顶部状态 + 底部导航/操作栏；触控和软键盘优先 |
| SSH/session | 首版 server-mediated，浏览器只持有 WSS 会话 | 首版 server-mediated；后续可选 local SSH | 首版 server-mediated |
| secret store | 服务端 Vault 解密边界；浏览器不保存凭据 | OS keychain 存放本地 transport 所需秘密；server mode 不复制秘密 | Android Keystore 包装本地密钥；不把私钥写入普通 app storage |
| 远端文件 | 浏览器文件选择/下载由 Web adapter 处理 | 系统文件选择器和安全路径权限由 desktop adapter 处理 | Storage Access Framework、分享面板和临时 URI 由 Android adapter 处理 |
| 离线 | app shell、非敏感工作区意图、状态提示 | server mode 不能新建远程操作；local mode 仅在授权秘密可用时离线工作 | 显示最近状态和恢复动作；不在后台隐式建立 SSH |
| 生命周期 | tab 刷新、休眠、网络 online/offline；依赖 session reattach | 窗口关闭/最小化/托盘、系统休眠和多窗口 | 前后台、进程回收、网络切换、锁屏和生物识别 |
| 通知/剪贴板 | 浏览器 permission API，能力缺失时回到应用内提示 | 系统通知/剪贴板可选，敏感内容默认不自动外发 | 系统通知/剪贴板需按 Android 权限和生命周期降级 |
| 同步 | 登录且解锁后使用加密 sync；未登录 Local-only | 同上，密钥优先进入 OS keychain | 同上，密钥优先进入 Keystore；设备撤销后停止同步 |

平台矩阵中的“支持”只表示 adapter 设计允许实现，不表示 X-02 已经交付这些平台。

## 5. Shared ports 与 adapter contract

### 5.1 现有端口的职责

X-02 复用当前 `src/shared/core/ports.ts` 的端口，不复制一套 platform API：

- `SecretStore`：按 `SecretRef` 读取、写入和删除秘密。实现负责加密、访问控制和生命周期；调用方只能得到完成当前操作所需的秘密。
- `SessionTransport`：打开、重连、关闭 shell，返回可订阅的 `SessionHandle`。`SessionEvent` 只能传输终端数据、退出/关闭和脱敏 `OperationDiagnostic`。
- `FileTransport`：远端 SFTP 列表、目录/重命名/删除和传输任务；`ByteStream`/`BinarySource` 只包含 `Uint8Array`，不暴露浏览器 `File`/`Blob` 或 native URI。
- `CommandTransport`：启动、查询、取消批量命令；请求使用已确认的目标快照和统一并发/超时/输出限制。
- `VaultSessionPort`：报告 `uninitialized/locked/unlocked` 并执行 setup/unlock/lock。主密码只存在于一次性调用边界，不进入状态 DTO。
- `WorkspaceStore`：保存非敏感的工作区意图，例如活动 Host、pane 布局、路径和筛选项；不保存凭据、终端原始输出或可恢复 token。
- `ImportExportPort`：通过 shared 的中立字节和导入 DTO 处理文件，不让平台文件对象穿过 core。

Adapter 必须遵守以下契约：

1. 平台异常映射为稳定错误码和可操作的 `nextAction`；不能把原生异常文本直接作为用户可见的业务状态。
2. 操作发出前由 capability 和 core policy 校验；adapter 不得只依赖 UI 是否显示按钮。
3. 开始长任务前记录 operation id 和 request id；重试、恢复、取消都必须能关联到同一任务生命周期。
4. session、transfer、command 的状态由 shared/server 事件更新；窗口、页面或 Activity 重建时通过查询和 reattach 恢复，而不是凭 UI 内存猜测。
5. adapter 的资源关闭必须幂等；网络断开、进程终止和用户主动关闭都要释放监听器、文件句柄、临时文件和系统权限。

### 5.2 未来的系统能力端口

下列端口是平台 shell 的最小契约。实现计划阶段才将它们加入 shared ports，并为不支持的端实现显式 fake；X-02 不修改 TypeScript 代码。

```ts
export type NotificationPermission = 'default' | 'granted' | 'denied';

export interface NotificationRequest {
  title: string;
  body: string;
  tag?: string;
}

export interface NotificationPort {
  permission(): Promise<NotificationPermission>;
  requestPermission(): Promise<NotificationPermission>;
  notify(request: NotificationRequest): Promise<void>;
}

export interface ClipboardPort {
  readText(): Promise<string>;
  writeText(text: string): Promise<void>;
}
```

端口规则：

- `NotificationPort` 只通知可操作的生命周期摘要，例如“传输已暂停，请重新打开”；标题和正文不得包含密码、私钥、完整命令、终端输出、Host 凭据或敏感路径。
- 未获通知权限、用户拒绝或系统限制时，返回稳定的不可用结果并使用应用内 Activity/Toast/状态栏提示；任务本身不能因为通知失败而失败。
- `ClipboardPort.readText()` 只能由用户明确触发，例如点击“从剪贴板粘贴”；连接建立、打开 Host 或页面加载不得自动读取剪贴板。
- 粘贴到命令输入框前应提供可见确认；shell adapter 可做长度限制、控制字符过滤和敏感内容提示，但不得把原文写入 Activity。
- `ClipboardPort.writeText()` 的成功只代表系统剪贴板接受内容；复制私钥、密码或 token 时必须有明确用户动作和短暂提示，默认不提供自动复制。
- 文件选择器、下载保存面板和系统分享不作为 shared port 的浏览器/native 类型；它们把数据转换成 `BinarySource`、`ByteStream` 或受控的导出结果后再进入 core。

### 5.3 Transport 模式

| 模式 | 允许的平台 | 凭据来源 | 可离线行为 | 必须复用 |
| --- | --- | --- | --- | --- |
| `server-mediated` | Web/PWA、Desktop、Android | 服务端 Vault/当前授权会话 | 不新建远端操作；已有 session 按 reattach 规则处理 | Host Key、错误码、任务终态、审计和超时 |
| `desktop-local` | Desktop，后续可选 | OS keychain，经用户解锁/系统授权 | 仅在本机秘密和网络均可用时打开远端连接 | 同上；不得因本地实现绕过 host key 或路径校验 |

local transport 不得由 Web 或 Android 通过 capability 名称自行开启。它必须同时满足平台允许、服务端/部署策略允许（如适用）、本地 secret store 已解锁、Host Key policy 已加载以及用户明确选择 local mode。

## 6. Capability 与降级矩阵

能力名称描述可观察行为，不描述平台。新增名称在后续实现计划中加入 `Capability` union，并由 client/server 交集决定，不能用 `client === 'desktop'` 代替。

| proposed capability | 代表行为 | 缺失时的行为 |
| --- | --- | --- |
| `workspace.max-panes` | 使用协商后的 pane 上限 | 回退到单 pane，并隐藏分屏/广播入口 |
| `session.reattach` | 页面/窗口/Activity 重建后尝试恢复已有会话 | 明确显示“需要重新连接”，不伪造 Connected |
| `sftp.local-files` | 使用平台文件选择、drop 或分享输入 | 保留远端浏览；上传入口显示不支持原因 |
| `transfer.resume` | 使用 checkpoint、offset 和校验恢复 | 只提供从头重试；不发送 resume 参数 |
| `ui.clipboard-read` | 用户触发从系统剪贴板读取 | 隐藏读取动作或显示手动粘贴指引 |
| `ui.clipboard-write` | 用户触发复制到系统剪贴板 | 保留应用内选择/下载，不自动复制 |
| `ui.notifications` | 发送脱敏任务状态通知 | 使用应用内状态、Activity 和未读标记 |
| `ssh.local-transport` | Desktop 使用本地 SSH adapter | 强制 server-mediated 或显示不可用，不静默切换 |
| `account.auth` | 登录、登出、会话状态 | 保持 Local-only，不发账号请求 |
| `device.trust` | 设备登记、撤销、重新授权 | 账号可停留在不可同步状态，显示恢复动作 |
| `sync.encrypted` | 加密 envelope 的上传、下载和冲突 | 本地工作继续，标记 `offline`/`pending`，不上传明文 |

协商流程固定为：

```text
client capabilities ∩ server capabilities
             ↓
shared runtime.supports(name)
             ↓
UI 显示能力 / adapter 选择 transport / 明确降级
```

服务端未声明或拒绝能力时，客户端不得通过 UI、query 参数或本地分支绕过。服务端应返回稳定的 `CAPABILITY_UNAVAILABLE` 或对应领域错误；客户端将其映射为原因和下一步动作。当前 X-01 已落地的 `transfer.resume`、`sftp.local-files`、`session.reattach` 和 pane 上限遵循同一规则，未来能力不应另起协议。

## 7. 生命周期与离线行为

### 7.1 统一状态语义

平台 shell 可以采用不同视觉呈现，但必须把操作状态映射到统一语义：

| 状态 | 用户可见含义 | 下一步动作 |
| --- | --- | --- |
| `connecting` | 正在建立网络/SSH 链路 | 等待或取消 |
| `awaiting-host-key` | Host Key 首次出现或发生变化 | 查看指纹并确认/拒绝 |
| `awaiting-credential` | 需要解锁或补充授权 | 解锁 Vault、修正凭据或取消 |
| `connected` | session 已建立且可输入 | 输入、调整 pane 或执行明确操作 |
| `reconnecting` | 网络/服务短暂中断，仍在恢复窗口 | 等待、手动重试或查看诊断 |
| `interrupted` | 操作被网络、生命周期或服务重启打断 | 恢复、重试或重新打开 |
| `needs-reopen` | 原 session 不再可恢复 | 重新打开 Host |
| `closed` | 用户或远端已关闭 | 重新连接 |
| `failed` | 操作失败且有稳定错误原因 | 按 `nextAction` 修复、重试或查看详情 |

连接、传输和命令可以有各自领域状态，但都必须保留原因、可重试性、request id 和下一步动作。`interrupted` 不等于 `failed`，`reconnecting` 不等于 `connected`。

### 7.2 Web/PWA

| 场景 | 规则 |
| --- | --- |
| 在线打开 | 正常加载 server-mediated runtime，先协商 capability，再加载可用 UI。 |
| 安装 PWA | 只改变启动入口和 app shell 生命周期，不改变 SSH/SFTP 安全边界。 |
| 短暂离线 | 标记网络状态；已存在 session 按 reattach/服务端保留窗口处理；新建连接、目录变更、上传、下载和命令返回可解释的 offline 错误。 |
| 刷新/重新打开 | 优先查询 workspace 和可恢复 session；恢复失败显示 `needs-reopen`，不恢复旧输入框为 Connected。 |
| 浏览器休眠/关闭 | 不承诺后台运行命令；服务端操作以其自身状态为准，重新打开后查询任务和 Activity。 |
| 文件/下载 | 本地 `File`、`Blob`、保存面板只存在 Web adapter；不把浏览器权限或路径写入 shared DTO。 |
| 通知/剪贴板 | 先检查 permission/capability；拒绝时不影响任务和核心 UI。 |

离线壳可以显示最近一次非敏感 Host metadata、workspace 意图和任务终态摘要，但不缓存可直接恢复的凭据、session token、主密码、私钥或完整终端输出。

### 7.3 Desktop

桌面端提供两种显式 transport mode，但首版只实现 server-mediated：

- `Relay server`：与 Web/PWA 使用相同的 HTTPS/WSS、服务端 Vault 和 session 语义。窗口最小化、托盘和系统休眠只影响 UI 订阅，不改变服务端任务状态。
- `This device`：后续实现的 local SSH 模式。用户必须明确选择；凭据从 OS keychain 获取，锁屏、keychain 拒绝、权限变更或 adapter 崩溃都进入 `awaiting-credential`/`interrupted`，不自动把秘密复制到普通配置文件。

窗口关闭策略必须在设置中清晰表达：

1. 关闭窗口默认停止本地 UI 订阅并请求 session detach；不把关闭窗口解释为远端命令成功或失败。
2. 托盘驻留和后台连接必须是显式开关，并显示系统权限、资源占用和退出动作。
3. 重新打开时先恢复非敏感 workspace，再查询 session/task 状态；只在 transport 确认可恢复时进入 `connected`/`reconnecting`。
4. 多窗口不能各自创建互相冲突的 workspace 写入；使用已有 `WorkspaceStore` 版本语义处理冲突。

### 7.4 Android

- 默认单 pane；Host、SFTP、命令和 Activity 通过底部导航或上下文操作切换，避免在窄屏同时堆叠多个桌面面板。
- Activity 进入后台时，UI 订阅可以释放；session 根据 server reattach 窗口和 Android 生命周期进入 `reconnecting`、`interrupted` 或 `needs-reopen`。
- 不允许通过普通后台任务持续使用未授权凭据建立 SSH。需要长期运行的操作必须有显式用户动作、平台允许的前台服务语义、可见状态和取消入口；X-02 不默认开启该能力。
- 网络从 Wi-Fi 切换到蜂窝、断网再恢复、锁屏和进程回收都必须有可测试的状态转移；重新打开后以 server/task 查询结果为准。
- 文件选择使用系统授权 URI，上传流读取完成或取消后释放 URI 权限；下载/分享使用临时文件和系统分享，不把远端绝对路径当作本地路径。
- 生物识别只解锁设备密钥或继续一次明确操作，不替代 Host Key 确认，不把生物识别结果发送给 Relay server。

## 8. UI 与交互基线

视觉方向借鉴 Termius、Netcatty 等现代 SSH 工具的共同优点：高密度但不拥挤、导航简单、状态清楚、危险操作可见。只借鉴原则，不复制品牌和具体布局。

### 8.1 Web 与 Desktop

- 左侧 Host/Group 导航保持稳定；搜索优先于层层展开，结果显示别名、地址、标签和最近使用等可搜索 metadata。
- 中央 workspace 聚焦终端；SFTP、传输、批量命令和 Activity 采用可展开 panel/drawer，避免打断当前 shell。
- 连接状态同时用文字、图标和颜色表达；颜色不能作为唯一信息。`reconnecting`、`interrupted` 和 `needs-reopen` 必须带原因和动作。
- Host Key 确认以指纹、算法、地址、端口和变更风险为主，确认/拒绝动作清晰且不可被普通“继续”按钮掩盖。
- 传输中心显示阶段、速度/进度（有数据时）、暂停/继续/重试/取消和失败原因；不支持 resume 时明确说“重试会从头开始”。
- 批量命令在执行前展示目标快照、展开后的命令、并发和超时；执行后按 Host 分组显示结果，不用一条总成功掩盖局部失败。
- 键盘快捷键、焦点顺序、紧凑密度和大触控目标作为同一 design token 的不同尺寸档，不通过复制业务组件形成两套状态逻辑。

### 8.2 Android

- 首屏优先是最近 Host、搜索和连接状态；不把桌面多栏导航压缩成不可读的横向列表。
- 底部操作栏只放当前上下文的高频动作，如连接、输入、SFTP、传输和更多；危险动作放入确认菜单。
- 软键盘弹出时终端保持可见并可调整；命令输入、粘贴和发送都要有明确焦点状态。
- 触控目标、对比度、动态字体和横竖屏变化按 Android 无障碍和真实设备检查；短视口不得出现横向溢出。
- 后台恢复入口要显示“会话是否仍可恢复”和“任务实际状态”，不只显示一个重新连接按钮。

### 8.3 反馈、错误与权限

每个失败反馈至少包含：发生阶段、脱敏原因、是否可重试、下一步动作和可复制的 request id。权限拒绝、网络离线、Host Key 不信任、Vault 锁定、能力缺失和 session 过期使用不同的文案，不用泛化的“连接失败”。

通知、剪贴板、文件权限和生物识别失败不应改变核心任务终态，除非失败本身就是用户主动取消操作。所有系统权限请求都在用户动作附近发起，并说明用途。

## 9. 威胁模型与安全控制

| 威胁面 | 风险 | 必须的控制 |
| --- | --- | --- |
| 浏览器 XSS/扩展 | 读取页面状态、剪贴板或本地缓存中的秘密 | 不在 Web storage 放凭据/主密码/token；CSP、HttpOnly Secure session、敏感内容不进 DOM 日志；权限按用户动作申请 |
| Desktop 本地存储 | 配置文件或崩溃转储泄露私钥/passphrase | local mode 只用 OS keychain；普通配置只存 SecretRef/metadata；锁定、退出和 keychain 错误有明确状态 |
| Android 备份/Root/截图 | Keystore 包装材料或屏幕上的秘密被导出 | 使用 Keystore、按策略排除敏感备份、敏感输入最小展示；生物识别只作本地解锁门槛 |
| 剪贴板泄露 | 密码/私钥被其他应用读取 | 默认不自动读；读写均需用户动作；敏感复制需确认和短时提示；不写 Activity/遥测 |
| 通知泄露 | 锁屏或其他人看到 Host/命令信息 | 通知只发脱敏摘要；默认不含完整 Host 地址、用户名、路径、命令和输出；用户可关闭 |
| 文件/路径穿越 | 本地路径、远端路径或导出文件越权 | 远端路径规范化；本地 picker 返回的句柄只在 adapter 生命周期使用；临时文件权限最小化并在结束/取消时清理 |
| 网络/WSS | 中间人、错误 origin、断线重放 | HTTPS/WSS、Origin 校验、服务端权限/owner 校验、request id/幂等策略；不凭 UI 放行能力 |
| Local SSH Host Key | 直接连接绕过服务端信任策略 | 每一跳复用 shared Host Key policy；首次/变更必须确认；拒绝时阻断连接并留稳定错误码 |
| 后台生命周期 | 进程回收后误报成功或继续使用凭据 | 任务状态以 transport/server 查询为准；后台不隐式建立连接；恢复失败显示 `interrupted`/`needs-reopen` |
| 多设备同步 | 云端或冲突处理暴露明文/覆盖安全设置 | 只同步加密 envelope；账号不等于 Vault key；revision 冲突拒绝静默覆盖；遵循账号同步 spec |

安全评审必须逐项确认：秘密存储位置、解锁时机、日志与通知脱敏、Host Key 和代理跳转校验、文件临时权限、生命周期状态，以及能力缺失时是否存在旁路请求。

## 10. 实现顺序与文件边界

X-02 之后拆为独立 implementation plans，顺序如下：

1. **PWA shell**：manifest/install、离线壳、online/offline 状态、session reattach、浏览器文件选择/下载、剪贴板和通知 adapter；补 browser capability 与 e2e 矩阵。
2. **Desktop shell**：server-mediated shell、窗口/托盘/恢复、OS keychain adapter、系统文件选择器；先完成 native-like contract，再单独评审 local SSH transport。
3. **Android shell**：单 pane、底部操作、软键盘、Storage Access Framework、前后台/网络生命周期、Keystore 和生物识别 adapter。
4. **跨端回归**：shared contract、fake adapter、平台能力矩阵、Host Key/SFTP/批量任务/锁定恢复和敏感数据扫描；必要时更新 Q-01 指标。

实现时的文件边界：

- `src/shared/core/**` 只接收平台中立的 DTO、ports、capability 和状态规则；任何 Web/native 对象先在 adapter 转换。
- `src/web/platform/**` 和 Web UI 承担浏览器 HTTP/WSS、File/Blob、权限 API 和下载行为。
- Desktop/Android 各自拥有 shell、lifecycle、secret store、file picker、notification 和 clipboard adapter；不把系统 API 放入 shared。
- server 继续承担当前 Web 的 SSH/SFTP/Vault/权限边界；local SSH 是显式可选 transport，不改变 server mode。
- 账号、设备和加密同步继续由 X-04 负责；本规范只规定平台如何提供 secret store、生命周期和同步状态承载。

## 11. 验收与验证矩阵

### 11.1 Spec 验收

- 平台选择、transport mode、secret store、离线/在线和生命周期行为有唯一结论。
- `SecretStore`、`SessionTransport`、`FileTransport`、`NotificationPort`、`ClipboardPort` 的责任和数据边界可被 implementation plan 直接引用。
- capability 缺失、权限拒绝、网络切换、Host Key 变化、传输中断和 session 失效均有用户可执行的降级动作。
- 威胁模型覆盖浏览器、桌面、Android、剪贴板、通知、文件、网络、Host Key、后台和同步；没有把未交付能力写成当前能力。
- 文档不要求 shared core 依赖 DOM、React、Node、WebSocket、HTTP 或系统 API。

### 11.2 实现阶段验证要求

| 层级 | 覆盖 |
| --- | --- |
| Artifact | Markdown 结构、链接、代码块、术语和禁止词检查；`git diff --check`。 |
| Shared contract | desktop-like、Android-like、Web adapter 对 session/file/capability/错误/状态的共同断言。 |
| Web | Chromium 视口、PWA install/offline、文件选择/下载、剪贴板/通知拒绝和 session reattach。 |
| Desktop | Windows/Linux 窗口/托盘/休眠、OS keychain 锁定、server/local mode、文件权限和 Host Key。 |
| Android | 320px/390px、软键盘、前后台、进程回收、网络切换、系统 picker/share、Keystore/生物识别。 |
| Security | secret/log/storage/notification/clipboard 扫描；Origin/WSS、权限、路径和 Host Key negative cases。 |
| Release gate | 只有跨模块、凭据/加密、迁移、原生 transport 或 public contract 的重大实现才运行全量验证；纯文档或局部 UI 采用受影响范围验证。 |

### 11.3 真实任务走查

每个平台实现计划都必须用同一组任务走查：

1. 搜索 Host，打开 Host Key 确认并拒绝一次；
2. 连接后输入命令，调整窗口/旋转或切换视口；
3. 浏览远端目录，上传、下载、暂停、恢复或从头重试；
4. 批量执行并验证目标隔离、取消和部分失败；
5. 锁定 Vault、断网、后台/关闭应用，再恢复并核对真实状态；
6. 拒绝文件、剪贴板、通知、生物识别权限，确认核心任务仍有可解释降级。

## 12. 相关文档

- [`cross-platform.md`](../../architecture/cross-platform.md)：统一核心、当前能力协商和 adapter 现状。
- [`relay-account-and-encrypted-sync-design.md`](./2026-09-16-relay-account-and-encrypted-sync-design.md)：账号、设备信任、Vault 包装、加密同步、冲突和恢复。
- [`2026-09-16-relay-long-term-roadmap.md`](../plans/2026-09-16-relay-long-term-roadmap.md)：X-02 任务状态、后续实现计划和发布门槛。
- [`2026-09-15-ux-audit.md`](../../ux/2026-09-15-ux-audit.md)：现有 UI/交互基线和 U-04 token 方向。

**Review gate:** 本 spec 通过评审后，才创建 PWA、Desktop 和 Android 的独立 implementation plan；在此之前不创建原生工程或把上述 proposed capability 标记为已交付。
