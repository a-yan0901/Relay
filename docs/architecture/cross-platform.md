# 统一核心与跨端/跨平台基础

Relay 当前以 Web app 为核心客户端，服务端负责 SSH、SFTP、批量命令和 Vault 的执行边界。桌面版后续覆盖 Windows 和 Linux，Android 版复用同一套 shared core、错误码和 wire protocol，再替换 transport 与 secret store；账号与加密同步作为登录后的可选扩展层，本地 Local-only 模式始终保留。本阶段不绑定 Tauri、Electron 或移动 UI 框架，也不提前实现原生 UI。

## Review 结论

本轮 review 后，统一核心已经形成可执行边界：`src/shared/core` 固定模型、校验、错误码、状态机、分组/连接继承、目标快照、`CoreRuntime` 和 ports；Web 只实现第一套 adapter。桌面和 Android 仍不做 UI，但可以替换 adapter 而不复制领域规则和用户任务语义；原生端仍需按各自生命周期和交互范式实现 UI。X-01 已将 capability 协商、Web/native-like contract 和规模回归落地：Web adapter 与 desktop/android native-like fake 运行同一套 shared contract，证明扩展点不依赖 DOM 或 HTTP。

剩余风险已收敛为明确的后置能力，而不是架构债务：原生客户端、个人账号/加密同步、团队 Vault、更多协议和更大规模 pane 分别通过 capability、数据归属和生命周期 spec 管理；个人账号/加密同步的边界见 [`relay-account-and-encrypted-sync-design.md`](../superpowers/specs/2026-09-16-relay-account-and-encrypted-sync-design.md)，平台 shell 的设计草案见 [`relay-platform-shell-design.md`](../superpowers/specs/2026-09-16-relay-platform-shell-design.md)，端口转发与协议边界见 [`relay-forwarding-and-protocol-boundaries.md`](../superpowers/specs/2026-09-16-relay-forwarding-and-protocol-boundaries.md)。这些文档都不是当前 Web 已交付能力的声明。

## 核心边界与依赖方向

依赖方向固定为：

~~~text
platform UI  ->  shared application/core  <-  platform adapter
                                      ^
                                      |
                                server adapter
~~~

`src/shared` 允许领域模型、schema、错误码、状态机、连接路径解析、目标快照和用例组合；不得导入 Node、DOM、React、浏览器存储、WebSocket、HTTP、`ssh2`、桌面 keychain 或 Android API。React 组件只能依赖 shared 类型和 runtime/port，不直接把 HTTP 响应当作业务模型使用。

`src/web/api.ts`、浏览器 WebSocket、`File`、`Blob`、`FormData` 和下载行为属于 Web adapter/UI 边界；Fastify、SQLite、Vault、`ssh2` 和服务端文件流属于 server adapter。当前 Web 入口把 `webAdapters` 注入 Web/React 的 `App.tsx`，App 内部只通过注入的 runtime 调用业务能力，导入/导出也通过 shared `ImportExportPort` 传输中立的数据；未来的桌面/Android adapter 可以使用本地 SSH 或继续调用服务端，但都必须实现同一组 shared ports。这里统一的是领域/应用契约，不承诺原生端直接复用 Web DOM 组件。

## 共享契约

核心 runtime 至少包含以下端口；具体 DTO 放在 `src/shared/core/models.ts` 或 `src/shared/validation.ts`，秘密载荷不进入 metadata：

~~~ts
export interface SecretRef {
  kind: 'host' | 'identity';
  id: string;
}

export type VaultPhase = 'uninitialized' | 'locked' | 'unlocked';

export interface VaultStatus {
  phase: VaultPhase;
}

export interface ConnectionTestResult {
  ok: boolean;
  hostKey?: {
    algorithm: string;
    fingerprint: string;
    address: string;
    port: number;
  };
}

export interface SecretStore<Secret = unknown> {
  get(ref: SecretRef): Promise<Secret | null>;
  set(ref: SecretRef, secret: Secret): Promise<void>;
  remove(ref: SecretRef): Promise<void>;
}

export interface VaultSessionPort {
  status(): Promise<VaultStatus>;
  setup(masterPassword: string): Promise<VaultStatus>;
  unlock(masterPassword: string): Promise<VaultStatus>;
  lock(): Promise<void>;
}

export interface ConnectionProbe {
  test(hostId: string): Promise<ConnectionTestResult>;
}

export interface CoreRuntime {
  platform: ClientPlatform;
  capabilities: CapabilitySet;
  negotiateCapabilities(): Promise<CapabilitySet>;
  vault: VaultSessionPort;
  hosts: HostStore;
  connection: ConnectionProbe;
  identities: IdentityStore;
  groups: GroupStore;
  workspace: WorkspaceStore;
  secrets: SecretStore;
  sessions: SessionTransport;
  files: FileTransport;
  commands: CommandTransport;
  snippets: SnippetStore;
  activity: ActivityStore;
  imports: ImportExportPort;
}
~~~

### Capability 协商

`CapabilitySet` 同时保留 `clientCapabilities`、`serverCapabilities` 和 `intersection`；历史字段 `capabilities` 只是 `intersection` 的兼容别名，`supports()` 只检查交集。业务代码不得用 client 集合自行放行请求，也不得通过 UI 绕过服务端权限。`negotiateCapabilitySet()` 保持 client 顺序、去重，并以服务端集合计算有效交集。

能力名称描述行为，不描述平台。当前矩阵如下：

| 行为能力 | Web 当前状态 | 缺失时的稳定降级 |
| --- | --- | --- |
| `workspace.max-panes` / `terminal.broadcast` | 已协商；pane 上限取服务端与 Web 上限的较小值 | 单 Console；隐藏分屏/广播入口 |
| `sftp.browse` / `sftp.entry-mutations` | 按服务端交集控制远端浏览和目录/重命名/删除 | 保留可用的远端只读能力，隐藏写操作 |
| `sftp.transfer` | 按交集显示传输中心、上传/下载动作 | 不加载传输队列，不调用传输 port |
| `transfer.resume` | Web 支持断点校验时才显示“继续”；否则显示“重试”且不发送 resume 参数 | 从头重试，不伪装成断点恢复 |
| `sftp.local-files` | 控制浏览器本地文件选择/drop 区 | 保留远端 SFTP，显示“不支持本地文件选择”说明 |
| `session.reattach` | 已纳入能力集合；仍受服务端会话保留窗口约束 | 刷新后明确显示需要重新连接 |
| `account.auth` / `device.trust` / `sync.encrypted` | 当前 Web 不宣称已交付 | 保持 Local-only，不创建账号/同步调用 |
| `forwarding.local` | 当前未广告 | 不在导航和 runtime 中创建转发入口 |

账号/同步能力即使被服务端错误或提前声明，仍必须经过 client/server 交集；因此当前 Web 不会因为服务端响应包含这些名称而进入账号或云同步路径。

其中 `WorkspaceStore` 只保存非敏感工作区意图，`IdentityStore` 只返回 Identity metadata，`SecretStore` 由平台决定保存位置，`ImportExportPort` 使用 shared 的 `ImportSourceFile` 和 `Uint8Array`，不使用浏览器 `File`/`Blob`。Web adapter 可以在边界把浏览器对象转换成这些类型，native adapter 则把文件选择器或系统路径转换成同一输入。`FileTransport.download()` 对所有端返回 `Promise<ByteStream>`，resolve 后的 stream 只包含 `Uint8Array`；Web 端只在 stream 内部读取 Blob，避免浏览器对象泄露到 shared port。

Host Key policy、ProxyJump 每一跳校验、SFTP 路径规范化、批量目标快照、并发/超时/输出上限、任务终态、重启中断和审计脱敏属于 core/server 共同不变量，不能由某个平台 UI 自行放宽。连接 profile 继承还必须保留旧版本 Host 的显式配置，迁移后以 host override 参与解析。

## 平台职责矩阵

| 层 | 共享内容 | 平台/部署差异 |
| --- | --- | --- |
| Domain/application | Host、Identity、Group、Workspace、Snippet、Transfer、CommandRun、Activity；validation、错误码、状态机、目标解析 | 无平台 API |
| Client ports | VaultSession/ConnectionProbe；Workspace/Identity/Group/Snippet/Activity store；Session/File/Command transport；SecretStore；ImportExportPort | 由 Web、桌面、Android 分别实现 |
| Account/sync extension | Account session、device trust、SyncEnvelope、revision/conflict 状态和 Local-only fallback | 作为可选扩展；不把账号/同步变成 CoreRuntime 的必选依赖 |
| Web | React UI、HTTP/WSS、浏览器 WebSocket、server-mediated SSH、浏览器文件读写 | 不能在浏览器保存凭据或 Vault secret |
| Desktop | Windows/Linux UI shell、OS keychain、安全文件选择器；可选本地 SSH 或 server-mediated transport | 不选择具体桌面框架，不改变 core 语义 |
| Android | Android UI、Keystore、系统文件选择器、移动网络/生命周期 adapter | 处理后台挂起和网络切换，不改变重连/终态定义 |
| Server | Fastify、SQLite、Vault、`ssh2`、权限/owner 校验、任务和审计 | 作为当前 Web 的 SSH/SFTP/command 安全边界 |

## Web adapter

`src/web/platform/web-adapters.ts` 是 Web 对 `CoreRuntime` 的唯一实现入口，`src/web/main.tsx` 将它注入 Web/React `App`；`App.tsx` 本身只依赖 `CoreRuntime`，但原生客户端应复用 shared core、ports、状态语义和 contract tests，并按平台重写 UI/生命周期编排。Web adapter 负责把 setup/unlock/lock、Host CRUD、connection probe、activity、任务轮询、HTTP/WSS、浏览器 WebSocket、浏览器文件和服务端响应映射为 shared ports；`File`/`Blob`/`FormData` 只在 Web UI/adapter 侧转换。`negotiateCapabilities()` 通过 `WebCapabilityAdapter` 读取服务端集合，并使用 shared `negotiateCapabilitySet()` 生成 client/server/intersection 三组结果；原生端可以用同一 helper 返回本地能力与服务端能力的交集。Web UI 只消费协商后的 `supports()` 和有效 pane 上限，不依赖 `client === 'web'` 做业务放行。

Web 的 `SecretStore` 不在浏览器中保存主密码、服务器凭据、导出密码、bundle、token 或命令输出；Web session 由服务端 Vault 解析凭据。若未来桌面/Android 采用本地 SSH，则由 OS keychain/Android Keystore 实现 `SecretStore`，且凭据不会因为复用 core 而自动上传。

服务端通过 `GET /api/capabilities` 返回版本化能力集合。客户端应按 capability 判断功能是否可用，不能根据平台名称复制业务分支；未支持的操作统一返回 `CAPABILITY_UNAVAILABLE`。Terminal/operation wire message 使用 shared 的版本和状态语义，adapter 只负责传输编码与连接生命周期。

## 账号与加密同步边界

账号与同步不改变现有 Local-only 核心路径：

- 未登录账号时，不创建账号会话、不调用同步 API，Host、Identity、Workspace、Snippet 和本地加密凭据只留在当前实例/设备。
- 登录账号是开启同步的用户动作，但账号密码不等于 Vault 主密码；只有 Vault 已解锁或使用离线 recovery key 后，才读取/上传同步内容。
- Account service 只管理 account id、设备、会话和撤销；Blind sync store 只保存 opaque vault id、revision、hash、size、时间和加密 envelope。
- `K_sync` 由现有 `K_vault` 包装；同步服务不能拿到主密码、Vault key、Sync key 或 Vault 明文。当前 Web-mediated SSH 的 Relay 执行端仍是受信解密边界，不宣称对运行时凭据零知识。
- 同步对象包括加密的 Host/Identity/Group/Snippet/Workspace 数据；不包括 live Shell、terminal/session id、TransferJob、CommandRun、终端原始内容、SFTP 文件内容和默认 Activity 输出。
- 首版采用 encrypted snapshot + revision conflict；服务端 revision 冲突时拒绝覆盖，客户端保留两侧加密副本并要求用户选择，不能静默最后写入覆盖 Host Key、凭据、ProxyJump 或 Snippet command。
- 登出或设备撤销停止同步但保留本地数据；同步服务离线时本地 SSH/SFTP/批量能力继续工作，状态显示 `offline`/`pending`。

共享 DTO/可选 ports 只传输 account/device/sync 状态和密文 envelope，不传 session token、主密码、私钥、passphrase、recovery key 或解锁后的凭据。Web 使用 HttpOnly Secure session；桌面/Android 使用 OS keychain/Keystore。具体账号 provider 可以替换，但不能把 provider-specific auth 字段传播到 shared core。

## Desktop / Windows / Linux / Android 适配要求

Windows/Linux 桌面端可以使用 OS keychain 或桌面安全存储，Android 端使用 Android Keystore；三者仍需保持同样的状态语义和确认步骤。替换 transport 时必须保留：

- 每一跳独立的 Host Key 校验与可解释诊断；
- 远程路径拒绝控制字符和越界 `..`；
- 多主机执行前展示完整目标、展开命令、并发、超时和输出保存选项；
- 结果按主机隔离，输出有大小和 TTL 限制；
- 活动日志只记录脱敏结构化摘要，不记录交互式 shell 原始输入输出；
- 移动端后台挂起、网络切换和进程回收只能产生明确的 reconnecting/interrupted/needs-reopen 状态，不能伪造继续执行。

平台差异应存在于 adapter，不应进入 shared core 或改变服务端的安全默认值。云同步不是 CoreRuntime 的必选端口；已批准的账号/同步设计通过可选 `AccountSessionPort`、`DeviceTrustPort` 和 `SyncPort` 扩展，并必须遵守 [`relay-account-and-encrypted-sync-design.md`](../superpowers/specs/2026-09-16-relay-account-and-encrypted-sync-design.md) 的数据归属、冲突、加密和离线语义。

## X-02 平台 shell 设计草案

X-02 将平台产品化边界单独固定在 [`relay-platform-shell-design.md`](../superpowers/specs/2026-09-16-relay-platform-shell-design.md)：Web/PWA 和 Android 以 server-mediated SSH 为基线，Desktop 后续才可在安全评审后增加 local SSH；三者通过统一的 `SecretStore`、`SessionTransport`、`FileTransport`、系统能力端口、capability 降级和生命周期状态接入 shared core。PWA 离线只提供 app shell、非敏感工作区意图和恢复提示；移动端不默认在后台使用未授权凭据；文件选择、下载、剪贴板和通知均停留在平台 adapter。

该文档当前处于待评审草案状态，不代表 manifest、service worker、桌面/Android 工程或 proposed capability 已经实现。评审通过后，每个平台另立 implementation plan，并按真实浏览器、桌面和移动生命周期补充 contract、设备和安全验证。

### PWA shell 当前交付

Web 侧的 PWA 子项目已按上述边界落地，具体计划和验证记录见 [`relay-pwa-shell-implementation.md`](../superpowers/plans/2026-09-16-relay-pwa-shell-implementation.md)：

- `index.html` 声明 manifest、移动 Web 元数据和本地品牌图标；`public/manifest.webmanifest` 提供 standalone 启动入口。
- `public/sw.js` 只预缓存 app shell，并对同源静态 GET 做 runtime cache；`/api/`、`/ws/`、非 GET 和跨 origin 请求不进入 service worker cache。
- `src/web/platform/pwa-registration.ts` 将 service worker 注册失败降级为非阻断结果；React 启动不依赖注册成功。
- shared core 的 `platformServices` 是可选字段；Web adapter 用 browser adapter 提供用户主动剪贴板动作和通知权限/脱敏摘要，缺失时保留应用内反馈。
- 网络断开保留工作区并暂停/等待会话恢复；恢复后只提示“正在检查会话状态”，以真实 session/task 状态为准。

PWA 交付不代表账号同步、Desktop/Android 原生 shell、local SSH 或后台常驻连接已交付；这些仍需各自的 implementation plan、安全评审和设备验证。

## X-03 端口转发与协议能力边界

X-03 的安全边界见 [`relay-forwarding-and-protocol-boundaries.md`](../superpowers/specs/2026-09-16-relay-forwarding-and-protocol-boundaries.md)。文档目前是待安全评审的 capability/security spec，不代表端口转发、Agent Forwarding、Mosh、Serial、Telnet、RDP/VNC 或 X11 已实现。

设计默认值是：local/remote/dynamic SOCKS 分开建模；forwarding 绑定 owner、连接路径和生命周期；V1 只允许显式 loopback bind、严格目标策略和幂等停止；Web 不创建本机 TCP listener，也不提供 URL proxy 或开放 SOCKS。每一跳仍复用 Host Key policy、ProxyJump 路径校验、Vault/权限检查和脱敏审计。

当前 `ForwardingManager` 仍是预留接口，`forwarding.local` 仍未加入 Web capability 广告列表。安全评审和后续 implementation plan 完成前，服务端不新增 forwarding route/data channel，Web 主导航也不增加入口。

## X-01 规模回归基线

规模检查使用结构性上限和相对基线，不把一次机器的绝对耗时当作发布承诺：

- `tests/performance/host-vault-scale.test.ts` 用 100 Host 作为基线，对 1,000 Host 重复执行 100 轮搜索；搜索索引按 Host 集合构建一次，回归阈值为 `max(40 × 小样本耗时, 500ms)`，用于发现非线性退化和重复元数据拼接。
- `tests/performance/terminal-output-scale.test.ts` 固定 xterm scrollback 不超过 5,000 行；Terminal server 的输出缓冲仍由 `SshSessionManager` 按字节上限控制。
- `TransferCenter` 保持 render-only，不为每个任务建立订阅；任务状态由 `App` 的单一刷新队列负责，DOM 测试覆盖暂停/重试/取消等生命周期动作。

这些是回归门槛，不是对所有设备的性能保证；后续平台 shell 需要在真实浏览器、桌面和移动设备上补充相同工作负载的实测基线。

## Contract tests 与发布门槛

- `tests/fixtures/core-runtime-contract.ts` 保存平台无关的 session、file、command、store、capability 和 `Uint8Array` import/export 断言。
- `tests/unit/shared/core-adapter-contract.test.ts` 用无平台依赖的 in-memory runtime 验证 `CoreRuntime` 组合；`tests/unit/shared/native-adapter-contract.test.ts` 用同一断言覆盖 desktop 和 Android native-like fake。
- `tests/unit/web/web-adapters.test.ts` 对真实 Web adapter 运行同一套 CoreRuntime contract，另行验证 HTTP/WSS/浏览器对象到 shared port 的映射，不把 Web 实现细节泄露给 core。
- `tests/performance/host-vault-scale.test.ts`、`tests/performance/terminal-output-scale.test.ts` 和 TransferCenter DOM 回归覆盖 Host 搜索、终端 scrollback 与传输任务动作；阈值不依赖固定机器的绝对性能。
- CI 对 `src/shared` 做静态依赖检查，禁止出现 Node/DOM/React/WebSocket/`ssh2`/浏览器存储依赖；同时运行 Web 和 server 两个 TypeScript target。
- 每个新功能先修改 shared contract 和 fake contract test，再实现 Web adapter；没有 shared port 的功能不得直接写入 `App.tsx`。

这套约束保证 Relay 仍是 Web-first、local-first、单 Vault 产品，同时保留跨 Web、Windows/Linux 桌面和 Android 的扩展可能；未来登录账号即可进入加密同步，但不牺牲 Local-only 路径，也不提前把团队协作或原生 UI 当作已交付能力。
