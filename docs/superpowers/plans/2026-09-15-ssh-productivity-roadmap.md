# SSH Productivity Roadmap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将当前 Web SSH MVP 演进为一个 local-first、Web 优先、可扩展到桌面和 Windows/Android/Linux 的可信 SSH 工作台，按优先级交付工作区恢复、连接可靠性、SFTP、安全批量执行和审计能力。

**Architecture:** 保持当前 TypeScript + React/Vite + Fastify + SQLite + Vault + ssh2 架构。把平台无关的领域模型、状态机、schema、错误码和 capability contract 放入 shared core；Web 通过 HTTP/WSS adapter 首先实现，未来桌面和 Android 通过各自的 SecretStore、SessionTransport、FileTransport 和 CommandTransport 接入，不让 shared core 依赖 Node、DOM、React 或 ssh2。

**Tech Stack:** Node.js 22+, TypeScript, React 19, Vite, Fastify, WebSocket, SQLite/better-sqlite3, Argon2id, AES-256-GCM, ssh2, xterm.js, Vitest, React Testing Library, Playwright, Docker Compose, OpenSSH fixture, @fastify/multipart.

**Spec:** `docs/superpowers/specs/2026-09-15-ssh-productivity-roadmap-design.md`

> Implementation and verification are complete in the current worktree. Commit steps remain unchecked because this workspace protocol leaves commits to the caller.

## Global Constraints

> Workspace snapshot: at plan creation, user-owned changes were present in `README.md`, `docker-compose.yml`, `src/server/config.ts`, `src/web/components/TerminalPanel.tsx`, `src/web/terminal-output.ts`, `tests/unit/server/config.test.ts` and `tests/unit/web/terminal-panel.dom.test.tsx`. Review and split those changes before staging any overlapping task files.

- Web 是本阶段唯一的一等客户端；不创建桌面或 Android UI，但必须提供可供未来客户端实现的 shared core 和 adapter contracts。
- shared core 只能使用平台无关的 TypeScript 类型和纯函数；不得导入 Node、浏览器、React、DOM、Android API 或 ssh2。
- 保持单实例、单 Vault、单用户部署模型；owner_id 边界必须保留，不能把默认 owner 逻辑散落进业务模块。
- 密码、私钥、passphrase、session cookie、token 和完整交互式终端内容不得进入浏览器持久化存储或普通日志。
- SSH host key 首次连接必须确认；已知指纹变化必须硬失败；跳板链路每一跳都执行同一 Host Key policy。
- P0 只持久化非敏感工作区意图；terminalId 只用于进程内 live reattach，应用重启后恢复 tab 意图但创建新 shell。
- ProxyJump 最多 4 跳；跳转图不得有环；SFTP 路径必须防止 NUL、控制字符和规范化后的目录越界。
- 批量执行默认并发 4、最大 16，单主机默认超时 60 秒，单主机输出默认上限 256 KiB；所有多主机任务需要显式确认。
- SFTP 上传必须先写临时远程文件，完成后原子重命名；取消或失败不能把半文件当成目标文件。
- 不实现浏览器本地 shell、RDP/VNC/X11/Telnet/串口、云账号、第三方同步、团队 RBAC 或 SSO。
- 每个新行为先写失败测试，再写最小实现；每个任务完成后运行聚焦测试和相关全量测试。
- 当前工作区已有用户改动；实现时只 stage 本任务明确列出的文件，不使用 reset、checkout 或覆盖用户改动。
- 提交前先运行 `git diff --name-only`；下面的提交命令只作为文件边界示例，若共享文件包含其他任务或用户改动，使用 `git add -p`，不得用目录级通配把无关文件一并加入。

---

## 1. 实施顺序和可独立交付边界

按以下顺序执行，每个 slice 都能单独验证：

1. **Task 1：shared core contract** —— 统一跨端模型、能力和状态机，不改变现有用户流程。
2. **Task 2：工作区持久化和 Vault bundle** —— 解决配置/工作状态不可靠和不可迁移。
3. **Task 3：连接资源、诊断、重连和 ProxyJump** —— 解决连接阻断和服务端资源复用。
4. **Task 4：SFTP 文件闭环** —— 在同一主机上下文中完成目录和文件操作。
5. **Task 5：Snippets 和安全多主机执行** —— 把重复输入变成可确认、可追踪的任务。
6. **Task 6：活动日志和批量结果审计** —— 提供复盘能力，不默认录制交互式 shell。
7. **Task 7：Web adapter 收口、跨端契约测试和 E2E** —— 证明核心没有被 Web 实现绑死。
8. **Task 8：文档、迁移和发布验证** —— 更新部署/安全说明，跑全套检查。

Task 2–6 是独立子系统，实施时可以分别创建 feature branch；不要把它们合并成一次“大重构”。

## 2. 文件地图

### Shared core

- Create: `src/shared/core/models.ts` — 非敏感领域模型和状态类型。
- Create: `src/shared/core/ports.ts` — HostStore、SecretStore、SessionTransport、FileTransport、CommandTransport。
- Create: `src/shared/core/capabilities.ts` — 能力名称、能力集合和能力查询。
- Create: `src/shared/core/state-machines.ts` — connection、transfer、command-run 的纯状态转换。
- Modify: `src/shared/validation.ts` — connection profile、workspace、SFTP、Snippet 和 batch request schema。
- Modify: `src/shared/protocol.ts` — diagnostic、operation、transfer 和 command-run 事件。
- Modify: `src/shared/errors.ts` — 稳定错误码和用户可理解文案。

### Server

- Modify: `src/server/db/migrations.ts`, `src/server/db/types.ts`, `src/server/db/repositories.ts` — 新增工作区、模板、Snippet、任务和审计存储。
- Create: `src/server/workspace/workspace-repository.ts`, `workspace-service.ts`, `vault-bundle-service.ts`。
- Create: `src/server/api/workspace-routes.ts`, `vault-routes.ts`。
- Modify: `src/server/ssh/types.ts`, `ssh2-adapter.ts`, `session-manager.ts`。
- Create: `src/server/ssh/connection-path.ts`, `forwarding-manager.ts`。
- Create: `src/server/sftp/types.ts`, `sftp-adapter.ts`, `sftp-service.ts`, `transfer-manager.ts`。
- Create: `src/server/automation/snippet-service.ts`, `command-runner.ts`, `command-run-store.ts`。
- Create: `src/server/audit/audit-service.ts`。
- Create: `src/server/ws/operation-gateway.ts`。
- Create: `src/server/api/sftp-routes.ts`, `command-routes.ts`, `audit-routes.ts`。
- Modify: `src/server/app.ts`, `src/server/api/host-routes.ts`, `src/server/ws/terminal-gateway.ts`。

### Web

- Create: `src/web/platform/web-adapters.ts`, `src/web/state/workspace-state.ts`。
- Create: `src/web/components/WorkspaceSettings.tsx`, `SftpPanel.tsx`, `TransferQueue.tsx`, `SnippetPicker.tsx`, `CommandRunDialog.tsx`, `CommandRunResults.tsx`, `ActivityPanel.tsx`。
- Modify: `src/web/api.ts`, `src/web/App.tsx`, `src/web/state/app-state.ts`, `src/web/components/HostForm.tsx`, `TerminalWorkspace.tsx`, `TerminalPanel.tsx`, `styles.css`。

### Tests and fixtures

- Create: `tests/unit/shared/core-models.test.ts`, `core-state-machines.test.ts`。
- Create: `tests/unit/server/workspace-service.test.ts`, `vault-bundle.test.ts`, `connection-path.test.ts`, `sftp-service.test.ts`, `transfer-manager.test.ts`, `command-runner.test.ts`, `audit-service.test.ts`。
- Create: `tests/integration/server/workspace-routes.test.ts`, `sftp-routes.test.ts`, `command-routes.test.ts`, `audit-routes.test.ts`。
- Modify: existing SSH, terminal gateway, repository, validation and DOM tests as interfaces change.
- Create or modify: `tests/fixtures/openssh/` only when a real SFTP or multi-hop behavior cannot be covered by an injected fake.

## Task 1: Establish the platform-neutral shared core

**Files:**

- Create: `src/shared/core/models.ts`
- Create: `src/shared/core/ports.ts`
- Create: `src/shared/core/capabilities.ts`
- Create: `src/shared/core/state-machines.ts`
- Modify: `src/shared/validation.ts`
- Modify: `src/shared/protocol.ts`
- Modify: `src/shared/errors.ts`
- Test: `tests/unit/shared/core-models.test.ts`
- Test: `tests/unit/shared/core-state-machines.test.ts`
- Test: `tests/unit/shared/validation.test.ts`
- Test: `tests/unit/shared/protocol.test.ts`

**Interfaces:**

- Produces `ConnectionProfile`, `WorkspaceState`, `SftpEntry`, `TransferJob`, `SnippetMetadata`, `CommandRunRequest`, `CommandTargetResult`, `Capability` and `CapabilitySet`.
- Produces `HostStore`, `SecretStore`, `SessionTransport`, `FileTransport` and `CommandTransport` interfaces that contain no Node or browser types.
- Produces pure `transitionConnection`, `transitionTransfer` and `transitionCommandTarget` functions.

- [x] **Step 1: Write failing model and state-machine tests.**

  Cover valid/invalid connection profiles, maximum four jumps, cyclic jump rejection, workspace ratio clamping to 0.2–0.8, transfer transitions for queued/running/completed/failed/cancelled, and command target transitions that cannot move from completed back to running.

- [x] **Step 2: Run the focused tests and verify failure.**

  Run:

  ~~~bash
  export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
  npm test -- tests/unit/shared/core-models.test.ts tests/unit/shared/core-state-machines.test.ts
  ~~~

  Expected: failure because the new modules and functions do not exist.

- [x] **Step 3: Add platform-neutral types and ports.**

  Use interfaces shaped like:

  ~~~ts
  export interface SessionTransport {
    openShell(request: OpenShellRequest): Promise<SessionHandle>;
    reconnect(sessionId: string): Promise<SessionHandle>;
    close(sessionId: string): Promise<void>;
  }

  export interface FileTransport {
    list(hostId: string, path: string): Promise<readonly SftpEntry[]>;
    createTransfer(request: TransferRequest): Promise<TransferJob>;
    cancelTransfer(transferId: string): Promise<void>;
  }

  export interface CapabilitySet {
    client: 'web' | 'desktop' | 'android';
    supports(capability: Capability): boolean;
  }
  ~~~

  Keep `Buffer`, `Readable`, `Writable`, `WebSocket`, `File`, `Response` and `HTMLElement` out of these types.

- [x] **Step 4: Add schemas, operation events and errors.**

  Add strict schemas for `ConnectionProfile`, `WorkspaceState`, transfer requests, Snippets, command runs and operation events. Add stable codes for `WORKSPACE_VERSION_CONFLICT`, `VAULT_BUNDLE_INVALID`, `SFTP_PATH_INVALID`, `SFTP_TRANSFER_FAILED`, `COMMAND_RUN_NOT_FOUND`, `COMMAND_RUN_CANCELLED`, `CONNECTION_STAGE_FAILED` and `CAPABILITY_UNAVAILABLE`.

- [x] **Step 5: Implement pure state transitions and run tests.**

  Run:

  ~~~bash
  export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
  npm test -- tests/unit/shared/core-models.test.ts tests/unit/shared/core-state-machines.test.ts tests/unit/shared/validation.test.ts tests/unit/shared/protocol.test.ts
  npm run typecheck
  ~~~

- [ ] **Step 6: Commit only the shared-core files.**

  ~~~bash
  git add src/shared/core/models.ts src/shared/core/ports.ts src/shared/core/capabilities.ts src/shared/core/state-machines.ts src/shared/validation.ts src/shared/protocol.ts src/shared/errors.ts tests/unit/shared/core-models.test.ts tests/unit/shared/core-state-machines.test.ts tests/unit/shared/validation.test.ts tests/unit/shared/protocol.test.ts
  git commit -m "feat: define cross-platform ssh core contracts"
  ~~~

## Task 2: Persist the workspace and implement encrypted Vault bundles

**Files:**

- Modify: `src/server/db/migrations.ts`
- Modify: `src/server/db/types.ts`
- Modify: `src/server/db/repositories.ts`
- Create: `src/server/workspace/workspace-repository.ts`
- Create: `src/server/workspace/workspace-service.ts`
- Create: `src/server/workspace/vault-bundle-service.ts`
- Create: `src/server/api/workspace-routes.ts`
- Create: `src/server/api/vault-routes.ts`
- Modify: `src/server/app.ts`
- Modify: `src/web/api.ts`
- Create: `src/web/platform/web-adapters.ts`
- Create: `src/web/state/workspace-state.ts`
- Create: `src/web/components/WorkspaceSettings.tsx`
- Modify: `src/web/App.tsx`
- Modify: `src/web/state/app-state.ts`
- Modify: `src/web/components/TerminalWorkspace.tsx`
- Test: `tests/unit/server/workspace-service.test.ts`
- Test: `tests/unit/server/vault-bundle.test.ts`
- Test: `tests/unit/server/repositories.test.ts`
- Test: `tests/integration/server/workspace-routes.test.ts`
- Test: `tests/unit/web/app-state.test.ts`
- Test: `tests/unit/web/terminal-workspace.dom.test.tsx`

**Interfaces:**

- `WorkspaceRepository.get(ownerId): WorkspaceSnapshot | null`
- `WorkspaceRepository.put(ownerId, expectedVersion, state): WorkspaceSnapshot`
- `WorkspaceService.load(ownerId): WorkspaceState`
- `WorkspaceService.save(ownerId, expectedVersion, state): WorkspaceSnapshot`
- `VaultBundleService.export(sessionKey, exportPassword): Promise<string>`
- `VaultBundleService.previewImport(sessionKey, exportPassword, bundle): ImportPreview`
- `VaultBundleService.applyImport(sessionKey, previewId, resolution): ImportResult`

- [x] **Step 1: Write failing repository and service tests.**

  Test a missing workspace returns the default state; PUT increments the version; stale versions throw `WORKSPACE_VERSION_CONFLICT`; invalid tab host IDs and invalid split ratios are rejected; workspace JSON never contains credentials or terminal session tokens.

  Test Vault bundle export/import with a wrong export password, tampered ciphertext, unsupported version, conflicting host IDs, merge success, and import failure leaving all existing rows unchanged.

- [x] **Step 2: Run focused tests and verify failure.**

  ~~~bash
  export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
  npm test -- tests/unit/server/workspace-service.test.ts tests/unit/server/vault-bundle.test.ts
  ~~~

- [x] **Step 3: Add SQLite workspace tables and repositories.**

  Add `workspace_snapshots(owner_id, version, state_json, created_at, updated_at)` with one row per owner and `workspace_templates(owner_id, id, name, state_json, created_at, updated_at)`. Add indexes by owner and updated time. Use a transaction for PUT and `WHERE owner_id = @ownerId AND version = @expectedVersion` for optimistic concurrency.

  Do not store terminalId in the durable workspace. Keep the current sessionStorage descriptors only for live reattach after a browser refresh.

- [x] **Step 4: Implement the Vault bundle format.**

  Serialize a versioned `webssh-vault` envelope. Derive an export KEK with the existing Argon2id parameters, wrap the existing Vault key with AES-256-GCM, and encrypt the host credential payload with AAD containing the bundle version and host id. Keep plaintext only in ephemeral buffers and wipe temporary key buffers in finally blocks where practical.

  The preview must return counts and conflict names only. Store a one-time preview id in an in-memory TTL map for 10 minutes; applying a preview consumes it.

- [x] **Step 5: Add routes and Web adapter methods.**

  Implement:

  ~~~text
  GET  /api/workspace
  PUT  /api/workspace
  GET  /api/workspace/templates
  POST /api/workspace/templates
  POST /api/vault/export
  POST /api/vault/import/preview
  POST /api/vault/import/apply
  ~~~

  Require an unlocked session on every route. Return 409 for workspace version conflicts and import conflicts. Export/import must create audit events without recording the export password.

- [x] **Step 6: Hydrate the Web app without coupling core to Web APIs.**

  Load the durable workspace after hosts/groups are loaded. Map durable tab ids to fresh terminal ids, then use existing sessionStorage terminal descriptors only when the server can reattach the live session. Save changes with a 500 ms debounce and ignore stale saves after lock.

  Add Workspace Settings actions for “导出加密数据”, “导入加密数据”, “预览变更” and “确认导入”. Never place the bundle or export password in localStorage/sessionStorage.

- [x] **Step 7: Run focused integration and full checks.**

  ~~~bash
  export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
  npm test -- tests/unit/server/workspace-service.test.ts tests/unit/server/vault-bundle.test.ts tests/integration/server/workspace-routes.test.ts
  npm run lint
  npm run typecheck
  ~~~

- [ ] **Step 8: Commit the workspace slice.**

  ~~~bash
  git add src/server/db/migrations.ts src/server/db/types.ts src/server/db/repositories.ts src/server/workspace/workspace-repository.ts src/server/workspace/workspace-service.ts src/server/workspace/vault-bundle-service.ts src/server/api/workspace-routes.ts src/server/api/vault-routes.ts src/server/app.ts src/web/api.ts src/web/platform/web-adapters.ts src/web/state/workspace-state.ts src/web/components/WorkspaceSettings.tsx src/web/App.tsx src/web/state/app-state.ts src/web/components/TerminalWorkspace.tsx tests/unit/server/workspace-service.test.ts tests/unit/server/vault-bundle.test.ts tests/unit/server/repositories.test.ts tests/integration/server/workspace-routes.test.ts tests/unit/web/app-state.test.ts tests/unit/web/terminal-workspace.dom.test.tsx
  git commit -m "feat: persist and export ssh workspaces safely"
  ~~~

## Task 3: Refactor SSH resources, diagnostics, reconnect and ProxyJump

**Files:**

- Modify: `src/server/ssh/types.ts`
- Modify: `src/server/ssh/ssh2-adapter.ts`
- Modify: `src/server/ssh/session-manager.ts`
- Create: `src/server/ssh/connection-path.ts`
- Create: `src/server/ssh/forwarding-manager.ts`
- Modify: `src/server/db/migrations.ts`, `db/types.ts`, `db/repositories.ts`
- Modify: `src/shared/validation.ts`, `src/shared/protocol.ts`
- Modify: `src/server/api/host-routes.ts`, `src/server/app.ts`
- Modify: `src/server/ws/terminal-gateway.ts`
- Modify: `src/web/api.ts`, `src/web/hooks/use-terminal-session.ts`, `src/web/components/TerminalPanel.tsx`, `src/web/components/HostForm.tsx`
- Test: `tests/unit/server/connection-path.test.ts`
- Modify: `tests/unit/server/ssh2-adapter.test.ts`, `session-manager.test.ts`
- Modify: `tests/integration/server/terminal-gateway.test.ts`
- Modify: `tests/unit/web/terminal-session.test.ts`, `terminal-panel.dom.test.tsx`

**Interfaces:**

- `SshConnectionResource.openShell(options)`
- `SshConnectionResource.exec(command, options)`
- `SshConnectionResource.openSftp()`
- `SshResourceAdapter.connect(config, callbacks)`
- `ConnectionPathResolver.resolve(targetHostId, ownerId)`
- `SshConnectCallbacks.onDiagnostic(event)`

- [x] **Step 1: Write regression tests for the resource refactor.**

  Adapt the existing fake adapter tests so shell open, resize, close, host-key approval and buffered output retain current behavior. Add tests proving an SFTP or exec consumer receives the same host key callback and connection close lifecycle.

- [x] **Step 2: Write path and diagnostics tests.**

  Test direct path, one-hop path, four-hop path, missing jump host, self-reference, indirect cycle, owner isolation, and diagnostic order: resolve → tcp → jump → host-key → authentication → channel. Test a failed stage returns a stable stage code without exposing credentials.

- [x] **Step 3: Add connection profile persistence and validation.**

  Store non-secret JSON connection profile fields on hosts. Validate jumpHostIds against the owner’s hosts and reject cycles before opening a connection. Extend host DTOs with profile metadata but never return jump credentials.

- [x] **Step 4: Implement the resource abstraction.**

  Change the concrete ssh2 adapter to own a client resource that can open shell, exec and SFTP channels. Keep the current `SshChannel` bridge for PTY. The session manager calls `openShell`; future SFTP and command services call the other methods. Existing injected fakes must implement the new interface rather than reaching into ssh2.

- [x] **Step 5: Implement ProxyJump.**

  Build each jump connection sequentially. Pass the downstream socket into the next ssh2 client, retain every client for the lifetime of the target resource, and close clients in reverse order. Run Host Key policy with the target host id and hop index so the Web UI can explain which hop needs trust.

  Define ForwardingManager only as a tested interface in this slice. Do not expose arbitrary port forwarding until the server-side bind and browser access model is separately approved.

- [x] **Step 6: Extend the terminal protocol and Web status UI.**

  Add diagnostic events and multi-hop host-key fields while preserving current open/resize/input/close messages. Display a compact stage label and a retry action; do not render raw ssh2 error strings containing addresses, usernames or paths unless sanitized.

- [x] **Step 7: Verify direct and path connections.**

  ~~~bash
  export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
  npm test -- tests/unit/server/connection-path.test.ts tests/unit/server/ssh2-adapter.test.ts tests/unit/server/session-manager.test.ts tests/integration/server/terminal-gateway.test.ts
  npm run typecheck
  ~~~

- [ ] **Step 8: Commit the connection slice.**

  ~~~bash
  git add src/server/ssh/types.ts src/server/ssh/ssh2-adapter.ts src/server/ssh/session-manager.ts src/server/ssh/connection-path.ts src/server/ssh/forwarding-manager.ts src/server/db/migrations.ts src/server/db/types.ts src/server/db/repositories.ts src/shared/validation.ts src/shared/protocol.ts src/server/api/host-routes.ts src/server/app.ts src/server/ws/terminal-gateway.ts src/web/api.ts src/web/hooks/use-terminal-session.ts src/web/components/TerminalPanel.tsx src/web/components/HostForm.tsx tests/unit/server/connection-path.test.ts tests/unit/server/ssh2-adapter.test.ts tests/unit/server/session-manager.test.ts tests/integration/server/terminal-gateway.test.ts tests/unit/web/terminal-session.test.ts tests/unit/web/terminal-panel.dom.test.tsx
  git commit -m "feat: add diagnosable ssh resources and jump hosts"
  ~~~

## Task 4: Add SFTP browsing and reliable transfers

**Files:**

- Modify: `package.json`, `package-lock.json`
- Create: `src/server/sftp/types.ts`
- Create: `src/server/sftp/sftp-adapter.ts`
- Create: `src/server/sftp/sftp-service.ts`
- Create: `src/server/sftp/transfer-manager.ts`
- Create: `src/server/api/sftp-routes.ts`
- Create: `src/server/ws/operation-gateway.ts`
- Modify: `src/server/app.ts`
- Modify: `src/shared/validation.ts`, `src/shared/protocol.ts`, `src/shared/errors.ts`
- Modify: `src/web/api.ts`
- Create: `src/web/components/SftpPanel.tsx`, `TransferQueue.tsx`
- Modify: `src/web/components/TerminalWorkspace.tsx`, `src/web/styles.css`
- Test: `tests/unit/server/sftp-service.test.ts`, `transfer-manager.test.ts`
- Test: `tests/integration/server/sftp-routes.test.ts`
- Test: `tests/unit/web/sftp-panel.dom.test.tsx`

**Interfaces:**

- `SftpResource.list/stat/mkdir/rename/remove/rmdir`
- `SftpService.listEntries(hostId, path)`
- `TransferManager.create/consumeUpload/streamDownload/get/cancel`
- `OperationEventBus.publish/subscribe`

- [x] **Step 1: Add the streaming dependency and write path tests.**

  Add `@fastify/multipart`. Before implementing SFTP, test path normalization for root, nested paths, repeated separators, NUL, control characters, absolute path policy, and attempts to escape with .. .

- [x] **Step 2: Write fake SFTP service tests.**

  Test list sorting, file/directory metadata, permission errors, missing path, rename, delete confirmation boundary, and owner/host isolation. Test that service methods never receive plaintext credentials from the browser.

- [x] **Step 3: Write transfer-manager tests.**

  Test upload progress, download progress, cancellation, retry, TTL cleanup, output size limits, failure cleanup of the remote temporary file, and atomic rename only after the stream completes.

- [x] **Step 4: Implement the ssh2 SFTP adapter.**

  Adapt the resource returned by Task 3 to a narrow `SftpResource`. Convert callback-based ssh2 methods into promises, use streams for file content, cap concurrent operations per host, and map errors to `SFTP_NOT_FOUND`, `SFTP_PERMISSION_DENIED`, `SFTP_TRANSFER_FAILED` or `SFTP_CONNECTION_FAILED`.

- [x] **Step 5: Implement transfer routes and operation events.**

  Implement:

  ~~~text
  GET    /api/sftp/:hostId/list
  POST   /api/sftp/:hostId/entries
  POST   /api/sftp/:hostId/transfers
  POST   /api/transfers/:transferId/content
  GET    /api/transfers/:transferId/content
  GET    /api/transfers/:transferId
  DELETE /api/transfers/:transferId
  GET    /ws/operations
  ~~~

  Upload consumes a multipart file stream and writes to a remote temporary path. Download streams the remote file with a safe content-disposition filename. The operation WebSocket authenticates using the same session cookie and only publishes events owned by that session/owner.

- [x] **Step 6: Integrate SFTP into the Web workspace.**

  Add a file panel associated with the active host. Keep terminal and file panel state separate so changing directories does not modify the shell’s current directory. Show loading, permission, empty directory, transfer progress, cancel and retry states. Require confirmation before delete.

- [x] **Step 7: Run OpenSSH integration and browser tests.**

  Extend the fixture with a readable/writable test directory and a known file. Verify a real upload/download round trip, permissions, cancellation cleanup and host-key enforcement.

  ~~~bash
  export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
  npm test -- tests/unit/server/sftp-service.test.ts tests/unit/server/transfer-manager.test.ts tests/integration/server/sftp-routes.test.ts
  npm run test:e2e -- tests/e2e/host-to-terminal.spec.ts
  npm run lint
  npm run typecheck
  ~~~

- [ ] **Step 8: Commit the SFTP slice.**

  ~~~bash
  git add package.json package-lock.json src/server/sftp/types.ts src/server/sftp/sftp-adapter.ts src/server/sftp/sftp-service.ts src/server/sftp/transfer-manager.ts src/server/api/sftp-routes.ts src/server/ws/operation-gateway.ts src/server/app.ts src/shared/validation.ts src/shared/protocol.ts src/shared/errors.ts src/web/api.ts src/web/components/SftpPanel.tsx src/web/components/TransferQueue.tsx src/web/components/TerminalWorkspace.tsx src/web/styles.css tests/unit/server/sftp-service.test.ts tests/unit/server/transfer-manager.test.ts tests/integration/server/sftp-routes.test.ts tests/unit/web/sftp-panel.dom.test.tsx tests/fixtures/openssh/Dockerfile tests/fixtures/openssh/entrypoint.sh
  git commit -m "feat: add integrated sftp transfers"
  ~~~

## Task 5: Add Snippets and safe multi-host command runs

**Files:**

- Modify: `src/server/db/migrations.ts`, `src/server/db/types.ts`, `src/server/db/repositories.ts`
- Create: `src/server/automation/snippet-service.ts`
- Create: `src/server/automation/command-runner.ts`
- Create: `src/server/automation/command-run-store.ts`
- Create: `src/server/api/command-routes.ts`
- Modify: `src/server/app.ts`
- Modify: `src/shared/validation.ts`, `src/shared/protocol.ts`, `src/shared/errors.ts`
- Modify: `src/server/ws/operation-gateway.ts`
- Modify: `src/web/api.ts`
- Create: `src/web/components/SnippetPicker.tsx`, `CommandRunDialog.tsx`, `CommandRunResults.tsx`
- Modify: `src/web/components/TerminalWorkspace.tsx`, `src/web/styles.css`
- Test: `tests/unit/server/command-runner.test.ts`
- Test: `tests/integration/server/command-routes.test.ts`
- Test: `tests/unit/web/command-run-dialog.dom.test.tsx`

**Interfaces:**

- `SnippetService.create/list/update/delete`
- `CommandRunner.start(request): Promise<CommandRun>`
- `CommandRunner.cancel(runId): Promise<void>`
- `CommandRunStore.get/listTargets`

- [x] **Step 1: Write validation and safety tests.**

  Reject empty commands, control characters in variable names, variables above the configured size, duplicate/unknown host ids, concurrency above 16, timeout above 10 minutes, and a run created while the Vault is locked.

  Test that a command containing a destructive-looking token is labeled for confirmation but is not silently “sanitized” or rewritten.

- [x] **Step 2: Write command-runner tests.**

  Use fake connection resources to test target snapshotting, concurrency, per-target status, timeout, output truncation, cancellation before start, cancellation during exec, one target failure not hiding other results, and owner isolation.

- [x] **Step 3: Add encrypted Snippet and run tables.**

  Store Snippet metadata separately from an AES-GCM encrypted payload. Store command run metadata and one row per target; when `persistOutput` is true, encrypt output with AAD containing run id and host id. Do not store expanded variable values in audit rows.

- [x] **Step 4: Implement SnippetService and parameter expansion.**

  Use explicit variables in the form `{{service}}`, `{{container}}` and `{{lines}}`. Parse variable names, require every referenced variable to be supplied, reject unknown variables and control characters, and return the expanded command only to the current request flow.

- [x] **Step 5: Implement CommandRunner.**

  Resolve all target host rows again on the server, create a fixed target snapshot, use the connection resource `exec` method, enforce concurrency/timeout/output caps, publish operation events, and close every resource in a finally block.

- [x] **Step 6: Implement API and Web confirmation flow.**

  Implement:

  ~~~text
  GET    /api/snippets
  POST   /api/snippets
  PATCH  /api/snippets/:id
  DELETE /api/snippets/:id
  POST   /api/command-runs
  GET    /api/command-runs/:id
  DELETE /api/command-runs/:id
  ~~~

  The dialog must show selected host names/addresses, expanded command, concurrency, timeout and output persistence before the final confirm action. The results view must keep output isolated per host.

- [x] **Step 7: Run focused and integration tests.**

  ~~~bash
  export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
  npm test -- tests/unit/server/command-runner.test.ts tests/integration/server/command-routes.test.ts tests/unit/web/command-run-dialog.dom.test.tsx
  npm run typecheck
  ~~~

- [ ] **Step 8: Commit the automation slice.**

  ~~~bash
  git add src/server/db/migrations.ts src/server/db/types.ts src/server/db/repositories.ts src/server/automation/snippet-service.ts src/server/automation/command-runner.ts src/server/automation/command-run-store.ts src/server/api/command-routes.ts src/server/app.ts src/shared/validation.ts src/shared/protocol.ts src/shared/errors.ts src/server/ws/operation-gateway.ts src/web/api.ts src/web/components/SnippetPicker.tsx src/web/components/CommandRunDialog.tsx src/web/components/CommandRunResults.tsx src/web/components/TerminalWorkspace.tsx src/web/styles.css tests/unit/server/command-runner.test.ts tests/integration/server/command-routes.test.ts tests/unit/web/command-run-dialog.dom.test.tsx
  git commit -m "feat: add safe reusable multi-host commands"
  ~~~

## Task 6: Add activity log, batch summaries and controlled audit

**Files:**

- Create: `src/server/audit/audit-service.ts`
- Create: `src/server/api/audit-routes.ts`
- Modify: `src/server/db/migrations.ts`, `src/server/db/types.ts`, `src/server/db/repositories.ts`
- Modify: `src/server/api/host-routes.ts`, `src/server/ws/terminal-gateway.ts`, `src/server/api/workspace-routes.ts`, `src/server/api/sftp-routes.ts`, `src/server/api/command-routes.ts`
- Modify: `src/shared/validation.ts`, `src/shared/errors.ts`
- Modify: `src/web/api.ts`, `src/web/App.tsx`
- Create: `src/web/components/ActivityPanel.tsx`
- Test: `tests/unit/server/audit-service.test.ts`
- Test: `tests/integration/server/audit-routes.test.ts`
- Test: `tests/unit/web/activity-panel.dom.test.tsx`

**Interfaces:**

- `AuditService.record(event)`
- `AuditService.list(filter): PaginatedAuditEvents`
- `AuditService.recordCommandSummary(run)`

- [x] **Step 1: Write audit redaction tests.**

  Assert that event serialization omits passwords, private keys, passphrases, session cookies, tokens, expanded secret variables and raw file content. Test pagination, owner filtering, event type filtering and host filtering.

- [x] **Step 2: Extend the existing audit repository.**

  Keep the current `audit_events` table and add structured event metadata JSON only for non-secret fields: event type, host id, run id, transfer id, target count, success count, failure count, duration and request id. Reject arbitrary caller-provided metadata keys.

- [x] **Step 3: Add audit service and routes.**

  Implement:

  ~~~text
  GET /api/audit?cursor=...&limit=...&eventType=...&hostId=...
  ~~~

  Require an unlocked session. Return newest-first events with stable paging. Keep raw interactive terminal output out of the response.

- [x] **Step 4: Add the Web activity panel.**

  Show connection, workspace, SFTP and batch summaries. Link a batch event to its per-host result when the run is still available. When output TTL has expired, display “结果已过期，需要重新执行” rather than an empty success state.

- [x] **Step 5: Verify logging and audit behavior.**

  ~~~bash
  export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
  npm test -- tests/unit/server/audit-service.test.ts tests/integration/server/audit-routes.test.ts tests/unit/web/activity-panel.dom.test.tsx
  npm run lint
  npm run typecheck
  ~~~

- [ ] **Step 6: Commit the observability slice.**

  ~~~bash
  git add src/server/audit/audit-service.ts src/server/api/audit-routes.ts src/server/db/migrations.ts src/server/db/types.ts src/server/db/repositories.ts src/server/api/host-routes.ts src/server/api/workspace-routes.ts src/server/api/sftp-routes.ts src/server/api/command-routes.ts src/server/ws/terminal-gateway.ts src/shared/validation.ts src/shared/errors.ts src/web/api.ts src/web/App.tsx src/web/components/ActivityPanel.tsx tests/unit/server/audit-service.test.ts tests/integration/server/audit-routes.test.ts tests/unit/web/activity-panel.dom.test.tsx
  git commit -m "feat: add redacted activity and audit summaries"
  ~~~

## Task 7: Make Web the first adapter and prove cross-platform contracts

**Files:**

- Modify: `src/web/platform/web-adapters.ts`
- Modify: `src/web/api.ts`, `src/web/App.tsx`, `src/web/hooks/use-terminal-session.ts`
- Create: `tests/unit/shared/core-adapter-contract.test.ts`
- Create: `tests/unit/web/web-adapters.test.ts`
- Create: `docs/architecture/cross-platform.md`
- Modify: `tsconfig.json`, `tsconfig.server.json` only if needed to compile shared core independently

**Interfaces:**

- Web implementations of `SessionTransport`, `FileTransport`, `CommandTransport`, `HostStore` and `SecretStore` use HTTP/WSS and never expose transport implementation details to React components.
- Contract test exports `assertSessionTransportContract`, `assertFileTransportContract` and `assertCommandTransportContract` using injected fakes.

- [x] **Step 1: Write adapter contract tests.**

  Cover open/reconnect/close, operation event ordering, transfer cancellation and command result isolation. The tests must run in Node without DOM or WebSocket globals by injecting fake transports.

- [x] **Step 2: Move Web-specific API and socket code behind adapters.**

  Keep `fetch`, `WebSocket`, `AbortController`, base URLs and cookie behavior inside `src/web/platform/web-adapters.ts`. React components consume the shared port interfaces and shared models.

- [x] **Step 3: Add capability discovery.**

  Add `GET /api/capabilities` returning versioned capability names. The Web adapter must expose the server set; future desktop and Android adapters can return local capabilities without changing feature code. Unsupported operations produce `CAPABILITY_UNAVAILABLE`.

- [x] **Step 4: Document future clients.**

  Document the invariant that desktop and Android may replace the transport and secret storage implementation, but must preserve shared state semantics, Host Key confirmation, path validation, batch confirmation and redaction rules. Do not choose Tauri, Electron or a mobile UI framework in this task.

- [x] **Step 5: Run both compiler targets and tests.**

  ~~~bash
  export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
  npm test -- tests/unit/shared/core-adapter-contract.test.ts tests/unit/web/web-adapters.test.ts
  npm run typecheck
  npm run lint
  ~~~

- [ ] **Step 6: Commit the adapter boundary.**

  ~~~bash
  git add src/web/platform/web-adapters.ts src/web/api.ts src/web/App.tsx src/web/hooks/use-terminal-session.ts src/shared/core/ports.ts src/shared/core/capabilities.ts tests/unit/shared/core-adapter-contract.test.ts tests/unit/web/web-adapters.test.ts docs/architecture/cross-platform.md tsconfig.json tsconfig.server.json
  git commit -m "refactor: isolate web transport from shared ssh core"
  ~~~

## Task 8: Complete E2E, migration, documentation and release verification

**Files:**

- Modify: `tests/e2e/host-to-terminal.spec.ts`
- Create or modify: `tests/e2e/ssh-productivity.spec.ts`
- Modify: `tests/fixtures/openssh/Dockerfile`, `entrypoint.sh`, fixture keys/config only when required
- Modify: `README.md`
- Modify: `docs/product/2026-09-14-product-requirements.md`
- Create: `docs/product/2026-09-15-ssh-productivity-release.md`

- [x] **Step 1: Add end-to-end recovery coverage.**

  Create a workspace with multiple tabs and a split layout, refresh the browser, verify the layout and host tabs restore, then close the live socket and verify the UI offers a new connection without claiming the remote shell survived.

- [x] **Step 2: Add end-to-end SFTP coverage.**

  Connect to the OpenSSH fixture, browse a directory, upload a fixture file, verify progress and completion, download it, cancel a second transfer, and assert no temporary remote file remains.

- [x] **Step 3: Add end-to-end batch coverage.**

  Select two fixture hosts or two logical targets, confirm the expanded command, verify per-target results, cancel a queued target, and confirm the activity panel shows only redacted metadata.

- [x] **Step 4: Test lock and restart boundaries.**

  Lock the Vault while a new API operation is attempted and expect `SESSION_INVALID`. Restart the server with the same data volume and verify host metadata, workspace and encrypted bundle behavior. Verify active shell sessions are reported as new sessions after process restart.

- [x] **Step 5: Update product and security documentation.**

  Document the new P0/P1 capabilities, encrypted export handling, SFTP path policy, batch safety model, operation TTLs, Web-first status and future desktop/Android/Linux/Windows adapter boundary. Remove only the non-goals that are actually implemented; leave team RBAC, cloud sync, port forwarding, RDP and other protocols explicitly out of scope.

- [x] **Step 6: Run the complete verification suite.**

  ~~~bash
  export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
  npm test
  npm run test:e2e
  npm run lint
  npm run typecheck
  npm run build
  git diff --check
  ~~~

  Expected: all tests, lint, typecheck and build pass; `git diff --check` reports no whitespace errors.

- [ ] **Step 7: Commit only release documentation and test changes.**

  ~~~bash
  git add tests/e2e/host-to-terminal.spec.ts tests/e2e/ssh-productivity.spec.ts tests/e2e/ssh-fixture.ts tests/fixtures/openssh/Dockerfile tests/fixtures/openssh/entrypoint.sh README.md docs/product/2026-09-14-product-requirements.md docs/product/2026-09-15-ssh-productivity-release.md
  git commit -m "docs: publish ssh productivity roadmap boundaries"
  ~~~

## 3. Requirement coverage matrix

| Design requirement | Implemented by |
| --- | --- |
| Cross-platform shared models and ports | Task 1, Task 7 |
| Durable workspace and layout recovery | Task 2, Task 8 |
| Encrypted export/import with preview | Task 2, Task 6 |
| Connection diagnostics and reconnect | Task 3, Task 8 |
| ProxyJump/multi-hop | Task 3 |
| Port-forwarding boundary reserved but not exposed | Task 3 |
| Integrated SFTP and safe transfer lifecycle | Task 4, Task 8 |
| Snippets and parameter expansion | Task 5 |
| Safe multi-host command execution | Task 5, Task 8 |
| Batch output limits and cancellation | Task 5 |
| Redacted activity and audit | Task 6, Task 8 |
| Web-first capability discovery | Task 7 |
| No secret leakage and Host Key invariants | Tasks 1–8 |
| Team/RBAC/cloud sync/native clients deferred | Task 8 documentation |

## 4. Definition of done

The roadmap is complete only when:

- All Tasks 1–8 have their focused tests; commits are intentionally left to the caller in this worktree.
- `npm test`, `npm run test:e2e`, `npm run lint`, `npm run typecheck` and `npm run build` pass from the current worktree.
- A fresh instance can create a Vault, add a host, persist a workspace, export/import an encrypted bundle and recover after restart.
- A real OpenSSH fixture supports shell, SFTP and the defined connection path behavior.
- A multi-host command shows target preview, bounded execution, per-host output and cancellation.
- Audit responses and logs pass redaction tests.
- Shared core compiles without platform-specific imports, and Web is implemented only through adapters.
- README and product requirements describe the actual delivered scope and the remaining non-goals.
