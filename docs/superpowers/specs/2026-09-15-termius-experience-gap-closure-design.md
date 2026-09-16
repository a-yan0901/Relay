# Termius 使用体验差距收敛方案设计

**日期：** 2026-09-15

**状态：** Implemented (Web-first; native clients/cloud sync deferred)

**前置基线：** 当前分支正在收口导入/导出改造。本方案不重新设计 OpenSSH、Termius CSV、MobaXterm、Xshell、SecureCRT 解析器；导入/导出通过聚焦测试后作为本方案的回归基线。

## 1. 方案摘要

Relay 继续保持 Web-first、local-first、单实例、单用户和单 Vault 定位，不把目标定义成复制 Termius 的所有商业版能力。下一阶段的目标是让 Relay 在浏览器和自托管场景中具备 Termius 式的日常工作流，同时把 shared core、ports、wire protocol 和 capability 做成跨 Web、桌面、Android 可复用的边界：

> 找到主机 → 复用连接身份 → 打开任务 Workspace → 在终端中执行可复用命令 → 同时处理文件 → 断线后得到可信状态和恢复入口。

当前项目的核心 SSH、SFTP、批量执行、Vault、ProxyJump 和审计能力已经存在或正在完成。本方案重点解决它们之间的断点：

- 主机凭据附着在单个 Host 上，缺少可复用的 Keychain/Identity。
- Workspace 目前主要保存 Tab 意图和两栏布局，没有命名模板、任务上下文和清晰的会话生命周期。
- 批量命令从已打开终端发起，不能直接从主机或分组选择目标。
- Snippet 已有服务端 CRUD，但缺少管理界面和终端内快捷入口。
- SFTP 服务端已有目录操作，Web UI 仍偏向列表查看。
- 浏览器路由切换、服务重启和实时任务失联时，用户缺少准确的状态解释。
- 弹窗、移动端、图标语义和键盘焦点还没有形成统一 UI 规范。
- shared core 已补齐 `CoreRuntime`、Identity/Group/Workspace/Snippet/Activity store port、File/Session/Command transport、版本化 wire/capability 和 Web adapter contract；未来桌面/Android 只需替换 adapter，不复制业务规则。

## 2. Benchmark 与证据

Termius 官方文档采用 Vault → Group → Host 的资产模型，并提供可复用的 Keychain、配置继承、Snippets、Workspace、多协议和跨设备能力。[官方产品模型文档](https://docs.termius.com/getting-started/what-is-termius.md)

Termius 官方 Workspace 说明包含 Focus、Split、多个连接、保存 Workspace 模板和批量操作；公开页面描述最多 16 个同时连接。[官方 Workspace 说明](https://termius.com/blog/workspaces)
Termius 的能力矩阵还包括端口转发、Agent Forwarding、Mosh、Telnet、Serial、Session Logs、团队 Vault、同步和企业身份能力，但这些能力分布在不同套餐。[官方定价与能力矩阵](https://termius.com/pricing)

Relay 当前的事实基线：

- 主机、分组、标签、收藏、最近连接和 ProxyJump：HostWorkspace、HostForm 和 shared core 已覆盖。
- SSH 终端、SFTP、批量执行、Snippet 服务、活动面板和加密 Vault：见 README、shared core models、server routes 和 web adapters。
- Workspace 模板 API、Web switcher 和最多四 pane 的布局任务流已经接通；模板只保存非敏感 WorkspaceState。
- 现有 Workspace 只保存非敏感 Tab、布局和筛选；live session 仍由进程内 session manager 管理。
- 当前导入/导出改造已将 Vault 数据包和跨产品迁移拆为独立入口，剩余工作以文案、测试契约和发布回归为主。
- 当前 `src/web/platform/web-adapters.ts` 是 Web 的 `CoreRuntime` 实现入口，`src/web/main.tsx` 将 runtime 注入 Web/React `App.tsx`，App 的业务调用已通过注入的 runtime 收口；导入/导出通过 shared `ImportExportPort`，浏览器 `File`/`Blob`/`FormData` 只在 Web UI/adapter 边界转换。原生客户端复用 shared core、ports、状态语义和 contract tests，但按平台重写 UI/生命周期编排，不直接复用 Web DOM 组件。

本设计只把官方 Termius 页面当作体验和能力 benchmark，不把营销页面当作独立的可用性实验结论。

## 3. 方案选择

### 方案 A：协议和功能数量优先

先增加端口转发、Mosh、Telnet、Serial、RDP/VNC 和原生客户端。

优点是功能列表接近 Termius；缺点是不能解决当前高频路径的配置复用、批量目标、Workspace、SFTP 和恢复问题，同时会显著扩大安全边界和跨平台成本。

不采用。

### 方案 B：工作流优先，能力分层交付

先补齐统一 core contract、Identity、主机发现、批量目标、SFTP、Snippet、命名 Workspace 和会话生命周期，再为端口转发、团队、同步和原生客户端保留 capability/adapter 边界。

优点是每个 slice 都可以独立验收，直接降低日常操作成本，并保留 Relay 的自托管差异化。缺点是短期功能矩阵不会完全覆盖 Termius。

采用此方案。

### 方案 C：先做云同步和多端客户端

先建设账号、同步服务和桌面/移动端，再反向统一 Web 体验。

优点是可以快速对齐 Termius 的跨端叙事；缺点是与当前单 Vault、自托管、无云账号的安全和部署定位冲突，会把数据同步、密钥托管、冲突合并和多端安全问题提前引入。

不采用。

## 4. 产品范围和发布边界

### 4.1 本轮实施范围

按优先级分成三个 release slice：

#### Slice 0：基线收口

- 导入/导出 UI、DOM 测试和组件接口一致。
- Vault 包与跨产品迁移在 UI 上明确区分。
- 外部配置缺失凭据时统一显示“需要补录凭据”，不展示源密码。
- 固定 shared `CoreRuntime`、store/transport ports、版本化 capability 和 platform-neutral import/export contract；Web 只是第一个 adapter。
- lint、typecheck、聚焦单测和导入/导出集成测试通过。

#### Slice 1：日常任务闭环

- 统一 Dialog、状态反馈、键盘焦点和移动端操作语义。
- 主机/分组可直接选择批量目标。
- SFTP 补齐面包屑、新建目录、重命名、多选和上下文操作。
- 返回主机列表不再意外卸载 live terminal；服务重启或任务失联时显示明确的可恢复状态。
- 批量任务、传输任务不出现永久 loading。

#### Slice 2：Termius 式生产力

- Keychain/Identity 可复用连接身份。
- 分组支持嵌套和有限的配置/身份继承。
- Workspace 支持命名、保存、打开和删除模板。
- 终端 Workspace 支持最多 4 个可见 pane，保留后续扩展到 N pane 的模型边界。
- Snippet 管理、搜索和终端内快捷调用。
- 主机列表增加 Recent、Tag 过滤和目标选择入口。

### 4.2 本轮非目标

以下能力不进入本次实施计划：

- 端口转发、SOCKS/HTTP Proxy、Agent Forwarding。
- Mosh、Telnet、Serial、RDP、VNC、X11。
- 云端账号、第三方同步、团队 Vault、RBAC、SSO 和实时协作。
- Windows/Linux/Android 原生 UI；本轮只建立可被原生客户端实现的 core/adapter contract。
- AI 命令生成和真正依赖远端 Shell 集成的补全。
- 默认录制完整交互式终端输入输出。
- 让 Web 应用进程重启后伪造恢复原来的交互式 Shell。

## 5. 用户任务和验收目标

### J1：连接已有主机

1. 用户在主机列表按名称、地址、用户名、标签搜索。
2. 用户直接点击主机连接。
3. 已绑定 Identity 的主机不再要求重复录入凭据。
4. 新 Host Key 仍要求明确确认；已知指纹变化必须阻断。
5. 首次连接成功后终端获得焦点，主机列表刷新最近连接时间。

验收：一台 Identity 被两个主机引用时，修改 Identity 后两个主机下一次连接都使用新凭据；任何浏览器持久化存储、主机列表 DTO 和日志都不包含秘密内容。

### J2：从主机列表执行批量命令

1. 用户从 All、Favorite、Group、Recent 或 Tag 视图进入批量执行。
2. 用户选择单个主机、分组或多个主机。
3. UI 展示去重后的目标列表、命令展开结果、并发、超时和输出保存选项。
4. 用户确认后调用现有 command-runs API。
5. 结果按主机隔离，单台失败不影响其他目标展示。

验收：不打开终端也能发起批量任务；服务端重新按 owner 校验每个 hostId；浏览器修改目标列表不能绕过服务端校验。

### J3：在终端内复用命令

1. 用户从 Snippets 页面创建名称、描述、标签、命令和变量。
2. 终端工具栏通过快捷键或按钮打开 Snippet palette。
3. 选择 Snippet 后进入批量命令预览，变量缺失时阻止执行。
4. 用户可以编辑、复制和删除自己的 Snippet。

验收：Snippet 命令只在解锁期间进入内存；锁定、关闭面板和完成操作后清理表单中的命令内容；不实现未经 Shell 适配的“假自动补全”。

### J4：在终端上下文处理文件

1. 用户打开 Remote Files。
2. 当前路径显示面包屑，可点击回到任意父目录。
3. 新建目录、重命名和删除使用明确的确认语义。
4. 文件支持多选、下载和上传；传输队列显示进度、取消、失败和重试。
5. 当前目录、文件名和操作失败原因始终可见。

验收：所有路径经过现有 normalizeSftpPath；删除和重命名不能离开当前 hostId；取消上传不留下临时文件。

### J5：保存和打开 Workspace

1. 用户把当前打开的主机、Tab 标题、活动 Tab、布局和筛选保存为命名模板。
2. 用户可以从 Workspace switcher 打开或删除模板。
3. 打开模板前若会关闭 live tabs，先展示影响范围并要求确认。
4. 模板不保存 terminalId、sessionId、凭据、命令输出或完整 Shell 状态。
5. 浏览器刷新会尽力复接现有 live session；服务重启后明确显示“需要重新连接”，不显示虚假的“已连接”。

验收：模板可在服务重启后正常读取；旧版 Workspace JSON 可迁移为新布局；应用没有把 live session ID 写入服务端持久化快照。

## 6. 信息架构和交互设计

### 6.1 一级入口

保留当前主机页为默认入口，增加三个可见的任务入口：

- Servers：搜索、Recent、Favorites、Groups、Tags。
- Workspaces：当前 Workspace、保存模板、打开模板。
- Snippets：命令片段管理、搜索、标签。
- Activity：连接、SFTP、批量任务和结果摘要。
- Vault settings：Vault 导入/导出、跨产品迁移、Identity 管理。

终端页不复制完整导航，而是在顶栏提供 Workspace switcher、New terminal、Batch、Snippets、Remote Files 和 Activity 的紧凑入口。

### 6.2 Host / Identity 关系

Host 保存目标地址和主机级覆盖配置；Identity 保存可复用凭据。Host 只保存 identityId 或 inline credential source，不能同时把两份凭据当作有效来源。

建议的非敏感模型：

~~~ts
export type IdentityType = 'password' | 'private_key';

export interface IdentityMetadata {
  id: string;
  name: string;
  type: IdentityType;
  username: string;
  keyFingerprint: string | null;
  usageCount: number;
  createdAt: string;
  updatedAt: string;
}

export type HostCredentialSource =
  | { type: 'inline'; authType: IdentityType }
  | { type: 'identity'; identityId: string }
  | { type: 'group' };
~~~

Identity 的 password、privateKey 和 passphrase 只保存在服务端 Vault 加密载荷中。Identity metadata 可以返回给 Web，但不能返回 credentialCiphertext 或明文。

为兼容现有数据：

- 现有 Host 继续支持 inline credentials。
- 新 Host 可以选择已有 Identity。
- 将旧 Host 绑定 Identity 时，在事务中切换唯一 credential source，并清理旧的 host-owned ciphertext。
- 现有导入数据默认按 inline Host 导入，不强行猜测多个 Host 是否应共用同一 Identity；用户可以在导入后手动合并。

### 6.3 Group 和继承

Group 从平面列表升级为有限深度树：

- parentId 可为空，最大深度 8。
- Group 可设置默认 Identity 和连接 profile。
- Host 的显式配置优先于最近父级 Group，父级优先于应用默认值。
- Group 环不能保存；删除父级时子级移动到父级的父级或根节点，不能静默删除 Host。
- Host 列表显示最终生效的 Identity 名称和配置来源，但不显示秘密。

连接解析顺序固定为：

~~~text
Host explicit value
  ↓
nearest Group value
  ↓
ancestor Group value
  ↓
application default
~~~

### 6.4 Batch target picker

Target picker 不创建新的服务端目标语义。它只负责把用户选择转成去重后的 hostIds，服务端仍按 owner、Host Key、凭据和 capability 重新验证。

UI 选择模型：

~~~ts
export interface TargetSelection {
  hostIds: readonly string[];
  groupIds: readonly string[];
  favoriteOnly: boolean;
  query: string;
}
~~~

显示层可以有 groupIds 和筛选条件，但提交前必须生成固定 hostIds 快照，避免任务执行期间主机列表变化导致目标漂移。

### 6.5 Workspace

第一阶段将当前 WorkspaceState 保持向后兼容，并增加可选的 paneTabIds：

~~~ts
export interface WorkspaceLayout {
  mode: 'single' | 'vertical' | 'horizontal' | 'grid';
  ratio: number;
  paneTabIds?: readonly string[];
}
~~~

规则：

- single 使用 activeTabId。
- vertical 和 horizontal 兼容当前两个 pane。
- grid 最多 4 个可见 pane，paneTabIds 中的 Tab 必须存在于 tabs。
- 未指定 paneTabIds 的旧快照按当前 activeTabId 和相邻 Tab 推导。
- 模板只保存 Host/Tab/layout/filter，不保存 terminalId 和 sessionId。
- 打开模板是显式动作；存在不在模板中的 live tabs 时先确认，确认后关闭这些 tab，再创建模板中的 tab。

### 6.6 SFTP

SFTP 面板采用“路径上下文 + 文件列表 + 操作反馈”结构：

- 顶部：面包屑、路径输入、刷新。
- 工具区：上传、新建目录。
- 列表：类型、名称、大小、修改时间、权限。
- 单选或多选后：下载、重命名、删除。
- 删除、重命名和新建目录使用统一 Dialog。
- 失败反馈包含远端路径、动作和可恢复建议，不展示凭据或底层堆栈。

### 6.7 Snippet palette

本轮只实现安全的 Snippet palette，不实现依赖不同远端 Shell 的语法补全：

- Ctrl/Cmd+Shift+P 打开搜索面板。
- 按名称、描述、标签过滤。
- 选择后把命令和变量带入现有批量预览。
- 终端快捷入口不能直接绕过批量确认。
- AI 命令生成、Shell History 和实时远端路径补全列入后续 capability，不在本轮伪装实现。

## 7. 统一核心与跨端/跨平台扩展

### 7.1 Review 结论：统一核心已成为实现边界

本轮已将 `src/shared/core` 收口为平台无关的模型、validation、error/state、capability、分组/连接继承、目标快照、runtime 和 ports；Web 通过 `src/web/platform/web-adapters.ts` 实现第一套 adapter，并由 `src/web/main.tsx` 注入 Web/React `App.tsx`。App 不直接调用 `api.ts`，导入/导出使用 `ImportSourceFile`/`Uint8Array`，浏览器对象只在 Web UI/adapter 边界转换。统一的是领域/应用契约，不承诺原生客户端直接复用 Web DOM 组件；原生端应复用 shared contract tests 并自行处理 UI 与生命周期。

后续桌面/Android 可以选择本地 SSH + OS keychain/Keystore，或继续使用服务端 transport，但必须复用相同的 Host Key、SFTP 路径、批量目标、任务终态和重启语义。云同步、团队 Vault、多协议和原生 UI 仍是后续独立 spec，不进入当前核心的隐式依赖。

### 7.2 依赖方向和 CoreRuntime

依赖方向固定为 `platform UI → shared application/core ← platform adapter`，服务端作为当前 Web 的 SSH/SFTP/command adapter 和安全边界。`src/shared` 只能包含平台无关的领域模型、schema、纯函数、用例组合和 ports，不得导入 Node、DOM、React、浏览器存储、WebSocket、HTTP、`ssh2`、桌面 keychain 或 Android API。

核心 runtime 统一组合以下能力。接口中的 DTO 必须来自 `src/shared/core/models.ts` 或 `src/shared/validation.ts`；Identity 和 Host 的秘密载荷不进入 metadata。

~~~ts
export interface SecretRef {
  kind: 'host' | 'identity';
  id: string;
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

export interface WorkspaceStore {
  load(): Promise<WorkspaceState>;
  save(expectedVersion: number, state: WorkspaceState): Promise<WorkspaceState>;
  listTemplates(): Promise<readonly WorkspaceTemplate[]>;
  createTemplate(input: WorkspaceTemplateInput): Promise<WorkspaceTemplate>;
  deleteTemplate(templateId: string): Promise<void>;
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

这些 store port 的语义必须明确而且不携带部署细节：

~~~ts
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

export interface HostStore {
  list(filter?: HostListFilter): Promise<readonly HostMetadata[]>;
  get(id: string): Promise<HostMetadata | null>;
  getProfile(id: string): Promise<ConnectionProfile | null>;
  create(input: HostCreateInput): Promise<HostMetadata>;
  update(id: string, input: HostPatchInput): Promise<HostMetadata>;
  delete(id: string): Promise<void>;
}

export interface IdentityStore {
  list(): Promise<readonly IdentityMetadata[]>;
  get(id: string): Promise<IdentityMetadata | null>;
  create(input: IdentityCreateInput): Promise<IdentityMetadata>;
  update(id: string, input: IdentityUpdateInput): Promise<IdentityMetadata>;
  delete(id: string): Promise<void>;
}

export interface GroupStore {
  list(): Promise<readonly GroupNode[]>;
  get(id: string): Promise<GroupNode | null>;
  create(input: GroupMutationInput): Promise<GroupNode>;
  update(id: string, input: GroupMutationInput): Promise<GroupNode>;
  delete(id: string): Promise<void>;
}

export interface SnippetStore {
  list(): Promise<readonly SnippetMetadata[]>;
  get(id: string): Promise<Snippet | null>;
  create(input: SnippetInput): Promise<Snippet>;
  update(id: string, input: SnippetPatchInput): Promise<Snippet>;
  delete(id: string): Promise<void>;
}

export interface ActivityStore {
  list(filter?: ActivityFilter): Promise<readonly AuditEvent[]>;
}

export interface VaultBundlePreview {
  previewId: string;
  hostCount: number;
  groupCount: number;
  identityCount?: number;
  conflicts: readonly VaultBundleConflict[];
  expiresAt: string;
}

export interface VaultBundleConflict {
  type: 'host' | 'group' | 'identity';
  id: string;
  name: string;
}

export interface VaultBundleResolution {
  hostConflicts: 'skip' | 'replace';
  groupConflicts: 'reuse' | 'replace';
  identityConflicts?: 'reuse' | 'replace';
}

export interface VaultBundleApplyResult {
  importedHosts: number;
  importedGroups: number;
  skippedHosts: number;
  skippedGroups: number;
  importedIdentities?: number;
  skippedIdentities?: number;
}

export interface ImportExportPort {
  previewExternalImport(files: readonly ImportSourceFile[], formatHint?: ImportFormat): Promise<ImportPreview>;
  applyExternalImport(previewId: string, input: ImportApplyRequest): Promise<ImportApplyResult>;
  exportOpenSshConfig(): Promise<Uint8Array>;
  exportCsv(options?: ExportOptions): Promise<Uint8Array>;
  exportVaultBundle(exportPassword: string): Promise<string>;
  previewVaultImport(exportPassword: string, bundle: string): Promise<VaultBundlePreview>;
  applyVaultImport(previewId: string, resolution: VaultBundleResolution): Promise<VaultBundleApplyResult>;
}
~~~

这些 store 只暴露跨端可用的 metadata、查询、变更和结果模型；`SecretStore` 的实现可以是服务端 Vault、桌面 OS keychain 或 Android Keystore。Web 端可以让 `SecretStore` 保持不可读/不可持久化，连接时由服务端 Vault 解析凭据，不因统一 core 而把秘密下发到浏览器。

导入/导出使用已有 shared `ImportSourceFile`（`string | Uint8Array`）和 `Uint8Array` 结果。Web 在 adapter 边界把 `File`/`Blob` 转换为 shared 类型，桌面和 Android 则把文件选择器或系统路径转换为同一类型；shared core 不引用 `File`、`Blob`、`FormData`、`Buffer`、`ReadableStream` 或平台路径对象。

文件端口也必须保持传输中立：目录 mutation、上传、下载、取消和重试都使用 shared `ByteStream`/`BinarySource`，不能让 `FileTransport` 接收浏览器 `File` 或返回 `Blob`。

~~~ts
export type ByteStream = AsyncIterable<Uint8Array>;

export interface BinarySource {
  name: string;
  size: number | null;
  stream(): ByteStream;
}

export interface FileTransport {
  list(hostId: string, path: string): Promise<readonly SftpEntry[]>;
  createDirectory(hostId: string, path: string): Promise<void>;
  rename(hostId: string, from: string, to: string): Promise<void>;
  remove(hostId: string, path: string): Promise<void>;
  createTransfer(request: TransferRequest): Promise<TransferJob>;
  upload(transferId: string, source: BinarySource): Promise<TransferJob>;
  download(transferId: string): Promise<ByteStream>;
  cancelTransfer(transferId: string): Promise<void>;
  retryTransfer(transferId: string): Promise<TransferJob>;
}
~~~

### 7.3 跨平台职责矩阵

| 能力层 | 统一内容 | 平台差异 |
| --- | --- | --- |
| Domain/application | Host、Identity、Group、Workspace、Snippet、Transfer、CommandRun、Activity；validation、错误码、状态机、连接路径和目标解析 | 不依赖平台 API |
| Client ports | VaultSession/ConnectionProbe；Workspace/Identity/Group/Snippet/Activity store；Session/File/Command transport；SecretStore；ImportExportPort | Web、桌面、Android 各自实现 |
| Web | React UI、HTTP/WSS、浏览器 WebSocket、server-mediated SSH、浏览器文件读写 | 不在浏览器保存凭据、Vault secret 或完整输出 |
| Desktop | Windows/Linux UI shell、OS keychain、安全文件选择器；可选本地 SSH 或 server-mediated transport | 不提前选 Tauri/Electron，不改变 core 语义 |
| Android | Android UI、Keystore、系统文件选择器、移动网络和生命周期 adapter | 处理后台挂起/网络切换，不改变重连和终态定义 |
| Server | Fastify、SQLite、Vault、`ssh2`、owner 校验、任务和审计 | 当前 Web 的 SSH/SFTP/command 安全边界 |

### 7.4 协议、Capability 和同步边界

- Terminal/operation wire message 使用 shared 的版本和状态语义；新增或变更消息必须带可协商的 `protocolVersion`，不把 WebSocket 对象或 `ssh2` 错误暴露给客户端。
- Capability 名称和版本由 shared 定义，服务端与客户端分别声明支持集合。客户端只按 capability 判断入口；不按 `web`、`desktop`、`android` 写业务分支。未支持操作统一返回 `CAPABILITY_UNAVAILABLE`。
- `connecting`、`awaiting-host-key`、`awaiting-credential`、`connected`、`reconnecting`、`interrupted`、`needs-reopen` 等状态在端之间保持相同含义；平台可以改变恢复实现，但不能把“服务已重启”显示成旧 Shell 仍在执行。
- Cloud sync 不是 `CoreRuntime` 的必选能力。未来如果增加 `SyncStore`/`SyncTransport`，必须另写数据归属、冲突合并、加密、离线和删除语义 spec，不把云账号偷偷引入当前 local-first 核心。

### 7.5 跨端验收门槛

- `src/shared` 的静态依赖检查不得发现 Node、DOM、React、WebSocket、`ssh2` 或浏览器存储依赖。
- `tests/unit/shared/core-adapter-contract.test.ts` 对 in-memory fake 和 Web adapter 复用同一套 Session、File、Command、Store、错误码和终态断言。
- `tests/unit/web/web-adapters.test.ts` 只验证 HTTP/WSS/浏览器对象到 shared port 的映射；`App.tsx` 新增功能不得直接调用 `api.ts`。
- 每个新增功能的实施任务必须按“shared contract → fake contract test → Web adapter → Web UI”顺序推进，并在未来客户端接入时复用同一 contract tests。

## 8. 服务端和数据架构

### 8.1 Identity 持久化

数据库迁移新增 identities 表，并为 hosts 增加 credential source 字段：

~~~sql
CREATE TABLE identities (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  name TEXT NOT NULL,
  auth_type TEXT NOT NULL CHECK (auth_type IN ('password', 'private_key')),
  username TEXT NOT NULL,
  credential_ciphertext TEXT NOT NULL,
  credential_version INTEGER NOT NULL DEFAULT 1,
  key_fingerprint TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (owner_id, name)
);

ALTER TABLE hosts ADD COLUMN credential_source TEXT NOT NULL DEFAULT 'inline'
  CHECK (credential_source IN ('inline', 'identity', 'group'));
ALTER TABLE hosts ADD COLUMN identity_id TEXT REFERENCES identities(id) ON DELETE RESTRICT;
~~~

SQLite 现有 hosts 表的非空约束需要通过事务性 table rebuild 处理，使 identity source 的 Host 不再保留一份有效的 host-owned ciphertext。迁移必须保留现有索引、owner_id、Host Key、jumpHostIds、connection profile、favorite 和 lastConnectedAt。

Identity 加密 AAD 使用 identity:<id>:credentials:v1。Host route、SFTP resource provider 和 command runner 都通过统一的 resolved credential 读取路径获得解密载荷，不直接读取数据库字段。

### 8.2 API 边界

新增：

- GET /api/identities：返回 metadata。
- POST /api/identities：创建并加密 Identity。
- PATCH /api/identities/:id：修改 metadata 或凭据。
- DELETE /api/identities/:id：被 Host 引用时返回明确冲突。
- GET /api/workspace/templates：当前已有，补齐 Web adapter 和 UI。
- POST /api/workspace/templates：当前已有，继续只接受非敏感 WorkspaceState。
- DELETE /api/workspace/templates/:id：当前已有，保持 owner 隔离。

保留：

- POST /api/command-runs：接收 hostIds 快照，服务端重新校验。
- POST /api/sftp/:hostId/entries：继续使用 mkdir、rename、delete discriminated union。
- GET/PUT /api/workspace：继续使用乐观版本号。

### 8.3 Capability

在现有 capability 集合上增加稳定名称：

- vault.identities
- workspace.templates
- workspace.multi-pane
- automation.snippet-manager
- automation.target-picker
- sftp.entry-mutations
- session.lifecycle-status

客户端只通过 capability 判断入口是否可用；未支持时显示不可用原因，不根据平台名称复制业务分支。

### 8.4 会话和实时任务恢复

Interactive Shell 不做跨进程持久化，恢复语义明确为：

- 浏览器刷新或 WebSocket 短断：在现有 30 秒 detach grace 内尝试 reattach 并回放有限 buffer。
- 路由切换：保持 TerminalWorkspace 挂载，隐藏而不销毁 live panels。
- Session 不存在：标记为“需要重新连接”，允许新建 Shell，不显示旧 Shell 仍然存活。
- 服务重启：Workspace tabs 可恢复；live session、未完成 SFTP 和未完成命令不会伪造为继续执行。

为避免任务永久 loading：

- command_runs 中 queued/running 记录在服务启动时统一标记 failed，errorCode 为 SERVER_RESTARTED。
- transfer_jobs 新增持久化状态；queued/running 在服务启动后标记 interrupted，UI 提供重试。
- transfer retry 只能从 failed 或 interrupted 进入 queued。
- Activity 记录重启中断摘要，不写入命令、输出、文件内容和凭据。

## 9. 安全、错误和数据生命周期

- 浏览器 localStorage/sessionStorage 不保存主密码、Host credential、Identity payload、导出密码、Vault bundle、命令输出或 SFTP 文件内容。
- Identity、Snippet 和选择保存的批量输出只在服务端 Vault 解锁期间按需解密。
- 导入/导出仍使用当前独立的 bundle 密码和 preview/apply 事务。
- 批量执行的完整目标、展开命令、并发、超时和输出策略在确认前可见。
- 服务端对 owner、Host、Group、Identity、Workspace template 和 command target 做二次校验。
- Host Key 首次连接必须确认，指纹变化硬失败；每一跳跳板都使用同一 policy。
- 统一错误码至少覆盖：Identity 被引用、Group 环、Workspace 模板冲突、Session 不存在、服务重启中断、Target 为空、SFTP 目录不可写和路径越界。
- 所有异步操作都有终态；客户端收到 404 或 SERVER_RESTARTED 时停止轮询并显示重试/重新连接入口。

## 10. UI 规范和可访问性

### 10.1 Dialog

新增统一 Dialog 组件，所有 role=dialog 的面板都必须：

- 有唯一 aria-labelledby 或 aria-label。
- 打开后聚焦安全动作或首个输入。
- Tab 只在当前 Dialog 内循环。
- Escape 执行取消/关闭，不执行危险操作。
- 关闭后把焦点还给触发按钮。
- 遮罩点击只关闭非破坏性面板；删除、替换和批量执行不允许误触关闭即提交。

### 10.2 文案

状态文案采用动作和结果导向：

- “需要补录凭据”表示当前记录不能直接导入。
- “凭据可导入”表示无需额外输入。
- “需要重新连接”表示旧 session 已不存在，不承诺恢复旧 Shell。
- “服务重启中断，可重试”表示传输或批量任务不会自动继续。
- 危险按钮包含对象和动作，例如“删除远程文件”“替换现有服务器”。

### 10.3 响应式

- 320px 宽度下不隐藏关键动作文字；次要动作可折叠到菜单。
- 终端 pane 最小高度 220px；短视口下优先保留活动 pane。
- 分隔线保持键盘和触控可操作。
- 文件列表和目标列表支持横向滚动或卡片化，不让长主机名撑破布局。
- 高对比度主题、:focus-visible、aria-live 和 reduced motion 保持现有约束。

## 11. 验收与发布门槛

每个 slice 必须先有失败测试再实现，至少覆盖：

- shared validation/model migration；
- repository/service owner 隔离；
- API schema 和错误码；
- React DOM 交互和 Dialog 焦点；
- 真实 OpenSSH SFTP、Host Key、断线和重启边界；
- Playwright 的连接、Workspace、批量、SFTP、导入/导出和 320px 流程。

发布前必须全部通过：

~~~text
npm test -- --reporter=dot
npm run typecheck
npm run lint
npm run build
npm run test:e2e
git diff --check
~~~

并检查：

- 默认导出和日志中没有密码、私钥、passphrase、命令输出或文件内容。
- Identity 被多个 Host 引用时修改和删除行为可预测。
- 服务重启后没有永远 loading、虚假 connected 或可继续执行的假任务。
- 旧 WorkspaceState、旧 Host inline credentials 和旧导入文件仍可读取。
- 当前工作树中用户已有的导入/导出改动没有被覆盖或混入无关提交。
