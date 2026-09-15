# Termius Experience Gap Closure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在导入/导出改造稳定后，将 Relay 的 Web SSH MVP 收敛为一个具备 Termius 式日常工作流的 local-first、自托管 SSH 工作台。

**Architecture:** 保持现有 TypeScript + React/Vite + Fastify + SQLite + Vault + ssh2 架构。先固定 platform-neutral shared core、CoreRuntime、store/transport ports、wire/capability contract，再补齐 Identity/Group 解析、Workspace 和任务选择契约，通过 Web adapter 接入 UI；服务端继续作为 SSH/SFTP/批量任务的安全边界，不把凭据、live session 或平台 API 放入 shared core。

**Tech Stack:** Node.js 22+, TypeScript, React 19, Vite, Fastify, WebSocket, SQLite/better-sqlite3, Argon2id, AES-256-GCM, ssh2, xterm.js, Vitest, React Testing Library, Playwright, Docker Compose, OpenSSH fixture.

**Spec:** docs/superpowers/specs/2026-09-15-termius-experience-gap-closure-design.md

## Global Constraints

- 当前分支的导入/导出改造是前置基线；先修复其 UI/测试契约，再开始新增体验能力；不重新实现现有解析器。
- 保持 Web-first、local-first、单实例、单用户、单 Vault；本计划不创建云账号、云同步、团队 RBAC、SSO、原生客户端或新协议。
- shared core 只能依赖平台无关的 TypeScript 类型和纯函数；不得导入 Node、DOM、React、浏览器存储、WebSocket 或 ssh2。
- “统一核心”是实施硬门槛，不是文档备注：每个新增能力必须先落到 shared model/validation/error/state/capability/port，再由 Web adapter 和 Web UI 接入；`App.tsx` 不得为新行为直接调用 `src/web/api.ts`。
- CoreRuntime 必须组合 VaultSession、ConnectionProbe、Host、Identity、Group、Workspace、Snippet、Activity store 以及 Session、File、Command transport、SecretStore 和 ImportExportPort；未来桌面/Android 通过替换这些 adapter 扩展，不复制业务规则。
- shared import/export 只使用 `ImportSourceFile`、`Uint8Array` 等平台无关类型；浏览器 `File`/`Blob`/`FormData`、原生文件选择器和系统路径只能在各自 adapter/UI 边界出现。
- Wire message、错误码、状态机和 capability 名称/版本是跨端契约；平台差异只能出现在 adapter。未支持能力统一返回 `CAPABILITY_UNAVAILABLE`，不得用平台名称写业务分支。
- 浏览器 localStorage/sessionStorage 不得保存主密码、Host 凭据、Identity payload、导出密码、Vault bundle、命令输出或 SFTP 文件内容。
- Identity 的凭据、Snippet 内容和选择保存的批量输出只能在服务端 Vault 解锁期间按需解密；Web 只接收 metadata 或当前操作所需的短生命周期内容。
- 现有 Host inline credential 必须继续可用；选择 Identity 后只能存在一个有效 credential source，不能同时使用两份凭据。
- 所有 Host、Group、Identity、Workspace template 和 command target 读取都必须按 owner 隔离并在服务端重新校验。
- Host Key 首次连接必须确认；已知指纹变化必须硬失败；每一跳 ProxyJump 使用相同 Host Key policy。
- Group 树最大深度 8，不能有环；Workspace 最多 4 个可见 pane；旧 WorkspaceState 和旧 Host inline credential 必须可读取。
- 批量执行默认并发 4、最大 16，单主机默认超时 60 秒，单主机输出默认上限 256 KiB；所有多主机任务仍需要显式确认。
- SFTP 所有路径继续经过 normalizeSftpPath；上传必须临时文件后原子重命名；取消或失败不得留下可见的半文件。
- Interactive Shell 不承诺跨服务进程重启恢复；重启后必须显示“需要重新连接”，不能伪造旧 Shell 仍然存活。
- 每个新增行为先写失败测试，再实现最小改动；每个任务完成后运行聚焦测试和受影响的全量测试。
- 当前工作区含用户改动；执行时只 stage 本任务明确列出的文件，不使用 reset、checkout、目录级通配或覆盖用户文件。
- 每个完成的任务使用独立 commit；提交前检查 git diff --name-only 和 git diff --check。

---

## 1. 实施顺序与独立交付边界

按以下顺序执行：

1. Task 0：导入/导出基线收口。
2. Task 1A：统一核心与跨端/跨平台契约硬门槛。
3. Task 1：统一 Dialog、状态反馈和可访问性基础。
4. Task 2：Identity/Keychain 和 Host credential source。
5. Task 3：嵌套 Group、配置继承和主机发现。
6. Task 4：主机/分组批量目标选择。
7. Task 5：SFTP 文件工作流 UI。
8. Task 6：Snippet 管理和终端内 palette。
9. Task 7：Workspace 模板和最多四 pane 的布局。
10. Task 8：会话生命周期、重启边界和任务中断恢复。
11. Task 9：端到端回归、文档和发布门槛。

Task 1A 是所有新增功能的前置契约，不单独改变用户流程。Task 1、4、5、8 构成 Slice 1 的日常任务闭环；Task 2、3、6、7 构成 Slice 2 的 Termius 式生产力。Task 2 和 Task 3 共享数据库迁移边界，应连续执行；其余任务可在独立分支中分别完成。

## 2. 文件地图

### Shared core

- Modify: src/shared/core/models.ts — Vault status、connection probe、Identity、Group、Workspace template、Workspace pane、binary source、Transfer interrupted 和目标选择模型。
- Create: src/shared/core/runtime.ts — `CoreRuntime`、store/transport 组合和平台无关的应用入口类型。
- Modify: src/shared/core/ports.ts — `VaultSessionPort`、`ConnectionProbe`、`SecretRef`、Identity/Group/Workspace/Snippet/Activity store、ImportExportPort 和传输中立的 FileTransport。
- Create: src/shared/core/connection-resolution.ts — Group 继承和 Host 有效连接配置的纯函数解析。
- Modify: src/shared/core/state-machines.ts — Session/Transfer 的中断和可恢复状态。
- Modify: src/shared/core/capabilities.ts — Identity、Workspace template、multi-pane、target picker、SFTP mutation 和 lifecycle capability。
- Modify: src/shared/validation.ts — Identity、Group tree、Host credential source、Workspace layout、target request 和 runtime DTO schema。
- Modify: src/shared/errors.ts — Identity 引用、Group 环、Session 失效、服务重启和 Transfer interrupted 错误码。
- Modify: src/shared/protocol.ts — versioned terminal lifecycle 和 operation recovery 事件。

### Server

- Create: src/server/identity/identity-service.ts — Identity metadata、加密 credential 载荷和引用检查。
- Modify: src/server/db/migrations.ts — Identity/Host credential source 及 transfer job schema migration。
- Modify: src/server/db/types.ts — Identity、Group effective config 和 persisted transfer row。
- Modify: src/server/db/repositories.ts — Identity、Group tree、transfer job 和 restart reconciliation 查询。
- Modify: src/server/api/host-routes.ts — 接收 inline 或 Identity credential source。
- Create: src/server/api/identity-routes.ts — Identity CRUD API。
- Modify: src/server/api/group-routes.ts — parentId、默认 Identity 和连接配置。
- Modify: src/server/api/workspace-routes.ts — 保持 template API，补充严格 state validation 和冲突语义。
- Modify: src/server/workspace/workspace-service.ts — template open/save 的非敏感校验。
- Modify: src/server/automation/command-run-store.ts — queued/running 任务的 restart reconciliation。
- Modify: src/server/sftp/transfer-manager.ts — 持久化 job 状态和 interrupted/retry 语义。
- Modify: src/server/api/command-routes.ts、src/server/api/sftp-routes.ts — 新状态和稳定错误码。
- Modify: src/server/ssh/session-manager.ts、src/server/ws/terminal-gateway.ts — reattach 失败和 session 生命周期诊断。
- Modify: src/server/app.ts、src/server/index.ts — 注册 Identity 路由和启动时任务 reconciliation。

### Web

- Create: src/web/components/Dialog.tsx — 统一 Dialog 焦点、Escape、遮罩和标题语义。
- Create: src/web/components/IdentityManager.tsx、src/web/components/IdentityEditor.tsx — Identity 管理。
- Create: src/web/components/HostTargetPicker.tsx — Host/Group/Recent/Favorite/Tag 目标选择。
- Create: src/web/components/SftpBreadcrumbs.tsx、src/web/components/SftpEntryActions.tsx — SFTP 路径和上下文操作。
- Create: src/web/components/SnippetManager.tsx、src/web/components/SnippetEditor.tsx、src/web/components/SnippetPalette.tsx — Snippet 管理和终端入口。
- Create: src/web/components/WorkspaceSwitcher.tsx、src/web/components/WorkspaceTemplateDialog.tsx — 命名 Workspace 模板。
- Create: src/web/state/target-selection.ts — 目标快照生成和去重纯函数。
- Modify: src/web/api.ts、src/web/platform/web-adapters.ts — 仅在 adapter 内完成 HTTP/WSS、浏览器文件对象和 shared ports 的映射；Identity、template、SFTP mutation、Snippet 和任务状态接口。
- Modify: src/web/App.tsx、src/web/state/app-state.ts、src/web/state/workspace-state.ts — 页面入口改为消费 `CoreRuntime`，Workspace 生命周期和任务状态仍由 Web UI 管理。
- Modify: src/web/components/HostWorkspace.tsx、GroupSidebar.tsx、HostForm.tsx、HostCard.tsx — 主机发现、Group tree、Identity 选择和批量入口。
- Modify: src/web/components/CommandRunDialog.tsx、SnippetPicker.tsx、TerminalWorkspace.tsx、TerminalPanel.tsx — 目标预览、Snippet palette、pane 和 session 状态。
- Modify: src/web/components/SftpPanel.tsx、TransferQueue.tsx、WorkspaceSettings.tsx — 文件工作流、重启中断和导入/导出基线。
- Modify: src/web/hooks/use-dialog-focus.ts、src/web/hooks/use-terminal-session.ts、src/web/styles.css — 统一焦点、连接状态和响应式样式。

### Tests and docs

- Create: tests/unit/web/dialog.dom.test.tsx、identity-manager.dom.test.tsx、host-target-picker.dom.test.tsx、snippet-manager.dom.test.tsx、workspace-switcher.dom.test.tsx、group-sidebar.dom.test.tsx、transfer-queue.dom.test.tsx。
- Create: tests/unit/shared/connection-resolution.test.ts、target-selection.test.ts、identity-types.test.ts。
- Modify: tests/unit/shared/core-adapter-contract.test.ts、tests/unit/web/web-adapters.test.ts — 复用同一套 fake/Web runtime contract。
- Create: tests/unit/server/identity-service.test.ts、snippet-service.test.ts、transfer-restart.test.ts。
- Modify: tests/unit/web/workspace-settings.dom.test.tsx、app.dom.test.tsx、host-workspace.dom.test.tsx、host-form.dom.test.tsx、terminal-workspace.dom.test.tsx、sftp-panel.dom.test.tsx、command-run-dialog.dom.test.tsx。
- Modify: tests/unit/server/repositories.test.ts、command-run-store.test.ts、transfer-manager.test.ts、session-manager.test.ts、workspace-service.test.ts。
- Create: tests/integration/server/identity-routes.test.ts、group-inheritance-routes.test.ts。
- Modify: tests/integration/server/restart-boundaries.test.ts、workspace-routes.test.ts、sftp-routes.test.ts、command-routes.test.ts。
- Create or modify: tests/e2e/termius-experience.spec.ts、tests/e2e/ssh-productivity.spec.ts。
- Modify: README.md、docs/product/2026-09-15-ssh-productivity-release.md、docs/architecture/cross-platform.md、docs/ux/2026-09-15-ux-audit.md。

---

## Task 0: 收口导入/导出基线

**目标：** 让当前导入/导出改造成为稳定前置条件，不扩大解析器范围。

**Files:**
- Modify: src/web/components/WorkspaceSettings.tsx
- Test: tests/unit/web/workspace-settings.dom.test.tsx、tests/unit/web/app.dom.test.tsx
- Verify: tests/unit/server/ssh-import-service.test.ts、tests/integration/server/ssh-import-routes.test.ts

**Interfaces:**
- 保持现有 WorkspaceSettingsProps、preview/apply adapter 和 API 路径不变。
- 外部配置没有可读凭据时，Web 展示文案固定为“需要补录凭据”；有可读凭据时固定为“凭据可导入”。

- [ ] **Step 1: 运行当前聚焦测试确认基线失败点**

Run:
~~~bash
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
npm test -- tests/unit/web/workspace-settings.dom.test.tsx tests/unit/web/app.dom.test.tsx --reporter=dot
~~~

Expected: 只有导入记录状态文案或同一改造产生的明确契约差异失败，不出现 parser、API 或 secret-redaction 回归。

- [ ] **Step 2: 固定缺失凭据的 DOM 契约**

在 tests/unit/web/workspace-settings.dom.test.tsx 中固定以下行为：

~~~tsx
expect(screen.getByText('需要补录凭据')).toBeInTheDocument();
expect(screen.queryByText('source-secret')).not.toBeInTheDocument();
expect(screen.getByRole('button', { name: '确认导入' })).toBeEnabled();
~~~

同时保留 Vault bundle 和外部文件两条独立入口的测试。

- [ ] **Step 3: 对齐 WorkspaceSettings 的状态文案**

在 src/web/components/WorkspaceSettings.tsx 中将缺失 credentialState 的状态文字改为“需要补录凭据”，不要改变 credential payload、previewId、apply request 或清理逻辑。

- [ ] **Step 4: 运行导入/导出相关验证**

Run:
~~~bash
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
npm test -- tests/unit/web/workspace-settings.dom.test.tsx tests/unit/web/app.dom.test.tsx tests/unit/server/ssh-import-service.test.ts tests/integration/server/ssh-import-routes.test.ts --reporter=dot
npm run typecheck
~~~

Expected: 聚焦测试、两个 TypeScript target 全部通过；DOM 中不出现源密码。

- [ ] **Step 5: 检查文件边界并提交基线修正**

Run:
~~~bash
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
git diff --check
git diff --name-only
git add -p src/web/components/WorkspaceSettings.tsx tests/unit/web/workspace-settings.dom.test.tsx tests/unit/web/app.dom.test.tsx
git commit -m "fix: close import export UI contract"
~~~

Stage 时只选择本任务新增的 hunk；不得把用户尚未完成的 parser 或其它 UI 改动一并提交。

---

## Task 1A: 统一核心与跨端/跨平台契约硬门槛

**目标：** 把“未来可扩展到桌面/Android”变成当前可验证的代码边界。shared core 负责平台无关的模型、校验、状态、错误、capability、用例组合和 ports；Web 只实现第一个 adapter，不创建原生 UI，也不引入云同步。

**Files:**
- Create: src/shared/core/runtime.ts — `CoreRuntime` 及平台无关的 store/transport 组合类型。
- Modify: src/shared/core/models.ts、src/shared/core/ports.ts、src/shared/core/capabilities.ts、src/shared/protocol.ts、src/shared/errors.ts、src/shared/validation.ts。
- Modify: src/shared/import/types.ts — Vault bundle preview/result 和平台无关的 import/export DTO。
- Modify: src/web/platform/web-adapters.ts、src/web/api.ts、src/web/App.tsx。
- Modify: tests/unit/shared/core-adapter-contract.test.ts、tests/unit/web/web-adapters.test.ts。
- Create: tests/unit/shared/core-boundary.test.ts — shared 目录静态依赖边界检查。
- Modify: docs/architecture/cross-platform.md。

**Interfaces:**
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

`IdentityStore`、`GroupStore`、`SnippetStore` 和 `ActivityStore` 使用 shared metadata/DTO；`ImportExportPort` 使用 `ImportSourceFile` 和 `Uint8Array`，不得把浏览器 `File`/`Blob`、`FormData`、Node `Buffer` 或原生路径对象放入 shared contract。Web adapter 可以在边界完成这些对象的转换；未来桌面/Android adapter 可以选择本地 SSH + OS keychain/Keystore，或继续使用服务端 transport。

实现时固定以下 store 端口签名；HTTP response、SQLite row 和 keychain handle 只在 adapter 内部存在：

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
  conflicts: readonly VaultBundleConflict[];
  expiresAt: string;
}

export interface VaultBundleConflict {
  type: 'host' | 'group';
  id: string;
  name: string;
}

export interface VaultBundleResolution {
  hostConflicts: 'skip' | 'replace';
  groupConflicts: 'reuse' | 'replace';
}

export interface VaultBundleApplyResult {
  importedHosts: number;
  importedGroups: number;
  skippedHosts: number;
  skippedGroups: number;
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

文件端口同样不能绑定浏览器对象。目录 mutation、上传、下载、取消和重试全部使用 shared `ByteStream`/`BinarySource`：

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

- [ ] **Step 1: 先写跨端 contract 的失败测试**

扩展 `tests/unit/shared/core-adapter-contract.test.ts`，让 in-memory fake 同时满足 Host、Identity、Group、Workspace、Snippet、Activity store 和 Session/File/Command transport；增加断言：

~~~ts
await assertCoreRuntimeContract(fakeRuntime);
expect(fakeRuntime.secrets).toBeDefined();
expect(fakeRuntime.capabilities.supports('workspace.persistence')).toBe(true);
~~~

扩展 `tests/unit/web/web-adapters.test.ts`，验证 `createWebAdapters()` 返回完整 runtime，且浏览器 WebSocket、HTTP 响应和文件对象只在 adapter 内被转换。增加静态依赖断言/脚本，扫描 `src/shared` 不得出现 Node、DOM、React、WebSocket、`ssh2` 或浏览器存储依赖。

- [ ] **Step 2: 运行新增测试确认失败点**

Run:
~~~bash
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
npm test -- tests/unit/shared/core-adapter-contract.test.ts tests/unit/web/web-adapters.test.ts --reporter=dot
~~~

Expected: 失败原因限定为 `CoreRuntime`、新增 store ports、Web runtime 组合或静态依赖检查尚不存在；现有 parser、SSH 和导入/导出测试不应被这一步改动。

- [ ] **Step 3: 在 shared core 定义 runtime、ports 和平台无关 DTO**

在 `src/shared/core/ports.ts` 增加 `VaultSessionPort`、`ConnectionProbe`、`SecretRef`、`IdentityStore`、`GroupStore`、`WorkspaceStore`、`SnippetStore`、`ActivityStore`、`ImportExportPort` 和传输中立的 `FileTransport` mutation/stream 方法；在 `models.ts` 放置 `VaultStatus`、`ConnectionTestResult`、`IdentityMetadata`、`GroupNode`、`WorkspaceTemplate`、`WorkspaceTemplateInput`、`BinarySource` 等跨端模型，在 `src/shared/import/types.ts` 放置 Vault bundle preview/result DTO，在 `runtime.ts` 导出 `CoreRuntime`。Store/transport 方法只返回 shared 类型，不泄露 SQLite row、Fastify reply、HTTP response 或本地 keychain handle。

同时把 `SecretStore` 从按 `hostId` 寻址改为按 `SecretRef` 寻址。Web 实现可以对 `get/set/remove` 返回空值或 `CAPABILITY_UNAVAILABLE`，因为 Web 的秘密由服务端 Vault 在连接/操作时解析；桌面/Android 实现才允许把同一 ref 映射到 OS keychain/Keystore。

- [ ] **Step 4: 将 Web API 收口为第一个 adapter**

让 `createWebAdapters()` 返回 `CoreRuntime` 所需的所有 store/transport。把 `src/web/api.ts` 的 HTTP、WSS、`File`/`Blob` 和 `FormData` 转换留在 `src/web/platform/web-adapters.ts` 或 Web UI 边界；`App.tsx` 新增行为只能从 runtime 调用。`WebFileTransport` 用 `BinarySource` 映射上传、用 `ByteStream` 映射下载，并把 mkdir/rename/remove/retry 纳入同一 port。保留现有 API 函数作为过渡 wiring，但本任务不得再增加 React 到 `api.ts` 的直接依赖。

导入/导出 adapter 需把浏览器文件转换为 shared `ImportSourceFile`，把导出结果转换为 `Uint8Array` 后再由 Web UI 触发下载；不改变现有 preview/apply、bundle 密码或 secret-redaction 语义。

- [ ] **Step 5: 固定版本化 wire、capability 和终态语义**

在 `src/shared/protocol.ts` 增加 shared `protocolVersion`/envelope 约束，兼容迁移期间的旧 Web wire 只允许存在于 adapter；在 `src/shared/core/capabilities.ts` 固定 capability 名称、版本和 `CAPABILITY_UNAVAILABLE` 行为。`connecting`、`awaiting-host-key`、`awaiting-credential`、`connected`、`reconnecting`、`interrupted` 和 `needs-reopen` 的含义由 shared 定义，平台不得按客户端名称复制状态分支。

不要在本任务增加 `SyncStore`/`SyncTransport`、云账号或桌面/Android UI；同步和 native UI 进入独立 spec。

- [ ] **Step 6: 运行双 target、contract 和静态边界验证**

Run:
~~~bash
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
npm test -- tests/unit/shared/core-adapter-contract.test.ts tests/unit/shared/core-boundary.test.ts tests/unit/web/web-adapters.test.ts tests/unit/shared/protocol.test.ts --reporter=dot
npm run typecheck
npm run lint
rg -n -e "node:" -e "from ['\"]react" -e "from ['\"]react-dom" -e "WebSocket" -e "ssh2" -e "localStorage" -e "sessionStorage" src/shared || true
~~~

Expected: contract tests、Web/server 两个 TypeScript target 和 lint 通过；最后的 `rg` 无输出（命令以 `|| true` 运行时需人工确认无命中）。

- [ ] **Step 7: 只提交统一核心边界**

~~~bash
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
git diff --check
git diff --name-only
git add -p src/shared/core/runtime.ts src/shared/core/models.ts src/shared/core/ports.ts src/shared/core/capabilities.ts src/shared/protocol.ts src/shared/errors.ts src/shared/validation.ts src/shared/import/types.ts src/web/platform/web-adapters.ts src/web/api.ts src/web/App.tsx tests/unit/shared/core-adapter-contract.test.ts tests/unit/shared/core-boundary.test.ts tests/unit/web/web-adapters.test.ts docs/architecture/cross-platform.md
git commit -m "refactor: enforce cross-platform core boundary"
~~~

只 stage 本任务的 hunk；当前用户未提交的功能改动必须留在原有 diff 中，不能因为 `App.tsx`、`api.ts` 或共享文件重叠而整文件提交。

---

## Task 1: 统一 Dialog、状态反馈和可访问性基础

**目标：** 让危险操作、导入、批量执行、SFTP 和活动结果使用一致的焦点与关闭语义。

**Files:**
- Create: src/web/components/Dialog.tsx
- Modify: src/web/hooks/use-dialog-focus.ts、src/web/App.tsx、src/web/components/CommandRunDialog.tsx、src/web/components/WorkspaceSettings.tsx、src/web/components/SftpPanel.tsx、src/web/components/TerminalWorkspace.tsx、src/web/styles.css
- Test: tests/unit/web/dialog.dom.test.tsx，并更新现有 Dialog 交互测试

**Interfaces:**
~~~tsx
export interface DialogProps {
  title: string;
  ariaLabel?: string;
  onClose: () => void;
  initialFocusSelector?: string;
  closeOnBackdrop?: boolean;
  children: React.ReactNode;
}
~~~

Dialog 默认使用唯一标题 ID、aria-modal=true、role=dialog、首焦点、Tab trap、Escape close 和关闭后焦点恢复；closeOnBackdrop 对删除、替换和确认执行默认关闭为 false。

- [ ] **Step 1: 写失败测试覆盖焦点和危险关闭语义**

在 tests/unit/web/dialog.dom.test.tsx 覆盖：

~~~tsx
it('focuses the requested control, traps Tab, restores focus, and closes on Escape', async () => {});
it('does not close a destructive dialog when the backdrop is clicked', async () => {});
it('exposes exactly one accessible dialog name', async () => {});
~~~

- [ ] **Step 2: 运行新测试确认失败**

Run:
~~~bash
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
npm test -- tests/unit/web/dialog.dom.test.tsx --reporter=dot
~~~

Expected: 失败原因是 Dialog 组件或统一 focus wiring 尚不存在。

- [ ] **Step 3: 实现 Dialog wrapper 并复用现有 focus hook**

Dialog 只负责 DOM 语义和生命周期，不负责业务提交。实现核心结构：

~~~tsx
<div className="modal-backdrop" role="presentation" onMouseDown={closeOnBackdrop ? onClose : undefined}>
  <section ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby={titleId}>
    <h2 id={titleId}>{title}</h2>
    {children}
  </section>
</div>
~~~

将 useDialogFocus 的首焦点、Escape 和 focus restore 行为收口到 Dialog；保留 HostKeyDialog 的安全默认按钮行为。

- [ ] **Step 4: 迁移现有 Web dialogs**

依次迁移 CommandRunDialog、批量结果、ActivityPanel、WorkspaceSettings、Host picker、SFTP delete，并为每个危险操作设置明确取消按钮。按钮文本包含对象和动作，例如“删除远程文件”“替换现有服务器”。

- [ ] **Step 5: 运行回归和样式检查**

Run:
~~~bash
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
npm test -- tests/unit/web/dialog.dom.test.tsx tests/unit/web/app.dom.test.tsx tests/unit/web/command-run-dialog.dom.test.tsx tests/unit/web/host-key-dialog.dom.test.tsx tests/unit/web/sftp-panel.dom.test.tsx --reporter=dot
npm run typecheck
npm run lint
~~~

- [ ] **Step 6: 提交独立 UI 基础改动**

~~~bash
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
git diff --check
git add -p src/web/components/Dialog.tsx src/web/hooks/use-dialog-focus.ts src/web/App.tsx src/web/components/CommandRunDialog.tsx src/web/components/WorkspaceSettings.tsx src/web/components/SftpPanel.tsx src/web/components/TerminalWorkspace.tsx src/web/styles.css tests/unit/web/dialog.dom.test.tsx
git commit -m "feat: unify web dialog behavior"
~~~

---

## Task 2: Identity/Keychain 和 Host credential source

**目标：** 让一个用户名、密码、SSH Key 或证书身份可以被多个 Host 复用，同时保持现有 inline Host 凭据兼容。

**依赖：** 消费 Task 1A 定义的 `IdentityStore`、`SecretRef` 和 `CoreRuntime`；Identity API 的 HTTP DTO 只能在 Web adapter 内映射，不能成为 shared domain 类型。

**Files:**
- Modify: src/shared/core/models.ts、src/shared/validation.ts、src/shared/core/capabilities.ts、src/shared/errors.ts
- Create: src/server/identity/identity-service.ts、src/server/api/identity-routes.ts、src/web/components/IdentityManager.tsx、src/web/components/IdentityEditor.tsx、tests/unit/server/identity-service.test.ts、tests/unit/web/identity-manager.dom.test.tsx、tests/integration/server/identity-routes.test.ts、tests/unit/shared/identity-types.test.ts
- Modify: src/server/db/migrations.ts、src/server/db/types.ts、src/server/db/repositories.ts、src/server/api/host-routes.ts、src/server/app.ts、src/web/api.ts、src/web/platform/web-adapters.ts、src/web/App.tsx、src/web/components/HostForm.tsx、src/web/components/HostCard.tsx
- Test: tests/unit/server/repositories.test.ts、tests/unit/web/host-form.dom.test.tsx、tests/integration/server/host-routes.test.ts

**Interfaces:**
~~~ts
export type IdentityType = AuthType;

export interface IdentityCreateInput {
  name: string;
  username: string;
  auth: HostCredentialInput;
}

export interface IdentityUpdateInput {
  name?: string;
  username?: string;
  auth?: HostCredentialInput;
}

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
  | { type: 'identity'; identityId: string };
~~~

Server service methods：

~~~ts
class IdentityService {
  list(ownerId: string): Promise<IdentityMetadata[]>;
  create(ownerId: string, input: IdentityCreateInput, vaultKey: Buffer): Promise<IdentityMetadata>;
  getCredential(ownerId: string, id: string, vaultKey: Buffer): Promise<StoredHostCredential>;
  update(ownerId: string, id: string, input: IdentityUpdateInput, vaultKey: Buffer): Promise<IdentityMetadata>;
  delete(ownerId: string, id: string): Promise<void>;
}
~~~

Host create/patch 接受 legacy auth 或新的 credentialSource，但经过 validation 后必须归一为 inline 或 identity 二选一。Web API 新增：

~~~ts
getIdentities(): Promise<IdentityMetadata[]>;
createIdentity(input: IdentityCreateInput): Promise<IdentityMetadata>;
updateIdentity(id: string, input: IdentityUpdateInput): Promise<IdentityMetadata>;
deleteIdentity(id: string): Promise<void>;
~~~

- [ ] **Step 1: 写 shared validation 和旧数据兼容测试**

在 tests/unit/shared/identity-types.test.ts 中覆盖：

~~~ts
it('accepts an inline host credential source');
it('accepts an identity reference without exposing credential fields');
it('rejects a host with both inline and identity sources');
it('keeps legacy host auth input valid');
it('rejects an identity reference with an invalid owner-scoped identifier');
~~~

- [ ] **Step 2: 写数据库迁移和服务端失败测试**

在 tests/unit/server/identity-service.test.ts、tests/unit/server/repositories.test.ts 中覆盖：

- 旧 schema 的 Host 仍能读取 inline credential。
- Identity credential 按 identity AAD 加密，metadata 不含 ciphertext。
- 不同 owner 不能读取、更新、删除或引用 Identity。
- 被 Host 引用的 Identity 删除返回稳定冲突错误。
- 修改 Identity 后引用它的两个 Host 使用新 credential。

- [ ] **Step 3: 实现 schema version 7 和加密 Identity service**

在 src/server/db/migrations.ts 中将 schema version 提升为 7，新增 identities 表，并给 hosts 增加 credential_source 和 identity_id。SQLite 通过事务性 table rebuild 处理 hosts 的 credential_ciphertext 可为空语义，同时保留现有索引、owner_id、Host Key、jumpHostIds、connection profile、favorite 和 lastConnectedAt。

Identity credential 统一使用：

~~~ts
const identityAad = (id: string): string => 'identity:' + id + ':credentials:v1';
~~~

旧 Host 不迁移成猜测出的共享 Identity；旧数据保持 inline source。用户显式绑定 Identity 时，事务中切换 source 并清理旧的 host-owned ciphertext。

- [ ] **Step 4: 接入 routes、Host route 和 resolved credential**

注册 /api/identities 的 GET、POST、PATCH、DELETE。Host route 在保存前验证 identity 属于当前 owner，并在连接、SFTP 和 command runner 的统一 resolved credential 路径中读取 Identity secret。禁止把 credentialCiphertext、privateKey 或 password 返回给 Web。

- [ ] **Step 5: 实现 Web Identity manager 和 HostForm 选择**

IdentityManager 通过 `webAdapters.identities` 支持列表、创建、重命名、更新凭据和删除；HostForm 增加“使用已有身份”选择，选择 Identity 时不显示 inline password/private key 输入。HostCard 通过 metadata 显示 Identity 名称和引用数量，不显示秘密；组件不直接调用 `src/web/api.ts`。

- [ ] **Step 6: 运行服务端和 Web 回归**

~~~bash
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
npm test -- tests/unit/shared/identity-types.test.ts tests/unit/server/identity-service.test.ts tests/unit/server/repositories.test.ts tests/integration/server/identity-routes.test.ts tests/integration/server/host-routes.test.ts tests/unit/web/identity-manager.dom.test.tsx tests/unit/web/host-form.dom.test.tsx --reporter=dot
npm run typecheck
npm run lint
~~~

- [ ] **Step 7: 提交 Identity slice**

~~~bash
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
git diff --check
git add -p src/shared/core/models.ts src/shared/validation.ts src/shared/core/capabilities.ts src/shared/errors.ts src/server/identity src/server/db/migrations.ts src/server/db/types.ts src/server/db/repositories.ts src/server/api/identity-routes.ts src/server/api/host-routes.ts src/server/app.ts src/web/api.ts src/web/platform/web-adapters.ts src/web/App.tsx src/web/components/HostForm.tsx src/web/components/HostCard.tsx src/web/components/IdentityManager.tsx src/web/components/IdentityEditor.tsx tests/unit/shared/identity-types.test.ts tests/unit/server/identity-service.test.ts tests/unit/server/repositories.test.ts tests/integration/server/identity-routes.test.ts tests/integration/server/host-routes.test.ts tests/unit/web/identity-manager.dom.test.tsx tests/unit/web/host-form.dom.test.tsx
git commit -m "feat: add reusable ssh identities"
~~~

---

## Task 3: 嵌套 Group、配置继承和主机发现

**目标：** 让主机组织从平面分组升级为可解释的树形资产，并提供 Recent、Tag 和配置来源。

**依赖：** 消费 Task 1A 的 `GroupStore`、`HostStore` 和连接解析 port。`GroupSummaryResponse` 是 HTTP response DTO，只能由 Web adapter 转换为 shared `GroupNode`/effective configuration，React 不直接依赖 route response。

**Files:**
- Create: src/shared/core/connection-resolution.ts、tests/unit/shared/connection-resolution.test.ts、tests/integration/server/group-inheritance-routes.test.ts
- Modify: src/shared/core/models.ts、src/shared/validation.ts、src/server/db/migrations.ts、src/server/db/types.ts、src/server/db/repositories.ts、src/server/api/group-routes.ts、src/server/api/host-routes.ts、src/web/api.ts、src/web/App.tsx、src/web/components/GroupSidebar.tsx、src/web/components/HostWorkspace.tsx、src/web/components/HostForm.tsx、src/web/components/HostCard.tsx
- Test: tests/unit/server/repositories.test.ts、tests/unit/web/group-sidebar.dom.test.tsx、tests/unit/web/host-workspace.dom.test.tsx

**Interfaces:**
~~~ts
export interface GroupSummaryResponse {
  id: string;
  name: string;
  parentId: string | null;
  identityId: string | null;
  identityName: string | null;
  connectionProfile: ConnectionProfileSettings | null;
  hostCount: number;
  sortOrder: number;
}

export interface GroupInheritanceInput {
  id: string;
  parentId: string | null;
  identityId: string | null;
  connectionProfile: ConnectionProfileSettings | null;
}

export interface HostConnectionOverrides {
  id: string;
  groupId: string | null;
  identityId: string | null;
  connectionProfile: ConnectionProfileSettings | null;
}

export interface ResolvedConnectionConfig {
  hostId: string;
  identityId: string | null;
  identityName: string | null;
  connectionProfile: ConnectionProfileSettings;
  source: {
    identity: 'host' | 'group' | 'default';
    connectionProfile: 'host' | 'group' | 'default';
  };
}
~~~

Pure resolver：

~~~ts
export const resolveGroupChain = (
  groupId: string | null,
  groups: ReadonlyMap<string, GroupInheritanceInput>
): readonly string[] => {};

export const resolveConnectionConfig = (
  host: HostConnectionOverrides,
  groups: ReadonlyMap<string, GroupInheritanceInput>,
  defaults: ConnectionProfileSettings
): ResolvedConnectionConfig => {};
~~~

- [ ] **Step 1: 写 Group tree、环和继承测试**

在 tests/unit/shared/connection-resolution.test.ts 中覆盖：

~~~ts
it('resolves the nearest group value before an ancestor and default');
it('rejects a group cycle');
it('rejects a tree deeper than eight levels');
it('keeps explicit host values ahead of group values');
it('returns source metadata without secret fields');
~~~

- [ ] **Step 2: 写 repository/API owner 和 delete 语义测试**

在 tests/integration/server/group-inheritance-routes.test.ts 中覆盖创建/更新 parentId、identityId、connectionProfile、跨 owner 引用、重复名称、环、删除父级和 Host 不被静默删除。

- [ ] **Step 3: 增加 schema version 8 的 Group 字段和有效配置查询**

为 groups 增加 parent_id、identity_id、connection_profile_json；迁移时旧 Group 的 parentId、identityId 和 profile 使用 null。Repository 返回 hostCount 和非敏感生效来源；所有 Group 查询按 owner_id 过滤。

- [ ] **Step 4: 接入服务端 Group route 和 Host resolved config**

Group route 接受 parentId、identityId、connectionProfile，并在写入前调用 resolveGroupChain。Host connection、SFTP 和 command target 解析时使用同一 resolved config，不在三个模块中复制继承规则。

- [ ] **Step 5: 改造 GroupSidebar 和主机发现入口**

GroupSidebar 展示可展开树、每组主机数、All、Favorites、Recent 和 Tags；HostWorkspace 的搜索范围包含名称、地址、用户名、标签和 Identity 名称。Recent 使用 lastConnectedAt 排序或过滤，不在浏览器存储新的敏感信息。

- [ ] **Step 6: 运行 shared/server/Web 回归**

~~~bash
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
npm test -- tests/unit/shared/connection-resolution.test.ts tests/unit/server/repositories.test.ts tests/integration/server/group-inheritance-routes.test.ts tests/unit/web/group-sidebar.dom.test.tsx tests/unit/web/host-workspace.dom.test.tsx tests/unit/web/host-form.dom.test.tsx --reporter=dot
npm run typecheck
npm run lint
~~~

- [ ] **Step 7: 提交 Group slice**

~~~bash
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
git diff --check
git add -p src/shared/core/connection-resolution.ts src/shared/core/models.ts src/shared/validation.ts src/server/db/migrations.ts src/server/db/types.ts src/server/db/repositories.ts src/server/api/group-routes.ts src/server/api/host-routes.ts src/web/api.ts src/web/App.tsx src/web/components/GroupSidebar.tsx src/web/components/HostWorkspace.tsx src/web/components/HostForm.tsx src/web/components/HostCard.tsx tests/unit/shared/connection-resolution.test.ts tests/integration/server/group-inheritance-routes.test.ts tests/unit/web/group-sidebar.dom.test.tsx tests/unit/web/host-workspace.dom.test.tsx
git commit -m "feat: add inherited host group settings"
~~~

---

## Task 4: 主机/分组批量目标选择

**目标：** 用户不打开终端也能从主机列表选择目标，并在确认前看到稳定的 hostIds 快照。

**Files:**
- Create: src/web/state/target-selection.ts、src/web/components/HostTargetPicker.tsx、tests/unit/shared/target-selection.test.ts、tests/unit/web/host-target-picker.dom.test.tsx
- Modify: src/web/App.tsx、src/web/components/HostWorkspace.tsx、src/web/components/CommandRunDialog.tsx、src/web/components/TerminalWorkspace.tsx、src/web/styles.css
- Test: tests/unit/web/command-run-dialog.dom.test.tsx、tests/e2e/ssh-productivity.spec.ts

**Interfaces:**
~~~ts
export interface TargetSelection {
  hostIds: readonly string[];
  groupIds: readonly string[];
  favoriteOnly: boolean;
  query: string;
}

export const expandTargetSelection = (
  selection: TargetSelection,
  hosts: readonly HostMetadata[]
): readonly string[] => {};
~~~

CommandRunDialog 接受所有可选 Host 和 Group，而不是只接收当前 terminals 的 hostIds：

~~~tsx
<CommandRunDialog
  hosts={state.hosts}
  groups={state.groups}
  initialHostIds={initialHostIds}
  onConfirm={(request) => void handleStartCommandRun(request)}
/>
~~~

GroupSidebar、HostWorkspace 和 HostForm 通过 `runtime.groups`/`runtime.hosts` 获取数据；`identityName` 只作为展示 metadata，Host 的 canonical credential source 仍只保存 `identityId`。

- [ ] **Step 1: 写目标展开和去重测试**

在 tests/unit/shared/target-selection.test.ts 中覆盖组选择、收藏选择、Recent/Tag 查询、重复 Host 去重、空目标、已删除 Host 和稳定排序。

- [ ] **Step 2: 写 HostTargetPicker DOM 测试**

在 tests/unit/web/host-target-picker.dom.test.tsx 中覆盖：

~~~tsx
it('selects a group and shows its concrete hosts');
it('filters by name, address, tag, recent, and favorite');
it('keeps checked targets when the search filter changes');
it('does not enable confirm with zero targets');
~~~

- [ ] **Step 3: 在主机页和终端页增加目标入口**

HostWorkspace 增加“批量执行”入口，TerminalWorkspace 保留当前入口但打开同一 HostTargetPicker。App 不再用 state.terminals 作为唯一 hostIds 来源；如果从终端页进入，则用当前 terminal hostIds 作为初始选中集合。

- [ ] **Step 4: 在确认时固化 hostIds 并保持服务端二次校验**

确认前调用 expandTargetSelection 生成排序稳定、去重后的 hostIds，展示完整目标快照并传给现有 /api/command-runs。不要把 groupIds 或前端筛选条件当作服务端执行目标。

- [ ] **Step 5: 运行批量命令回归和 E2E**

~~~bash
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
npm test -- tests/unit/shared/target-selection.test.ts tests/unit/web/host-target-picker.dom.test.tsx tests/unit/web/command-run-dialog.dom.test.tsx tests/unit/web/host-workspace.dom.test.tsx --reporter=dot
npm run typecheck
npm run lint
~~~

E2E 新增“没有打开终端时从主机列表批量执行”的 Chromium 场景，并检查目标预览、变量展开、取消和活动摘要。

- [ ] **Step 6: 提交 target picker slice**

~~~bash
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
git diff --check
git add -p src/web/state/target-selection.ts src/web/components/HostTargetPicker.tsx src/web/App.tsx src/web/components/HostWorkspace.tsx src/web/components/CommandRunDialog.tsx src/web/components/TerminalWorkspace.tsx src/web/styles.css tests/unit/shared/target-selection.test.ts tests/unit/web/host-target-picker.dom.test.tsx tests/unit/web/command-run-dialog.dom.test.tsx tests/e2e/ssh-productivity.spec.ts
git commit -m "feat: add host target picker"
~~~

---

## Task 5: SFTP 文件工作流 UI

**目标：** 将已有的 SFTP server capability 暴露为可完成日常文件任务的 UI。

**依赖：** 消费 Task 1A 的 `FileTransport`、`BinarySource` 和 `ByteStream`。SFTP UI 只负责编排选择、确认和展示；目录 mutation、上传、下载、取消和重试不能另建 Web-only 业务接口。

**Files:**
- Create: src/web/components/SftpBreadcrumbs.tsx、src/web/components/SftpEntryActions.tsx
- Modify: src/shared/core/models.ts、src/shared/core/ports.ts
- Modify: src/web/api.ts、src/web/platform/web-adapters.ts、src/web/components/SftpPanel.tsx、src/web/components/TransferQueue.tsx、src/web/styles.css
- Test: tests/unit/web/sftp-panel.dom.test.tsx、tests/unit/web/transfer-queue.dom.test.tsx（新增）、tests/e2e/ssh-productivity.spec.ts
- Verify: src/server/api/sftp-routes.ts、src/server/sftp/sftp-service.ts、tests/integration/server/sftp-routes.test.ts

**Interfaces:**
~~~ts
export interface SftpPanelOperations {
  createDirectory(hostId: string, path: string): Promise<void>;
  rename(hostId: string, from: string, to: string): Promise<void>;
  remove(hostId: string, path: string, confirmed: boolean): Promise<void>;
}

export interface SftpSelection {
  hostId: string;
  currentPath: string;
  selectedPaths: readonly string[];
}
~~~

- [ ] **Step 1: 写 SFTP DOM 失败测试**

在 tests/unit/web/sftp-panel.dom.test.tsx 中增加：

~~~tsx
it('renders breadcrumbs and navigates to a parent path');
it('creates a directory and refreshes the current path');
it('renames a selected entry with an explicit destination');
it('supports multi-select download without mixing host ids');
it('uses a destructive dialog for remote delete');
it('renders mode and modified time when the server provides them');
~~~

- [ ] **Step 2: 运行聚焦测试确认缺失入口**

~~~bash
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
npm test -- tests/unit/web/sftp-panel.dom.test.tsx --reporter=dot
~~~

Expected: 失败点只应是当前 UI 缺少 breadcrumbs、mkdir、rename、多选和 mutation callbacks。

- [ ] **Step 3: 接通已有 mutation API 和 shared FileTransport**

在 shared `FileTransport` 实现 createDirectory、rename、remove、upload、download、cancel 和 retry；Web adapter 把 `File` 转成 `BinarySource`，把响应流转成 `ByteStream`，继续调用现有 /api/sftp/:hostId/entries discriminated union，不新增绕过 normalizeSftpPath 的客户端路径拼接。

- [ ] **Step 4: 实现路径、选择和上下文操作**

SftpBreadcrumbs 根据 normalize 后的 path 构造父级按钮；SftpEntryActions 根据 entry type 显示操作。多选只保存当前 hostId 和 path，下载按单个 transfer job 创建，删除一次只确认明确列出的路径。

- [ ] **Step 5: 更新文件元数据和移动端布局**

列表展示 directory/file/symlink、size、modifiedAt、mode；320px 下将次要元数据折叠，但保留路径、上传、新建目录、重命名、删除和刷新入口文字。

- [ ] **Step 6: 运行 SFTP server 和浏览器回归**

~~~bash
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/sbin:/bin
npm test -- tests/unit/web/sftp-panel.dom.test.tsx tests/unit/web/transfer-queue.dom.test.tsx tests/unit/server/sftp-service.test.ts tests/integration/server/sftp-routes.test.ts --reporter=dot
npm run typecheck
npm run lint
~~~

E2E 覆盖新建目录、重命名、上传、下载、取消上传后的临时文件清理和权限错误提示。

- [ ] **Step 7: 提交 SFTP UI slice**

~~~bash
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
git diff --check
git add -p src/shared/core/models.ts src/shared/core/ports.ts src/web/components/SftpBreadcrumbs.tsx src/web/components/SftpEntryActions.tsx src/web/api.ts src/web/platform/web-adapters.ts src/web/components/SftpPanel.tsx src/web/components/TransferQueue.tsx src/web/styles.css tests/unit/web/sftp-panel.dom.test.tsx tests/unit/web/transfer-queue.dom.test.tsx tests/e2e/ssh-productivity.spec.ts
git commit -m "feat: complete sftp workspace actions"
~~~

---

## Task 6: Snippet 管理和终端内 palette

**目标：** 将已有的加密 Snippet CRUD 变成可发现、可搜索、可复用的日常命令入口。

**依赖：** 消费 Task 1A 的 `SnippetStore` 和 capability；Web manager/palette 只通过 runtime 读取/变更 Snippet，不直接绑定 `/api/snippets` response。

**Files:**
- Create: src/web/components/SnippetManager.tsx、src/web/components/SnippetEditor.tsx、src/web/components/SnippetPalette.tsx、tests/unit/web/snippet-manager.dom.test.tsx
- Modify: src/shared/core/ports.ts、src/web/api.ts、src/web/platform/web-adapters.ts、src/web/App.tsx、src/web/components/CommandRunDialog.tsx、src/web/components/SnippetPicker.tsx、src/web/components/TerminalWorkspace.tsx、src/web/styles.css
- Test: tests/unit/web/command-run-dialog.dom.test.tsx、tests/unit/server/command-routes.test.ts、tests/unit/server/snippet-service.test.ts（新增）

**Interfaces:**
~~~tsx
export interface SnippetManagerProps {
  snippets: readonly SnippetMetadata[];
  onCreate(input: SnippetInput): Promise<void>;
  onUpdate(id: string, input: SnippetPatchInput): Promise<void>;
  onDelete(id: string): Promise<void>;
}

export interface SnippetPaletteProps {
  snippets: readonly SnippetMetadata[];
  onSelect(id: string): Promise<void>;
  onClose: () => void;
}
~~~

- [ ] **Step 1: 写 Snippet CRUD 和 palette 测试**

在 tests/unit/web/snippet-manager.dom.test.tsx 中覆盖创建、编辑、删除、标签搜索、变量展示、确认删除、关闭清理输入内容和无权限错误。

在 tests/unit/web/command-run-dialog.dom.test.tsx 中覆盖选择 Snippet 后命令、变量和目标预览同步。

- [ ] **Step 2: 运行测试确认当前 UI 缺口**

~~~bash
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
npm test -- tests/unit/web/snippet-manager.dom.test.tsx tests/unit/web/command-run-dialog.dom.test.tsx --reporter=dot
~~~

Expected: 新 manager/palette 测试在组件不存在时失败；现有 picker 测试继续通过。

- [ ] **Step 3: 实现 SnippetManager 和 Editor**

Editor 通过 `runtime.snippets` 支持 name、description、tags、command 和显式变量列表。保存前调用现有 snippetSchema；重复名称、空命令和无效变量名显示字段级错误。删除使用 Task 1 的 Dialog。

- [ ] **Step 4: 实现 palette 并接入终端快捷键**

TerminalWorkspace 顶栏增加 Snippet 入口；Ctrl/Cmd+Shift+P 打开 palette。按名称、description 和 tags 过滤，选择后把完整 Snippet 读取到 CommandRunDialog，不直接把命令写入终端，也不绕过批量确认。

- [ ] **Step 5: 保持内容生命周期和安全边界**

Snippet 内容只保存在 React 内存和服务端加密载荷中；App lock、Dialog close 和提交完成后清理当前编辑器内容。不要新增 localStorage/sessionStorage 缓存，不实现未经过 Shell 适配的语法自动补全。

- [ ] **Step 6: 运行 API、DOM 和 lint 回归**

~~~bash
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
npm test -- tests/unit/web/snippet-manager.dom.test.tsx tests/unit/web/command-run-dialog.dom.test.tsx tests/unit/server/snippet-service.test.ts tests/integration/server/command-routes.test.ts --reporter=dot
npm run typecheck
npm run lint
~~~

- [ ] **Step 7: 提交 Snippet slice**

~~~bash
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
git diff --check
git add -p src/web/components/SnippetManager.tsx src/web/components/SnippetEditor.tsx src/web/components/SnippetPalette.tsx src/web/api.ts src/web/platform/web-adapters.ts src/web/App.tsx src/web/components/CommandRunDialog.tsx src/web/components/SnippetPicker.tsx src/web/components/TerminalWorkspace.tsx src/web/styles.css tests/unit/web/snippet-manager.dom.test.tsx tests/unit/web/command-run-dialog.dom.test.tsx
git commit -m "feat: add snippet management and palette"
~~~

---

## Task 7: Workspace 模板和最多四 pane 的布局

**目标：** 使用已有 Workspace template API，补齐用户可见的命名任务上下文，并将当前两 pane 布局扩展到最多四个可见 pane。

**依赖：** 消费 Task 1A 的 `WorkspaceStore` 和 `CoreRuntime`。WorkspaceSwitcher 只调用 shared store；Web adapter 负责把现有 HTTP template response 映射为 shared `WorkspaceTemplate`。

**Files:**
- Create: src/web/components/WorkspaceSwitcher.tsx、src/web/components/WorkspaceTemplateDialog.tsx、tests/unit/web/workspace-switcher.dom.test.tsx
- Modify: src/shared/core/models.ts、src/shared/validation.ts、src/shared/core/capabilities.ts、src/web/api.ts、src/web/platform/web-adapters.ts、src/web/App.tsx、src/web/state/app-state.ts、src/web/state/workspace-state.ts、src/web/components/TerminalWorkspace.tsx、src/web/styles.css
- Verify: src/server/api/workspace-routes.ts、src/server/workspace/workspace-service.ts、tests/unit/server/workspace-service.test.ts、tests/integration/server/workspace-routes.test.ts、tests/unit/web/terminal-workspace.dom.test.tsx

**Interfaces:**
~~~ts
export interface WorkspaceTemplateSummary {
  id: string;
  name: string;
  state: WorkspaceState;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceLayout {
  mode: 'single' | 'vertical' | 'horizontal' | 'grid';
  ratio: number;
  paneTabIds?: readonly string[];
}
~~~

`WorkspaceTemplateSummary` 只作为 Web 列表的 view model；实际 Web adapter 必须实现 Task 1A 的 shared `WorkspaceStore`：

~~~ts
listTemplates(): Promise<readonly WorkspaceTemplate[]>;
createTemplate(input: WorkspaceTemplateInput): Promise<WorkspaceTemplate>;
deleteTemplate(id: string): Promise<void>;
~~~

- [ ] **Step 1: 写旧快照迁移和模板行为测试**

在 tests/unit/web/workspace-switcher.dom.test.tsx 和 tests/unit/web/terminal-workspace.dom.test.tsx 中覆盖：

~~~tsx
it('loads templates without exposing live terminal ids');
it('saves and deletes a named workspace template');
it('asks for confirmation before closing live tabs absent from a template');
it('derives two panes from a legacy layout without paneTabIds');
it('renders and switches up to four visible panes');
~~~

- [ ] **Step 2: 更新 shared schema 并运行失败测试**

在 workspaceStateSchema 中允许 grid 和可选 paneTabIds，限制 paneTabIds 不超过 4 且每个 ID 必须属于 tabs。旧 single/vertical/horizontal JSON 必须通过 parseWorkspaceState。

Run:
~~~bash
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
npm test -- tests/unit/web/workspace-switcher.dom.test.tsx tests/unit/web/terminal-workspace.dom.test.tsx tests/unit/server/workspace-service.test.ts --reporter=dot
~~~

- [ ] **Step 3: 接入已有 template API 和 WorkspaceStore**

在 src/web/api.ts 和 Web `WorkspaceStore` adapter 中增加 list/create/delete template 方法。App 启动时只加载 metadata 和非敏感 state；创建模板前移除任何 terminalId、sessionId、credential、output 等字段，服务端再次调用 workspaceStateSchema。不要同时保留一套只供 Web 使用的 Workspace template 业务接口。

- [ ] **Step 4: 实现 WorkspaceSwitcher 和打开确认**

保存当前 tabs、activeTabId、layout 和 filters。打开模板时，如果当前有不在模板中的 live tabs，Dialog 展示将关闭的 Host 列表；用户确认后才关闭并创建 template tabs。模板重复打开不复制同一 template tab，除非用户使用 New terminal 显式创建第二个会话。

- [ ] **Step 5: 将 TerminalWorkspace 扩展到 grid 四 pane**

保持旧 mode 和 ratio 兼容；grid 使用 paneTabIds，最多显示 4 个 TerminalPanel。每个 pane 都有明确 aria-label、活动同步和最小高度；布局调整后保存 ratio/paneTabIds，不保存 live terminalId。

- [ ] **Step 6: 运行模板、布局和 E2E 回归**

~~~bash
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
npm test -- tests/unit/web/workspace-switcher.dom.test.tsx tests/unit/web/terminal-workspace.dom.test.tsx tests/unit/web/app-state.test.ts tests/unit/server/workspace-service.test.ts tests/integration/server/workspace-routes.test.ts --reporter=dot
npm run typecheck
npm run lint
~~~

E2E 覆盖保存模板、刷新后读取模板、打开模板的关闭确认、四 pane 和 320px 下的最小布局。

- [ ] **Step 7: 提交 Workspace slice**

~~~bash
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
git diff --check
git add -p src/web/components/WorkspaceSwitcher.tsx src/web/components/WorkspaceTemplateDialog.tsx src/shared/core/models.ts src/shared/validation.ts src/shared/core/capabilities.ts src/web/api.ts src/web/platform/web-adapters.ts src/web/App.tsx src/web/state/app-state.ts src/web/state/workspace-state.ts src/web/components/TerminalWorkspace.tsx src/web/styles.css tests/unit/web/workspace-switcher.dom.test.tsx tests/unit/web/terminal-workspace.dom.test.tsx tests/unit/web/app-state.test.ts
git commit -m "feat: add named workspaces and four pane layout"
~~~

---

## Task 8: 会话生命周期、重启边界和任务中断恢复

**目标：** 让断线、路由切换、服务重启和任务失联都有真实、可解释、可恢复的终态。

**依赖：** 消费 Task 1A 定义的 versioned protocol、shared lifecycle state 和 transport contract；未来桌面/Android 的后台挂起、网络切换和进程回收必须映射到同一终态，不能另造“看起来已连接”的平台状态。

**Files:**
- Modify: src/shared/core/models.ts、src/shared/core/state-machines.ts、src/shared/protocol.ts、src/shared/errors.ts
- Modify: src/web/App.tsx、src/web/state/app-state.ts、src/web/hooks/use-terminal-session.ts、src/web/components/TerminalWorkspace.tsx、src/web/components/TerminalToolbar.tsx、src/web/components/TransferQueue.tsx
- Modify: src/server/ssh/session-manager.ts、src/server/ws/terminal-gateway.ts、src/server/automation/command-run-store.ts、src/server/sftp/transfer-manager.ts、src/server/db/migrations.ts、src/server/db/types.ts、src/server/db/repositories.ts、src/server/api/command-routes.ts、src/server/api/sftp-routes.ts、src/server/app.ts、src/server/index.ts
- Create: tests/unit/server/transfer-restart.test.ts
- Test: tests/unit/web/terminal-session.test.ts、tests/unit/web/terminal-workspace.dom.test.tsx、tests/unit/server/session-manager.test.ts、tests/unit/server/command-run-store.test.ts、tests/unit/server/transfer-manager.test.ts、tests/integration/server/restart-boundaries.test.ts、tests/e2e/ssh-productivity.spec.ts

**Interfaces:**
~~~ts
export type TerminalStatus =
  | 'connecting'
  | 'awaiting-host-key'
  | 'awaiting-credential'
  | 'connected'
  | 'reconnecting'
  | 'closed'
  | 'failed'
  | 'needs-reopen';

export type TransferStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted';
~~~

Restart reconciliation：

~~~ts
export interface RestartReconciliation {
  failedCommandRuns: number;
  interruptedTransfers: number;
}
~~~

- [ ] **Step 1: 写状态机和 session lifecycle 失败测试**

覆盖：

~~~ts
it('reattaches within detach grace and replays bounded output');
it('maps missing server session to needs-reopen instead of connected');
it('keeps permanent authentication and Host Key failures from auto-retrying');
it('marks queued and running command runs as SERVER_RESTARTED');
it('marks queued and running transfers as interrupted and allows retry');
~~~

- [ ] **Step 2: 持久化 transfer jobs 并增加 interrupted 状态**

新增 transfer_jobs 表及 repository，保存 hostId、kind、sourcePath、targetPath、status、completedBytes、totalBytes、errorCode、createdAt 和 updatedAt，不保存文件内容。将 database schema version 提升为 9；migration 保留现有 TransferManager API，服务启动时将 queued/running 标记为 interrupted，错误码固定为 SERVER_RESTARTED。

Transfer 状态机只允许：

~~~text
failed/interrupted -> queued -> running -> completed
queued/running -> cancelled
running -> failed
~~~

- [ ] **Step 3: 调整 CommandRunStore 的 restart reconciliation**

不要在构造时删除 queued/running 数据。增加 repository 方法 markActiveRunsFailed(errorCode, finishedAt)，启动时把这些任务变为 failed/SERVER_RESTARTED，并让 API 返回可重试的终态。已完成任务继续按 TTL 清理。

- [ ] **Step 4: 保持 TerminalWorkspace 挂载并明确 session 状态**

App 在存在 terminal tabs 时保持 TerminalWorkspace 挂载，返回 Server 列表只切换可见性，不销毁 TerminalPanel。WebSocket reconnect 失败或 server 返回 session not found 时进入 needs-reopen；TerminalToolbar 显示“需要重新连接”，按钮创建新 Shell，不宣称恢复旧进程。

- [ ] **Step 5: 增加 operation 终态 UI**

TransferQueue 对 interrupted 显示“服务重启中断，可重试”；CommandRunResults 对 SERVER_RESTARTED 显示“服务重启后任务未继续执行”。收到 404、session not found 或 SERVER_RESTARTED 后停止轮询并显示操作按钮。

- [ ] **Step 6: 运行重启边界和 OpenSSH 回归**

~~~bash
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
npm test -- tests/unit/web/terminal-session.test.ts tests/unit/web/terminal-workspace.dom.test.tsx tests/unit/server/session-manager.test.ts tests/unit/server/command-run-store.test.ts tests/unit/server/transfer-manager.test.ts tests/unit/server/transfer-restart.test.ts tests/integration/server/restart-boundaries.test.ts --reporter=dot
npm run typecheck
npm run lint
~~~

E2E 增加：路由切换后 live terminal 仍可输入；短断线显示 reconnecting；服务重启后 Workspace tabs 恢复但 Shell 显示 needs-reopen；任务列表没有永久 loading。

- [ ] **Step 7: 提交 reliability slice**

~~~bash
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
git diff --check
git add -p src/shared/core/models.ts src/shared/core/state-machines.ts src/shared/protocol.ts src/shared/errors.ts src/web/App.tsx src/web/state/app-state.ts src/web/hooks/use-terminal-session.ts src/web/components/TerminalWorkspace.tsx src/web/components/TerminalToolbar.tsx src/web/components/TransferQueue.tsx src/server/ssh/session-manager.ts src/server/ws/terminal-gateway.ts src/server/automation/command-run-store.ts src/server/sftp/transfer-manager.ts src/server/db/migrations.ts src/server/db/types.ts src/server/db/repositories.ts src/server/api/command-routes.ts src/server/api/sftp-routes.ts src/server/app.ts src/server/index.ts tests/unit/server/transfer-restart.test.ts tests/unit/web/terminal-session.test.ts tests/unit/web/terminal-workspace.dom.test.tsx tests/unit/server/session-manager.test.ts tests/unit/server/command-run-store.test.ts tests/unit/server/transfer-manager.test.ts tests/integration/server/restart-boundaries.test.ts tests/e2e/ssh-productivity.spec.ts
git commit -m "feat: make session and task recovery explicit"
~~~

---

## Task 9: 端到端回归、文档和发布门槛

**目标：** 证明四个体验维度和导入/导出基线一起满足发布条件。

**Files:**
- Create or modify: tests/e2e/termius-experience.spec.ts
- Modify: tests/e2e/ssh-productivity.spec.ts、README.md、docs/product/2026-09-15-ssh-productivity-release.md、docs/architecture/cross-platform.md、docs/ux/2026-09-15-ux-audit.md
- Verify: all existing unit/integration/e2e tests and build artifacts

**Interfaces:**
- 不新增业务接口；本任务只固化已经完成的 capability、用户文案、恢复语义和发布说明。
- README 必须明确 single-user/local-first、Identity、Workspace template、SFTP、批量目标和服务重启边界。

- [ ] **Step 1: 写四条关键用户旅程 E2E**

在 tests/e2e/termius-experience.spec.ts 增加以下 Playwright 场景：

~~~ts
test('reuses one identity across two hosts and keeps credentials out of browser storage', async ({ page }) => {});
test('runs a batch command from the host list without opening terminals', async ({ page }) => {});
test('saves, opens, and deletes a named workspace with four panes', async ({ page }) => {});
test('completes SFTP navigation, mkdir, rename, upload, download, and retry', async ({ page }) => {});
~~~

每条测试都通过 DOM、API 状态和 fixture 结果验证，不读取真实密码写入日志或快照。

- [ ] **Step 2: 增加安全和恢复断言**

E2E 明确检查：

~~~ts
expect(await page.evaluate(() => Object.keys(localStorage))).not.toContain('relay.credentials');
expect(await page.evaluate(() => Object.keys(sessionStorage))).not.toContain('relay.vault');
await expect(page.getByText('需要重新连接')).toBeVisible();
await expect(page.locator('.transfer-item')).not.toContainText('loading');
~~~

同时检查 Host Key 变更、锁定后清理、导入预览不显示源密码和服务重启后的 interrupted 终态。

- [ ] **Step 3: 更新用户和架构文档**

README 写明：

- Host 可以使用 inline credential 或共享 Identity。
- Workspace template 只保存 Host/Tab/layout/filter，不保存 live session、凭据、输出。
- 批量任务从 Host/Group 选择固定目标快照。
- WebSocket 短断可在 detach grace 内复接；服务重启后 Shell 不保证恢复。
- SFTP 上传、取消、重试和目录操作的限制。

架构文档同步 shared core、CoreRuntime、server/Web adapter、Identity secret store、platform-neutral file/import/export、capability 和 operation restart boundary；明确桌面/Android 只替换 adapter，不复制业务规则，也不把云同步作为核心依赖。

- [ ] **Step 4: 执行最终验证命令**

~~~bash
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
npm test -- --reporter=dot
npm run typecheck
npm run lint
npm run build
npm run test:e2e
git diff --check
git status --short
rg -n -e "node:" -e "from ['\"]react" -e "from ['\"]react-dom" -e "WebSocket" -e "ssh2" -e "localStorage" -e "sessionStorage" src/shared || true
~~~

Expected: 单元/集成测试、TypeScript、lint、Web/Server build 和 Playwright 全部通过；没有未解释的失败或永久 loading，且 shared core 静态依赖检查无命中。

- [ ] **Step 5: 做发布前人工走查**

使用 320px 宽度、短视口和高对比度主题分别检查：

- Host 名称、Tag、Identity、Group tree 不溢出。
- 关键操作文字未被无提示地隐藏。
- Dialog 首焦点、Tab、Escape、遮罩和关闭后焦点正确。
- SFTP path、批量目标、Host Key 指纹和重启状态可理解。
- 导入/导出和 Identity 编辑关闭后没有残留输入内容。

- [ ] **Step 6: 记录发布结果并提交文档**

~~~bash
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
git diff --name-only
git add -p tests/e2e/termius-experience.spec.ts tests/e2e/ssh-productivity.spec.ts README.md docs/product/2026-09-15-ssh-productivity-release.md docs/architecture/cross-platform.md docs/ux/2026-09-15-ux-audit.md
git commit -m "docs: close Termius experience gap release plan"
~~~

只提交本任务文档和 E2E 文件；用户尚未完成的导入/导出实现必须保持在其原有 diff 中。

---

## 3. 发布验收矩阵

| 体验维度 | 必须证明的行为 | 主要证据 |
| --- | --- | --- |
| 功能性 | Identity 复用、Group 继承、主机列表批量、SFTP mkdir/rename、多 pane、Snippet CRUD | shared tests、server integration、DOM tests |
| 易用性 | Recent/Tag/Group 导航、目标选择预览、Workspace template、统一错误和重试入口 | DOM tests、关键旅程 E2E、人工走查 |
| UI 体验 | Dialog 焦点、移动端关键入口、路径和目标上下文、pane 最小高度 | dialog DOM tests、320px E2E、CSS review |
| 可靠性 | Host Key 安全、短断线 reattach、needs-reopen、SERVER_RESTARTED/interrupted 终态、无永久 loading | session/transfer/restart tests、OpenSSH integration、E2E |
| 跨端扩展 | shared CoreRuntime、VaultSession/ConnectionProbe、Web adapter contract、platform-neutral file/import/export、无平台依赖 | core boundary test、fake/Web adapter contract、双 TypeScript target |

## 4. 明确保留的后续决策

本计划完成后，以下能力仍只保留 capability 和 adapter 扩展点，不因为 Termius benchmark 而自动启动：

- 端口转发、SOCKS/HTTP Proxy、Agent Forwarding。
- Mosh、Telnet、Serial、RDP、VNC、X11。
- AI 命令生成、Shell History 和真正的远端 Shell autocomplete。
- 云端同步、团队 Vault、RBAC、SSO、实时协作。
- Windows/Linux/Android 原生 UI。

它们必须在另一个独立 spec 中分别定义安全模型、数据归属、权限、平台 transport 和验收标准。原生客户端的实现前提是 Task 1A 的 shared contract 已通过；不能先做一套平台专属业务，再反向拼装 shared core。
