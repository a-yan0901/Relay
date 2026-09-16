# Termius Gap Follow-up Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在保持 Web-first 的前提下，继续缩小 Relay 与 Termius 在任务发现、弱网可靠性、传输恢复、多 pane 协同和跨端能力协商上的差距。

**Architecture:** 先补齐 shared contract、状态语义和能力描述，再由 Web adapter/UI 实现；原生客户端复用 shared core、ports 和 contract tests，但自行实现 UI 与生命周期。协议扩展、团队协作和云同步不直接进入当前核心，而是分别建立 capability、数据归属和安全边界 spec。

**Tech Stack:** TypeScript, React, Vite, Fastify, SQLite/better-sqlite3, xterm.js, ssh2, Vitest, React Testing Library, Playwright, OpenSSH fixture.

**Spec:** `docs/research/2026-09-16-termius-gap-review.md`、`docs/architecture/cross-platform.md`、`docs/superpowers/specs/2026-09-15-termius-experience-gap-closure-design.md`

## Global Constraints

- shared core 不得导入 Node、DOM、React、浏览器存储、WebSocket、HTTP、`ssh2` 或平台 keychain API。
- 所有新增功能遵循 `shared contract → fake contract test → adapter → Web UI` 顺序。
- Web 不保存主密码、Host/Identity secret、导出密码、bundle、token 或完整命令输出。
- Host Key、ProxyJump 每跳校验、SFTP 路径规范化、批量目标快照、任务终态和审计脱敏语义不能由 UI 放宽。
- Workspace 持久化只保存非敏感意图；远端 Shell 是否仍存活必须由 session 状态明确表达。
- 本计划不实现团队 Vault、云同步、RDP/VNC、Telnet、Serial、Mosh 或原生 UI；这些能力先完成独立边界 spec。
- 本轮执行不自动提交或暂存 Git 改动；每个任务以测试和 review checkpoint 结束。

---

## 交付顺序

1. **P0 可靠性底座**：恢复、取消、重启和大文件传输的可信状态。
2. **P1 主机发现和任务上下文**：Recent/Tags、保存筛选、Workspace pane/broadcast。
3. **P1 Identity 语义收口**：明确 Host username 与 Identity username 的优先级。
4. **P2 能力广度设计**：端口转发、Agent Forwarding、Mosh、团队/同步分别立项。
5. **跨端验收与人工走查**：确保新能力仍沿用统一 core，而不是产生 Web 特殊分支。

## Task 1: 建立差距回归矩阵和 P0 可靠性验收

**Files:**

- Modify: `tests/e2e/ssh-productivity.spec.ts`
- Modify: `tests/e2e/host-to-terminal.spec.ts`
- Modify: `tests/integration/server/restart-boundaries.test.ts`
- Modify: `tests/unit/server/transfer-restart.test.ts`
- Modify: `tests/unit/web/app-terminal-lifecycle.dom.test.tsx`
- Modify: `docs/research/2026-09-16-termius-gap-review.md`

**Interfaces:**

- Consumes: `TerminalStatus`, `TransferStatus`, `CommandRun.status`, `WorkspaceState` and existing Playwright OpenSSH fixture.
- Produces: 可重复执行的“刷新、服务重启、取消、失败重试、锁定 Vault”验收矩阵；不新增业务接口。

- [ ] **Step 1: 写失败的可靠性回归测试**

在现有测试中增加以下断言：

```ts
expect(restartedTransfer.status).toBe('interrupted');
expect(restartedCommand.status).toBe('interrupted');
expect(reopenedTerminal.state).toBe('needs-reopen');
expect(savedWorkspace.tabs[0]).not.toHaveProperty('terminalId');
```

Playwright 流程必须覆盖：连接成功后刷新、服务端主动关闭、点击重试、锁定 Vault 后再次打开终端；断言页面出现可理解的状态和操作入口，而不是永久 loading。

- [ ] **Step 2: 运行聚焦测试确认缺口**

Run:

```bash
npm test -- --run tests/integration/server/restart-boundaries.test.ts tests/unit/server/transfer-restart.test.ts tests/unit/web/app-terminal-lifecycle.dom.test.tsx
npm run test:e2e -- tests/e2e/ssh-productivity.spec.ts tests/e2e/host-to-terminal.spec.ts
```

Expected: 新增断言在实现缺失时失败，并定位到具体状态机或 UI 生命周期边界。

- [ ] **Step 3: 修正状态和文案的最小实现**

只修改现有 `src/shared/core/state-machines.ts`、`src/web/hooks/use-terminal-session.ts`、`src/web/App.tsx` 和 `src/web/components/TransferQueue.tsx` 中与测试对应的状态映射；不得用“成功”覆盖 `interrupted` 或 `needs-reopen`。

- [ ] **Step 4: 运行 P0 聚焦验证**

Run:

```bash
npm test -- --run tests/integration/server/restart-boundaries.test.ts tests/unit/server/transfer-restart.test.ts tests/unit/web/app-terminal-lifecycle.dom.test.tsx
npm run typecheck
npm run lint
```

Expected: server restart、transfer restart、terminal lifecycle 和 Web UI 状态测试全部通过。

## Task 2: 将 Web 文件传输从整块 Blob 改为流式边界

**Files:**

- Modify: `src/web/platform/web-adapters.ts`
- Modify: `src/web/api.ts`
- Modify: `src/server/api/sftp-routes.ts`
- Modify: `src/server/sftp/transfer-manager.ts`
- Modify: `tests/unit/web/web-adapters.test.ts`
- Modify: `tests/unit/server/transfer-manager.test.ts`
- Modify: `tests/integration/server/sftp-routes.test.ts`

**Interfaces:**

- Consumes: `BinarySource.stream(): AsyncIterable<Uint8Array>`, `ByteStream`, existing raw upload route and `TransferManager.consumeUpload`。
- Produces: Web adapter 内部的 `ReadableStream<Uint8Array>` 转换；shared port 仍只暴露 `BinarySource`/`ByteStream`，不暴露 `Blob`、`File` 或 `ReadableStream`。

- [ ] **Step 1: 写流式适配失败测试**

让测试源分三次产生数据，并断言 `WebFileTransport.upload()` 将每个 chunk 按顺序交给 Web 请求边界；下载则断言调用方可以逐块消费，而不是只收到一个聚合块。

```ts
const chunks = [new Uint8Array([1]), new Uint8Array([2, 3]), new Uint8Array([4])];
const source = { name: 'large.bin', size: 4, async *stream() { yield* chunks; } };
await files.upload('transfer-1', source);
expect(uploadBodyChunks).toEqual(chunks);
```

- [ ] **Step 2: 固定 Web-only 转换**

在 `src/web/platform/web-adapters.ts` 增加唯一的 `BinarySource → ReadableStream<Uint8Array>` 转换；`src/web/api.ts` 的请求方法接收 Web adapter 专用 body 类型并保留 `Content-Type`、取消信号和超时语义。`src/shared` 不增加浏览器类型。

- [ ] **Step 3: 固定服务端取消和清理**

在 `src/server/api/sftp-routes.ts` 将请求断开映射为 `AbortSignal`；`TransferManager` 在取消、超限、断线和异常时继续删除临时文件，并将最终状态持久化为 `cancelled` 或 `failed`。

- [ ] **Step 4: 运行传输验证**

Run:

```bash
npm test -- --run tests/unit/web/web-adapters.test.ts tests/unit/server/transfer-manager.test.ts tests/integration/server/sftp-routes.test.ts
npm run typecheck
```

Expected: 大文件不再由 Web adapter 先聚合成单个 Blob；取消后远端不残留临时文件。

## Task 3: 补齐 Recent、Tags 和保存筛选视图

**Files:**

- Modify: `src/shared/core/models.ts`
- Modify: `src/shared/validation.ts`
- Modify: `src/server/api/host-routes.ts`
- Modify: `src/server/db/repositories.ts`
- Modify: `src/web/api.ts`
- Modify: `src/web/state/app-state.ts`
- Modify: `src/web/state/workspace-state.ts`
- Modify: `src/web/components/GroupSidebar.tsx`
- Modify: `src/web/components/HostWorkspace.tsx`
- Modify: `src/web/components/HostTargetPicker.tsx`
- Modify: `src/web/styles.css`
- Modify: `tests/unit/shared/core-models.test.ts`
- Modify: `tests/unit/web/host-workspace.dom.test.tsx`
- Modify: `tests/unit/web/host-target-picker.dom.test.tsx`
- Modify: `tests/integration/server/host-routes.test.ts`

**Interfaces:**

- Consumes: 现有 `HostListFilter`、`WorkspaceFilters`、`TargetSelection`。
- Produces: `recentOnly` 和 `tag` 的 shared filter 字段；服务端、Web adapter、Workspace snapshot 和 target picker 共享同一筛选语义。

筛选契约固定为：

```ts
export interface HostListFilter {
  query?: string;
  groupId?: string | null;
  favorite?: boolean;
  recentOnly?: boolean;
  tag?: string;
}
```

- [ ] **Step 1: 写筛选和快照失败测试**

测试必须覆盖：最近连接按 `lastConnectedAt` 过滤、标签精确匹配、Group 与 Tag 组合过滤、刷新后 Workspace 保留筛选、Target picker 提交前生成固定 `hostIds`。

- [ ] **Step 2: 实现 server/API filter**

在 `hostListQuerySchema`、`HostRepository.listMetadata()` 和 `web/api.ts:listHosts()` 中增加 `recent` 与 `tag` 参数；tag 使用已存储的 JSON 标签做安全参数化匹配，不拼接用户输入 SQL。

- [ ] **Step 3: 实现 Web 导航入口**

在 `GroupSidebar` 增加“最近”和“标签”区域；`HostWorkspace` 显示当前筛选条件和清空入口；`HostTargetPicker` 复用相同的 Group/Favorite/Recent/Tag 过滤规则，不复制另一套过滤函数。

- [ ] **Step 4: 迁移 Workspace schema**

在 `workspace-state.ts` 对旧快照补默认值；`WorkspaceFilters` 增加 `recentOnly` 和 `tag`，旧版本没有字段时分别按 `false` 和 `null` 处理。

- [ ] **Step 5: 运行筛选验证**

Run:

```bash
npm test -- --run tests/unit/shared/core-models.test.ts tests/unit/web/host-workspace.dom.test.tsx tests/unit/web/host-target-picker.dom.test.tsx tests/integration/server/host-routes.test.ts
```

## Task 4: 收口 Identity username 解析策略

**Files:**

- Modify: `src/shared/core/connection-resolution.ts`
- Modify: `src/shared/core/models.ts`
- Modify: `src/shared/validation.ts`
- Modify: `src/server/api/host-routes.ts`
- Modify: `src/server/ssh/connection-resource-provider.ts`
- Modify: `src/server/ws/terminal-gateway.ts`
- Modify: `src/web/components/HostForm.tsx`
- Modify: `src/web/components/HostCard.tsx`
- Modify: `tests/unit/shared/connection-resolution.test.ts`
- Modify: `tests/integration/server/host-routes.test.ts`
- Modify: `tests/unit/web/host-form.dom.test.tsx`

**Interfaces:**

- Consumes: `HostMetadata.username`, `IdentityMetadata.username`, Group default Identity。
- Produces: 明确的 `ResolvedConnectionConfiguration.username`；策略为“Host username 始终是连接值，Identity username 只作为创建/切换时的表单默认值”，不破坏已有 Host 数据。若未来需要 Identity username 动态继承，另立 schema migration 和继承语义 spec。

- [ ] **Step 1: 写用户名优先级测试**

覆盖三种情况：Host username 覆盖 Identity username、创建时选择 Identity 自动带出 Identity username、Group 更换默认 Identity 不修改已经明确填写的 Host username。

- [ ] **Step 2: 在 shared resolver 固定结果字段**

将 `ResolvedConnectionConfiguration` 扩展为：

```ts
export interface ResolvedConnectionConfiguration {
  profile: ConnectionProfileSettings;
  username: string;
  groupChain: readonly GroupNode[];
  identityId: string | null;
  identitySource: IdentitySource;
}
```

Resolver 只负责返回 Host 已持久化的 username，不读取数据库或 secret；Identity username 的默认填充由 HostForm 完成。

- [ ] **Step 3: 接入连接和表单**

Host route、SFTP resource provider 和 terminal gateway 全部使用 resolver 返回的 username；HostForm 选择 Identity 时仅在用户填写的 username 为空时填充，不覆盖已有值。

- [ ] **Step 4: 运行 identity 验证**

Run:

```bash
npm test -- --run tests/unit/shared/connection-resolution.test.ts tests/integration/server/host-routes.test.ts tests/unit/web/host-form.dom.test.tsx
```

## Task 5: 将 Workspace pane 模型从固定四格扩展为 capability-limited pane

**Files:**

- Modify: `src/shared/core/models.ts`
- Modify: `src/shared/core/capabilities.ts`
- Modify: `src/shared/core/ports.ts`
- Modify: `src/shared/core/runtime.ts`
- Modify: `src/web/platform/web-adapters.ts`
- Modify: `src/web/components/TerminalWorkspace.tsx`
- Modify: `src/web/components/TerminalToolbar.tsx`
- Modify: `src/web/state/workspace-state.ts`
- Modify: `src/web/styles.css`
- Modify: `tests/unit/shared/core-adapter-contract.test.ts`
- Modify: `tests/unit/web/terminal-workspace-grid.test.tsx`
- Modify: `tests/unit/web/web-adapters.test.ts`

**Interfaces:**

- Consumes: `WorkspaceLayout.paneTabIds`、`CapabilitySet`、`CoreRuntime.negotiateCapabilities()`。
- Produces: capability 提供 `workspace.max-panes` 的数值限制；shared layout 不硬编码 4 或 16，Web adapter 根据服务端和本地上限取交集。

- [ ] **Step 1: 写 capability 和 layout 失败测试**

断言 Web 在服务端返回不同 pane 上限时只渲染允许数量，旧 Workspace 快照仍然保持兼容，超过上限的 tab 不丢失而是保留在后台 tab 列表。

- [ ] **Step 2: 扩展 capability 描述**

为 `CapabilitySet` 增加只读 limits，例如：

```ts
export interface CapabilityLimits {
  maxWorkspacePanes?: number;
}
```

保持 capability 名称用于开关，limits 只用于数量约束；原生端可返回自己的本地上限。

- [ ] **Step 3: 改造 TerminalWorkspace**

将 `slice(0, 4)` 改为使用 `runtime`/capability limit；保留 single、vertical、horizontal、grid 兼容逻辑，并在窄屏下限制可见 pane 数量而不删除 Workspace tab。

- [ ] **Step 4: 运行 pane 验证**

Run:

```bash
npm test -- --run tests/unit/shared/core-adapter-contract.test.ts tests/unit/web/terminal-workspace-grid.test.tsx tests/unit/web/web-adapters.test.ts
```

## Task 6: 增加 Broadcast Input，但保持 transport 中立

**Files:**

- Modify: `src/shared/core/ports.ts`
- Modify: `src/shared/core/models.ts`
- Modify: `src/shared/protocol.ts`
- Modify: `src/server/ws/terminal-gateway.ts`
- Modify: `src/web/platform/web-adapters.ts`
- Modify: `src/web/components/TerminalWorkspace.tsx`
- Modify: `src/web/components/TerminalToolbar.tsx`
- Modify: `tests/unit/shared/protocol.test.ts`
- Modify: `tests/integration/server/terminal-gateway.test.ts`
- Modify: `tests/unit/web/terminal-workspace-grid.test.tsx`

**Interfaces:**

- Consumes: `SessionTransport`、多个 `SessionHandle`、版本化 terminal envelope。
- Produces: `broadcastInput(sessionIds: readonly string[], data: string): Promise<void>`，服务端逐个校验 session owner、状态和输入长度；不把“广播”实现成绕过单 session 权限的批量写入。

- [ ] **Step 1: 写协议失败测试**

增加 `broadcast-input` envelope 的版本、大小限制、空 session 列表、未知 session 和部分 session 关闭时的错误语义测试。

- [ ] **Step 2: 实现 server session validation**

在 terminal gateway 内将目标 session 映射到当前 owner；任一目标未授权时整体拒绝，已关闭 session 返回明确的 `SESSION_NOT_FOUND`/`OPERATION_INTERRUPTED`，不静默吞掉错误。

- [ ] **Step 3: 实现 Web UI**

只在 split/grid 且存在两个以上可写 session 时显示 Broadcast 开关；执行前显示目标名称，关闭后恢复单 pane 输入；Snippet palette 复用同一入口。

- [ ] **Step 4: 运行 Broadcast 验证**

Run:

```bash
npm test -- --run tests/unit/shared/protocol.test.ts tests/integration/server/terminal-gateway.test.ts tests/unit/web/terminal-workspace-grid.test.tsx
```

## Task 7: 为协议扩展、团队和同步单独建立边界 spec

**Files:**

- Create: `docs/superpowers/specs/2026-09-16-port-forwarding-boundary.md`
- Create: `docs/superpowers/specs/2026-09-16-multi-protocol-boundary.md`
- Create: `docs/superpowers/specs/2026-09-16-team-sync-boundary.md`
- Modify: `src/shared/core/capabilities.ts`
- Modify: `docs/architecture/cross-platform.md`
- Test: `tests/unit/shared/core-adapter-contract.test.ts`

**Interfaces:**

- Consumes: 现有 `ForwardingManager` 预留接口、`CapabilitySet`、`CoreRuntime`。
- Produces: 仅 capability 和安全边界定义；在 spec 通过评审前不新增可访问公网的端口转发路由、不引入云账号或团队数据模型。

- [ ] **Step 1: 写 capability contract 测试**

断言不支持的能力统一返回 `CAPABILITY_UNAVAILABLE`，Web 默认不暴露未实现的 forward/protocol/team/sync 入口。

- [ ] **Step 2: 编写端口转发边界 spec**

明确 bind address、端口范围、owner/session 归属、浏览器如何访问服务端容器内端口、审计字段、关闭和重启语义；禁止以任意 `0.0.0.0` 监听作为默认实现。

- [ ] **Step 3: 编写多协议边界 spec**

分别定义 Mosh、Telnet、Serial、RDP/VNC 的 transport、secret、host identity、session lifecycle 和 capability，不把协议特有字段加入 SSH `ConnectionProfile`。

- [ ] **Step 4: 编写团队/同步边界 spec**

定义数据归属、冲突合并、加密、撤销、离线删除、审计和多租户 owner 模型；在这些语义明确前维持单 Vault、单用户定位。

## Task 8: 跨端 contract、文档和发布验收

**Files:**

- Create: `tests/fixtures/core-runtime-contract.ts`
- Create: `tests/fixtures/native-runtime.ts`
- Modify: `tests/unit/shared/core-adapter-contract.test.ts`
- Create: `tests/unit/shared/native-adapter-contract.test.ts`
- Modify: `tests/unit/web/web-adapters.test.ts`
- Modify: `src/web/platform/web-adapters.ts`
- Modify: `tests/e2e/ssh-fixture.ts`
- Modify: `tests/e2e/ssh-productivity.spec.ts`
- Modify: `src/server/config.ts`
- Modify: `src/server/app.ts`
- Modify: `playwright.config.ts`
- Modify: `tests/unit/server/config.test.ts`
- Modify: `docs/architecture/cross-platform.md`
- Modify: `docs/research/2026-09-16-termius-gap-review.md`
- Modify: `README.md`

**Interfaces:**

- Consumes: `CoreRuntime`、`CapabilitySet`、`SessionTransport`、`FileTransport`、`ImportExportPort`。
- Produces: 一个不依赖 DOM/HTTP 的 in-memory native-like fake，证明桌面/Android 可以替换 adapter 而不复制 core 规则。

- [x] **Step 1: 写 fake native runtime**

fake runtime 必须实现 `CoreRuntime` 的全部端口，使用 `Uint8Array`/`AsyncIterable<Uint8Array>`，不能导入 `File`、`Blob`、`FormData`、`WebSocket` 或 `window`。

- [x] **Step 2: 复用 contract assertions**

将 session open/reconnect/close、file upload/download、command cancellation、capability negotiation 和 transport-neutral import/export boundary 断言同时运行于 Web adapter 与 fake native runtime；服务重启终态继续由既有 server/UI 回归覆盖。

- [x] **Step 3: 更新差距矩阵**

在 `docs/research/2026-09-16-termius-gap-review.md` 标记已完成项、未完成项和新的体验证据；README 只描述真实已交付能力，不把 capability 预留写成已支持功能。

- [x] **Step 4: 执行最终门槛**

Run:

```bash
npm run typecheck
npm run lint
npm test -- --run
npm run test:e2e
npm run build
git diff --check
```

Expected: shared boundary、Web/server target、80 个单测文件（289 tests）、关键 Playwright 流程和 Web/Server build 全部通过；构建包体积 warning 单独记录，不降低功能验收标准。

## 验收结果定义

- P0 完成：刷新、锁定、服务重启、取消、失败重试和大文件传输都有明确且可恢复的状态。
- P1 完成：Recent/Tags、保存筛选、Identity username 策略、可配置 pane 和 Broadcast Input 可在不复制规则的情况下工作。
- P2 完成：协议转发、多协议、团队/同步拥有独立且可评审的 capability/security/data ownership spec；未批准能力不会出现在 Web UI。
- 跨端完成：native-like fake 通过与 Web 相同的 shared contract，证明未来桌面/Android 只需要替换 adapter 和 UI/lifecycle。
