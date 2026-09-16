# Relay 长期产品与体验路线图 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在保持 Web-first、local-first、自托管和可信安全边界的前提下，把 Relay 从“可用的 Web SSH 工作台”持续演进为易发现、易操作、状态可信、传输可靠、可复盘并可扩展到多端的长期产品。

**Architecture:** 以 `src/shared/core` 的领域模型、状态机、错误码、能力集合和 ports 作为跨端边界；Web 通过 `src/web/platform/web-adapters.ts` 和 React UI 实现第一套体验，未来桌面/移动端替换 transport、文件选择器、生命周期和 secret store，不复制业务规则。交付顺序遵循“可靠性底座 → 现代任务工作流 → 自动化与复盘 → capability/跨端边界 → 团队与生态”。

**Tech Stack:** Node.js 22+, TypeScript, React 19, Vite, Fastify, WebSocket, SQLite/better-sqlite3, Argon2id, AES-256-GCM, ssh2, xterm.js, Vitest, React Testing Library, Playwright, Docker Compose, OpenSSH fixture.

**Spec:** `docs/product/2026-09-14-product-requirements.md`, `docs/product/2026-09-15-ssh-productivity-release.md`, `docs/superpowers/specs/2026-09-15-termius-experience-gap-closure-design.md`, `docs/ux/2026-09-15-ux-audit.md`, `relay-ssh-competitive-brief-2026-09-16.html`

## Global Constraints

- 保持单实例、单 Vault、单用户、自托管和 Web-first；不为了追赶云客户端而提前引入账号、云同步、团队 Vault、RBAC 或 SSO。
- `src/shared/core` 只能依赖平台无关的 TypeScript 类型和纯函数，不导入 Node、DOM、React、浏览器存储、WebSocket、HTTP、`ssh2` 或平台 keychain API。
- 密码、私钥、passphrase、主密码、导出密码、session cookie、token、bundle 和完整交互式终端内容不得进入浏览器持久化存储或普通日志。
- Host Key 首次连接必须明确确认；已知指纹变化必须硬失败；ProxyJump 每一跳执行相同的 Host Key policy，最多四级且不能有环。
- 工作区快照和模板只保存非敏感意图；`terminalId`/`sessionId` 只能用于当前进程或短期 live reattach，不得伪造应用重启后的旧 Shell 仍然存活。
- SFTP 路径必须经过现有规范化和越界检查；上传先写远端临时文件，完成后原子重命名；取消或失败不能把半文件当成目标文件。
- 批量任务默认并发 4、最大 16，单主机默认超时 60 秒，单主机输出默认上限 256 KiB；多主机或高风险动作必须有目标预览和明确确认。
- 所有状态必须有文字语义；颜色、图标、动画只能增强信息，不能成为唯一的安全或连接提示。
- 新行为遵循 `shared contract → failing test → minimal implementation → focused verification → browser/E2E verification → documentation` 顺序。
- 验证按变更风险分级：单模块运行聚焦测试；跨模块、核心流程、安全、数据迁移、构建链或重大行为变更在里程碑门槛运行全量验证。
- 不使用 reset、checkout 或覆盖用户改动；每个任务只 stage 任务文件。提交前检查 `git status`、`git diff` 和 `git diff --check`，除非用户要求不 push。

---

## 0. 计划跟踪规则

这是未来工作的主跟踪文件。旧的产品需求、UX 走查和实施计划保留为历史/详细设计依据；执行后续任务时在本文件更新状态、勾选步骤、补充 commit 和验证证据。

状态只使用以下值：

| 状态 | 含义 |
| --- | --- |
| `Done` | 已有代码、文档和验证证据，不重复实现。 |
| `Ready` | 范围、依赖和验收已明确，可以进入迭代。 |
| `In Progress` | 已开始实现，必须在任务下记录当前步骤和阻塞点。 |
| `Blocked` | 有明确外部依赖或安全决策未完成；记录阻塞原因和恢复条件。 |
| `Deferred` | 已决定暂不进入当前产品边界，不作为隐含承诺。 |

每个任务完成时必须留下：

- 任务状态和实际完成日期。
- 变更文件和 commit hash。
- 聚焦测试、浏览器验证或 E2E 的命令与结果。
- 需求覆盖和仍然存在的证据缺口。
- 如果改变了产品边界，更新对应 spec、README 和本路线图的依赖关系。

## 1. 当前基线：已交付与不重复建设

### 1.1 已交付基线（Done）

- Vault 初始化/解锁、加密凭据、单容器数据卷、HTTPS/WSS 部署边界和脱敏日志。
- Host、Group、Identity、标签、收藏、最近连接排序、ProxyJump、Keepalive、Host Key 首次确认和变更阻断。
- 同一 Host 多 Console、tab、Workspace 快照/模板、左右/上下/四格布局、刷新后的 live reattach 尝试和锁定清理。
- SSH 终端输入输出、复制粘贴、清屏、全屏、搜索、连接状态、重连和错误反馈。
- 同一 SSH 上下文的 SFTP 目录、上传/下载、新建目录、重命名、删除、路径校验、队列、取消和失败重试。
- 加密 Snippets、变量、批量目标预览、并发/超时/输出上限、逐主机结果、活动摘要、可选输出保存和 TTL。
- OpenSSH、Termius CSV、MobaXterm、Xshell、SecureCRT 的通用导入，以及 OpenSSH/CSV/Relay bundle 导出。
- `CoreRuntime`、Web adapter、capability、native-like contract tests 和跨端领域边界。
- 深色/浅色/高对比主题、Dialog 焦点、Escape、ARIA 状态播报、320px 长主机名和基础响应式走查。

### 1.2 仍需解决的主要差距

| 领域 | 当前差距 | 对应任务 |
| --- | --- | --- |
| 可靠性 | Web 文件适配层仍可能聚合数据；重试不是从断点继续；服务重启、网络切换和任务失联的终态还需更完整的可视诊断。 | R-01、R-02、R-03 |
| UI 信息架构 | 顶部功能入口偏平铺；Recent、Tags、保存筛选和打开会话没有统一的快速入口。 | U-01、U-04 |
| Workspace | 有布局和模板，但 Focus/Split/后台任务/Broadcast 还没有形成统一的任务视角。 | U-02 |
| SFTP | 当前以远程列表、路径输入和文件选择为主；缺少本地/远端双栏、拖放和稳定的 Transfer Center。 | R-02、U-03 |
| 批量与复盘 | 有安全批量命令和逐主机结果，但缺少输出对比、历史检索、异常聚合和可选的会话日志书签。 | O-01、O-02 |
| 迁移 | 已覆盖多个产品的通用输入，FinalShell/Netcatty 原生或专属字段映射仍需评估。 | O-03 |
| 平台 | shared core 已预留，原生桌面/Android UI、系统 keychain、移动生命周期尚未交付。 | X-01、X-02 |
| 能力广度 | 端口转发、Agent Forwarding、Mosh、Serial、Telnet、RDP/VNC、X11、团队和云同步尚未进入当前核心。 | X-03、X-04 |

## 2. 长期里程碑与进入/退出条件

不预设日历日期；以 1–2 周迭代为基本节奏，按团队容量调整迭代数量。下表是顺序和质量门槛，不是对具体上线日期的承诺。

| 里程碑 | 目标 | 主要任务 | 进入下一阶段的条件 |
| --- | --- | --- | --- |
| M0 基线与度量 | 统一术语、状态、指标和回归矩阵。 | Task 0、Q-01 | 每个核心用户路径有可重复测试和基线数据。 |
| M1 可信工作台 | 让用户敢在真实环境中传文件、重连和批量执行。 | R-01、R-02、R-03 | 无虚假“已连接”；任务都有终态；中断传输可恢复且不产生坏文件；相关 E2E 通过。 |
| M2 现代任务工作流 | 让用户少记忆、少跳转、少在 tab 中迷路。 | U-01、U-02、U-03、U-04 | 目标主机/会话可快速找到；Focus/Split/文件面板保持上下文；键盘、触控和窄屏路径通过。 |
| M3 生产力与复盘 | 让批量命令、片段、结果、日志和迁移形成闭环。 | O-01、O-02、O-03 | 批量目标固定快照；结果可搜索/对比；导入冲突可解释；敏感内容不泄露。 |
| M4 平台与能力边界 | 在不污染 shared core 的情况下扩展桌面、移动端和协议能力。 | X-01、X-02、X-03 | 每个新平台/协议有 capability、adapter、权限、审计和 contract test；不支持时有一致降级。 |
| M5 组织与 Agent | 在明确数据归属和权限后支持协作与受控 Agent。 | X-04 | 完成独立 spec、威胁模型、审批/审计和恢复设计；未批准能力不进入 UI。 |

## 3. 需求追踪矩阵

| 需求范围 | 主要验收主题 | 计划任务 |
| --- | --- | --- |
| FR-001–FR-004、FR-011、FR-013、FR-014 | Vault、凭据、Host Key、锁定和数据持久化 | 已交付基线；由 R-01、S-01、Q-01 持续回归 |
| FR-005–FR-010、FR-012、FR-015 | 终端、tab、resize、重连和 Workspace 恢复 | R-01、R-03、U-02 |
| FR-016–FR-017 | bundle、冲突、事务导入、ProxyJump | 已交付基线；O-03、X-03 扩展边界 |
| FR-018–FR-019 | SFTP 文件闭环、原子上传、取消、重试和断点续传 | R-02、U-03 |
| FR-020–FR-024 | Snippets、批量执行、逐主机结果、活动和 TTL | O-01、O-02 |
| FR-025、NFR-008 | shared core、capability、Web/native adapter | X-01、X-02、X-03、X-04 |
| NFR-001–NFR-003 | 单容器、加密存储、HTTPS/WSS 和 Origin | 已交付基线；S-01、Q-01 持续回归 |
| NFR-004–NFR-007 | 可用性、可访问性、可观测性和可测试性 | U-04、R-01、Q-01 |

## 4. 文件与模块地图

### Shared core

- `src/shared/core/models.ts`：Host、Identity、Group、Workspace、Transfer、CommandRun、Activity 和状态类型。
- `src/shared/core/ports.ts`：SecretStore、SessionTransport、FileTransport、CommandTransport、ImportExportPort 等平台无关接口。
- `src/shared/core/state-machines.ts`、`src/shared/core/connection-resolution.ts`、`src/shared/core/target-selection.ts`：状态迁移、连接解析和批量目标快照。
- `src/shared/core/capabilities.ts`、`src/shared/protocol.ts`、`src/shared/errors.ts`：能力协商、事件协议和稳定错误码。
- `src/shared/validation.ts`、`src/shared/import/`：输入校验、导入检测、规范化、去重、解析和导出。

### Server

- `src/server/ssh/`：连接路径、Host Key、session manager、forwarding 和 ssh2 adapter。
- `src/server/sftp/`、`src/server/api/sftp-routes.ts`：SFTP、TransferManager、错误映射和传输路由。
- `src/server/automation/`、`src/server/api/command-routes.ts`：Snippet、批量命令、结果存储和取消。
- `src/server/ws/`、`src/server/api/`：终端/操作事件、Workspace、Vault、Activity 和 Host API。
- `src/server/db/`、`src/server/vault/`：迁移、Repository、密文和数据生命周期。

### Web

- `src/web/App.tsx`、`src/web/state/`：应用路由、全局 UI 状态、Workspace 和目标选择。
- `src/web/components/HostWorkspace.tsx`、`GroupSidebar.tsx`、`HostList.tsx`、`HostCard.tsx`：Server 发现和资产管理。
- `src/web/components/TerminalWorkspace.tsx`、`TerminalPanel.tsx`、`TerminalToolbar.tsx`、`ConnectionStatus.tsx`：终端和状态。
- `src/web/components/SftpPanel.tsx`、`TransferQueue.tsx`、`ActivityPanel.tsx`：文件、传输和任务反馈。
- `src/web/components/HostTargetPicker.tsx`、`CommandRunDialog.tsx`、`CommandRunResults.tsx`、`SnippetPalette.tsx`：批量与片段。
- `src/web/platform/web-adapters.ts`、`src/web/theme.ts`、`src/web/styles.css`：平台边界、主题和视觉系统。

### Tests

- Shared：`tests/unit/shared/`、`tests/unit/shared/core-adapter-contract.test.ts`、`tests/unit/shared/native-adapter-contract.test.ts`。
- Server：`tests/unit/server/`、`tests/integration/server/`、`tests/integration/openssh/`。
- Web：`tests/unit/web/`，重点是 DOM、状态、焦点、响应式和 adapter 测试。
- Browser：`tests/e2e/host-to-terminal.spec.ts`、`tests/e2e/ssh-productivity.spec.ts`、`tests/e2e/ssh-fixture.ts`。

---

## Task 0: 固化基线、指标和发布门槛

**Status:** Done（本路线图创建时完成基线盘点）
**Priority:** P0
**Milestone:** M0
**Depends on:** 当前产品代码、产品需求、UX 走查、竞品研究和既有验证证据。
**Owner roles:** Product / UX / Engineering / QA

**Files:**

- Create: `docs/superpowers/plans/2026-09-16-relay-long-term-roadmap.md`
- Read: `docs/product/2026-09-14-product-requirements.md`
- Read: `docs/product/2026-09-15-ssh-productivity-release.md`
- Read: `docs/ux/2026-09-15-ux-audit.md`
- Read: `docs/research/2026-09-16-termius-gap-review.md`
- Read: `relay-ssh-competitive-brief-2026-09-16.html`

**Tracking outputs:**

- [x] 将 FR/NFR、UI/交互差距、可靠性差距和跨端边界映射到本路线图。
- [x] 为每个后续 Epic 定义文件边界、验收标准和验证层级。
- [x] 建立以下建议指标；第一次实现任务开始前记录现状基线，后续按里程碑更新：
  - `host_find_time_ms`：从 Server 页开始到打开目标主机的耗时；M2 目标为常用主机中位数不超过 10 秒。
  - `open_session_time_ms`：从已找到主机到终端可输入的耗时；M2 目标为常用主机中位数不超过 5 秒。
  - `task_state_explainability_rate`：连接、传输、批量任务终态中同时包含原因和下一步动作的比例；M1/M2 目标为 100%。
  - `transfer_resume_success_rate`：fixture 中人为中断后从 checkpoint 完成且校验一致的比例；M1 目标为 100% 的受控场景通过。
  - `corrupt_final_file_count`：取消/失败/恢复测试中被当成最终目标文件的半文件数量；目标为 0。
  - `secret_persistence_findings`：浏览器存储、普通日志、Workspace JSON 中的敏感信息发现数量；目标为 0。
  - `core_path_e2e_success_rate`：找主机、连接、传文件、批量执行、锁定/恢复等核心路径通过率；每个 release gate 必须 100% 通过。
  - `mobile_overflow_count`：320px/390px 宽度和短视口下的横向溢出数量；目标为 0。

**Verification:**

- [x] 使用 `rg` 复核需求、现有组件、测试和已交付文档。
- [x] 后续任务不以本指标替代真实用户访谈；公开反馈和代码推断必须标记为方向性证据。

**Acceptance:** FR/NFR、UI/交互、功能性、易用性、可靠性和跨端边界均有对应任务；已交付能力不重复建设；每个后续任务都有可追踪的状态、依赖、验收和验证证据。

---

## Task R-01: 统一连接、会话和任务生命周期诊断

**Status:** Ready
**Priority:** P0
**Milestone:** M1
**Depends on:** 已交付的 CoreRuntime、TerminalStatus、TransferJob、CommandRun 状态模型。

**Goal:** 让用户能回答“现在发生了什么、是否还会自动恢复、我下一步要做什么”，并消除“服务已重启但界面仍显示已连接”的不可信状态。

**Files:**

- Modify: `src/shared/core/models.ts`, `src/shared/core/state-machines.ts`, `src/shared/protocol.ts`, `src/shared/errors.ts`
- Modify: `src/server/ssh/session-manager.ts`, `src/server/ws/terminal-gateway.ts`, `src/server/ws/operation-gateway.ts`, `src/server/sftp/transfer-manager.ts`, `src/server/automation/command-run-store.ts`
- Modify: `src/web/components/ConnectionStatus.tsx`, `src/web/components/TerminalToolbar.tsx`, `src/web/components/TerminalPanel.tsx`, `src/web/components/TransferQueue.tsx`, `src/web/components/ActivityPanel.tsx`, `src/web/App.tsx`
- Test: `tests/unit/shared/core-state-machines.test.ts`, `tests/unit/shared/protocol.test.ts`, `tests/unit/server/terminal-gateway-state.test.ts`, `tests/unit/server/transfer-restart.test.ts`, `tests/integration/server/restart-boundaries.test.ts`, `tests/unit/web/app-terminal-lifecycle.dom.test.tsx`, `tests/e2e/ssh-productivity.spec.ts`

**Interfaces:**

- 在现有状态枚举上扩展统一诊断事件，不创建第二套互相冲突的状态模型：

```ts
export type OperationStage =
  | 'dns'
  | 'tcp'
  | 'jump-host'
  | 'host-key'
  | 'auth'
  | 'pty'
  | 'sftp'
  | 'command';

export interface OperationDiagnostic {
  operationId: string;
  hostId: string;
  kind: 'terminal' | 'transfer' | 'command';
  stage: OperationStage;
  state: 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted' | 'needs-reopen';
  retryable: boolean;
  nextAction: 'wait' | 'retry' | 'edit-credentials' | 'confirm-host-key' | 'reopen' | 'none';
  errorCode?: string;
  startedAt: string;
  endedAt?: string;
}
```

- Server 只发布脱敏的阶段、状态、稳定错误码和 request id；Web 负责将 `nextAction` 映射为可读按钮和文案。
- `reconnecting` 只表示客户端仍在保留窗口内尝试恢复；服务重启后的旧 Shell 使用 `interrupted`/`needs-reopen`，不能显示 `connected`。

- [ ] **Step 1: 写失败的状态和事件测试。**

  覆盖 DNS/TCP/跳板/Host Key/认证/PTY 顺序，永久认证失败不重连，可恢复断线显示倒计时，服务重启将 terminal/transfer/command 的非终态变为 `interrupted`，旧 session 进入 `needs-reopen`，取消后不能回到 running。

- [ ] **Step 2: 运行聚焦测试确认失败。**

  ```bash
  export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
  npm test -- --run tests/unit/shared/core-state-machines.test.ts tests/unit/shared/protocol.test.ts tests/unit/server/terminal-gateway-state.test.ts tests/unit/server/transfer-restart.test.ts tests/integration/server/restart-boundaries.test.ts
  ```

  Expected: 新增状态/事件断言在实现前失败，且失败位置指向状态转换或重启边界。

- [ ] **Step 3: 实现 server 诊断映射和终态落盘。**

  在 session manager、TransferManager、command-run-store 和 operation gateway 复用同一终态语义；启动时把持久化的 queued/running 任务标记为 interrupted；底层错误只在 server 侧映射为稳定 `AppError` code。

- [ ] **Step 4: 实现 Web 状态组件。**

  `ConnectionStatus`、`TerminalToolbar`、`TransferQueue` 和 `ActivityPanel` 显示阶段、状态、原因和下一步；所有自动重试显示下一次时间；永久错误只显示编辑/确认/重新打开等相关动作。

- [ ] **Step 5: 运行 DOM 与 Chromium 回归。**

  ```bash
  export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
  npm test -- --run tests/unit/web/app-terminal-lifecycle.dom.test.tsx tests/unit/web/activity-panel.dom.test.tsx tests/unit/web/terminal-panel.dom.test.tsx
  npm run test:e2e -- --project=chromium tests/e2e/ssh-productivity.spec.ts
  ```

- [ ] **Step 6: 更新状态/错误文档并提交。**

  更新 `README.md` 和 `docs/product/2026-09-15-ssh-productivity-release.md` 的重启、取消和恢复语义；检查 `git diff --check` 后提交：

  ```bash
  export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
  git add src/shared/core/models.ts src/shared/core/state-machines.ts src/shared/protocol.ts src/shared/errors.ts src/server/ssh/session-manager.ts src/server/ws/terminal-gateway.ts src/server/ws/operation-gateway.ts src/server/sftp/transfer-manager.ts src/server/automation/command-run-store.ts src/web/components/ConnectionStatus.tsx src/web/components/TerminalToolbar.tsx src/web/components/TerminalPanel.tsx src/web/components/TransferQueue.tsx src/web/components/ActivityPanel.tsx src/web/App.tsx tests/unit/shared/core-state-machines.test.ts tests/unit/shared/protocol.test.ts tests/unit/server/terminal-gateway-state.test.ts tests/unit/server/transfer-restart.test.ts tests/integration/server/restart-boundaries.test.ts tests/unit/web/app-terminal-lifecycle.dom.test.tsx tests/e2e/ssh-productivity.spec.ts README.md docs/product/2026-09-15-ssh-productivity-release.md
  git diff --cached --check
  git commit -m "feat: unify ssh operation lifecycle diagnostics"
  ```

**Acceptance:**

- 每个连接/传输/批量任务状态都能显示原因和下一步。
- 网络短断可重连，认证/Host Key/协议错误不盲目重连。
- 服务重启后不显示虚假的旧 Shell 状态；任务和传输可见且可重试。
- 终端状态、Activity、TransferQueue 和 API 事件的状态含义一致。

**Verification:** 相关 focused tests、Chromium 路径、状态文档和一条任务 commit；M1 结束再运行全量验证。

---

## Task R-02: 流式 SFTP、断点续传和文件完整性

**Status:** Ready
**Priority:** P0
**Milestone:** M1
**Depends on:** R-01 的 transfer 终态；现有 `BinarySource`/`ByteStream` adapter 边界。

**Goal:** 将“重试”升级为可解释的 checkpoint/resume，同时避免浏览器和 server 为大文件一次性聚合全部内容。

**Files:**

- Modify: `src/shared/core/models.ts`, `src/shared/core/ports.ts`, `src/shared/core/state-machines.ts`, `src/shared/protocol.ts`
- Modify: `src/server/sftp/transfer-manager.ts`, `src/server/sftp/sftp-adapter.ts`, `src/server/api/sftp-routes.ts`, `src/server/db/migrations.ts`, `src/server/db/repositories.ts`
- Modify: `src/web/platform/web-adapters.ts`, `src/web/components/TransferQueue.tsx`, `src/web/components/SftpPanel.tsx`
- Test: `tests/unit/server/transfer-manager.test.ts`, `tests/unit/server/transfer-restart.test.ts`, `tests/integration/server/sftp-routes.test.ts`, `tests/unit/web/web-adapters.test.ts`, `tests/unit/web/sftp-panel.dom.test.tsx`

**Interfaces:**

- 保留现有平台无关的 `BinarySource`/`ByteStream`，扩展非敏感 checkpoint：

```ts
export interface TransferCheckpoint {
  transferId: string;
  offset: number;
  totalBytes: number | null;
  checksum: string | null;
}

export interface TransferResumeRequest {
  transferId: string;
  expectedOffset: number;
  checksum: string | null;
}
```

- Web adapter 传递 `AsyncIterable<Uint8Array>`；不得在 `web-adapters.ts` 通过 `collectBinarySource` 将完整文件聚合成一个 Blob/Uint8Array 后再发送。
- Server 的临时远端文件必须绑定 `hostId + transferId`，恢复前验证已有字节数和 checkpoint；checksum 不匹配从安全位置重新开始而不是拼接未知内容。

- [ ] **Step 1: 写失败的中断、恢复和完整性测试。**

  对上传/下载分别在 0%、中间 offset、接近完成处中断；断点恢复后比较最终 checksum；取消、失败和服务重启均断言目标文件不存在半文件，且重新执行不会复用其他 transfer 的临时文件。

- [ ] **Step 2: 运行传输聚焦测试确认失败。**

  ```bash
  export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
  npm test -- --run tests/unit/server/transfer-manager.test.ts tests/unit/server/transfer-restart.test.ts tests/integration/server/sftp-routes.test.ts tests/unit/web/web-adapters.test.ts
  ```

- [ ] **Step 3: 实现持久化 checkpoint 和 streaming adapter。**

  给 transfer_jobs 增加 checkpoint/temporary path/last error 的非敏感字段；上传和下载按 chunk 更新进度；Web 文件读取和响应写出使用 async iterable；状态更新沿用 R-01 的 operation event。

- [ ] **Step 4: 实现恢复与失败清理。**

  `retry` 先读取当前 job 和 checkpoint，确认同一 owner/host/path，再调用 resume；取消、超时、连接错误和 checksum mismatch 执行临时文件清理或标记为可人工清理，不把远端临时文件显示为目标文件。

- [ ] **Step 5: 运行 SFTP DOM、OpenSSH 和大文件 fixture。**

  ```bash
  export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
  npm test -- --run tests/unit/web/sftp-panel.dom.test.tsx tests/unit/web/web-adapters.test.ts tests/integration/openssh/ssh-fixture.test.ts
  npm run test:e2e -- --project=chromium tests/e2e/ssh-productivity.spec.ts
  ```

- [ ] **Step 6: 提交可靠传输 slice。**

  ```bash
  export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
  git add src/shared/core/models.ts src/shared/core/ports.ts src/shared/core/state-machines.ts src/shared/protocol.ts src/server/sftp/transfer-manager.ts src/server/sftp/sftp-adapter.ts src/server/api/sftp-routes.ts src/server/db/migrations.ts src/server/db/repositories.ts src/web/platform/web-adapters.ts src/web/components/TransferQueue.tsx src/web/components/SftpPanel.tsx tests/unit/server/transfer-manager.test.ts tests/unit/server/transfer-restart.test.ts tests/integration/server/sftp-routes.test.ts tests/unit/web/web-adapters.test.ts tests/unit/web/sftp-panel.dom.test.tsx
  git diff --cached --check
  git commit -m "feat: add resumable streaming sftp transfers"
  ```

**Acceptance:**

- 中断后从 checkpoint 恢复，不默认从 0 开始；恢复后的最终文件 checksum 一致。
- 浏览器、server 和远端临时文件都不需要一次性持有完整大文件。
- 取消/失败/重启后状态可解释，半文件不会替代目标文件。
- TransferQueue 可显示进度、速度/ETA、恢复位置、失败原因和下一步动作。

**Verification:** server transfer unit/integration、Web adapter/DOM、OpenSSH SFTP fixture 和 Chromium E2E；M1 退出时按 Q-01 的 Release gate 执行全量回归。

---

## Task R-03: 网络切换、刷新、锁定和 Workspace 恢复

**Status:** Ready
**Priority:** P0
**Milestone:** M1
**Depends on:** R-01 的状态终态；现有 `sessionStorage` live descriptor 和 Workspace snapshot。

**Files:**

- Modify: `src/web/hooks/use-terminal-session.ts`, `src/web/state/app-state.ts`, `src/web/state/workspace-state.ts`, `src/web/App.tsx`, `src/web/components/TerminalWorkspace.tsx`, `src/web/components/WorkspaceSwitcher.tsx`
- Modify: `src/server/ssh/session-manager.ts`, `src/server/ws/terminal-gateway.ts`, `src/server/workspace/workspace-service.ts`
- Test: `tests/unit/web/terminal-descriptors.test.ts`, `tests/unit/web/app-state.test.ts`, `tests/unit/web/app-terminal-lifecycle.dom.test.tsx`, `tests/unit/server/session-manager.test.ts`, `tests/integration/server/restart-boundaries.test.ts`, `tests/e2e/host-to-terminal.spec.ts`

**Interfaces:**

- live reattach descriptor只允许 `{ terminalId, hostId, workspaceTabId }`；持久化 Workspace 不增加 terminal/session id。
- `restoreWorkspace()` 返回每个 tab 的 `restored | needs-reopen | missing-host` 结果，UI 不用一个全局布尔值掩盖部分失败。
- 运行中 session 在浏览器路由离开、页面刷新、网络切换、Vault lock 和 server restart 时分别使用明确策略；不能以“刷新成功”推断“远端命令仍在运行”。

- [ ] **Step 1: 写恢复矩阵测试。**

  覆盖浏览器刷新、WebSocket 短断、网络切换、服务重启、显式关闭、锁定/解锁、删除 Host 和模板打开冲突；断言每种场景的 tab/terminal/command/transfer 终态和页面动作。

- [ ] **Step 2: 运行恢复聚焦测试确认失败。**

  ```bash
  export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
  npm test -- --run tests/unit/web/terminal-descriptors.test.ts tests/unit/web/app-state.test.ts tests/unit/server/session-manager.test.ts tests/integration/server/restart-boundaries.test.ts
  ```

- [ ] **Step 3: 实现分层恢复策略。**

  保留短期 live reattach；路由离开时不静默销毁 session，若平台无法保持则显示明确提示；服务重启将旧会话标为 needs-reopen；模板只恢复 tab 意图、布局和筛选。

- [ ] **Step 4: 实现 UI 恢复结果。**

  Workspace tab、TerminalToolbar、Activity 和全局反馈显示“已恢复/需要重新连接/主机已不存在”；失败 tab 仍保留在列表中，用户可选择重新连接或关闭，不自动丢失。

- [ ] **Step 5: 运行刷新/重启/锁定 E2E 并提交。**

  ```bash
  export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
  npm run test:e2e -- --project=chromium tests/e2e/host-to-terminal.spec.ts
  git add src/web/hooks/use-terminal-session.ts src/web/state/app-state.ts src/web/state/workspace-state.ts src/web/App.tsx src/web/components/TerminalWorkspace.tsx src/web/components/WorkspaceSwitcher.tsx src/server/ssh/session-manager.ts src/server/ws/terminal-gateway.ts src/server/workspace/workspace-service.ts tests/unit/web/terminal-descriptors.test.ts tests/unit/web/app-state.test.ts tests/unit/web/app-terminal-lifecycle.dom.test.tsx tests/unit/server/session-manager.test.ts tests/integration/server/restart-boundaries.test.ts tests/e2e/host-to-terminal.spec.ts
  git diff --cached --check
  git commit -m "feat: make workspace recovery states explicit"
  ```

**Acceptance:** 刷新/网络切换在保留窗口内可恢复；服务重启、锁定、删除 Host 和模板冲突均有清晰终态；没有把旧 Shell 误报为仍在运行。

**Verification:** Web/server 恢复矩阵测试、restart-boundaries integration 和 Chromium 刷新/锁定/重启 E2E；跨模块改动在 M1 退出时执行 Release gate。

---

## Task U-01: Servers / Workspaces / Activity 信息架构与 Quick Switcher

**Status:** Ready
**Priority:** P1
**Milestone:** M2
**Depends on:** R-03 的 Workspace/恢复语义；现有 Host、Group、Tag、Snippet 和 Activity API。

**Files:**

- Create: `src/web/components/QuickSwitcher.tsx`, `src/web/state/navigation-state.ts`
- Modify: `src/web/App.tsx`, `src/web/components/GroupSidebar.tsx`, `src/web/components/HostWorkspace.tsx`, `src/web/components/HostList.tsx`, `src/web/components/HostCard.tsx`, `src/web/components/WorkspaceSwitcher.tsx`, `src/web/styles.css`
- Test: `tests/unit/web/quick-switcher.dom.test.tsx`, `tests/unit/web/app.dom.test.tsx`, `tests/unit/web/host-workspace.dom.test.tsx`, `tests/unit/web/workspace-switcher.dom.test.tsx`

**Interfaces:**

```ts
export type PrimaryDestination = 'servers' | 'workspaces' | 'activity';

export type QuickSwitcherItem =
  | { type: 'host'; id: string; label: string; secondary: string; tags: readonly string[] }
  | { type: 'tab'; id: string; label: string; secondary: string; status: string }
  | { type: 'workspace'; id: string; label: string; secondary: string }
  | { type: 'snippet'; id: string; label: string; secondary: string };
```

- `Ctrl/Cmd+K` 统一打开 Quick Switcher；在终端输入焦点下不得截断 shell 的文本输入语义，使用现有焦点规则决定是否拦截。
- Quick Switcher 只调用已存在的 runtime/store，不在 UI 复制一套 Host 筛选规则。

- [ ] **Step 1: 写发现路径和键盘测试。**

  覆盖 Host/Tag/Group/Identity/打开 tab/Workspace/Snippet 的模糊匹配、上下键、Enter、Escape、空结果、长标签、重复名称和焦点恢复。

- [ ] **Step 2: 运行 DOM 测试确认失败。**

  ```bash
  export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
  npm test -- --run tests/unit/web/quick-switcher.dom.test.tsx tests/unit/web/app.dom.test.tsx tests/unit/web/host-workspace.dom.test.tsx
  ```

- [ ] **Step 3: 收敛一级入口。**

  将顶部平铺入口整理为 Servers、Workspaces、Activity；Identity、Snippet、导入导出和偏好设置保留在上下文面板或设置入口；不改变已存在的业务 API。

- [ ] **Step 4: 实现 Quick Switcher 和 Recent/Tags。**

  GroupSidebar 增加 Recent、Favorites、Tags、Groups；HostWorkspace 显示当前筛选和清除入口；目标选择器复用相同过滤语义；搜索结果展示环境、用户名、协议和连接状态。

- [ ] **Step 5: 运行浏览器可用性验证并提交。**

  ```bash
  export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
  npm test -- --run tests/unit/web/quick-switcher.dom.test.tsx tests/unit/web/host-target-picker.dom.test.tsx tests/unit/web/host-workspace.dom.test.tsx
  npm run test:e2e -- --project=chromium tests/e2e/host-to-terminal.spec.ts
  git add src/web/components/QuickSwitcher.tsx src/web/state/navigation-state.ts src/web/App.tsx src/web/components/GroupSidebar.tsx src/web/components/HostWorkspace.tsx src/web/components/HostList.tsx src/web/components/HostCard.tsx src/web/components/WorkspaceSwitcher.tsx src/web/styles.css tests/unit/web/quick-switcher.dom.test.tsx tests/unit/web/app.dom.test.tsx tests/unit/web/host-workspace.dom.test.tsx tests/unit/web/workspace-switcher.dom.test.tsx
  git diff --cached --check
  git commit -m "feat: add task-oriented server navigation"
  ```

**Acceptance:** 常用 Host 在两次操作内可打开；打开的 tab、Workspace、Snippet 和标签可从同一 Quick Switcher 找到；不再用顶部按钮数量表达产品信息架构。

**Verification:** Quick Switcher、Host Workspace、目标选择器和 Workspace DOM tests，Chromium 主机发现路径，以及键盘焦点和空结果人工走查。

---

## Task U-02: Focus / Split / Broadcast 任务工作区

**Status:** Ready
**Priority:** P1
**Milestone:** M2
**Depends on:** U-01 的任务入口；R-01 的状态语义；`CapabilitySet`。

**Files:**

- Create: `src/web/components/BroadcastPreview.tsx`
- Modify: `src/shared/core/models.ts`, `src/shared/core/capabilities.ts`, `src/shared/core/target-selection.ts`, `src/web/state/workspace-state.ts`, `src/web/components/TerminalWorkspace.tsx`, `src/web/components/TerminalPanel.tsx`, `src/web/components/TerminalToolbar.tsx`, `src/web/App.tsx`, `src/web/styles.css`
- Test: `tests/unit/shared/core-models.test.ts`, `tests/unit/shared/target-selection.test.ts`, `tests/unit/web/terminal-workspace-grid.test.tsx`, `tests/unit/web/terminal-workspace.dom.test.tsx`, `tests/unit/web/app-terminal-lifecycle.dom.test.tsx`, `tests/e2e/ssh-productivity.spec.ts`

**Interfaces:**

```ts
export interface BroadcastTargetSnapshot {
  workspaceId: string | null;
  tabIds: readonly string[];
  hostIds: readonly string[];
  capturedAt: string;
  highRisk: boolean;
}
```

- pane 数量由 `workspace.max-panes` capability 与当前平台上限取交集；shared core 不写死 Termius 的 16 或当前 Web 的 4。
- `BroadcastTargetSnapshot` 在确认时冻结；执行中新增/关闭 tab 不改变已提交目标。
- Focus 是默认视角，Split 是同一 Workspace 的视角切换；后台 pane 可显示未读完成/错误状态。

- [ ] **Step 1: 写 pane、焦点和 Broadcast 安全测试。**

  覆盖 single/vertical/horizontal/grid、窄屏上限、键盘方向键调整、活动 pane、目标快照、部分失败、停止和状态恢复；断言目标列表变更不会修改已提交任务。

- [ ] **Step 2: 运行 shared/Web 聚焦测试确认失败。**

  ```bash
  export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
  npm test -- --run tests/unit/shared/core-models.test.ts tests/unit/shared/target-selection.test.ts tests/unit/web/terminal-workspace-grid.test.tsx tests/unit/web/terminal-workspace.dom.test.tsx
  ```

- [ ] **Step 3: 将 pane 模型改为 capability-limited。**

  旧 Workspace 快照按兼容规则补全 `paneTabIds`；超过当前上限的 tab 保留在后台 tab 列表，不删除、不静默合并。

- [ ] **Step 4: 实现 Focus/Split 视图和 BroadcastPreview。**

  Broadcast 只在至少两个可写 session 且 capability 可用时显示；预览显示 Host、环境、用户、命令范围、风险、并发和停止方式；确认后复用 command target snapshot 和逐主机结果。

- [ ] **Step 5: 运行 DOM/E2E 和提交。**

  ```bash
  export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
  npm test -- --run tests/unit/web/terminal-workspace-grid.test.tsx tests/unit/web/terminal-workspace.dom.test.tsx tests/unit/web/app-terminal-lifecycle.dom.test.tsx
  npm run test:e2e -- --project=chromium tests/e2e/ssh-productivity.spec.ts
  git add src/shared/core/models.ts src/shared/core/capabilities.ts src/shared/core/target-selection.ts src/web/components/BroadcastPreview.tsx src/web/state/workspace-state.ts src/web/components/TerminalWorkspace.tsx src/web/components/TerminalPanel.tsx src/web/components/TerminalToolbar.tsx src/web/App.tsx src/web/styles.css tests/unit/shared/core-models.test.ts tests/unit/shared/target-selection.test.ts tests/unit/web/terminal-workspace-grid.test.tsx tests/unit/web/terminal-workspace.dom.test.tsx tests/unit/web/app-terminal-lifecycle.dom.test.tsx tests/e2e/ssh-productivity.spec.ts
  git diff --cached --check
  git commit -m "feat: add capability-aware focus split workspace"
  ```

**Acceptance:** 用户可以在 Focus 与 Split 间切换而不丢上下文；Broadcast 目标、风险和结果清晰；不同平台/服务端 pane 上限通过 capability 生效；不误发到错误 Host。

**Verification:** shared target-selection/model、Web workspace DOM/grid tests 和 Chromium Broadcast 路径；对高风险目标执行人工确认走查，并在 M2 退出时运行 Release gate。

---

## Task U-03: 上下文 SFTP、双栏文件视图和 Transfer Center

**Status:** Ready
**Priority:** P0/P1
**Milestone:** M1（传输可靠性）→ M2（交互体验）
**Depends on:** R-02 的 streaming/resume；U-01 的 Host/Workspace 上下文。

**Files:**

- Create: `src/web/components/SftpWorkspace.tsx`, `src/web/components/LocalFilePanel.tsx`, `src/web/components/TransferCenter.tsx`
- Modify: `src/web/components/SftpPanel.tsx`, `src/web/components/SftpBreadcrumbs.tsx`, `src/web/components/TransferQueue.tsx`, `src/web/App.tsx`, `src/web/platform/web-adapters.ts`, `src/web/styles.css`
- Test: `tests/unit/web/sftp-panel.dom.test.tsx`, `tests/unit/web/transfer-center.dom.test.tsx`, `tests/unit/web/web-adapters.test.ts`, `tests/e2e/ssh-productivity.spec.ts`

**Interfaces:**

- `SftpWorkspace` 接收 `hostId`、当前 `workspaceId`、远端 path、`FileTransport` 和 `TransferJob[]`；不直接读取 App 的 secret 或底层 HTTP response。
- `TransferCenter` 只消费 `TransferJob` 和 `onCancel/onRetry/onResume`，并显示 host alias、remote path、status、progress、checkpoint 和 error code。
- 例行文件操作使用面板；删除、批量覆盖、Host Key 和 Broadcast 使用 Dialog；错误文案给出路径、权限、连接状态和下一步，不展示堆栈或凭据。

- [ ] **Step 1: 写 SFTP 上下文和操作测试。**

  覆盖从终端打开 SFTP、切换 Host 后路径隔离、面包屑、选择/多选、拖放命中当前目录、隐藏文件、权限错误、返回终端和传输中心保留状态。

- [ ] **Step 2: 运行 DOM 测试确认失败。**

  ```bash
  export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
  npm test -- --run tests/unit/web/sftp-panel.dom.test.tsx tests/unit/web/transfer-center.dom.test.tsx tests/unit/web/web-adapters.test.ts
  ```

- [ ] **Step 3: 实现同一 Host/Workspace 的上下文面板。**

  终端、Remote Files、Activity 和 Snippet 面板共享当前 Host/Workspace 标识；离开 Server 列表不卸载 live session；在不支持本地文件系统的 Web 环境中使用文件选择器作为降级路径。

- [ ] **Step 4: 实现双栏/拖放和 Transfer Center。**

  左侧本地、右侧远端；上传/下载进入 Transfer Center；支持暂停、恢复、重试、取消、异常聚合和回到原路径；拖放失败显示命中目录和恢复入口。

- [ ] **Step 5: 运行浏览器和窄屏验证。**

  使用 Chromium 检查桌面双栏、390px 单栏、短视口和键盘焦点；验证横向滚动只出现在明确的文件列表容器，不出现在页面根节点。

- [ ] **Step 6: 提交 UI slice。**

  ```bash
  export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
  npm test -- --run tests/unit/web/sftp-panel.dom.test.tsx tests/unit/web/transfer-center.dom.test.tsx tests/unit/web/web-adapters.test.ts
  git add src/web/components/SftpWorkspace.tsx src/web/components/LocalFilePanel.tsx src/web/components/TransferCenter.tsx src/web/components/SftpPanel.tsx src/web/components/SftpBreadcrumbs.tsx src/web/components/TransferQueue.tsx src/web/App.tsx src/web/platform/web-adapters.ts src/web/styles.css tests/unit/web/sftp-panel.dom.test.tsx tests/unit/web/transfer-center.dom.test.tsx tests/unit/web/web-adapters.test.ts tests/e2e/ssh-productivity.spec.ts
  git diff --cached --check
  git commit -m "feat: add contextual sftp workspace and transfer center"
  ```

**Acceptance:** 用户可以在当前 Workspace 中完成“看终端 → 找文件 → 拖放/传输 → 查看恢复 → 回到终端”；大文件状态不丢失；面板切换不让用户重新选择 Host 和路径。

**Verification:** SFTP DOM、transfer focused tests、OpenSSH fixture、Chromium 文件路径和 320/390px 窄屏走查；可靠传输部分在 M1、交互部分在 M2 分别验收。

---

## Task U-04: 视觉系统、快捷键、可访问性和响应式

**Status:** Ready
**Priority:** P1
**Milestone:** M2
**Depends on:** U-01、U-02、U-03 的组件结构；现有主题和 Dialog 基线。

**Files:**

- Create: `src/web/state/shortcut-map.ts`
- Modify: `src/web/theme.ts`, `src/web/styles.css`, `src/web/components/Dialog.tsx`, `src/web/components/HostKeyDialog.tsx`, `src/web/components/HostCard.tsx`, `src/web/components/TerminalToolbar.tsx`, `src/web/components/SftpPanel.tsx`, `src/web/App.tsx`
- Test: `tests/unit/web/theme.test.ts`, `tests/unit/web/dialog.dom.test.tsx`, `tests/unit/web/host-key-dialog.dom.test.tsx`, `tests/unit/web/host-card.dom.test.tsx`, `tests/unit/web/terminal-workspace.dom.test.tsx`, `tests/e2e/host-to-terminal.spec.ts`

**Interfaces:**

```ts
export interface ShortcutDefinition {
  id: string;
  label: string;
  keys: string;
  scope: 'global' | 'workspace' | 'terminal' | 'sftp';
  command: 'quick-switch' | 'new-terminal' | 'close-tab' | 'focus-pane' | 'open-sftp' | 'open-snippets';
}
```

- 颜色 token 继续使用主题变量；生产环境、Host Key 和危险操作同时显示文字和图标。
- 所有 icon-only action 有 `aria-label` 和可见 tooltip；Dialog 有初始焦点、Tab 循环、Escape 和关闭后焦点恢复。
- 不增加全局动画库；只保留状态变化所需的短过渡，并尊重 `prefers-reduced-motion`。

- [ ] **Step 1: 写键盘、焦点和视口回归测试。**

  覆盖输入框内不抢快捷键、终端内 Ctrl/Cmd+C 的复制/中断语义、Quick Switcher 焦点、Host Key 高风险默认按钮、320/390px 宽度、短高度、软键盘等价路径和高对比主题。

- [ ] **Step 2: 实现 Shortcut Map 和统一控制规范。**

  将快捷键定义从组件事件中集中出来；展示可搜索的 Shortcut Map；同一动作提供按钮、快捷键和可访问名称，不让浏览器、终端和 Relay 互相抢占。

- [ ] **Step 3: 收敛视觉层级。**

  终端占主要视觉空间；资产使用卡片/列表；减少顶部按钮、无意义渐变和过量阴影；用环境徽标、协议、最近活动和 Host Key 状态辅助扫视。

- [ ] **Step 4: 运行页面级验证。**

  ```bash
  export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
  npm test -- --run tests/unit/web/theme.test.ts tests/unit/web/dialog.dom.test.tsx tests/unit/web/host-key-dialog.dom.test.tsx tests/unit/web/host-card.dom.test.tsx tests/unit/web/terminal-workspace.dom.test.tsx
  npm run test:e2e -- --project=chromium tests/e2e/host-to-terminal.spec.ts
  ```

- [ ] **Step 5: 提交 UI 基础 slice。**

  ```bash
  export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
  git add src/web/state/shortcut-map.ts src/web/theme.ts src/web/styles.css src/web/components/Dialog.tsx src/web/components/HostKeyDialog.tsx src/web/components/HostCard.tsx src/web/components/TerminalToolbar.tsx src/web/components/SftpPanel.tsx src/web/App.tsx tests/unit/web/theme.test.ts tests/unit/web/dialog.dom.test.tsx tests/unit/web/host-key-dialog.dom.test.tsx tests/unit/web/host-card.dom.test.tsx tests/unit/web/terminal-workspace.dom.test.tsx tests/e2e/host-to-terminal.spec.ts
  git diff --cached --check
  git commit -m "feat: standardize relay interaction and accessibility"
  ```

**Acceptance:** 核心任务可以键盘或触控完成；320/390px 和短视口不溢出；高风险操作可读、可聚焦、可撤销/拒绝；主题和状态不依赖颜色单独传达。

**Verification:** 组件 DOM/keyboard tests、Chromium 320/390px 与短视口验证、可访问性审查和主题切换人工走查；纯视觉调整不触发无关全量测试。

---

## Task O-01: Snippet、批量命令和目标选择器的生产力闭环

**Status:** Ready
**Priority:** P1
**Milestone:** M3
**Depends on:** U-01 Quick Switcher、U-02 Broadcast 目标快照、R-01 任务终态。

**Files:**

- Modify: `src/shared/core/target-selection.ts`, `src/shared/core/command-safety.ts`, `src/shared/core/models.ts`, `src/shared/validation.ts`
- Modify: `src/server/automation/command-runner.ts`, `src/server/automation/command-run-store.ts`, `src/server/api/command-routes.ts`, `src/server/audit/audit-service.ts`
- Modify: `src/web/components/HostTargetPicker.tsx`, `src/web/components/CommandRunDialog.tsx`, `src/web/components/CommandRunResults.tsx`, `src/web/components/SnippetPalette.tsx`, `src/web/components/SnippetPicker.tsx`, `src/web/components/ActivityPanel.tsx`, `src/web/App.tsx`
- Test: `tests/unit/shared/target-selection.test.ts`, `tests/unit/shared/validation.test.ts`, `tests/unit/server/command-runner.test.ts`, `tests/unit/server/command-run-store.test.ts`, `tests/integration/server/command-routes.test.ts`, `tests/unit/web/host-target-picker.dom.test.tsx`, `tests/unit/web/command-run-dialog.dom.test.tsx`, `tests/unit/web/snippet-palette.dom.test.tsx`, `tests/unit/web/activity-panel.dom.test.tsx`

**Interfaces:**

```ts
export interface TargetSelectionSnapshot {
  hostIds: readonly string[];
  source: 'servers' | 'workspace' | 'group' | 'tag' | 'favorites' | 'recent';
  capturedAt: string;
  displayNames: readonly string[];
}
```

- UI 负责选择和预览；server 在执行前重新校验 owner、Host Key、身份、命令安全级别和 capability。
- Snippet 选择后只能进入现有批量预览，不得直接执行；缺失变量、额外变量和高风险命令必须阻止提交或二次确认。
- 结果视图提供按主机、状态、错误码筛选，并保留 request id；原始输出只有用户明确保存时才进入加密存储。

- [ ] **Step 1: 写目标漂移、变量和结果测试。**

  覆盖从 Server/Group/Recent/Tag 选择、重复 Host 去重、执行前列表变化、缺失/多余变量、高风险命令、单台失败、多台部分成功、取消、TTL 过期。

- [ ] **Step 2: 实现固定目标快照和结果模型。**

  从当前筛选生成 `TargetSelectionSnapshot`；服务端重新解析并拒绝跨 owner/不存在 Host；结果以 hostId 隔离，不让 UI 自己合并退出码或输出。

- [ ] **Step 3: 打通 Snippet palette 到预览。**

  `Ctrl/Cmd+Shift+P` 与 Quick Switcher 共享搜索和标签语义；选中后填充命令/变量，预览显示实际目标、展开后的非敏感摘要和确认要求。

- [ ] **Step 4: 增加结果筛选、异常聚合和输出 diff。**

  只对用户主动选择的主机/结果做横向对比；长输出分页或按主机加载，默认不把所有主机输出同时塞入 DOM。

- [ ] **Step 5: 运行聚焦测试并提交。**

  ```bash
  export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
  npm test -- --run tests/unit/shared/target-selection.test.ts tests/unit/shared/validation.test.ts tests/unit/server/command-runner.test.ts tests/unit/server/command-run-store.test.ts tests/integration/server/command-routes.test.ts tests/unit/web/host-target-picker.dom.test.tsx tests/unit/web/command-run-dialog.dom.test.tsx tests/unit/web/snippet-palette.dom.test.tsx tests/unit/web/activity-panel.dom.test.tsx
  git add src/shared/core/target-selection.ts src/shared/core/command-safety.ts src/shared/core/models.ts src/shared/validation.ts src/server/automation/command-runner.ts src/server/automation/command-run-store.ts src/server/api/command-routes.ts src/server/audit/audit-service.ts src/web/components/HostTargetPicker.tsx src/web/components/CommandRunDialog.tsx src/web/components/CommandRunResults.tsx src/web/components/SnippetPalette.tsx src/web/components/SnippetPicker.tsx src/web/components/ActivityPanel.tsx src/web/App.tsx tests/unit/shared/target-selection.test.ts tests/unit/shared/validation.test.ts tests/unit/server/command-runner.test.ts tests/unit/server/command-run-store.test.ts tests/integration/server/command-routes.test.ts tests/unit/web/host-target-picker.dom.test.tsx tests/unit/web/command-run-dialog.dom.test.tsx tests/unit/web/snippet-palette.dom.test.tsx tests/unit/web/activity-panel.dom.test.tsx
  git diff --cached --check
  git commit -m "feat: improve snippet and multi-host task workflow"
  ```

**Acceptance:** 不打开终端也能安全选择目标；目标在提交时固定；每台 Host 的状态和输出可独立查看；Snippet 不能绕过变量校验和人工确认。

**Verification:** shared target snapshot、snippet/batch server、Web picker/results tests 和多 Host Chromium E2E；发布前执行敏感输出/变量脱敏扫描。

---

## Task S-01: Identity、Host Key 和安全确认体验收口

**Status:** Ready
**Priority:** P1
**Milestone:** M3
**Depends on:** R-01 状态/错误语义；现有 Identity、Group inheritance 和 Host Key policy。

**Files:**

- Modify: `src/shared/core/connection-resolution.ts`, `src/shared/core/models.ts`, `src/shared/validation.ts`, `src/shared/errors.ts`
- Modify: `src/server/identity/identity-service.ts`, `src/server/ssh/host-key-policy.ts`, `src/server/ssh/connection-resource-provider.ts`, `src/server/api/identity-routes.ts`, `src/server/api/host-routes.ts`
- Modify: `src/web/components/HostForm.tsx`, `src/web/components/HostCard.tsx`, `src/web/components/IdentityManager.tsx`, `src/web/components/IdentityEditor.tsx`, `src/web/components/HostKeyDialog.tsx`
- Test: `tests/unit/shared/connection-resolution.test.ts`, `tests/unit/server/identity-service.test.ts`, `tests/unit/server/host-key-policy.test.ts`, `tests/integration/server/host-routes.test.ts`, `tests/unit/web/host-form.dom.test.tsx`, `tests/unit/web/host-key-dialog.dom.test.tsx`, `tests/unit/web/identity-manager.dom.test.tsx`

**Interfaces and policy:**

- 固定 username 解析策略：Host 明确填写的 username 优先；Identity username 只作为创建/切换时的表单默认值；Group 默认 Identity 不覆盖已经明确填写的 Host username。
- Host Key 变化流程展示地址、算法、旧 SHA-256 指纹、新 SHA-256 指纹和安全动作；不提供“跳过校验”按钮。
- Identity metadata 可显示名称、用户名、类型、指纹和使用数量；password/privateKey/passphrase 只在 server Vault 密文中使用。

- [ ] **Step 1: 写 username/Host Key 安全测试。**

  覆盖 Host/Identity/Group 三层 username 优先级、首次指纹、已知指纹变化、拒绝后重试、清除旧信任后重新确认、Identity 删除前使用量检查。

- [ ] **Step 2: 实现解析和完整变更流。**

  将旧/新指纹传给显式安全 Dialog；拒绝不会更新信任；清除旧信任是单独的安全操作；连接资源 provider 使用同一 `resolveConnectionConfiguration()`。

- [ ] **Step 3: 优化表单和卡片信息。**

  Host 卡片显示最终身份来源、环境和 Host Key 状态；表单将 inline/Identity/Group source 分组，避免用户误以为编辑 Identity 会覆盖 Host 的显式 username。

- [ ] **Step 4: 运行安全 focused tests 并提交。**

  ```bash
  export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
  npm test -- --run tests/unit/shared/connection-resolution.test.ts tests/unit/server/identity-service.test.ts tests/unit/server/host-key-policy.test.ts tests/integration/server/host-routes.test.ts tests/unit/web/host-form.dom.test.tsx tests/unit/web/host-key-dialog.dom.test.tsx tests/unit/web/identity-manager.dom.test.tsx
  git add src/shared/core/connection-resolution.ts src/shared/core/models.ts src/shared/validation.ts src/shared/errors.ts src/server/identity/identity-service.ts src/server/ssh/host-key-policy.ts src/server/ssh/connection-resource-provider.ts src/server/api/identity-routes.ts src/server/api/host-routes.ts src/web/components/HostForm.tsx src/web/components/HostCard.tsx src/web/components/IdentityManager.tsx src/web/components/IdentityEditor.tsx src/web/components/HostKeyDialog.tsx tests/unit/shared/connection-resolution.test.ts tests/unit/server/identity-service.test.ts tests/unit/server/host-key-policy.test.ts tests/integration/server/host-routes.test.ts tests/unit/web/host-form.dom.test.tsx tests/unit/web/host-key-dialog.dom.test.tsx tests/unit/web/identity-manager.dom.test.tsx
  git diff --cached --check
  git commit -m "feat: clarify identity and host key safety flows"
  ```

**Acceptance:** 用户能看懂凭据/身份的最终来源；Host Key 变化不会静默放行；删除、替换和恢复信任都不会留下旧密文或错误的信任关系。

**Verification:** connection-resolution、identity、Host Key policy、route 和 Dialog focused tests；覆盖拒绝/清除旧信任/重新确认路径，并执行敏感数据扫描。

---

## Task O-02: Activity、会话日志、复盘和远程编辑边界

**Status:** Ready
**Priority:** P1/P2
**Milestone:** M3
**Depends on:** R-01 的 operation event；O-01 的结果模型；现有审计脱敏规则。

**Files:**

- Modify: `src/shared/core/models.ts`, `src/shared/protocol.ts`, `src/shared/validation.ts`
- Modify: `src/server/audit/audit-service.ts`, `src/server/api/audit-routes.ts`, `src/server/db/repositories.ts`, `src/server/db/migrations.ts`
- Modify: `src/web/components/ActivityPanel.tsx`, `src/web/components/CommandRunResults.tsx`, `src/web/components/SftpPanel.tsx`, `src/web/App.tsx`
- Create: `src/web/components/SessionLogPanel.tsx` only after opt-in log contract is approved
- Test: `tests/unit/server/audit-service.test.ts`, `tests/integration/server/audit-routes.test.ts`, `tests/unit/web/activity-panel.dom.test.tsx`, `tests/unit/web/command-run-results.dom.test.tsx`

**Interfaces:**

- Activity 默认只保存固定 metadata：`runId`、`transferId`、`hostId`、`eventType`、`durationMs`、`successCount`、`failureCount`、`requestId` 等；命令正文、展开变量、终端原始输入输出和文件内容不进入普通 activity。
- Session logs 必须是显式 opt-in、加密、可设 retention、可删除/导出，并在 UI 中标记是否包含终端原始内容；没有完整威胁模型前不实现默认录制。
- 远程编辑第一阶段采用临时下载/外部编辑/保存回远端，不在浏览器中保留永久明文副本。

- [ ] **Step 1: 写脱敏和 TTL 测试。**

  断言审计事件不会包含 secrets/命令/变量/终端内容；已过期结果不可读取但显示“需要重新执行”；用户删除或锁定后临时数据清理。

- [ ] **Step 2: 实现可搜索 Activity 和结果复盘。**

  支持按 Host、类型、状态、时间和 request id 查询；批量结果提供异常聚合、跳转到具体 Host 和输出对比入口；分页避免一次加载所有输出。

- [ ] **Step 3: 单独评审 Session Log 和远程编辑边界。**

  在实现前补充数据分类、retention、加密、导出、删除、权限和 UI 文案；若无法满足“不记录秘密”的验收，将该能力保持 Deferred，而不是绕过规则。

- [ ] **Step 4: 运行审计 focused tests 并提交。**

  ```bash
  export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
  npm test -- --run tests/unit/server/audit-service.test.ts tests/integration/server/audit-routes.test.ts tests/unit/web/activity-panel.dom.test.tsx tests/unit/web/command-run-results.dom.test.tsx
  git add src/shared/core/models.ts src/shared/protocol.ts src/shared/validation.ts src/server/audit/audit-service.ts src/server/api/audit-routes.ts src/server/db/repositories.ts src/server/db/migrations.ts src/web/components/ActivityPanel.tsx src/web/components/CommandRunResults.tsx src/web/components/SftpPanel.tsx src/web/App.tsx tests/unit/server/audit-service.test.ts tests/integration/server/audit-routes.test.ts tests/unit/web/activity-panel.dom.test.tsx tests/unit/web/command-run-results.dom.test.tsx
  git diff --cached --check
  git commit -m "feat: improve activity and task review"
  ```

**Acceptance:** Activity 可检索、可关联、可过期；默认不记录交互式终端；任何日志/编辑能力都有明确的数据生命周期和安全开关。

**Verification:** audit unit/integration、Activity/results DOM tests、TTL/锁定清理验证和人工数据分类走查；Session Log 未通过安全评审时只保留 Deferred 状态。

---

## Task O-03: 导入/导出、FinalShell/Netcatty 迁移和可逆性

**Status:** Ready
**Priority:** P1
**Milestone:** M3
**Depends on:** 已交付的 `src/shared/import/`、Vault bundle、Identity/Group schema 和 U-01 的筛选语义。

**Files:**

- Modify: `src/shared/import/detect.ts`, `src/shared/import/normalize.ts`, `src/shared/import/dedupe.ts`, `src/shared/import/export.ts`, `src/shared/import/types.ts`, `src/shared/import/index.ts`
- Create: `src/shared/import/parsers/finalshell.ts`, `src/shared/import/parsers/netcatty.ts` only when real samples and license/format evidence are available
- Modify: `src/server/workspace/ssh-import-service.ts`, `src/server/workspace/vault-bundle-service.ts`, `src/server/api/ssh-import-routes.ts`, `src/server/api/vault-routes.ts`, `src/web/components/WorkspaceSettings.tsx`
- Test: `tests/unit/shared/import/detect.test.ts`, `tests/unit/shared/import/vendor-parsers.test.ts`, `tests/unit/shared/import/round-trip.test.ts`, `tests/unit/server/ssh-import-service.test.ts`, `tests/integration/server/ssh-import-routes.test.ts`, `tests/unit/web/workspace-settings.dom.test.tsx`

**Interfaces:**

- 各 parser 输出同一 `ImportedConnection`/`ImportDiagnostic`，不把 vendor-specific schema 传播到 core。
- 受保护或无法解密的密码统一标为 `needs-supplement`；预览只显示计数、名称、字段缺失和冲突，不显示源密码或密文。
- 导出优先 OpenSSH、通用 CSV、Relay encrypted bundle；没有证据证明能被目标产品安全读取时，不伪造 FinalShell/Netcatty 原生格式。

- [ ] **Step 1: 收集真实样本并写 parser/round-trip 失败测试。**

  每个新增格式至少有合法、空字段、重复主机、跳板、身份引用、受保护密码和非法输入 fixture；没有真实样本的格式不进入实现清单。

- [ ] **Step 2: 实现检测、预览、冲突和可逆导出。**

  复用现有 dedupe/normalize；保持 Group/Identity/ProxyJump 关系；导入先 preview 再 transaction apply；失败时现有 Vault 不变。

- [ ] **Step 3: 运行导入回归并提交。**

  ```bash
  export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
  npm test -- --run tests/unit/shared/import/detect.test.ts tests/unit/shared/import/vendor-parsers.test.ts tests/unit/shared/import/round-trip.test.ts tests/unit/server/ssh-import-service.test.ts tests/integration/server/ssh-import-routes.test.ts tests/unit/web/workspace-settings.dom.test.tsx
  git add src/shared/import/detect.ts src/shared/import/normalize.ts src/shared/import/dedupe.ts src/shared/import/export.ts src/shared/import/types.ts src/shared/import/index.ts src/shared/import/parsers/finalshell.ts src/shared/import/parsers/netcatty.ts src/server/workspace/ssh-import-service.ts src/server/workspace/vault-bundle-service.ts src/server/api/ssh-import-routes.ts src/server/api/vault-routes.ts src/web/components/WorkspaceSettings.tsx tests/unit/shared/import/detect.test.ts tests/unit/shared/import/vendor-parsers.test.ts tests/unit/shared/import/round-trip.test.ts tests/unit/server/ssh-import-service.test.ts tests/integration/server/ssh-import-routes.test.ts tests/unit/web/workspace-settings.dom.test.tsx
  git diff --cached --check
  git commit -m "feat: extend ssh migration coverage"
  ```

**Acceptance:** 用户能在导入前知道字段缺失和冲突；导入事务失败不损坏现有数据；至少一种通用导出可再次导入并保持 Host/Group/Identity 关系；不把未经证实的 native export 当卖点。

**Verification:** parser/detect/round-trip unit、import service/route integration 和 Workspace Settings DOM tests；每种格式只使用有证据的 fixture，导入失败后复核 Vault 未变化。

---

## Task X-01: Capability、跨端 contract 和规模性能门槛

**Status:** Ready
**Priority:** P1/P2
**Milestone:** M4
**Depends on:** R-01、U-02、U-03 的 capability 使用点；现有 `CoreRuntime` 和 native-like runtime。

**Files:**

- Modify: `src/shared/core/capabilities.ts`, `src/shared/core/ports.ts`, `src/shared/core/runtime.ts`, `src/shared/core/models.ts`
- Modify: `src/web/platform/web-adapters.ts`, `src/web/App.tsx`, `src/web/components/TerminalWorkspace.tsx`, `src/web/components/SftpWorkspace.tsx`
- Modify: `tests/fixtures/core-runtime-contract.ts`, `tests/fixtures/native-runtime.ts`, `tests/unit/shared/core-adapter-contract.test.ts`, `tests/unit/shared/native-adapter-contract.test.ts`, `tests/unit/web/web-adapters.test.ts`
- Create: `tests/performance/host-vault-scale.test.ts`, `tests/performance/terminal-output-scale.test.ts` only when the test runner supports stable timing thresholds
- Modify: `docs/architecture/cross-platform.md`

**Interfaces:**

- Capability 名称必须表达行为，不表达平台：`workspace.max-panes`、`transfer.resume`、`terminal.broadcast`、`sftp.local-files`、`session.reattach`、`forwarding.local` 等。
- `CoreRuntime.negotiateCapabilities()` 返回 client、server 和交集；UI 对不可用能力显示原因或隐藏入口，但不能在 UI 旁路 server 权限。
- Web/native contract tests 同时验证 Host Key、SFTP 路径、批量目标、任务终态、取消、输出上限、导入/导出和错误码。

- [ ] **Step 1: 补 capability matrix 和 contract 失败测试。**

  覆盖 Web、native-like 和能力缺失三种 runtime；不同 pane 上限、不可恢复传输、无本地文件选择器时的降级均有断言。

- [ ] **Step 2: 实现能力交集和 UI 降级。**

  删除按 `client === 'web'` 的业务分支；使用 capability 控制按钮、面板和错误文案；共享规则只存在于 core/adapter，不复制到平台组件。

- [ ] **Step 3: 建立规模测试。**

  在不绑定脆弱的绝对机器时间前提下，验证 1,000 Host 列表搜索不会阻塞输入、长终端输出不会无限增长 DOM、传输队列不会泄漏订阅；先记录基线，再设回归阈值。

- [ ] **Step 4: 运行 contract/性能 focused tests 并提交。**

  ```bash
  export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
  npm test -- --run tests/unit/shared/core-adapter-contract.test.ts tests/unit/shared/native-adapter-contract.test.ts tests/unit/web/web-adapters.test.ts
  git add src/shared/core/capabilities.ts src/shared/core/ports.ts src/shared/core/runtime.ts src/shared/core/models.ts src/web/platform/web-adapters.ts src/web/App.tsx src/web/components/TerminalWorkspace.tsx src/web/components/SftpWorkspace.tsx tests/fixtures/core-runtime-contract.ts tests/fixtures/native-runtime.ts tests/unit/shared/core-adapter-contract.test.ts tests/unit/shared/native-adapter-contract.test.ts tests/unit/web/web-adapters.test.ts tests/performance/host-vault-scale.test.ts tests/performance/terminal-output-scale.test.ts docs/architecture/cross-platform.md
  git diff --cached --check
  git commit -m "test: enforce capability and cross-platform contracts"
  ```

**Acceptance:** Web/native-like runtime 共享状态和安全规则；能力缺失时可解释降级；规模测试有可重复的基线和阈值；shared core 不引入平台依赖。

**Verification:** core-adapter/native contract tests、Web adapter tests 和稳定的规模回归；shared core 发生跨模块变化时执行 Q-01 Release gate。

---

## Task X-02: PWA、桌面和移动端产品化边界

**Status:** Ready（先做 spec，后做独立实现计划）
**Priority:** P2
**Milestone:** M4
**Depends on:** X-01；R-03 的生命周期状态；U-04 的交互 token。

**Files:**

- Create: `docs/superpowers/specs/2026-09-16-relay-platform-shell-design.md`
- Modify: `docs/architecture/cross-platform.md`
- Later implementation files: 由上述 spec 确定，不在本任务中直接创建桌面/Android 工程。

**Interfaces and decisions to specify:**

- PWA：安装、离线壳、网络切换、文件选择、下载、剪贴板和通知的支持/降级矩阵。
- Desktop：本地 SSH vs server transport、OS keychain、系统托盘、窗口恢复、代理和文件系统权限。
- Mobile：单 pane、底部操作栏、软键盘、后台挂起、网络切换、文件分享和生物识别。
- 所有平台必须复用 Host Key、任务终态、SFTP 路径、批量目标、并发/超时/输出上限和审计语义。

- [ ] **Step 1: 为每个平台写任务清单和威胁模型。**

  以“找 Host → 连接 → 输入命令 → 传文件 → 锁定/恢复”为基线，不把桌面 UI 缩小到手机，不让移动后台继续使用未授权的凭据。

- [ ] **Step 2: 写平台 capability/adapter contract。**

  规定 `SecretStore`、`SessionTransport`、`FileTransport`、`NotificationPort` 和 `ClipboardPort` 的职责；明确哪些数据可离线、哪些必须在线。

- [ ] **Step 3: 评审并提交 spec。**

  ```bash
  export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
  git add docs/superpowers/specs/2026-09-16-relay-platform-shell-design.md docs/architecture/cross-platform.md
  git diff --cached --check
  git commit -m "docs: define relay platform shell boundaries"
  ```

- [ ] **Step 4: spec 通过后另立 desktop/mobile implementation plan。**

  桌面和 Android 不作为本 master plan 的隐式代码任务；每个平台有自己的文件地图、设备测试和发布门槛。

**Acceptance:** 平台选择、离线/在线、secret store、生命周期和 UI 降级均有明确答案；没有把 Web DOM 或浏览器 Blob 传播到 shared core。

**Verification:** spec artifact/链接检查、平台威胁模型评审和 capability/adapter contract review；spec 未批准前不创建桌面或移动端实现代码。

---

## Task X-03: 端口转发、Agent Forwarding 和协议能力分层

**Status:** Ready（先做 capability/security spec）
**Priority:** P2
**Milestone:** M4
**Depends on:** X-01；R-01 的生命周期；S-01 的安全确认。

**Files:**

- Modify: `src/shared/core/capabilities.ts`, `src/shared/core/ports.ts`, `src/shared/core/models.ts`
- Modify: `src/server/ssh/forwarding-manager.ts`, `src/server/ssh/connection-path.ts`, `src/server/api/host-routes.ts`, `src/server/ws/operation-gateway.ts`
- Create: `docs/superpowers/specs/2026-09-16-relay-forwarding-and-protocol-boundaries.md`
- Test: `tests/unit/server/connection-path.test.ts`, `tests/unit/server/host-key-policy.test.ts`, `tests/unit/shared/core-adapter-contract.test.ts`

**Interfaces and boundaries:**

- 先定义 local/remote/dynamic SOCKS forwarding 的 owner、监听地址、端口冲突、生命周期、自动启动、停止、审计和 Host Key 规则。
- Agent Forwarding、Mosh、Serial、Telnet、RDP/VNC、X11 分别拥有 capability、adapter、权限和平台兼容性；不把协议实现直接塞进当前 SSH core。
- Forwarding UI 显示监听端口、目标 Host/跳板、启动状态、创建者和停止动作；不提供无确认的公网绑定。

- [ ] **Step 1: 写威胁模型、数据流和错误矩阵。**

  覆盖绑定地址、端口抢占、跳板失败、凭据/Agent 暴露、服务重启、锁定和审计；明确不可用时的 `CAPABILITY_UNAVAILABLE`。

- [ ] **Step 2: 写失败的 capability/route 测试。**

  断言跨 owner、无权限、环路、无 Host Key 信任和不支持平台均拒绝；成功 forwarding 有可取消/可停止的生命周期。

- [ ] **Step 3: 评审 spec，再为批准能力建立独立 implementation plan。**

  未完成安全评审前不向 Web 主导航加入入口，不以“功能矩阵对齐”为理由跳过权限和审计。

**Acceptance:** 每个协议或转发能力都有独立边界、权限、审计、错误和平台矩阵；未批准的能力不会出现在当前产品 UI。

**Verification:** capability/route focused tests、威胁模型和数据流评审；批准前只验证 spec，不把未实现协议加入导航或发布说明。

---

## Task X-04: 团队 Vault、同步和受控 Agent/MCP

**Status:** Deferred（必须先完成独立 spec）
**Priority:** P2
**Milestone:** M5
**Depends on:** X-01、X-02、X-03；产品对账号、数据归属和部署模型的明确决策。

**Files:**

- Create: `docs/superpowers/specs/2026-09-16-relay-team-sync-agent-boundaries.md`
- Modify: `docs/architecture/cross-platform.md` only after the spec is approved
- Later implementation files: 由 spec 和独立 implementation plan 确定

**Required decisions:**

- 团队 Vault 的 owner、成员、最小权限、离线副本、密钥轮换、审计、撤销和恢复。
- 云同步/第三方同步的 provider trust、冲突合并、删除恢复、主密码丢失和数据驻留。
- Agent/MCP 的只读/写入/批量能力、人工确认、审批、速率限制、命令预览和 session 隔离。
- UI 中如何区分“建议”“预览”“待确认”“已执行”，不能让自然语言代理静默执行生产命令。

- [ ] **Step 1: 编写数据归属和威胁模型。**
- [ ] **Step 2: 定义 capability、permission、audit 和 recovery contract。**
- [ ] **Step 3: 以只读查询/诊断作为最小可行范围评审，写独立执行计划。**
- [ ] **Step 4: 在批准前保持当前产品不变。**

**Acceptance:** 组织/同步/Agent 不改变当前 local-first 安全承诺；任何写入和批量动作都可预览、确认、审计和停止。

**Verification:** 仅进行独立 spec、权限/威胁模型和恢复设计评审；保持 Deferred，不在当前任务创建团队、同步或 Agent 实现代码。

---

## Task Q-01: 统一验证、发布和长期质量门槛

**Status:** Ready
**Priority:** P0（贯穿所有里程碑）
**Milestone:** M0–M5
**Depends on:** 每个任务的 focused tests 和指标基线。

**Files:**

- Modify: `package.json`, `README.md`, `docs/product/2026-09-15-ssh-productivity-release.md`
- Modify: `tests/e2e/host-to-terminal.spec.ts`, `tests/e2e/ssh-productivity.spec.ts`, `tests/setup.ts`
- Create: `tests/fixtures/regression/` only for a concrete reproducible regression
- Modify: this plan file after each release gate

**Verification:**

以下 profile 按任务风险选择，不把 Artifact/Focused 任务强制升级为 Release gate。

| Profile | 使用场景 | 命令 |
| --- | --- | --- |
| Artifact | 纯文档/HTML/配置 | 文件存在、编码/结构、链接、渲染、`git diff --check` |
| Focused | 单模块或低风险代码 | 受影响的 lint/typecheck/test/DOM 测试 |
| Integration | API、协议、SFTP、SSH、数据迁移 | 相关 unit + integration + OpenSSH fixture |
| Release gate | 跨模块、核心流程、安全、迁移、构建链或重大行为 | `npm run lint`、`npm run typecheck`、`npm test`、`npm run build`、`npm run test:e2e` |

- [ ] **Step 1: 为核心路径建立矩阵。**

  至少覆盖：初始化/解锁、添加 Host、首次 Host Key、连接、同 Host 多 Console、刷新、网络断线、服务重启、锁定、SFTP 上传/下载/恢复、批量命令、取消、TTL、导入冲突和主题/窄屏。

- [ ] **Step 2: 为每个里程碑记录指标基线。**

  使用 Task 0 的指标命名；记录测试环境、Host 数量、文件大小、网络条件和浏览器尺寸，避免把一次机器结果当成普遍性能结论。

- [ ] **Step 3: 增加安全/敏感数据扫描。**

  检查浏览器 storage、Workspace JSON、普通日志、Activity、错误消息、截图和导入预览中不存在主密码、凭据、token、完整命令变量或原始终端内容。

- [ ] **Step 4: 每个 release gate 运行完整验证。**

  ```bash
  export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
  npm run lint
  npm run typecheck
  npm test
  npm run build
  npm run test:e2e
  ```

- [ ] **Step 5: 发布前做人工 UX 走查。**

  用首次使用者、多 Host 运维、移动/触控、安全/辅助四条路径复核；将发现记录回 `docs/ux/` 和本路线图，不用自动化通过替代人工观察。

- [ ] **Step 6: 更新状态并提交发布证据。**

  每个 gate 通过后记录命令、测试计数、构建版本、浏览器尺寸、已知问题和 commit；只有本任务涉及重大跨模块变更时才重复项目全量验证。

**Acceptance:** 每个未来版本都能说明“改了什么、验证了什么、哪些指标变化、哪些风险仍存在”；纯文档和低风险改动不会被不必要的全量测试拖慢，重大改动仍有完整回归证据。

---

## 5. 发布顺序摘要

执行时遵循以下顺序，不能为了新增能力跳过 P0：

1. **M1 / P0：** R-01 生命周期诊断 → R-02 流式/断点传输 → R-03 恢复边界。
2. **M2 / P1：** U-01 信息架构/Quick Switcher → U-02 Focus/Split/Broadcast → U-03 上下文 SFTP → U-04 交互/无障碍/响应式。
3. **M3 / P1：** O-01 Snippet/批量闭环 → S-01 Identity/Host Key → O-02 Activity/复盘 → O-03 迁移覆盖。
4. **M4 / P2：** X-01 capability/规模门槛 → X-02 平台 shell spec → X-03 协议/转发 spec。
5. **M5 / P2：** X-04 团队、同步和受控 Agent/MCP；只有完成数据、权限、安全和恢复设计后才实现。
6. **每个阶段：** Q-01 更新指标、运行对应验证、人工走查、记录风险、提交变更，并回写本路线图状态。

## 6. 明确不做的事情

- 不复制 Termius/MobaXterm/Netcatty 的全部功能矩阵作为短期目标。
- 不在传输、连接恢复和状态反馈不可信时优先堆 AI、监控、更多协议或视觉装饰。
- 不将 16-pane、云同步、团队协作或 Agent 写死进当前 shared core。
- 不把公开评论、Issue 或营销文案写成所有用户都会遇到的事实。
- 不把原生 UI、系统 keychain、离线同步或完整会话录制当作 Web-first 版本的隐含承诺。
