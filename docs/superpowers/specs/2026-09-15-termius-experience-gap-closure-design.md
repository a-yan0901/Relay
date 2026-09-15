# Termius 使用体验差距收敛方案设计

**日期：** 2026-09-15

**状态：** Proposed

**前置基线：** 当前分支正在收口导入/导出改造。本方案不重新设计 OpenSSH、Termius CSV、MobaXterm、Xshell、SecureCRT 解析器；导入/导出通过聚焦测试后作为本方案的回归基线。

## 1. 方案摘要

Relay 继续保持 Web-first、local-first、单实例、单用户和单 Vault 定位，不把目标定义成复制 Termius 的所有商业版能力。下一阶段的目标是让 Relay 在浏览器和自托管场景中具备 Termius 式的日常工作流：

> 找到主机 → 复用连接身份 → 打开任务 Workspace → 在终端中执行可复用命令 → 同时处理文件 → 断线后得到可信状态和恢复入口。

当前项目的核心 SSH、SFTP、批量执行、Vault、ProxyJump 和审计能力已经存在或正在完成。本方案重点解决它们之间的断点：

- 主机凭据附着在单个 Host 上，缺少可复用的 Keychain/Identity。
- Workspace 目前主要保存 Tab 意图和两栏布局，没有命名模板、任务上下文和清晰的会话生命周期。
- 批量命令从已打开终端发起，不能直接从主机或分组选择目标。
- Snippet 已有服务端 CRUD，但缺少管理界面和终端内快捷入口。
- SFTP 服务端已有目录操作，Web UI 仍偏向列表查看。
- 浏览器路由切换、服务重启和实时任务失联时，用户缺少准确的状态解释。
- 弹窗、移动端、图标语义和键盘焦点还没有形成统一 UI 规范。

## 2. Benchmark 与证据

Termius 官方文档采用 Vault → Group → Host 的资产模型，并提供可复用的 Keychain、配置继承、Snippets、Workspace、多协议和跨设备能力。[官方产品模型文档](https://docs.termius.com/getting-started/what-is-termius.md)

Termius 官方 Workspace 说明包含 Focus、Split、多个连接、保存 Workspace 模板和批量操作；公开页面描述最多 16 个同时连接。[官方 Workspace 说明](https://termius.com/blog/workspaces)
Termius 的能力矩阵还包括端口转发、Agent Forwarding、Mosh、Telnet、Serial、Session Logs、团队 Vault、同步和企业身份能力，但这些能力分布在不同套餐。[官方定价与能力矩阵](https://termius.com/pricing)

Relay 当前的事实基线：

- 主机、分组、标签、收藏、最近连接和 ProxyJump：HostWorkspace、HostForm 和 shared core 已覆盖。
- SSH 终端、SFTP、批量执行、Snippet 服务、活动面板和加密 Vault：见 README、shared core models、server routes 和 web adapters。
- Workspace 模板 API 和 SQLite 表已经存在，但还没有 Web 端任务流。
- 现有 Workspace 只保存非敏感 Tab、布局和筛选；live session 仍由进程内 session manager 管理。
- 当前导入/导出改造已将 Vault 数据包和跨产品迁移拆为独立入口，剩余工作以文案、测试契约和发布回归为主。

本设计只把官方 Termius 页面当作体验和能力 benchmark，不把营销页面当作独立的可用性实验结论。

## 3. 方案选择

### 方案 A：协议和功能数量优先

先增加端口转发、Mosh、Telnet、Serial、RDP/VNC 和原生客户端。

优点是功能列表接近 Termius；缺点是不能解决当前高频路径的配置复用、批量目标、Workspace、SFTP 和恢复问题，同时会显著扩大安全边界和跨平台成本。

不采用。

### 方案 B：工作流优先，能力分层交付

先补齐 Identity、主机发现、批量目标、SFTP、Snippet、命名 Workspace 和会话生命周期，再为端口转发、团队、同步和原生客户端保留 capability/adapter 边界。

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
- Windows/Linux/Android 原生 UI。
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
  | { type: 'identity'; identityId: string; identityName: string };
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

## 7. 服务端和数据架构

### 7.1 Identity 持久化

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

ALTER TABLE hosts ADD COLUMN credential_source TEXT NOT NULL DEFAULT 'inline';
ALTER TABLE hosts ADD COLUMN identity_id TEXT REFERENCES identities(id) ON DELETE RESTRICT;
~~~

SQLite 现有 hosts 表的非空约束需要通过事务性 table rebuild 处理，使 identity source 的 Host 不再保留一份有效的 host-owned ciphertext。迁移必须保留现有索引、owner_id、Host Key、jumpHostIds、connection profile、favorite 和 lastConnectedAt。

Identity 加密 AAD 使用 identity:<id>:credentials:v1。Host route、SFTP resource provider 和 command runner 都通过统一的 resolved credential 读取路径获得解密载荷，不直接读取数据库字段。

### 7.2 API 边界

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

### 7.3 Capability

在现有 capability 集合上增加稳定名称：

- vault.identities
- workspace.templates
- workspace.multi-pane
- automation.snippet-manager
- automation.target-picker
- sftp.entry-mutations
- session.lifecycle-status

客户端只通过 capability 判断入口是否可用；未支持时显示不可用原因，不根据平台名称复制业务分支。

### 7.4 会话和实时任务恢复

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

## 8. 安全、错误和数据生命周期

- 浏览器 localStorage/sessionStorage 不保存主密码、Host credential、Identity payload、导出密码、Vault bundle、命令输出或 SFTP 文件内容。
- Identity、Snippet 和选择保存的批量输出只在服务端 Vault 解锁期间按需解密。
- 导入/导出仍使用当前独立的 bundle 密码和 preview/apply 事务。
- 批量执行的完整目标、展开命令、并发、超时和输出策略在确认前可见。
- 服务端对 owner、Host、Group、Identity、Workspace template 和 command target 做二次校验。
- Host Key 首次连接必须确认，指纹变化硬失败；每一跳跳板都使用同一 policy。
- 统一错误码至少覆盖：Identity 被引用、Group 环、Workspace 模板冲突、Session 不存在、服务重启中断、Target 为空、SFTP 目录不可写和路径越界。
- 所有异步操作都有终态；客户端收到 404 或 SERVER_RESTARTED 时停止轮询并显示重试/重新连接入口。

## 9. UI 规范和可访问性

### 9.1 Dialog

新增统一 Dialog 组件，所有 role=dialog 的面板都必须：

- 有唯一 aria-labelledby 或 aria-label。
- 打开后聚焦安全动作或首个输入。
- Tab 只在当前 Dialog 内循环。
- Escape 执行取消/关闭，不执行危险操作。
- 关闭后把焦点还给触发按钮。
- 遮罩点击只关闭非破坏性面板；删除、替换和批量执行不允许误触关闭即提交。

### 9.2 文案

状态文案采用动作和结果导向：

- “需要补录凭据”表示当前记录不能直接导入。
- “凭据可导入”表示无需额外输入。
- “需要重新连接”表示旧 session 已不存在，不承诺恢复旧 Shell。
- “服务重启中断，可重试”表示传输或批量任务不会自动继续。
- 危险按钮包含对象和动作，例如“删除远程文件”“替换现有服务器”。

### 9.3 响应式

- 320px 宽度下不隐藏关键动作文字；次要动作可折叠到菜单。
- 终端 pane 最小高度 220px；短视口下优先保留活动 pane。
- 分隔线保持键盘和触控可操作。
- 文件列表和目标列表支持横向滚动或卡片化，不让长主机名撑破布局。
- 高对比度主题、:focus-visible、aria-live 和 reduced motion 保持现有约束。

## 10. 验收与发布门槛

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
