# Relay 长期产品与体验路线图 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在保持 Web-first、local-first、自托管和可信安全边界的前提下，把 Relay 从“可用的 Web SSH 工作台”持续演进为易发现、易操作、状态可信、传输可靠、可复盘、可跨端并能在登录账号后安全同步的长期产品。

**Architecture:** 以 `src/shared/core` 的领域模型、状态机、错误码、能力集合和 ports 作为跨端边界；Web 通过 `src/web/platform/web-adapters.ts` 和 React UI 实现第一套体验，未来桌面/移动端替换 transport、文件选择器、生命周期和 secret store，不复制业务规则。账号与同步作为 shared core 之外的可选身份/盲存储平面，登录后同步加密 Vault，未登录仍保持 Local-only。交付顺序遵循“可靠性底座 → 现代任务工作流 → 自动化与复盘 → capability/跨端边界 → 个人账号与加密同步 → 团队与生态”。

**Tech Stack:** Node.js 22+, TypeScript, React 19, Vite, Fastify, WebSocket, SQLite/better-sqlite3, Argon2id, AES-256-GCM, ssh2, xterm.js, Vitest, React Testing Library, Playwright, Docker Compose, OpenSSH fixture.

**Spec:** `docs/product/2026-09-14-product-requirements.md`, `docs/product/2026-09-15-ssh-productivity-release.md`, `docs/superpowers/specs/2026-09-15-termius-experience-gap-closure-design.md`, `docs/superpowers/specs/2026-09-16-relay-account-and-encrypted-sync-design.md`, `docs/ux/2026-09-15-ux-audit.md`, `relay-ssh-competitive-brief-2026-09-16.html`

## Global Constraints

- M0–M4 保持单实例、单 Vault、单用户、自托管和 Web-first；M5 允许引入可选账号与加密云同步，但 Local-only 永远可用，账号不成为单机使用前置条件。
- `src/shared/core` 只能依赖平台无关的 TypeScript 类型和纯函数，不导入 Node、DOM、React、浏览器存储、WebSocket、HTTP、`ssh2` 或平台 keychain API。
- 密码、私钥、passphrase、主密码、导出密码、session cookie、账号 token、recovery key、bundle 和完整交互式终端内容不得进入浏览器持久化存储或普通日志。
- Host Key 首次连接必须明确确认；已知指纹变化必须硬失败；ProxyJump 每一跳执行相同的 Host Key policy，最多四级且不能有环。
- 工作区快照和模板只保存非敏感意图；`terminalId`/`sessionId` 只能用于当前进程或短期 live reattach，不得伪造应用重启后的旧 Shell 仍然存活。
- SFTP 路径必须经过现有规范化和越界检查；上传先写远端临时文件，完成后原子重命名；取消或失败不能把半文件当成目标文件。
- 批量任务默认并发 4、最大 16，单主机默认超时 60 秒，单主机输出默认上限 256 KiB；多主机或高风险动作必须有目标预览和明确确认。
- 所有状态必须有文字语义；颜色、图标、动画只能增强信息，不能成为唯一的安全或连接提示。
- 云同步服务只接收加密 envelope 和最小 opaque metadata；账号认证、Vault 解锁和 SSH 执行边界不能混成一个可读取明文的同步存储接口。
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
| 账号与同步 | 已有默认关闭的 Web 账号/设备/加密快照同步核心切片、recovery key 一次展示/离线确认/包装轮换和新设备恢复 preview/apply；真实删除 re-auth、冲突导出和完整账号删除闭环仍缺失。 | X-04 |
| 能力广度 | 端口转发、Agent Forwarding、Mosh、Serial、Telnet、RDP/VNC、X11、团队 Vault 和受控 Agent 尚未进入当前核心。 | X-03、X-05 |

## 2. 长期里程碑与进入/退出条件

不预设日历日期；以 1–2 周迭代为基本节奏，按团队容量调整迭代数量。下表是顺序和质量门槛，不是对具体上线日期的承诺。

| 里程碑 | 目标 | 主要任务 | 进入下一阶段的条件 |
| --- | --- | --- | --- |
| M0 基线与度量 | 统一术语、状态、指标和回归矩阵。 | Task 0、Q-01 | 每个核心用户路径有可重复测试和基线数据。 |
| M1 可信工作台 | 让用户敢在真实环境中传文件、重连和批量执行。 | R-01、R-02、R-03 | 无虚假“已连接”；任务都有终态；中断传输可恢复且不产生坏文件；相关 E2E 通过。 |
| M2 现代任务工作流 | 让用户少记忆、少跳转、少在 tab 中迷路。 | U-01、U-02、U-03、U-04 | 目标主机/会话可快速找到；Focus/Split/文件面板保持上下文；键盘、触控和窄屏路径通过。 |
| M3 生产力与复盘 | 让批量命令、片段、结果、日志和迁移形成闭环。 | O-01、O-02、O-03 | 批量目标固定快照；结果可搜索/对比；导入冲突可解释；敏感内容不泄露。 |
| M4 平台与能力边界 | 在不污染 shared core 的情况下扩展桌面、移动端和协议能力，并固定账号/同步的接入边界。 | X-01、X-02、X-03 | 每个新平台/协议有 capability、adapter、权限、审计和 contract test；不支持时有一致降级。 |
| M5 个人账号与加密同步 | 登录账号后跨设备同步加密 Vault；未登录继续 Local-only。当前已完成核心 Web/自托管同步、recovery key 生命周期和 Web 新设备恢复。 | X-04 | 完成冲突导出、删除 re-auth 与账号删除语义的安全/跨端验证；云端不持有可解密 Vault 的材料。 |
| M6 组织与 Agent | 在明确数据归属和权限后支持团队协作与受控 Agent。 | X-05 | 完成独立 spec、威胁模型、审批/审计和恢复设计；未批准能力不进入 UI。 |

## 3. 需求追踪矩阵

| 需求范围 | 主要验收主题 | 计划任务 |
| --- | --- | --- |
| FR-001–FR-004、FR-011、FR-013、FR-014 | Vault、凭据、Host Key、锁定和数据持久化 | 已交付基线；由 R-01、S-01、Q-01 持续回归 |
| FR-005–FR-010、FR-012、FR-015 | 终端、tab、resize、重连和 Workspace 恢复 | R-01、R-03、U-02 |
| FR-016–FR-017 | bundle、冲突、事务导入、ProxyJump | 已交付基线；O-03、X-03 扩展边界 |
| FR-018–FR-019 | SFTP 文件闭环、原子上传、取消、重试和断点续传 | R-02、U-03 |
| FR-020–FR-024 | Snippets、批量执行、逐主机结果、活动和 TTL | O-01、O-02 |
| FR-025、NFR-008 | shared core、capability、Web/native adapter | X-01、X-02、X-03、X-04、X-05 |
| Future account/sync | 已交付 Local-only fallback、账号会话、设备信任、加密 envelope、离线队列、revision 冲突和撤销；恢复/轮换/删除安全闭环仍由 X-04 追踪 | X-04、Q-01 |
| NFR-001–NFR-003 | 单容器、加密存储、HTTPS/WSS 和 Origin | 已交付基线；S-01、Q-01 持续回归 |
| NFR-004–NFR-007 | 可用性、可访问性、可观测性和可测试性 | U-04、R-01、Q-01 |

## 4. 文件与模块地图

### Shared core

- `src/shared/core/models.ts`：Host、Identity、Group、Workspace、Transfer、CommandRun、Activity 和状态类型。
- `src/shared/core/ports.ts`：SecretStore、SessionTransport、FileTransport、CommandTransport、ImportExportPort 等平台无关接口。
- `src/shared/core/state-machines.ts`、`src/shared/core/connection-resolution.ts`、`src/shared/core/target-selection.ts`：状态迁移、连接解析和批量目标快照。
- `src/shared/core/capabilities.ts`、`src/shared/protocol.ts`、`src/shared/errors.ts`：能力协商、事件协议和稳定错误码。
- 可选 `AccountSessionPort`、`DeviceTrustPort`、`SyncPort`：账号、设备和加密同步不成为 Local-only `CoreRuntime` 的必选依赖；Web 和 native-like contract 已覆盖当前切片。
- `src/shared/validation.ts`、`src/shared/import/`：输入校验、导入检测、规范化、去重、解析和导出。

### Server

- `src/server/ssh/`：连接路径、Host Key、session manager、forwarding 和 ssh2 adapter。
- `src/server/sftp/`、`src/server/api/sftp-routes.ts`：SFTP、TransferManager、错误映射和传输路由。
- `src/server/automation/`、`src/server/api/command-routes.ts`：Snippet、批量命令、结果存储和取消。
- `src/server/ws/`、`src/server/api/`：终端/操作事件、Workspace、Vault、Activity 和 Host API。
- `src/server/db/`、`src/server/vault/`：迁移、Repository、密文和数据生命周期。
- `src/server/account/`、`src/server/sync/`：账号会话/设备撤销、加密盲存储、revision conflict、pending/retry 和删除恢复窗口；同步存储层不调用 Vault 明文解密接口，但当前 Web-mediated Relay 执行端仍是受信解密边界。

### Web

- `src/web/App.tsx`、`src/web/state/`：应用路由、全局 UI 状态、Workspace 和目标选择。
- `src/web/components/HostWorkspace.tsx`、`GroupSidebar.tsx`、`HostList.tsx`、`HostCard.tsx`：Server 发现和资产管理。
- `src/web/components/TerminalWorkspace.tsx`、`TerminalPanel.tsx`、`TerminalToolbar.tsx`、`ConnectionStatus.tsx`：终端和状态。
- `src/web/components/SftpPanel.tsx`、`TransferQueue.tsx`、`ActivityPanel.tsx`：文件、传输和任务反馈。
- `src/web/components/HostTargetPicker.tsx`、`CommandRunDialog.tsx`、`CommandRunResults.tsx`、`SnippetPalette.tsx`：批量与片段。
- `src/web/platform/web-adapters.ts`、`src/web/theme.ts`、`src/web/styles.css`：平台边界、主题和视觉系统。
- `src/web/components/AccountMenu.tsx`、`SyncCenter.tsx`：已交付当前 Web 账号/设备/同步状态和冲突选择 UI，只消费 shared account/sync 状态，不在组件中复制加密规则；恢复、密钥轮换和冲突导出仍待补齐。

### Tests

- Shared：`tests/unit/shared/`、`tests/unit/shared/core-adapter-contract.test.ts`、`tests/unit/shared/native-adapter-contract.test.ts`。
- Server：`tests/unit/server/`、`tests/integration/server/`、`tests/integration/openssh/`。
- Web：`tests/unit/web/`，重点是 DOM、状态、焦点、响应式和 adapter 测试。
- Browser：`tests/e2e/host-to-terminal.spec.ts`、`tests/e2e/ssh-productivity.spec.ts`、`tests/e2e/ssh-fixture.ts`。
- `tests/unit/shared/account-sync-contract.test.ts`、`tests/integration/server/sync-routes.test.ts`、跨端 Local fallback 和 `tests/e2e/account-sync.spec.ts`：已在 X-04 implementation plan 中落地，后续补充恢复/轮换/删除安全场景。

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

**Status:** Done（2026-09-16）
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
  requestId?: string;
  startedAt: string;
  endedAt?: string;
}
```

- Server 只发布脱敏的阶段、状态、稳定错误码和 request id；Web 负责将 `nextAction` 映射为可读按钮和文案。
- `reconnecting` 只表示客户端仍在保留窗口内尝试恢复；服务重启后的旧 Shell 使用 `interrupted`/`needs-reopen`，不能显示 `connected`。

- [x] **Step 1: 写失败的状态和事件测试。**

  覆盖 DNS/TCP/跳板/Host Key/认证/PTY 顺序，永久认证失败不重连，可恢复断线显示倒计时，服务重启将 terminal/transfer/command 的非终态变为 `interrupted`，旧 session 进入 `needs-reopen`，取消后不能回到 running。

- [x] **Step 2: 运行聚焦测试确认失败。**

  ```bash
  export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
  npm test -- --run tests/unit/shared/core-state-machines.test.ts tests/unit/shared/protocol.test.ts tests/unit/server/terminal-gateway-state.test.ts tests/unit/server/transfer-restart.test.ts tests/integration/server/restart-boundaries.test.ts
  ```

  Expected: 新增状态/事件断言在实现前失败，且失败位置指向状态转换或重启边界。

- [x] **Step 3: 实现 server 诊断映射和终态落盘。**

  在 session manager、TransferManager、command-run-store 和 operation gateway 复用同一终态语义；启动时把持久化的 queued/running 任务标记为 interrupted；底层错误只在 server 侧映射为稳定 `AppError` code。

- [x] **Step 4: 实现 Web 状态组件。**

  `ConnectionStatus`、`TerminalToolbar`、`TransferQueue` 和 `ActivityPanel` 显示阶段、状态、原因和下一步；所有自动重试显示下一次时间；永久错误只显示编辑/确认/重新打开等相关动作。

- [x] **Step 5: 运行 DOM 与 Chromium 回归。**

  ```bash
  export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
  npm test -- --run tests/unit/web/app-terminal-lifecycle.dom.test.tsx tests/unit/web/activity-panel.dom.test.tsx tests/unit/web/terminal-panel.dom.test.tsx
  npm run test:e2e -- --project=chromium tests/e2e/ssh-productivity.spec.ts
  ```

- [x] **Step 6: 更新状态/错误文档并提交。**

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

**Implementation notes:**

- `OperationDiagnostic` 统一 terminal/transfer/command 的阶段、终态、稳定错误码和下一步动作；底层 SSH `ConnectionDiagnostic` 只保留在 adapter/server 边界。
- 终端状态携带 `serviceInstanceId`；短断线沿用同一服务实例尝试 reattach，服务重启后进入 `needs-reopen`，不伪造旧 Shell 仍然 connected。
- 服务启动时将持久化的 queued/running command run 与 transfer job 标为 `interrupted/SERVICE_RESTARTED`；UI 显示原因、重试或凭据/Host Key 处理入口。
- 为 operation WebSocket 增加诊断事件；当前 Web 端仍以既有 API 状态轮询渲染传输/批量结果，后续可在 R-02/R-03 统一实时任务订阅。

**Verification:**

- RED：实现前新增状态、协议、服务重启和服务实例边界断言按预期失败。
- Focused：核心/DOM 聚焦回归 15 个文件、74 个测试通过；补充终端错误诊断后 6 个文件、47 个测试以及 terminal panel/session 2 个文件、17 个测试通过；`npm run lint`、`npm run typecheck`、`npm run build` 通过。
- Full regression：`npm test`，81 个测试文件、298 个测试全部通过。
- Browser：`npm run test:e2e -- --project=chromium tests/e2e/ssh-productivity.spec.ts`，2/2 通过。
- `git diff --check` 通过；feature commit：`58e5bcc`（`feat: unify ssh operation lifecycle diagnostics`）。

**Evidence gap / follow-up:** R-02 的断点续传与大文件 streaming、R-03 的网络切换/锁定/Workspace 恢复矩阵仍未实现；本任务只固定其依赖的终态和诊断契约。

---

## Task R-02: 流式 SFTP、断点续传和文件完整性

**Status:** Done (2026-09-16)
**Priority:** P0
**Milestone:** M1
**Depends on:** R-01 的 transfer 终态；现有 `BinarySource`/`ByteStream` adapter 边界。

**Goal:** 将“重试”升级为可解释的 checkpoint/resume，同时避免浏览器和 server 为大文件一次性聚合全部内容。

**Files:**

- Modify: `src/shared/core/models.ts`, `src/shared/core/ports.ts`, `src/shared/core/state-machines.ts`, `src/shared/errors.ts`, `src/shared/crypto/sha256.ts`
- Modify: `src/server/app.ts`, `src/server/sftp/transfer-manager.ts`, `src/server/sftp/sftp-adapter.ts`, `src/server/sftp/types.ts`, `src/server/api/sftp-routes.ts`, `src/server/db/migrations.ts`, `src/server/db/repositories.ts`, `src/server/db/types.ts`
- Modify: `src/web/api.ts`, `src/web/App.tsx`, `src/web/platform/web-adapters.ts`, `src/web/components/TransferQueue.tsx`, `src/web/components/SftpPanel.tsx`
- Test: `tests/unit/shared/sha256.test.ts`, `tests/unit/shared/core-state-machines.test.ts`, `tests/unit/server/transfer-manager.test.ts`, `tests/unit/server/transfer-restart.test.ts`, `tests/unit/server/sftp-adapter.test.ts`, `tests/integration/server/sftp-routes.test.ts`, `tests/unit/web/web-adapters.test.ts`, `tests/unit/web/sftp-panel.dom.test.tsx`, `tests/e2e/ssh-productivity.spec.ts`
- Docs: `README.md`, `docs/product/2026-09-15-ssh-productivity-release.md`, this roadmap

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

- Chromium/HTTP/1.1 不可靠支持 streaming request body；Web adapter 使用固定 1 MiB 上限的 Blob 分块 PUT，并通过共享增量 SHA-256 传递每块前后 checkpoint。Server 保留 async iterable 的直接流式入口，分块入口只在块边界落盘和更新 checkpoint；现代浏览器用 File System Access writer 直接写下载流，其他浏览器使用带 Content-Disposition 的原生下载，均不在应用层聚合完整文件。

- [x] **Step 1: 写失败的中断、恢复和完整性测试。**

  对上传/下载分别在 0%、中间 offset、接近完成处中断；断点恢复后比较最终 checksum；取消、失败和服务重启均断言目标文件不存在半文件，且重新执行不会复用其他 transfer 的临时文件。

- [x] **Step 2: 运行传输聚焦测试确认失败。**

  ```bash
  export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
  npm test -- --run tests/unit/server/transfer-manager.test.ts tests/unit/server/transfer-restart.test.ts tests/integration/server/sftp-routes.test.ts tests/unit/web/web-adapters.test.ts
  ```

- [x] **Step 3: 实现持久化 checkpoint 和 streaming adapter。**

  给 transfer_jobs 增加 checkpoint/temporary path/last error 的非敏感字段；上传和下载按 chunk 更新进度；Web 文件读取和响应写出使用 async iterable；状态更新沿用 R-01 的 operation event。

- [x] **Step 4: 实现恢复与失败清理。**

  `retry` 先读取当前 job 和 checkpoint，确认同一 owner/host/path，再调用 resume；取消、超时、连接错误和 checksum mismatch 执行临时文件清理或标记为可人工清理，不把远端临时文件显示为目标文件。

- [x] **Step 5: 运行 SFTP DOM、OpenSSH 和大文件 fixture。**

  ```bash
  export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
  npm test -- --run tests/unit/web/sftp-panel.dom.test.tsx tests/unit/web/web-adapters.test.ts tests/integration/openssh/ssh-fixture.test.ts
  npm run test:e2e -- --project=chromium tests/e2e/ssh-productivity.spec.ts
  ```

- [x] **Step 6: 提交可靠传输 slice。**

  ```bash
  export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
  git add src/shared/core/models.ts src/shared/core/ports.ts src/shared/core/state-machines.ts src/shared/errors.ts src/shared/crypto/sha256.ts src/server/app.ts src/server/sftp/transfer-manager.ts src/server/sftp/sftp-adapter.ts src/server/sftp/types.ts src/server/api/sftp-routes.ts src/server/db/migrations.ts src/server/db/repositories.ts src/server/db/types.ts src/web/api.ts src/web/App.tsx src/web/platform/web-adapters.ts src/web/components/TransferQueue.tsx src/web/components/SftpPanel.tsx tests/unit/shared/sha256.test.ts tests/unit/shared/core-state-machines.test.ts tests/unit/server/transfer-manager.test.ts tests/unit/server/transfer-restart.test.ts tests/unit/server/sftp-adapter.test.ts tests/integration/server/sftp-routes.test.ts tests/unit/web/web-adapters.test.ts tests/unit/web/sftp-panel.dom.test.tsx tests/e2e/ssh-productivity.spec.ts README.md docs/product/2026-09-15-ssh-productivity-release.md docs/superpowers/plans/2026-09-16-relay-long-term-roadmap.md
  git diff --cached --check
  git commit -m "feat: add resumable streaming sftp transfers"
  ```

**Acceptance:**

- 中断后从 checkpoint 恢复，不默认从 0 开始；恢复后的最终文件 checksum 一致。
- 浏览器、server 和远端临时文件都不需要一次性持有完整大文件。
- 取消/失败/重启后状态可解释，半文件不会替代目标文件。
- TransferQueue 可显示进度、速度/ETA、恢复位置、失败原因和下一步动作。

**Verification:**

- Focused transfer/adapter/DOM：7 个文件、29 个测试通过；`npm run lint`、`npm run typecheck`、`npm run build` 通过。
- SFTP DOM/Web adapter/OpenSSH：3 个文件、17 个测试通过。
- Full regression：`npm test`，83 个测试文件、308 个测试全部通过。
- Browser：`npm run test:e2e -- --project=chromium tests/e2e/ssh-productivity.spec.ts`，2/2 通过；覆盖真实 OpenSSH SFTP 上传、原生下载、取消清理、Workspace 和批量任务边界。
- `git diff --check` 通过；feature commit：`c2b04fd`（`feat: add resumable streaming sftp transfers`）。

**Evidence gap / follow-up:** 当前 Chromium E2E 固定关闭系统文件选择器，验证了原生下载 fallback；File System Access writer 的真实浏览器交互需要在有权限的 headed 浏览器矩阵补充。多块上传由 1 MiB+3 B fixture 覆盖，真实 OpenSSH 仍是小文件边界；后续 R-03 可加入网络切换、请求丢响应和大文件长时传输矩阵。

---

## Task R-03: 网络切换、刷新、锁定和 Workspace 恢复

**Status:** Done（2026-09-16）
**Priority:** P0
**Milestone:** M1
**Depends on:** R-01 的状态终态；现有 `sessionStorage` live descriptor 和 Workspace snapshot。

**Files:**

- Modify: `src/web/hooks/use-terminal-session.ts`, `src/web/state/app-state.ts`, `src/web/state/workspace-state.ts`, `src/web/App.tsx`, `src/web/components/TerminalWorkspace.tsx`, `src/web/components/WorkspaceSwitcher.tsx`
- Modify: `src/server/ssh/session-manager.ts`, `src/server/ws/terminal-gateway.ts`, `src/server/workspace/workspace-service.ts`
- Test: `tests/unit/web/terminal-descriptors.test.ts`, `tests/unit/web/app-state.test.ts`, `tests/unit/web/terminal-session.test.ts`, `tests/unit/web/app-terminal-lifecycle.dom.test.tsx`, `tests/unit/web/terminal-workspace.dom.test.tsx`, `tests/unit/web/app.dom.test.tsx`, `tests/unit/web/workspace-switcher.dom.test.tsx`, `tests/unit/server/session-manager.test.ts`, `tests/unit/server/workspace-service.test.ts`, `tests/integration/server/terminal-gateway.test.ts`, `tests/integration/server/restart-boundaries.test.ts`, `tests/e2e/host-to-terminal.spec.ts`

**Interfaces:**

- live reattach descriptor只允许 `{ terminalId, hostId, workspaceTabId }`；持久化 Workspace 不增加 terminal/session id。
- `restoreWorkspace()` 返回每个 tab 的 `restored | needs-reopen | missing-host` 结果，UI 不用一个全局布尔值掩盖部分失败。
- 运行中 session 在浏览器路由离开、页面刷新、网络切换、Vault lock 和 server restart 时分别使用明确策略；不能以“刷新成功”推断“远端命令仍在运行”。

- [x] **Step 1: 写恢复矩阵测试。**

  覆盖浏览器刷新、WebSocket 短断、网络切换、服务重启、显式关闭、锁定/解锁、删除 Host 和模板打开冲突；本 slice 断言 tab/terminal 终态和页面动作，command/transfer 继续复用 R-01/R-02 的终态与 Vault lock 清理边界。

- [x] **Step 2: 运行恢复聚焦测试确认失败。**

  ```bash
  export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
  npm test -- --run tests/unit/web/terminal-descriptors.test.ts tests/unit/web/app-state.test.ts tests/unit/server/session-manager.test.ts tests/integration/server/restart-boundaries.test.ts
  ```

- [x] **Step 3: 实现分层恢复策略。**

  保留短期 live reattach；路由离开时不静默销毁 session，若平台无法保持则显示明确提示；服务重启将旧会话标为 needs-reopen；模板只恢复 tab 意图、布局和筛选。

- [x] **Step 4: 实现 UI 恢复结果。**

  Workspace tab、TerminalToolbar、Activity 和全局反馈显示“已恢复/需要重新连接/主机已不存在”；失败 tab 仍保留在列表中，用户可选择重新连接或关闭，不自动丢失。

- [x] **Step 5: 运行刷新 E2E、重启边界集成测试并提交。**

  ```bash
  export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
  npm run test:e2e -- --project=chromium tests/e2e/host-to-terminal.spec.ts
  git add src/web/hooks/use-terminal-session.ts src/web/state/app-state.ts src/web/state/workspace-state.ts src/web/App.tsx src/web/components/TerminalWorkspace.tsx src/web/components/WorkspaceSwitcher.tsx src/server/ssh/session-manager.ts src/server/ws/terminal-gateway.ts src/server/workspace/workspace-service.ts tests/unit/web/terminal-descriptors.test.ts tests/unit/web/app-state.test.ts tests/unit/web/app-terminal-lifecycle.dom.test.tsx tests/unit/server/session-manager.test.ts tests/integration/server/restart-boundaries.test.ts tests/e2e/host-to-terminal.spec.ts
  git diff --cached --check
  git commit -m "feat: make workspace recovery states explicit"
  ```

**Acceptance:** 刷新/网络切换在保留窗口内可恢复；服务重启、锁定、删除 Host 和模板冲突均有清晰终态；没有把旧 Shell 误报为仍在运行。

**Verification:**

- Web/server 恢复矩阵聚焦回归：9 个文件、63 个测试通过；覆盖 descriptor 清理、Workspace tab 逐项恢复、网络离线/恢复、session reattach、服务会话失效、删除 Server 保留 tab 意图和缺失 Server UI；`WorkspaceSwitcher` 模板 Host 冲突定向回归另有 1 个文件、3 个测试通过。
- `npm run typecheck`、`npm run lint`、`npm run build` 通过；构建仅有既有前端 chunk 体积提示。
- Full regression：`npm test`，83 个测试文件、317 个测试全部通过。
- Chromium：`npm run test:e2e -- --project=chromium tests/e2e/host-to-terminal.spec.ts`，1/1 通过；覆盖真实 SSH 建连、双 tab、页面刷新后的 Workspace 恢复、锁定/解锁和窄屏布局。
- `git diff --check` 通过；feature commit：`28af895`（`feat: make workspace recovery states explicit`）。

**Evidence gap / follow-up:** 当前服务重启的 live session 失效由 service-instance、Gateway 和 session controller 的单测/集成覆盖，浏览器 E2E 已覆盖刷新与锁定/解锁，但还没有在 Playwright 中实际重启 Web 服务或模拟真实网络设备切换；后续跨平台生命周期矩阵补充这两类环境测试。Workspace 恢复结果只保留非敏感 tab 意图，command/transfer 的持久化任务仍遵循各自已有终态和 Vault lock 清理边界。

---

## Task U-01: Servers / Workspaces / Activity 信息架构与 Quick Switcher

**Status:** Done（2026-09-16）
**Priority:** P1
**Milestone:** M2
**Depends on:** R-03 的 Workspace/恢复语义；现有 Host、Group、Tag、Snippet 和 Activity API。

**Files:**

- Create: `src/web/components/QuickSwitcher.tsx`, `src/web/state/navigation-state.ts`
- Modify: `src/web/App.tsx`, `src/web/components/GroupSidebar.tsx`, `src/web/components/HostWorkspace.tsx`, `src/web/components/HostList.tsx`, `src/web/components/HostCard.tsx`, `src/web/components/HostTargetPicker.tsx`, `src/web/components/WorkspaceSwitcher.tsx`, `src/web/styles.css`
- Test: `tests/unit/web/quick-switcher.dom.test.tsx`, `tests/unit/web/navigation-state.test.ts`, `tests/unit/web/app.dom.test.tsx`, `tests/unit/web/app-terminal-lifecycle.dom.test.tsx`, `tests/unit/web/host-target-picker.dom.test.tsx`, `tests/unit/web/host-workspace.dom.test.tsx`, `tests/unit/web/workspace-switcher.dom.test.tsx`

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

- [x] **Step 1: 写发现路径和键盘测试。**

  覆盖 Host/Tag/Group/Identity/打开 tab/Workspace/Snippet 的模糊匹配、上下键、Enter、Escape、空结果、长标签、重复名称和焦点恢复。

- [x] **Step 2: 运行 DOM 测试确认失败。**

  ```bash
  export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
  npm test -- --run tests/unit/web/quick-switcher.dom.test.tsx tests/unit/web/app.dom.test.tsx tests/unit/web/host-workspace.dom.test.tsx
  ```

- [x] **Step 3: 收敛一级入口。**

  将顶部平铺入口整理为 Servers、Workspaces、Activity；Identity、Snippet、导入导出和偏好设置保留在上下文面板或设置入口；不改变已存在的业务 API。

- [x] **Step 4: 实现 Quick Switcher 和 Recent/Tags。**

  GroupSidebar 增加 Recent、Favorites、Tags、Groups；HostWorkspace 显示当前筛选和清除入口；目标选择器复用相同过滤语义；搜索结果展示环境、用户名、协议和连接状态。

- [x] **Step 5: 运行浏览器可用性验证并提交。**

  ```bash
  export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
  npm test -- --run tests/unit/web/quick-switcher.dom.test.tsx tests/unit/web/host-target-picker.dom.test.tsx tests/unit/web/host-workspace.dom.test.tsx
  npm run test:e2e -- --project=chromium tests/e2e/host-to-terminal.spec.ts
  git add src/web/components/QuickSwitcher.tsx src/web/state/navigation-state.ts src/web/App.tsx src/web/components/GroupSidebar.tsx src/web/components/HostWorkspace.tsx src/web/components/HostList.tsx src/web/components/HostCard.tsx src/web/components/HostTargetPicker.tsx src/web/components/WorkspaceSwitcher.tsx src/web/styles.css tests/unit/web/quick-switcher.dom.test.tsx tests/unit/web/navigation-state.test.ts tests/unit/web/app.dom.test.tsx tests/unit/web/app-terminal-lifecycle.dom.test.tsx tests/unit/web/host-target-picker.dom.test.tsx tests/unit/web/host-workspace.dom.test.tsx tests/unit/web/workspace-switcher.dom.test.tsx tests/e2e/host-to-terminal.spec.ts
  git diff --cached --check
  git commit -m "feat: add task-oriented server navigation"
  ```

**Acceptance:** 常用 Host 在两次操作内可打开；打开的 tab、Workspace、Snippet 和标签可从同一 Quick Switcher 找到；不再用顶部按钮数量表达产品信息架构。

**Verification:**

- RED：先加入导航索引、Quick Switcher、快捷键和 Recent/Tags 测试，确认缺失模块、旧快捷键断言和未实现行为按预期失败；随后以最小实现收敛到现有 runtime/store。
- Focused：Quick Switcher、导航索引、Host Workspace、Host Target Picker、App 和生命周期回归共 6 个重点文件、26 个测试通过；覆盖模糊匹配、重复名称、长结果/空结果、上下键、Enter、Escape、焦点恢复、Recent/Tags 和清除筛选。
- `npm run typecheck`、`npm run lint`、`npm run build` 通过；构建仅有既有前端 chunk 体积提示。
- Full regression：`npm test`，85 个测试文件、329 个测试全部通过。
- Browser：`npm run test:e2e -- --project=chromium tests/e2e/host-to-terminal.spec.ts`，1/1 通过；覆盖页面级 Quick Switcher、终端内顶栏打开、终端输入框 Ctrl+K 不抢占、真实 SSH 建连、刷新恢复、锁定/解锁和窄屏路径。
- `git diff --check` 通过；feature commit：`b978ea7`（`feat: add task-oriented server navigation`）。

---

## Task U-02: Focus / Split / Broadcast 任务工作区

**Status:** Done（2026-09-16）
**Priority:** P1
**Milestone:** M2
**Depends on:** U-01 的任务入口；R-01 的状态语义；`CapabilitySet`。

**Files:**

- Create: `src/web/components/BroadcastPreview.tsx`
- Modify: `src/shared/core/models.ts`, `src/shared/core/capabilities.ts`, `src/shared/core/target-selection.ts`, `src/shared/validation.ts`, `src/server/app.ts`, `src/web/api.ts`, `src/web/platform/web-adapters.ts`, `src/web/state/workspace-state.ts`, `src/web/components/TerminalWorkspace.tsx`, `src/web/App.tsx`, `src/web/styles.css`
- Test: `tests/unit/shared/core-models.test.ts`, `tests/unit/shared/target-selection.test.ts`, `tests/unit/web/app-state.test.ts`, `tests/unit/web/broadcast-preview.dom.test.tsx`, `tests/unit/web/terminal-workspace-grid.test.tsx`, `tests/unit/web/terminal-workspace.dom.test.tsx`, `tests/unit/web/web-adapters.test.ts`, `tests/integration/server/health.test.ts`, `tests/e2e/ssh-productivity.spec.ts`

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

- [x] **Step 1: 写 pane、焦点和 Broadcast 安全测试。**

  覆盖 single/vertical/horizontal/grid、窄屏上限、键盘方向键调整、活动 pane、目标快照、部分失败、停止和状态恢复；断言目标列表变更不会修改已提交任务。

- [x] **Step 2: 运行 shared/Web 聚焦测试确认失败。**

  ```bash
  export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
  npm test -- --run tests/unit/shared/core-models.test.ts tests/unit/shared/target-selection.test.ts tests/unit/web/terminal-workspace-grid.test.tsx tests/unit/web/terminal-workspace.dom.test.tsx
  ```

- [x] **Step 3: 将 pane 模型改为 capability-limited。**

  旧 Workspace 快照按兼容规则补全 `paneTabIds`；超过当前上限的 tab 保留在后台 tab 列表，不删除、不静默合并。

- [x] **Step 4: 实现 Focus/Split 视图和 BroadcastPreview。**

  Broadcast 只在至少两个可写 session 且 capability 可用时显示；预览显示 Host、环境、用户、命令范围、风险、并发和停止方式；确认后复用 command target snapshot 和逐主机结果。

- [x] **Step 5: 运行 DOM/E2E 和提交。**

  ```bash
  export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
  npm test -- --run tests/unit/web/terminal-workspace-grid.test.tsx tests/unit/web/terminal-workspace.dom.test.tsx tests/unit/web/app-terminal-lifecycle.dom.test.tsx
  npm run test:e2e -- --project=chromium tests/e2e/ssh-productivity.spec.ts
  git add src/shared/core/models.ts src/shared/core/capabilities.ts src/shared/core/target-selection.ts src/web/components/BroadcastPreview.tsx src/web/state/workspace-state.ts src/web/components/TerminalWorkspace.tsx src/web/components/TerminalPanel.tsx src/web/components/TerminalToolbar.tsx src/web/App.tsx src/web/styles.css tests/unit/shared/core-models.test.ts tests/unit/shared/target-selection.test.ts tests/unit/web/terminal-workspace-grid.test.tsx tests/unit/web/terminal-workspace.dom.test.tsx tests/unit/web/app-terminal-lifecycle.dom.test.tsx tests/e2e/ssh-productivity.spec.ts
  git diff --cached --check
  git commit -m "feat: add capability-aware focus split workspace"
  ```

**Acceptance:** 用户可以在 Focus 与 Split 间切换而不丢上下文；Broadcast 目标、风险和结果清晰；不同平台/服务端 pane 上限通过 capability 生效；不误发到错误 Host。

**Verification:**

- [x] Shared/Web focused：pane 上限、旧布局兼容、目标快照冻结、Broadcast 预览、Focus/Split/grid、后台完成/错误未读状态和 Web capability 交集测试通过；共 8 个重点文件、47 个测试通过。
- [x] Full regression：`npm test`，86 个测试文件、340 个测试全部通过。
- [x] `npm run typecheck`、`npm run lint`、`npm run build` 通过；构建仅有既有前端 chunk 体积提示。
- [x] Browser：`npm run test:e2e -- --project=chromium tests/e2e/ssh-productivity.spec.ts`，2/2 通过；覆盖 Broadcast 预览、两个 Host 上下文、命令结果/取消/审计、SFTP 和恢复路径。
- [x] `git diff --check` 通过；feature commit：`97d459c`（`feat: add capability-aware focus split workspace`）。

---

## Task U-03: 上下文 SFTP、双栏文件视图和 Transfer Center

**Status:** Done（2026-09-16）
**Priority:** P0/P1
**Milestone:** M1（传输可靠性）→ M2（交互体验）
**Depends on:** R-02 的 streaming/resume；U-01 的 Host/Workspace 上下文。

**Files:**

- Create: `src/web/components/SftpWorkspace.tsx`, `src/web/components/LocalFilePanel.tsx`, `src/web/components/TransferCenter.tsx`
- Modify: `src/shared/core/models.ts`, `src/shared/core/ports.ts`, `src/shared/core/state-machines.ts`, `src/shared/protocol.ts`, `src/server/sftp/transfer-manager.ts`, `src/server/api/sftp-routes.ts`, `src/server/db/migrations.ts`, `src/server/db/repositories.ts`, `src/web/components/SftpPanel.tsx`, `src/web/components/SftpBreadcrumbs.tsx`, `src/web/components/TransferQueue.tsx`, `src/web/components/ActivityPanel.tsx`, `src/web/App.tsx`, `src/web/api.ts`, `src/web/platform/web-adapters.ts`, `src/web/styles.css`
- Test: `tests/unit/shared/core-state-machines.test.ts`, `tests/unit/shared/protocol.test.ts`, `tests/unit/server/transfer-manager.test.ts`, `tests/unit/server/migrations.test.ts`, `tests/integration/server/sftp-routes.test.ts`, `tests/unit/web/local-file-panel.dom.test.tsx`, `tests/unit/web/sftp-panel.dom.test.tsx`, `tests/unit/web/sftp-workspace.dom.test.tsx`, `tests/unit/web/terminal-workspace.dom.test.tsx`, `tests/unit/web/transfer-center.dom.test.tsx`, `tests/unit/web/web-adapters.test.ts`, `tests/e2e/ssh-productivity.spec.ts`

**Interfaces:**

- `SftpWorkspace` 接收 `hostId`、当前 `workspaceId`、远端 path、`FileTransport` 和 `TransferJob[]`；不直接读取 App 的 secret 或底层 HTTP response。
- `TransferCenter` 只消费 `TransferJob` 和 `onCancel/onRetry/onResume`，并显示 host alias、remote path、status、progress、checkpoint 和 error code。
- 例行文件操作使用面板；删除、批量覆盖、Host Key 和 Broadcast 使用 Dialog；错误文案给出路径、权限、连接状态和下一步，不展示堆栈或凭据。

- [x] **Step 1: 写 SFTP 上下文和操作测试。**

  覆盖从终端打开 SFTP、切换 Host 后路径隔离、面包屑、选择/多选、拖放命中当前目录、隐藏文件、权限错误、返回终端和传输中心保留状态；增加暂停检查点、迁移保留检查点和 pause API 路由测试。

- [x] **Step 2: 运行 DOM 测试确认失败。**

  ```bash
  export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
  npm test -- --run tests/unit/web/sftp-panel.dom.test.tsx tests/unit/web/transfer-center.dom.test.tsx tests/unit/web/web-adapters.test.ts
  ```

  实现前新增组件导入、受控路径和终端组合断言按预期失败；实现后同范围聚焦回归通过。

- [x] **Step 3: 实现同一 Host/Workspace 的上下文面板。**

  终端、Remote Files、Activity 和 Snippet 面板共享当前 Host/Workspace 标识；SFTP path 按 Host 隔离并由父级控制；离开 Server 列表不卸载 live session；Web 环境使用多选文件选择器作为本地文件系统降级路径。

- [x] **Step 4: 实现双栏/拖放和 Transfer Center。**

  左侧本地、右侧远端；上传/下载进入 Transfer Center；支持暂停、从 checkpoint 恢复、重试、取消、异常聚合和回到原路径；拖放失败显示命中目录、权限/连接原因和下一步。TransferManager、协议、SQLite schema v11 和 API 增加可恢复 paused 生命周期。

- [x] **Step 5: 运行浏览器和窄屏验证。**

  使用 Chromium 检查桌面双栏、390px 单栏、短视口、SFTP 上传/下载和既有恢复路径；验证文件列表内部滚动和页面根节点无横向溢出。文件行在窄侧栏保持可见，超长列表只在明确的文件列表容器内滚动。

- [x] **Step 6: 提交 UI slice。**

  ```bash
  export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
  npm test -- --run tests/unit/web/sftp-panel.dom.test.tsx tests/unit/web/transfer-center.dom.test.tsx tests/unit/web/web-adapters.test.ts
  git add src/web/components/SftpWorkspace.tsx src/web/components/LocalFilePanel.tsx src/web/components/TransferCenter.tsx src/web/components/SftpPanel.tsx src/web/components/SftpBreadcrumbs.tsx src/web/components/TransferQueue.tsx src/web/App.tsx src/web/platform/web-adapters.ts src/web/styles.css tests/unit/web/sftp-panel.dom.test.tsx tests/unit/web/transfer-center.dom.test.tsx tests/unit/web/web-adapters.test.ts tests/e2e/ssh-productivity.spec.ts
  git diff --cached --check
  git commit -m "feat: add contextual sftp workspace and transfer center"
  ```

  Feature commit：`81150cb`（`feat: add contextual sftp workspace and transfer center`）。

**Acceptance:** 用户可以在当前 Workspace 中完成“看终端 → 找文件 → 拖放/传输 → 查看恢复 → 回到终端”；大文件状态不丢失；面板切换不让用户重新选择 Host 和路径。

**Verification:**

- [x] 聚焦回归：暂停/继续、迁移、TransferManager、SFTP route、协议和 Web adapter 共 9 个文件、51 个测试通过；UI 受影响文件共 6 个、35 个测试通过。
- [x] 全量回归：`npm test`，89 个测试文件、353 个测试全部通过，包含现有 OpenSSH fixture。
- [x] 静态检查：`npm run typecheck`、`npm run lint` 通过。
- [x] 生产构建：`npm run build` 通过；仅有既有前端 chunk 超过 500 kB 的提示。
- [x] Chromium：`npm run test:e2e -- --project=chromium tests/e2e/ssh-productivity.spec.ts`，2/2 通过；覆盖桌面双栏、390px 单栏、根节点无横向溢出、SFTP 上传/下载和恢复路径。
- [x] `git diff --check` 通过；代码 feature commit：`81150cb`。
- [ ] 证据缺口：真实浏览器原生拖放事件和没有 File System Access API 时的多选文件降级已分别由 DOM/Chromium 路径覆盖，但跨设备原生文件选择器和完整的移动端触控拖放仍留给 X-02/U-04；上传源文件不持久化，服务重启后需用户重新选择源文件才能继续上传。

---

## Task U-04: 视觉系统、快捷键、可访问性和响应式

**Status:** Done（2026-09-16）
**Priority:** P1
**Milestone:** M2
**Depends on:** U-01、U-02、U-03 的组件结构；现有主题和 Dialog 基线。

**Files:**

- Create: `src/web/state/shortcut-map.ts`
- Create: `src/web/components/ShortcutMap.tsx`
- Modify: `src/web/theme.ts`, `src/web/styles.css`, `src/web/components/Dialog.tsx`, `src/web/components/HostKeyDialog.tsx`, `src/web/components/HostCard.tsx`, `src/web/components/TerminalToolbar.tsx`, `src/web/components/SftpPanel.tsx`, `src/web/components/TerminalWorkspace.tsx`, `src/web/components/HostForm.tsx`, `src/web/components/IdentityEditor.tsx`, `src/web/components/SnippetEditor.tsx`, `src/web/components/WorkspaceSettings.tsx`, `src/web/App.tsx`
- Test: `tests/unit/web/theme.test.ts`, `tests/unit/web/dialog.dom.test.tsx`, `tests/unit/web/host-key-dialog.dom.test.tsx`, `tests/unit/web/host-card.dom.test.tsx`, `tests/unit/web/sftp-panel.dom.test.tsx`, `tests/unit/web/shortcut-map.test.ts`, `tests/unit/web/shortcut-map.dom.test.tsx`, `tests/unit/web/app.dom.test.tsx`, `tests/unit/web/terminal-workspace.dom.test.tsx`, `tests/e2e/host-to-terminal.spec.ts`

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

- [x] **Step 1: 写键盘、焦点和视口回归测试。**

  覆盖输入框内不抢快捷键、终端内 Ctrl/Cmd+C 的复制/中断语义、Quick Switcher 焦点、Host Key 高风险默认按钮、320/390px 宽度、短高度、软键盘等价路径和高对比主题。

- [x] **Step 2: 实现 Shortcut Map 和统一控制规范。**

  将快捷键定义从组件事件中集中出来；展示可搜索的 Shortcut Map；同一动作提供按钮、快捷键和可访问名称，不让浏览器、终端和 Relay 互相抢占。

- [x] **Step 3: 收敛视觉层级。**

  终端占主要视觉空间；资产使用卡片/列表；减少顶部按钮、无意义渐变和过量阴影；用环境徽标、协议、最近活动和 Host Key 状态辅助扫视。

- [x] **Step 4: 运行页面级验证。**

  ```bash
  export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
  npm test -- --run tests/unit/web/theme.test.ts tests/unit/web/dialog.dom.test.tsx tests/unit/web/host-key-dialog.dom.test.tsx tests/unit/web/host-card.dom.test.tsx tests/unit/web/terminal-workspace.dom.test.tsx
  npm run test:e2e -- --project=chromium tests/e2e/host-to-terminal.spec.ts
  ```

- [x] **Step 5: 提交 UI 基础 slice。**

  ```bash
  export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
  git add src/web/state/shortcut-map.ts src/web/theme.ts src/web/styles.css src/web/components/Dialog.tsx src/web/components/HostKeyDialog.tsx src/web/components/HostCard.tsx src/web/components/TerminalToolbar.tsx src/web/components/SftpPanel.tsx src/web/App.tsx tests/unit/web/theme.test.ts tests/unit/web/dialog.dom.test.tsx tests/unit/web/host-key-dialog.dom.test.tsx tests/unit/web/host-card.dom.test.tsx tests/unit/web/terminal-workspace.dom.test.tsx tests/e2e/host-to-terminal.spec.ts
  git diff --cached --check
  git commit -m "feat: standardize relay interaction and accessibility"
  ```

  Feature commit：`4ee6efd`（`feat: standardize relay interaction and accessibility`）。

**Acceptance:** 核心任务可以键盘或触控完成；320/390px 和短视口不溢出；高风险操作可读、可聚焦、可撤销/拒绝；主题和状态不依赖颜色单独传达。

**Verification:**

- [x] Focused DOM/keyboard 回归：9 个文件、42 个测试通过；覆盖普通输入框不抢快捷键、终端 Ctrl/Cmd+C 与 Ctrl/Cmd+K 语义、Alt+数字聚焦面板、Dialog/Host Key 焦点循环和 icon-only tooltip。
- [x] Chromium：`npm run test:e2e -- --project=chromium tests/e2e/host-to-terminal.spec.ts`，1/1 通过；覆盖表单输入、快捷键面板、高对比主题、320px/390px 宽度和 430px 短视口无横向溢出。
- [x] 静态检查：`npm run typecheck`、`npm run lint` 通过。
- [x] 生产构建：`npm run build` 通过；仅保留既有前端 chunk 超过 500 kB 的提示。
- [x] `git diff --check` 通过；代码 feature commit：`4ee6efd`。
- [ ] 证据缺口：真实屏幕阅读器（NVDA/VoiceOver）、实体移动设备软键盘和原生触控拖放尚未覆盖，保留给移动端/跨端验证（X-02）和后续可访问性专项。

---

## Task O-01: Snippet、批量命令和目标选择器的生产力闭环

**Status:** Done（2026-09-16）
**Priority:** P1
**Milestone:** M3
**Depends on:** U-01 Quick Switcher、U-02 Broadcast 目标快照、R-01 任务终态。

**Files:**

- Modify: `src/shared/core/target-selection.ts`, `src/shared/core/command-safety.ts`, `src/shared/core/command-results.ts`, `src/shared/core/models.ts`, `src/shared/validation.ts`
- Modify: `src/server/automation/command-runner.ts`, `src/server/automation/command-run-store.ts`, `src/server/api/command-routes.ts`, `src/server/audit/audit-service.ts`
- Modify: `src/web/components/HostTargetPicker.tsx`, `src/web/components/CommandRunDialog.tsx`, `src/web/components/CommandRunResults.tsx`, `src/web/components/SnippetPalette.tsx`, `src/web/components/SnippetPicker.tsx`, `src/web/components/ActivityPanel.tsx`, `src/web/App.tsx`
- Test: `tests/unit/shared/target-selection.test.ts`, `tests/unit/shared/validation.test.ts`, `tests/unit/shared/command-results.test.ts`, `tests/unit/server/command-runner.test.ts`, `tests/unit/server/command-run-store.test.ts`, `tests/unit/server/audit-service.test.ts`, `tests/integration/server/command-routes.test.ts`, `tests/unit/web/host-target-picker.dom.test.tsx`, `tests/unit/web/command-run-dialog.dom.test.tsx`, `tests/unit/web/command-run-results.dom.test.tsx`, `tests/unit/web/snippet-palette.dom.test.tsx`, `tests/unit/web/activity-panel.dom.test.tsx`

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

- [x] **Step 1: 写目标漂移、变量和结果测试。**

  覆盖从 Server/Group/Recent/Tag 选择、重复 Host 去重、执行前列表变化、缺失/多余变量、高风险命令、单台失败、多台部分成功、取消、TTL 过期。

- [x] **Step 2: 实现固定目标快照和结果模型。**

  从当前筛选生成 `TargetSelectionSnapshot`；服务端重新解析并拒绝跨 owner/不存在 Host；结果以 hostId 隔离，不让 UI 自己合并退出码或输出。

- [x] **Step 3: 打通 Snippet palette 到预览。**

  `Ctrl/Cmd+Shift+P` 与 Quick Switcher 共享搜索和标签语义；选中后填充命令/变量，预览显示实际目标、展开后的非敏感摘要和确认要求。

- [x] **Step 4: 增加结果筛选、异常聚合和输出 diff。**

  只对用户主动选择的主机/结果做横向对比；长输出分页或按主机加载，默认不把所有主机输出同时塞入 DOM。

- [x] **Step 5: 运行聚焦测试并提交。**

  ```bash
  export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
  npm test -- --run tests/unit/shared/target-selection.test.ts tests/unit/shared/validation.test.ts tests/unit/shared/command-results.test.ts tests/unit/server/command-runner.test.ts tests/unit/server/command-run-store.test.ts tests/unit/server/audit-service.test.ts tests/integration/server/command-routes.test.ts tests/unit/web/host-target-picker.dom.test.tsx tests/unit/web/command-run-dialog.dom.test.tsx tests/unit/web/command-run-results.dom.test.tsx tests/unit/web/snippet-palette.dom.test.tsx tests/unit/web/activity-panel.dom.test.tsx
  git add src/shared/core/target-selection.ts src/shared/core/command-safety.ts src/shared/core/models.ts src/shared/validation.ts src/server/automation/command-runner.ts src/server/automation/command-run-store.ts src/server/api/command-routes.ts src/server/audit/audit-service.ts src/web/components/HostTargetPicker.tsx src/web/components/CommandRunDialog.tsx src/web/components/CommandRunResults.tsx src/web/components/SnippetPalette.tsx src/web/components/SnippetPicker.tsx src/web/components/ActivityPanel.tsx src/web/App.tsx tests/unit/shared/target-selection.test.ts tests/unit/shared/validation.test.ts tests/unit/server/command-runner.test.ts tests/unit/server/command-run-store.test.ts tests/integration/server/command-routes.test.ts tests/unit/web/host-target-picker.dom.test.tsx tests/unit/web/command-run-dialog.dom.test.tsx tests/unit/web/snippet-palette.dom.test.tsx tests/unit/web/activity-panel.dom.test.tsx
  git diff --cached --check
  git commit -m "feat: improve snippet and multi-host task workflow"
  ```

**Acceptance:** 不打开终端也能安全选择目标；目标在提交时固定；每台 Host 的状态和输出可独立查看；Snippet 不能绕过变量校验和人工确认。

**Verification:** shared target snapshot、snippet/batch server、Web picker/results tests 和多 Host Chromium E2E；发布前执行敏感输出/变量脱敏扫描。

**Delivery evidence（2026-09-16）:**

- Code commit: `8374de6` (`feat: improve snippet and multi-host task workflow`).
- 新增 `TargetSelectionSnapshot`，保留 source、capturedAt、去重后的 hostIds 和 displayNames；CommandRunner 在入队前校验请求 hostIds 与快照一致，并按 owner 重新解析 Host。
- CommandRun 加入 requestId、目标快照和服务端计算的独立目标汇总；快照和 requestId 随命令密文恢复，输出仍只在 `persistOutput=true` 时进入 Vault 密文。
- Snippet palette 与 Quick Switcher 共用 token/fuzzy 搜索；Snippet 进入批量预览，提交时回传模板和变量，由 server 再次校验缺失/多余变量；常见敏感变量只在预览中遮罩。
- 结果页加入主机/状态/错误码筛选、异常聚合、请求 ID、按主机展开输出和显式主机选择后的 line diff；默认不同时渲染所有主机输出。
- Focused 验证：12 个相关 test files、52 项测试通过；Chromium `tests/e2e/ssh-productivity.spec.ts` 2/2 通过；`npm run typecheck`、`npm run lint` 通过；完整测试和生产构建在提交前执行。
- 变更文件：`src/shared/core/command-results.ts`、target selection/validation/command safety、CommandRunner/Store/routes/audit、HostTargetPicker/CommandRunDialog/CommandRunResults/SnippetPalette/ActivityPanel/App/navigation state/styles，以及对应 shared/server/Web 测试和 SSH fixture E2E。

---

## Task S-01: Identity、Host Key 和安全确认体验收口

**Status:** Done（2026-09-16）
**Priority:** P1
**Milestone:** M3
**Depends on:** R-01 状态/错误语义；现有 Identity、Group inheritance 和 Host Key policy。

**Files:**

- Modify: `src/shared/core/connection-resolution.ts`, `src/shared/core/models.ts`, `src/shared/validation.ts`, `src/shared/errors.ts`
- Modify: `src/shared/core/ports.ts`, `src/shared/protocol.ts`
- Modify: `src/server/identity/identity-service.ts`, `src/server/ssh/host-key-policy.ts`, `src/server/ssh/connection-resource-provider.ts`, `src/server/api/identity-routes.ts`, `src/server/api/host-routes.ts`
- Modify: `src/server/db/repositories.ts`
- Modify: `src/web/App.tsx`, `src/web/api.ts`, `src/web/platform/web-adapters.ts`, `src/web/hooks/use-terminal-session.ts`, `src/web/styles.css`
- Modify: `src/web/components/HostForm.tsx`, `src/web/components/HostCard.tsx`, `src/web/components/HostList.tsx`, `src/web/components/HostWorkspace.tsx`, `src/web/components/IdentityManager.tsx`, `src/web/components/IdentityEditor.tsx`, `src/web/components/HostKeyDialog.tsx`
- Test: `tests/unit/shared/connection-resolution.test.ts`, `tests/unit/server/identity-service.test.ts`, `tests/unit/server/host-key-policy.test.ts`, `tests/integration/server/host-routes.test.ts`, `tests/integration/server/terminal-gateway.test.ts`, `tests/unit/web/host-form.dom.test.tsx`, `tests/unit/web/host-card.dom.test.tsx`, `tests/unit/web/host-key-dialog.dom.test.tsx`, `tests/unit/web/identity-manager.dom.test.tsx`, `tests/unit/web/web-adapters.test.ts`

**Interfaces and policy:**

- 固定 username 解析策略：Host 明确填写的 username 优先；Identity username 只作为创建/切换时的表单默认值；Group 默认 Identity 不覆盖已经明确填写的 Host username。
- Host Key 变化流程展示地址、算法、旧 SHA-256 指纹、新 SHA-256 指纹和安全动作；不提供“跳过校验”按钮。
- Identity metadata 可显示名称、用户名、类型、指纹和使用数量；password/privateKey/passphrase 只在 server Vault 密文中使用。

- [x] **Step 1: 写 username/Host Key 安全测试。**

  覆盖 Host/Identity/Group 三层 username 优先级、首次指纹、已知指纹变化、拒绝后重试、清除旧信任后重新确认、Identity 删除前使用量检查。

- [x] **Step 2: 实现解析和完整变更流。**

  将旧/新指纹传给显式安全 Dialog；拒绝不会更新信任；清除旧信任是单独的安全操作；连接资源 provider 使用同一 `resolveConnectionConfiguration()`。

- [x] **Step 3: 优化表单和卡片信息。**

  Host 卡片显示最终身份来源、环境和 Host Key 状态；表单将 inline/Identity/Group source 分组，避免用户误以为编辑 Identity 会覆盖 Host 的显式 username。

- [x] **Step 4: 运行安全 focused tests 并提交。**

  ```bash
  export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
  npm test -- --run tests/unit/shared/connection-resolution.test.ts tests/unit/server/identity-service.test.ts tests/unit/server/host-key-policy.test.ts tests/integration/server/host-routes.test.ts tests/unit/web/host-form.dom.test.tsx tests/unit/web/host-key-dialog.dom.test.tsx tests/unit/web/identity-manager.dom.test.tsx
  git add src/shared/core/connection-resolution.ts src/shared/core/models.ts src/shared/validation.ts src/shared/errors.ts src/server/identity/identity-service.ts src/server/ssh/host-key-policy.ts src/server/ssh/connection-resource-provider.ts src/server/api/identity-routes.ts src/server/api/host-routes.ts src/web/components/HostForm.tsx src/web/components/HostCard.tsx src/web/components/IdentityManager.tsx src/web/components/IdentityEditor.tsx src/web/components/HostKeyDialog.tsx tests/unit/shared/connection-resolution.test.ts tests/unit/server/identity-service.test.ts tests/unit/server/host-key-policy.test.ts tests/integration/server/host-routes.test.ts tests/unit/web/host-form.dom.test.tsx tests/unit/web/host-key-dialog.dom.test.tsx tests/unit/web/identity-manager.dom.test.tsx
  git diff --cached --check
  git commit -m "feat: clarify identity and host key safety flows"
  ```

**Acceptance:** 用户能看懂凭据/身份的最终来源；Host Key 变化不会静默放行；删除、替换和恢复信任都不会留下旧密文或错误的信任关系。

**Verification:** connection-resolution、identity、Host Key policy、route 和 Dialog focused tests；覆盖拒绝/清除旧信任/重新确认路径，并执行敏感数据扫描。

**Delivery evidence（2026-09-16）：**

- `b3d4c8e feat: clarify identity and host key safety flows`：Host username 优先级和 Identity 默认用户名、Identity 轮换时清理旧 key metadata、Host Key algorithm/fingerprint 变化 challenge、拒绝保留旧信任、显式替换、独立清除信任 API（`DELETE /api/hosts/:id/host-key`）、非交互资源的严格 Host Key 校验，以及 Host/Identity/Group/Host Key UI 信息收口。
- focused security suite：9 个文件、41 个测试通过；Terminal WebSocket changed-key flow 通过集成测试，覆盖旧/新指纹传递与显式替换。
- full validation：`npm test` 93 个文件 / 381 个测试通过；`npm run build`、`npm run typecheck`、`npm run lint`、`git diff --check` 通过；敏感字段仍只在服务端 Vault 路径处理，Host/Identity metadata 和审计路径未返回凭据正文。
- Chromium E2E：`host-to-terminal.spec.ts`、`ssh-productivity.spec.ts` 共 3/3 通过。

---

## Task O-02: Activity、会话日志、复盘和远程编辑边界

**Status:** Done（2026-09-16；Session Log 与远程编辑保持 Deferred）
**Priority:** P1/P2
**Milestone:** M3
**Depends on:** R-01 的 operation event；O-01 的结果模型；现有审计脱敏规则。

**Files:**

- Modify: `src/shared/core/models.ts`, `src/shared/core/ports.ts`, `src/server/audit/audit-service.ts`, `src/server/api/audit-routes.ts`, `src/server/db/repositories.ts`, `src/server/db/types.ts`
- Modify: `src/web/api.ts`, `src/web/platform/web-adapters.ts`, `src/web/components/ActivityPanel.tsx`, `src/web/components/CommandRunResults.tsx`, `src/web/App.tsx`, `src/web/styles.css`
- Modify tests/fixtures: `tests/fixtures/native-runtime.ts`, `tests/unit/server/audit-service.test.ts`, `tests/integration/server/audit-routes.test.ts`, `tests/unit/server/command-run-store.test.ts`, `tests/unit/web/activity-panel.dom.test.tsx`, `tests/unit/web/command-run-results.dom.test.tsx`
- Create: none; `SessionLogPanel` is not created while the opt-in raw-terminal contract remains unapproved.

**Interfaces:**

- Activity 默认只保存固定 metadata：`runId`、`transferId`、`hostId`、`eventType`、`durationMs`、`successCount`、`failureCount`、`requestId` 等；命令正文、展开变量、终端原始输入输出和文件内容不进入普通 activity。
- Session logs 必须是显式 opt-in、加密、可设 retention、可删除/导出，并在 UI 中标记是否包含终端原始内容；没有完整威胁模型前不实现默认录制。
- 远程编辑第一阶段采用临时下载/外部编辑/保存回远端，不在浏览器中保留永久明文副本。

- [x] **Step 1: 写脱敏和 TTL 测试。**

  审计 metadata 采用固定白名单，拒绝 secrets/命令/变量/终端内容；完成、失败、取消和服务重启中断的结果都会按 TTL 清理；结果删除会级联清理目标输出；Web 锁定时清空当前 Activity、诊断、结果和传输临时状态，过期链接显示“需要重新执行”。

- [x] **Step 2: 实现可搜索 Activity 和结果复盘。**

  Activity API/界面支持按 Host、类型、状态、时间和 request id 查询，服务端 cursor 分页并由前端显式加载更多；批量结果保留异常聚合、逐 Host 状态筛选、跳转到具体 Host、输出 diff 和每页 20 台的结果分页，输出默认折叠且沿用服务端截断上限。

- [x] **Step 3: 单独评审 Session Log 和远程编辑边界。**

  评审结论：普通 Activity 只允许结构化 metadata；命令正文、展开变量、终端原始 I/O、文件内容不进入普通 Activity。Session Log 暂不实现，待明确 opt-in、加密、retention、导出、删除、权限和“包含原始终端内容”标识后再立项；SFTP 继续保持浏览、传输和 entry mutation，不在浏览器落永久明文编辑副本。该边界记录为 Deferred。

- [x] **Step 4: 运行审计 focused tests 并提交。**

  ```bash
  export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
  npm test -- --run tests/unit/server/audit-service.test.ts tests/integration/server/audit-routes.test.ts tests/unit/server/command-run-store.test.ts tests/unit/web/activity-panel.dom.test.tsx tests/unit/web/command-run-results.dom.test.tsx
  git add src/shared/core/models.ts src/shared/core/ports.ts src/server/audit/audit-service.ts src/server/api/audit-routes.ts src/server/db/repositories.ts src/server/db/types.ts src/web/api.ts src/web/platform/web-adapters.ts src/web/components/ActivityPanel.tsx src/web/components/CommandRunResults.tsx src/web/App.tsx src/web/styles.css tests/fixtures/native-runtime.ts tests/unit/server/audit-service.test.ts tests/integration/server/audit-routes.test.ts tests/unit/server/command-run-store.test.ts tests/unit/web/activity-panel.dom.test.tsx tests/unit/web/command-run-results.dom.test.tsx docs/superpowers/plans/2026-09-16-relay-long-term-roadmap.md
  git diff --cached --check
  git commit -m "feat: improve activity and task review"
  ```

**Delivery evidence（2026-09-16）：** focused 5 files / 19 tests passed；此前完整回归 93 files / 387 tests passed；`npm run build`、`npm run typecheck`、`npm run lint`、`git diff --check` passed。最后追加的 Host 跳转为低风险 UI 增量，并由 `command-run-results.dom.test.tsx` 覆盖。

**Acceptance:** Activity 可检索、可关联、可过期；默认不记录交互式终端；任何日志/编辑能力都有明确的数据生命周期和安全开关。Session Log 未通过安全评审，保持 Deferred。

**Verification:** audit unit/integration、Activity/results DOM tests、TTL/锁定清理验证和人工数据分类走查；Session Log 未通过安全评审时只保留 Deferred 状态。

---

## Task O-03: 导入/导出、FinalShell/Netcatty 迁移和可逆性

**Status:** Done
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

- [x] **Step 1: 收集真实样本并写 parser/round-trip 失败测试。**

  现有五种已支持格式使用脱敏的结构化 fixture 和 parser 回归；OpenSSH/CSV 增加了导出后再次解析、跳板关系重绑定和身份引用保留断言。FinalShell/Netcatty 没有进入实现清单，格式边界和替代迁移路径记录在 `docs/ssh-interoperability-guide.md`，不猜测其原生 schema。

- [x] **Step 2: 实现检测、预览、冲突和可逆导出。**

  复用现有 dedupe/normalize；保持 Group/Identity/ProxyJump 关系；导入先 preview 再 transaction apply；未知 XML 不再仅凭 `.xml` 扩展名误判为 SecureCRT；设置页明确显示支持格式和 FinalShell/Netcatty 原生格式边界；事务写入失败回滚分组和已写入 Host。

- [x] **Step 3: 运行导入回归并提交。**

  ```bash
  export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
  npm test -- --run tests/unit/shared/import/detect.test.ts tests/unit/shared/import/vendor-parsers.test.ts tests/unit/shared/import/round-trip.test.ts tests/unit/server/ssh-import-service.test.ts tests/integration/server/ssh-import-routes.test.ts tests/unit/web/workspace-settings.dom.test.tsx
  git add src/shared/import/detect.ts src/shared/import/normalize.ts src/shared/import/dedupe.ts src/shared/import/export.ts src/shared/import/types.ts src/shared/import/index.ts src/shared/import/parsers/finalshell.ts src/shared/import/parsers/netcatty.ts src/server/workspace/ssh-import-service.ts src/server/workspace/vault-bundle-service.ts src/server/api/ssh-import-routes.ts src/server/api/vault-routes.ts src/web/components/WorkspaceSettings.tsx tests/unit/shared/import/detect.test.ts tests/unit/shared/import/vendor-parsers.test.ts tests/unit/shared/import/round-trip.test.ts tests/unit/server/ssh-import-service.test.ts tests/integration/server/ssh-import-routes.test.ts tests/unit/web/workspace-settings.dom.test.tsx
  git diff --cached --check
  git commit -m "feat: extend ssh migration coverage"
  ```

**Acceptance:** 用户能在导入前知道字段缺失和冲突；导入事务失败不损坏现有数据；至少一种通用导出可再次导入并保持 Host/Group/Identity 关系；不把未经证实的 native export 当卖点。

**Verification:** parser/detect/round-trip unit、import service/route integration 和 Workspace Settings DOM tests；O-03 聚焦验证共 6 个测试文件、29 项断言通过；未知 XML 误判和事务回滚均有回归；每种格式只使用脱敏 fixture，导入失败后复核 Vault 未变化。FinalShell/Netcatty 原生格式保持 Deferred，待获得可验证 schema 和许可边界后单独立项。

---

## Task X-01: Capability、跨端 contract 和规模性能门槛

**Status:** Done（2026-09-16）
**Priority:** P1/P2
**Milestone:** M4
**Depends on:** R-01、U-02、U-03 的 capability 使用点；现有 `CoreRuntime` 和 native-like runtime。

**Files:**

- Modify: `src/shared/core/capabilities.ts`, `src/shared/core/ports.ts`, `src/shared/core/runtime.ts`, `src/shared/core/models.ts`
- Modify: `src/web/platform/web-adapters.ts`, `src/web/App.tsx`, `src/web/components/TerminalWorkspace.tsx`, `src/web/components/SftpWorkspace.tsx`
- Modify: `src/web/components/HostWorkspace.tsx`, `src/web/components/TerminalPanel.tsx`, `src/web/components/TransferCenter.tsx`, `src/web/state/navigation-state.ts`, `src/web/terminal-output.ts`, `src/web/styles.css`
- Modify: `tests/fixtures/core-runtime-contract.ts`, `tests/fixtures/native-runtime.ts`, `tests/unit/shared/core-adapter-contract.test.ts`, `tests/unit/shared/native-adapter-contract.test.ts`, `tests/unit/web/web-adapters.test.ts`
- Modify: `tests/unit/shared/core-models.test.ts`, `tests/unit/web/sftp-workspace.dom.test.tsx`, `tests/unit/web/transfer-center.dom.test.tsx`
- Create: `tests/performance/host-vault-scale.test.ts`, `tests/performance/terminal-output-scale.test.ts` only when the test runner supports stable timing thresholds
- Modify: `docs/architecture/cross-platform.md`

**Interfaces:**

- Capability 名称必须表达行为，不表达平台：`workspace.max-panes`、`transfer.resume`、`terminal.broadcast`、`sftp.local-files`、`session.reattach`、`forwarding.local`、`account.auth`、`device.trust`、`sync.encrypted` 等。
- `CoreRuntime.negotiateCapabilities()` 返回 client、server 和交集；UI 对不可用能力显示原因或隐藏入口，但不能在 UI 旁路 server 权限。账号/同步能力缺失时必须稳定降级到 Local-only。
- Web/native contract tests 同时验证 Host Key、SFTP 路径、批量目标、任务终态、取消、输出上限、导入/导出和错误码。

- [x] **Step 1: 补 capability matrix 和 contract 失败测试。**

  覆盖 Web、native-like 和能力缺失三种 runtime；不同 pane 上限、不可恢复传输、无本地文件选择器时的降级均有断言。

- [x] **Step 2: 实现能力交集和 UI 降级。**

  删除按 `client === 'web'` 的业务分支；使用 capability 控制按钮、面板和错误文案；共享规则只存在于 core/adapter，不复制到平台组件。

- [x] **Step 3: 建立规模测试。**

  在不绑定脆弱的绝对机器时间前提下，验证 1,000 Host 列表搜索不会阻塞输入、长终端输出不会无限增长 DOM、传输队列不会泄漏订阅；先记录基线，再设回归阈值。

- [x] **Step 4: 运行 contract/性能 focused tests 并提交。**

  ```bash
  export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
  npm test -- --run tests/unit/shared/core-models.test.ts tests/unit/shared/core-adapter-contract.test.ts tests/unit/shared/native-adapter-contract.test.ts tests/unit/web/web-adapters.test.ts tests/unit/web/sftp-workspace.dom.test.tsx tests/unit/web/transfer-center.dom.test.tsx tests/performance/host-vault-scale.test.ts tests/performance/terminal-output-scale.test.ts
  npm run lint
  npm run typecheck
  git add src/shared/core/capabilities.ts src/shared/core/ports.ts src/shared/core/runtime.ts src/shared/core/models.ts src/web/platform/web-adapters.ts src/web/App.tsx src/web/components/HostWorkspace.tsx src/web/components/TerminalPanel.tsx src/web/components/TerminalWorkspace.tsx src/web/components/SftpWorkspace.tsx src/web/components/TransferCenter.tsx src/web/state/navigation-state.ts src/web/terminal-output.ts src/web/styles.css tests/fixtures/core-runtime-contract.ts tests/fixtures/native-runtime.ts tests/unit/shared/core-models.test.ts tests/unit/shared/core-adapter-contract.test.ts tests/unit/shared/native-adapter-contract.test.ts tests/unit/web/web-adapters.test.ts tests/unit/web/sftp-workspace.dom.test.tsx tests/unit/web/transfer-center.dom.test.tsx tests/performance/host-vault-scale.test.ts tests/performance/terminal-output-scale.test.ts docs/architecture/cross-platform.md docs/superpowers/plans/2026-09-16-relay-long-term-roadmap.md
  git diff --cached --check
  git commit -m "test: enforce capability and cross-platform contracts"
  ```

**Acceptance:** Web/native-like runtime 共享状态和安全规则；能力缺失时可解释降级；规模测试有可重复的基线和阈值；shared core 不引入平台依赖。

**Verification:** focused contract/performance tests 8 files / 26 tests passed；`npm run lint` passed；`npm run typecheck` passed；Q-01 release gate `npm test` 95 files / 398 tests passed，`npm run build` Web/server 均成功，`npm run test:e2e` Chromium 3/3 passed。client/server/intersection、Local-only、不可恢复传输和 1,000 Host 搜索规模回归均有测试证据；build 仅保留既有的 Web bundle >500 kB 提示。

---

## Task X-02: PWA、桌面和移动端产品化边界

**Status:** In Progress（PWA shell 子项目已交付；Desktop/Android implementation plan 待拆分）
**Priority:** P2
**Milestone:** M4
**Depends on:** X-01；R-03 的生命周期状态；U-04 的交互 token。

**Files:**

- Create: `docs/superpowers/specs/2026-09-16-relay-platform-shell-design.md`
- Create: `docs/superpowers/plans/2026-09-16-relay-pwa-shell-implementation.md`
- Modify: `docs/architecture/cross-platform.md`
- Implemented Web files: `index.html`, `public/`, `src/web/platform/pwa-registration.ts`, `src/web/platform/browser-system-services.ts`, `src/shared/core/ports.ts`, `src/shared/core/runtime.ts` 及对应测试。
- Later Desktop/Android implementation files: 由上述 spec 确定，不在本任务中直接创建原生工程。

**Interfaces and decisions to specify:**

- PWA：安装、离线壳、网络切换、文件选择、下载、剪贴板和通知的支持/降级矩阵。
- Desktop：本地 SSH vs server transport、OS keychain、系统托盘、窗口恢复、代理和文件系统权限。
- Mobile：单 pane、底部操作栏、软键盘、后台挂起、网络切换、文件分享和生物识别。
- 所有平台必须复用 Host Key、任务终态、SFTP 路径、批量目标、并发/超时/输出上限和审计语义。

- [x] **Step 1: 为每个平台写任务清单和威胁模型。**

  以“找 Host → 连接 → 输入命令 → 传文件 → 锁定/恢复”为基线，不把桌面 UI 缩小到手机，不让移动后台继续使用未授权的凭据。

- [x] **Step 2: 写平台 capability/adapter contract。**

  规定 `SecretStore`、`SessionTransport`、`FileTransport`、`NotificationPort` 和 `ClipboardPort` 的职责；明确哪些数据可离线、哪些必须在线。

- [x] **Step 3: 提交 spec 并发起评审。**

  ```bash
  export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
  git add docs/superpowers/specs/2026-09-16-relay-platform-shell-design.md docs/architecture/cross-platform.md
  git diff --cached --check
  git commit -m "docs: define relay platform shell boundaries"
  ```

- [x] **Step 4: 建立并交付 PWA Web shell 子项目。**

  实现计划为 [`relay-pwa-shell-implementation.md`](./2026-09-16-relay-pwa-shell-implementation.md)，已覆盖可安装 shell、service worker 安全缓存、网络/离线反馈、浏览器文件边界、剪贴板、通知权限和 320px/Chromium 验证；未引入 native 工程、local SSH 或后台凭据。

- [ ] **Step 5: spec 通过后另立 Desktop/Android implementation plan。**

  桌面和 Android 不作为本 master plan 的隐式代码任务；每个平台有自己的文件地图、设备测试和发布门槛。

**Acceptance:** 平台选择、离线/在线、secret store、生命周期和 UI 降级均有明确答案；没有把 Web DOM 或浏览器 Blob 传播到 shared core。

**Verification:** spec artifact/链接检查、平台威胁模型评审和 capability/adapter contract review；PWA 子项目已通过 focused Vitest、lint、typecheck、Web build 和 Chromium e2e；spec 未批准前不创建桌面或移动端实现代码。

---

## Task X-03: 端口转发、Agent Forwarding 和协议能力分层

**Status:** In Progress（spec 草案已提交，待安全评审）
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

- [x] **Step 1: 写威胁模型、数据流和错误矩阵。**

  已在 [`relay-forwarding-and-protocol-boundaries.md`](../specs/2026-09-16-relay-forwarding-and-protocol-boundaries.md) 覆盖绑定地址、端口抢占、跳板失败、凭据/Agent 暴露、服务重启、锁定、浏览器 tunnel、协议隔离和审计；并明确不可用时的 `CAPABILITY_UNAVAILABLE`。

- [ ] **Step 2: 写失败的 capability/route 测试。**

  待安全评审和 implementation plan 批准后执行。断言跨 owner、无权限、环路、无 Host Key 信任、bind/target policy 和不支持平台均拒绝；成功 forwarding 有可取消/可停止的生命周期。本轮不提前创建 route 或测试假实现，避免把未批准能力变成可用入口。

- [ ] **Step 3: 评审 spec，再为批准能力建立独立 implementation plan。**

  未完成安全评审前不向 Web 主导航加入入口，不以“功能矩阵对齐”为理由跳过权限和审计。

**Acceptance:** 每个协议或转发能力都有独立边界、权限、审计、错误和平台矩阵；未批准的能力不会出现在当前产品 UI。

**Verification:** capability/route focused tests、威胁模型和数据流评审；批准前只验证 spec，不把未实现协议加入导航或发布说明。

**Progress record (2026-09-16):** 已创建并链接 forwarding/protocol boundary spec；本轮完成文档结构、关联链接和差异检查。capability/route tests、ForwardingManager implementation 和 Web UI 入口均等待安全评审后的独立 implementation plan。

---

## Task X-04: 个人账号、设备信任与端到端加密同步

**Status:** In Progress（核心 Web/自托管切片已完成；M5 完整安全闭环仍在进行）
**Priority:** P2
**Milestone:** M5
**Depends on:** X-01 的 capability/contract；X-02 的平台 secret store 和生命周期；R-03 的 Local/恢复语义；现有 Vault crypto 和事务导入边界。

**Files:**

- Read: `docs/superpowers/specs/2026-09-16-relay-account-and-encrypted-sync-design.md`
- Create: `docs/superpowers/plans/2026-09-16-relay-account-and-encrypted-sync-implementation.md`
- Implemented: `src/shared/core/capabilities.ts`, `src/shared/core/ports.ts`, `src/shared/core/models.ts`, `src/shared/errors.ts`, `src/shared/core/account-sync.ts`, `src/server/account/`, `src/server/sync/`, `src/web/components/AccountMenu.tsx`, `src/web/components/SyncCenter.tsx`
- Test: `tests/unit/shared/account-sync-contract.test.ts`, `tests/unit/server/account-service.test.ts`, `tests/unit/server/sync-crypto.test.ts`, `tests/integration/server/sync-routes.test.ts`, `tests/unit/web/account-menu.dom.test.tsx`, `tests/unit/web/sync-center.dom.test.tsx`, `tests/e2e/account-sync.spec.ts`

**Interfaces and invariants:**

- Local-only `CoreRuntime` 不要求账号或同步端口；`account.auth`、`device.trust`、`sync.encrypted` 作为可选 capability 协商。
- Account session 只代表身份/设备/权限；主密码、Vault key、Sync key、私钥、passphrase 和 token 不进入 shared DTO、云端日志或浏览器持久化。
- `SyncEnvelope` 只包含 opaque vault id、revision、keyVersion、密文、nonce、auth tag、AAD、hash 和幂等元数据；新设备所需的 `VaultUnlockEnvelope`/`wrappedSyncKey` 也只能以包装后的密文返回；Blind sync store 不能调用 Vault 解密或 SSH 凭据接口。
- `K_sync` 由现有 `K_vault` 包装；新设备必须用原 Vault 主密码或离线 recovery key 解锁，账号密码重置不能恢复 Vault。
- 登录并解锁后才自动同步；登出停止同步但保留本地数据；设备撤销停止同步但不隐式删除本地 Vault；账号删除默认进入 30 天云端可恢复窗口。
- 首版使用加密 snapshot + revision conflict；Host、Identity、Host Key trust、ProxyJump 和 Snippet command 不允许静默最后写入覆盖。
- 不同步 live Shell、terminal/session id、TransferJob、CommandRun、原始终端内容、SFTP 文件内容或普通 Activity 输出。

- [x] **Step 1: 写 Local-only、账号状态和 capability 失败测试。**

  覆盖未登录无同步请求、登录未解锁为 `needs-unlock`、账号失效/设备撤销和不支持 capability 的降级；确认终端、SFTP、批量命令不依赖账号服务。

- [x] **Step 2: 写加密 envelope 和盲存储测试，并为 recovery wrapper 预留版本边界。**

  当前已覆盖 `K_vault`/`K_sync` 包装、AAD/hash/version、云端 payload 不含明文和密文篡改拒绝；recovery key 生命周期由 X-04A 补齐。同步 API 禁止接收 master password 或 Vault plaintext。

- [x] **Step 3: 实现账号会话与设备信任边界。**

  账号认证采用可替换的 Account provider adapter；Web 使用 HttpOnly Secure session，desktop/Android 使用系统安全存储；设备列表、当前设备、撤销和登出状态进入统一 operation/error 语义。

- [x] **Step 4: 实现离线队列、revision conflict 和事务应用。**

  本地变更先事务提交，再持久化加密待上传 envelope；同步失败不阻塞本地工作；冲突保留两边加密副本并提供 keep-local/use-remote；`export-both` 的独立加密导出仍未完成，应用失败不改变现有 Vault。

- [x] **Step 5: 实现当前 Web/native-like 跨端同步 UI。**

  Account menu 显示 Local-only、Synced、Pending、Offline、Conflict、Needs unlock 和 Device revoked；Sync Center 提供最后同步时间、待处理数量、设备管理、冲突预览和 recovery key 一次展示/离线确认/轮换；Setup/Unlock gate 已提供账号登录后的新设备恢复入口和 preview/apply 确认。删除 re-auth UI 仍未完成。

- [x] **Step 6: 运行跨端 contract、OpenSSH 影响回归和 Release gate。**

  验证同步服务故障不会改变 Host Key、SFTP 路径、批量确认和任务终态；Web、desktop-like、Android-like runtime 共享状态/错误/Local fallback 断言；涉及 Vault、账号、加密、迁移或跨模块行为时按 Q-01 执行全量验证。

**Acceptance（当前状态）:** 未登录时完整 Local-only 可用且没有同步请求；登录并解锁后可创建并同步 opaque encrypted snapshot；已登录的新设备可使用原 Vault 主密码或 active recovery key 预览并事务创建本地 Vault，错误/过期输入不会改变本地状态；云端同步表、审计和普通日志不包含 Vault 明文或可直接使用的 key，recovery key 明文只出现在显式的一次性 issue response 和当前 UI 内存；离线、撤销、登出、revision 冲突、云端删除恢复窗口和 recovery key 生命周期已有验证，个人同步未改变现有 SSH/SFTP/批量安全不变量。冲突导出、真实删除 re-auth 和账号删除语义尚未满足最终 Acceptance。

**Verification:** account/sync shared contract、加密单元、server integration、DOM/E2E、跨端 fake 和敏感数据扫描已通过；migration `SCHEMA_VERSION = 13`，X-04A focused Vitest `8 files / 65 tests` 和历史 release gate 已通过，X-04B focused Vitest `9 files / 73 tests`、当前 full Vitest `106 files / 483 tests`、typecheck、lint、build、默认 E2E `4/4`、account E2E `3/3` 均通过。当前 Web E2E 通过清除本地 app_config/资源表并保留 blind sync 表来模拟独立新设备状态，真实 provider-separated 多数据卷仍需后续架构验证。`secret_persistence_findings = 0` 的扫描结论不覆盖尚未交付的 re-auth/export-both/账号删除安全评审。

**Progress record (2026-09-17):** 已完成实现计划 Task 1–8、Task 9 的敏感数据扫描与技术 release gate；相关提交为 `99410dd`、`1f88039`、`b8b8cb1`、`4b0b5a7`、`acc001c`、`f630ab2`、`9bd95c7`、`1d14100`、`23d0bdd`、`103a1ee` 和 `be07225`。X-04A 已完成实现、focused 验证和历史 Release gate；X-04B 已完成 Web recovery preview/apply、事务 bootstrap、恢复 UI 和 account E2E，最终 focused 9/73、full Vitest 106/483、默认 E2E 4/4、account E2E 3/3 的 release gate 证据见实现计划 Task 11。最终 M5 仍缺真实 provider-separated 多数据卷验证、删除 re-auth、冲突导出和完整账号删除闭环。

**Remaining implementation tasks:**

- [x] **X-04A：实现 recovery key 生命周期。** 生成、一次展示、离线确认、包装/轮换、丢失不可恢复，以及错误 recovery key 不改变本地 Vault；实现与验证证据见 `relay-account-and-encrypted-sync-implementation.md` Task 10，Release gate 已通过。
- [x] **X-04B：实现独立新设备恢复。** 新设备使用主密码或 active recovery key 解开 envelope，先预览再事务创建本地 Vault 并应用 Host/Identity/Group/Snippet/Workspace；Web DOM/App、服务端错误/TTL/一次性 token 和 account-enabled E2E 已覆盖。当前 E2E 通过保留 blind sync 表、清除本地表模拟独立设备状态，真正 provider-separated 多数据卷仍是后续架构任务。
- [ ] **X-04C：实现冲突加密导出。** 将 local/remote 两份以不含明文的可恢复格式导出，下载/文件能力留在 adapter，不在 shared core 引入浏览器对象。
- [ ] **X-04D：实现删除 re-auth 与账号删除闭环。** re-auth 必须由服务端验证且短时有效；账号/云端数据删除、恢复、撤销设备和本地副本保留都要有 UI/API/审计测试。

---

## Task X-05: 团队 Vault、协作同步和受控 Agent/MCP

**Status:** Deferred（个人同步完成前不进入实现）
**Priority:** P2
**Milestone:** M6
**Depends on:** X-01、X-02、X-03、X-04；产品对账号、团队数据归属、权限和部署模型的明确决策。

**Files:**

- Create: `docs/superpowers/specs/2026-09-16-relay-team-sync-agent-boundaries.md`
- Modify: `docs/architecture/cross-platform.md` only after the spec is approved
- Later implementation files: 由 spec 和独立 implementation plan 确定

**Required decisions:**

- 团队 Vault 的 owner、成员、最小权限、共享 key wrapping、离线副本、密钥轮换、审计、撤销和恢复；不能复用个人同步的“单一拥有者”假设。
- 团队协作同步的 provider trust、冲突合并、删除恢复、数据驻留和个人/团队 Vault 的隔离。
- Agent/MCP 的只读/写入/批量能力、人工确认、审批、速率限制、命令预览和 session 隔离。
- UI 中如何区分“建议”“预览”“待确认”“已执行”，不能让自然语言代理静默执行生产命令。

- [ ] **Step 1: 编写团队数据归属和威胁模型。**
- [ ] **Step 2: 定义 capability、permission、audit 和 recovery contract。**
- [ ] **Step 3: 以只读查询/诊断作为最小可行范围评审，写独立执行计划。**
- [ ] **Step 4: 在批准前保持当前产品不变。**

**Acceptance:** 团队/协作/Agent 不改变个人 Local-only 和加密同步承诺；任何写入和批量动作都可预览、确认、审计和停止；成员撤销后权限和离线副本行为可恢复、可验证。

**Verification:** 仅进行独立 spec、权限/威胁模型、密钥恢复和数据归属评审；保持 Deferred，不在当前任务创建团队、协作同步或 Agent 实现代码。

---

## Task Q-01: 统一验证、发布和长期质量门槛

**Status:** Ready
**Priority:** P0（贯穿所有里程碑）
**Milestone:** M0–M6
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

  至少覆盖：初始化/解锁、添加 Host、首次 Host Key、连接、同 Host 多 Console、刷新、网络断线、服务重启、锁定、SFTP 上传/下载/恢复、批量命令、取消、TTL、导入冲突、账号登录/未解锁、加密同步、离线队列、冲突、设备撤销和主题/窄屏。

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
5. **M5 / P2：** X-04 个人账号、设备信任和加密同步；只有完成密钥、恢复、冲突和云端盲存储验证后才实现。
6. **M6 / P2：** X-05 团队 Vault、协作同步和受控 Agent/MCP；只有完成数据、权限、安全和恢复设计后才实现。
7. **每个阶段：** Q-01 更新指标、运行对应验证、人工走查、记录风险、提交变更，并回写本路线图状态。

## 6. 明确不做的事情

- 不复制 Termius/MobaXterm/Netcatty 的全部功能矩阵作为短期目标。
- 不在传输、连接恢复和状态反馈不可信时优先堆 AI、监控、更多协议或视觉装饰。
- 不将 16-pane、账号、云同步、团队协作或 Agent 写死进当前 shared core；账号/同步只能作为可选扩展能力。
- 不把登录账号当作 Local-only 的使用前提，也不把账号密码当作 Vault 解密密钥。
- 不向云端上传明文 Vault、凭据、Host 地址、用户名、Snippet command、终端内容或活动输出；个人同步与团队协作分开建模。
- 不把公开评论、Issue 或营销文案写成所有用户都会遇到的事实。
- 不把原生 UI、系统 keychain、账号登录、离线同步或完整会话录制当作当前 Web-first 版本已经交付的能力。
