# SSH Productivity Roadmap Product Design

**日期：** 2026-09-15

**状态：** Proposed

**背景：** 综合 Termius、SecureCRT、MobaXterm、Xshell 的产品亮点和用户痛点，并结合当前 Web SSH Workspace 的代码、v0.1 需求和新增的跨端/跨平台要求。

## 1. 产品决策

产品下一阶段不追求协议数量，而是围绕一条完整的运维任务链提高生产率：

> 找到主机 → 可靠连接 → 在同一上下文中传文件/执行命令 → 看清结果 → 断线后恢复。

优先级和发布顺序：

1. **P0 可靠底座：** 工作区和 Vault 可恢复、可导出，连接状态和断线恢复可信。
2. **P1 任务闭环：** SFTP 与 SSH 共用连接配置；跳板机优先于端口转发。
3. **P1 操作提效：** 参数化命令片段、安全多主机执行和逐主机结果。
4. **P2 专业化：** 操作日志、批量结果保存/比较和可控审计。
5. **P3 企业扩展：** 团队共享、RBAC、SSO、RDP/X11/串口等。

Web 是当前唯一的一等客户端。桌面版和 Android/Linux/Windows 的跨平台能力通过平台无关的核心模型、协议和端口预留，不在第一阶段提前引入桌面或移动 UI 框架。

## 2. 综合研究结论

### 2.1 竞品可取亮点

- Termius 的工作区、主机分组、跨设备上下文和命令片段降低了记忆成本。
- SecureCRT 的深度会话配置、脚本、跳板机、关键字高亮和凭据引用适合专业网络运维。
- MobaXterm 的 SSH、SFTP、分屏和 MultiExec 集成减少了工具切换。
- Xshell 的会话管理、隧道/代理和 Windows 稳定性仍然有明确价值。

### 2.2 用户痛点共同模式

1. **信任损耗：** 同步、更新、授权变化或配置作用域不清导致主机/凭据/工作状态不可预期。
2. **切换损耗：** SSH、文件传输、跳板、日志和批量执行分散在多个工具中。
3. **恢复损耗：** 弱网、长输出、应用卡顿或浏览器刷新后，需要重新登录并重建上下文。
4. **操作损耗：** 重复命令没有被结构化复用，批量执行又容易误伤。
5. **认知损耗：** 功能很多但入口、作用域和错误原因不清晰。

产品定位因此应当是“可信的跨端 SSH 工作台”，而不是“更大的远程工具箱”。

### 2.3 综合优先级与当前 gap

| 优先级 | 能力/问题 | 竞品可取亮点 | 用户痛点 | 当前 gap | 生产率判断 |
| --- | --- | --- | --- | --- | --- |
| P0-1 | 工作区、Vault、配置迁移和恢复 | Termius 的 workspace/跨设备上下文 | 同步、更新或重启后状态/凭据不可预期，信任成本最高 | 只有短时 sessionStorage，单 Vault 无加密导出，布局不持久 | 高频且一旦出错会阻断全部任务；先做 |
| P0-2 | 连接诊断、重连和资源生命周期 | SecureCRT/Xshell 的深度会话配置、稳定连接；Termius 的恢复体验 | 弱网、Host Key、认证和跳板失败原因不清，刷新后要重建上下文 | 直连 ssh2、诊断粗、无 ProxyJump、SFTP/exec 无统一资源 | 减少等待和重复登录；与所有后续能力复用 |
| P1-1 | SSH 上下文内的 SFTP 文件闭环 | MobaXterm/Termius 的 SSH+SFTP 集成 | 在终端、文件工具之间切换，凭据和路径重复输入 | 当前无 SFTP | 高频运维动作直接闭环；优先于更多协议 |
| P1-2 | Snippets、参数化和安全多主机执行 | SecureCRT 脚本/关键字；MobaXterm MultiExec | 重复命令多，批量执行又容易误伤且结果分散 | 当前只有分屏，没有目标确认、并发/超时/逐主机结果 | 单次操作收益高，但必须先做安全边界 |
| P1-3 | ProxyJump/多级跳板 | SecureCRT/Xshell 的跳板、代理和隧道能力 | 受网络边界限制时无法稳定到达目标主机 | 当前没有多跳；端口转发还缺浏览器访问模型 | 解决可达性阻断；先做 ProxyJump，端口转发后置 |
| P2 | 活动日志、批量结果保存/比较和审计 | 专业工具的日志、脚本结果和可复盘能力 | 不知道做过什么、哪些主机成功、结果差异在哪里 | 仅有脱敏连接事件，无任务摘要和结果视图 | 频率低于连接/文件，但对排障和复盘价值高 |
| P3 | 桌面/Android 原生客户端、团队能力和更多协议 | 跨端工作区、RDP/X11/串口等工具箱能力 | 平台切换和团队协作有需求，但当前 Web 任务仍未闭环 | shared core、capability 和 adapter 边界尚未形成 | 现在只预留核心与契约；原生 UI、RBAC/SSO、RDP 等后置 |

排序原则：先消除会让用户不敢用或无法继续工作的信任/阻断问题，再补齐高频任务闭环，最后建设复盘和企业扩展。端口转发属于高风险边界能力，除非先明确服务端 bind、浏览器访问和权限模型，否则不因竞品存在而提前实现。

### 2.4 研究来源与证据边界

官方功能页：

- [Termius Workspaces](https://termius.com/blog/workspaces-focus-without-losing-context)、[Vaults](https://termius.com/blog/meet-vaults)
- [SecureCRT Key Features](https://www.vandyke.com/products/securecrt/key_features.html)
- [MobaXterm Features](https://mobaxterm.mobatek.net/features.html)
- [Xshell All Features](https://www.xshell.com/en/xshell-all-features/)

用户痛点采用公开 G2、Capterra、App Store 和 Reddit 的体验反馈做交叉归纳；评论存在样本偏差，本文把重复出现且能映射到当前代码 gap 的问题作为优先级输入，不把单条评论当作定量市场结论：

- [Termius G2 Reviews](https://www.g2.com/products/termius/reviews?page=2&qs=pros-and-cons)、[Termius App Store Reviews](https://apps.apple.com/us/app/termius-modern-ssh-client/id549039908?see-all=reviews)
- [SecureCRT G2 Reviews](https://www.g2.com/products/securecrt/reviews)、[SecureCRT Capterra Reviews](https://www.capterra.com/p/234791/SecureCRT/reviews/)
- [MobaXterm Capterra Reviews](https://www.capterra.com/p/209929/MobaXTerm/reviews/)、[MobaXterm TrustRadius Reviews](https://www.trustradius.com/products/mobaxterm/reviews/review-insights)
- [Xshell G2 Reviews](https://www.g2.com/products/xshell/reviews)

## 3. 用户和关键任务

### 3.1 首要用户

- 个人开发者：管理云主机、家用实验室和开发环境。
- DevOps/运维：在一个自托管入口管理开发、测试和生产环境。
- 网络工程师：批量查看或修改交换机、路由器和防火墙。
- 小团队管理员：先使用单实例，未来再引入成员和权限。

### 3.2 关键任务

| 任务 | 用户目标 | 当前主要阻碍 |
| --- | --- | --- |
| 恢复工作 | 刷新、重启或换客户端后继续原来的工作 | 当前只有短时 sessionStorage 描述，布局和工作区意图不持久 |
| 连接主机 | 通过直连或跳板快速进入 shell | 当前没有 ProxyJump/多级跳板，诊断信息较粗 |
| 处理文件 | 在终端旁边上传、下载、浏览和整理文件 | 当前没有 SFTP |
| 批量执行 | 对选定主机执行同一组命令并确认结果 | 当前只有分屏，没有安全批量执行和命令片段 |
| 复盘操作 | 知道执行过什么、哪些主机成功、结果有什么差异 | 当前只记录脱敏连接事件，不记录批量结果和可见活动流 |
| 跨端切换 | Web、桌面和移动端使用同一套主机/连接/操作模型 | 当前 UI、服务端和 ssh2 实现尚未形成平台端口边界 |

## 4. 范围和非目标

### 4.1 本路线图范围

- 持久化工作区：标签意图、活动标签、分屏布局、筛选状态和工作区模板。
- 加密 Vault 导出/导入和恢复预览。
- 连接诊断、Keepalive、指数退避和会话恢复。
- ProxyJump/多级跳板。
- SFTP 浏览、上传、下载、删除、重命名、新建目录、进度、取消和重试。
- Snippets、参数变量和安全多主机执行。
- 批量任务摘要、逐主机结果和可选结果保存。
- 脱敏活动日志和批量任务审计。
- 平台无关的核心 domain types、ports、wire contracts 和 capability model。

### 4.2 明确非目标

- 不在浏览器或服务端执行任意本地 shell 命令。
- 不把密码、私钥、session cookie、token 或完整交互式终端内容写入浏览器持久化存储。
- 不默认录制所有交互式终端输入输出。
- 不在第一轮实现 RDP、VNC、X11、Telnet、串口和移动原生客户端。
- 不在第一轮引入云端账号、第三方同步服务、团队 RBAC 和 SSO。
- 不用命令黑名单替代批量操作的目标确认、权限控制和人工确认。
- 不把 ssh2、Node fs、WebSocket、DOM、IndexedDB 或 Android API 直接暴露到 shared core。

## 5. 产品和架构原则

### 5.1 Local-first，数据可带走

当前项目的本地加密 Vault 是核心差异化。新增导入导出必须是加密 bundle，导出过程只在内存中处理，导入前先校验格式、版本、数量和冲突，用户确认后才写入。

核心 SSH 和 SFTP 能力不能依赖订阅状态才能继续使用，也不能因为授权或同步变化静默删除本地数据。

### 5.2 核心统一，平台适配

所有客户端共享以下内容：

- Host、Group、Tag、ConnectionProfile、WorkspaceState、TransferJob、CommandRun 等领域模型。
- schema、错误码、Host Key policy 规则和状态机。
- API/wire protocol 的版本和事件语义。
- capability discovery 的名称和行为定义。

平台差异通过 ports/adapters 隔离：

~~~text
shared/core
  Domain models + validation + state machines + ports

web client
  React UI + HTTP/WSS adapter

desktop client (future)
  React/native shell + desktop SecretStore + local or server Transport

android client (future)
  native UI + Android Keystore SecretStore + mobile SSH Transport

server
  Fastify API/WSS + SQLite + server Vault + ssh2 adapter
~~~

Web 优先意味着服务端仍是当前产品的 SSH 执行边界；桌面和 Android 可以先复用同一 API，再按需要替换为本地 SSH adapter。客户端不能依赖服务端返回 ssh2 对象或 Node 专属错误。

### 5.3 以任务为中心，不以协议为中心

用户看到的是“连接、文件、命令、结果”，而不是一长串底层协议选项。高级配置采用渐进式展开，默认路径只需要主机、认证和目标路径。

### 5.4 高价值操作安全默认

批量执行和文件删除属于高风险操作。界面必须显示目标、命令、远程路径和影响范围；服务端仍需重新校验所有目标和权限，不能信任浏览器传来的标签或筛选结果。

### 5.5 状态可解释，失败可恢复

连接失败至少区分解析、TCP、跳板、Host Key、认证、PTY/SFTP channel 和远端退出。网络波动可以自动重连；凭据错误、Host Key 变化、权限不足和路径不存在必须明确失败。

## 6. 目标架构

### 6.1 共享核心边界

新增或逐步整理为以下平台无关边界：

~~~text
src/shared/core/
  models.ts          非敏感领域模型和状态类型
  ports.ts           HostStore、SecretStore、SessionTransport、FileTransport、CommandTransport
  capabilities.ts    客户端/服务端能力发现
  state-machines.ts  connection、transfer、command-run 状态转换

src/shared/
  validation.ts      schema 和输入约束
  protocol.ts        终端、传输、批量事件
  errors.ts          稳定错误码
~~~

shared core 只能使用 TypeScript 标准类型和纯函数，不导入 Node、浏览器、React 或具体 SSH library。

### 6.2 服务端边界

~~~text
src/server/workspace/
  workspace-service.ts
  workspace-repository.ts
  vault-bundle-service.ts

src/server/ssh/
  types.ts
  ssh2-adapter.ts
  session-manager.ts
  connection-path.ts
  forwarding-manager.ts

src/server/sftp/
  sftp-service.ts
  sftp-adapter.ts
  transfer-manager.ts

src/server/automation/
  snippet-service.ts
  command-runner.ts
  command-run-store.ts

src/server/audit/
  audit-service.ts

src/server/api/
  workspace-routes.ts
  vault-routes.ts
  sftp-routes.ts
  command-routes.ts
  audit-routes.ts
~~~

现有 TerminalWorkspace、TerminalPanel 和 App reducer 继续负责 Web 终端展示，但不承担 SFTP、批量执行、Vault bundle 或平台适配逻辑。

### 6.3 连接资源抽象

现有 SshAdapterPort 只抽象 shell 和测试连接。为了让 shell、SFTP 和 exec 共用同一套 Host Key、跳板和凭据逻辑，抽象为：

~~~ts
export interface SshConnectionResource {
  openShell(options: ShellOptions): Promise<SshChannel>;
  exec(command: string, options: ExecOptions): Promise<ExecResult>;
  openSftp(): Promise<SftpResource>;
  close(): void;
}

export interface SshResourceAdapter {
  connect(config: SshConnectConfig, callbacks: SshConnectCallbacks): Promise<SshConnectionResource>;
  testConnection(config: SshConnectConfig, callbacks: SshConnectCallbacks): Promise<ConnectionTestResult>;
}
~~~

现有 shell session manager 通过 openShell 使用该资源；SFTP 和批量 exec 不直接接触 ssh2 Client。

## 7. 功能设计

### 7.1 持久化工作区和加密 bundle

工作区保存非敏感状态：

~~~ts
export interface WorkspaceState {
  version: 1;
  activeTabId: string | null;
  tabs: Array<{ tabId: string; hostId: string; title?: string }>;
  layout: {
    orientation: 'horizontal' | 'vertical' | null;
    primaryTabId: string | null;
    secondaryTabId: string | null;
    ratio: number;
  };
  selectedGroupId: string | null;
  favoriteOnly: boolean;
}
~~~

terminalId 只用于当前服务进程内的 live session reattach，不作为远程 shell 永久身份。应用重启后恢复“打开哪些主机”，但会为每个 tab 创建新 shell，并明确提示用户。

工作区 API：

- GET /api/workspace：返回经过 schema 校验的当前快照。
- PUT /api/workspace：使用乐观版本号保存；版本冲突返回 409 和服务端快照。
- POST /api/workspace/templates：保存和读取命名模板。

加密 bundle 包含 bundle format/version、主机元数据、分组、工作区和用导出密码重新包裹的 Vault key。导入固定为：读取 → 解密 → schema 校验 → 展示数量和冲突 → 用户确认 → 单事务合并 → 记录 audit event。

### 7.2 连接诊断、恢复和 ProxyJump

连接配置新增：

~~~ts
export interface ConnectionProfile {
  jumpHostIds: string[];
  keepaliveIntervalMs: number;
  keepaliveCountMax: number;
  reconnect: { enabled: boolean; maxAttempts: number };
}
~~~

约束：

- jumpHostIds 最多 4 个。
- 目标主机不能直接或间接跳转到自身。
- 每一跳独立执行 Host Key 校验并保存指纹。
- 跳板凭据只在服务端解密，不发送到浏览器。

端口转发暂放在 ProxyJump 后面。Web SSH 的“本地端口”实际位于服务端容器，必须先明确绑定地址、访问控制和浏览器暴露方式；第一轮只预留 ForwardingManager 接口。

### 7.3 SFTP

第一版支持列目录、元数据、上传、下载、新建目录、重命名、删除、进度、取消和失败重试，并复用主机认证、Host Key 和 jump path。

上传先写远程临时文件，完成并校验后原子重命名，避免半文件替换目标文件。第一版不做远端到远端复制、远程编辑器和交互式终端自动录制。

推荐 API：

- GET /api/sftp/:hostId/list?path=/path
- POST /api/sftp/:hostId/entries
- POST /api/sftp/:hostId/transfers
- GET /api/transfers/:transferId
- DELETE /api/transfers/:transferId
- GET /api/transfers/:transferId/content
- PUT /api/transfers/:transferId/content

### 7.4 Snippets 和安全多主机执行

Snippet 内容存为 Vault 加密 payload，用户可使用显式变量。批量任务在服务端重新解析 hostIds，执行前展示目标和变量展开结果。

~~~ts
export interface CommandRunRequest {
  hostIds: string[];
  command: string;
  variables: Record<string, string>;
  concurrency: number;
  timeoutMs: number;
  persistOutput: boolean;
}

export interface CommandTargetResult {
  hostId: string;
  state: 'queued' | 'connecting' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  exitCode: number | null;
  output: string;
  truncated: boolean;
  errorCode?: string;
}
~~~

默认并发 4，最大 16；单主机超时 60 秒；单主机输出上限 256 KiB；取消需要阻止未开始目标并尽力关闭运行中的 exec channel。

### 7.5 活动日志和结果审计

默认继续不记录交互式终端原始输入输出。记录 workspace 导入/导出、SFTP 传输生命周期、批量任务生命周期和逐任务成功/失败摘要。用户明确选择保存批量输出时，输出按主机隔离、大小封顶并在 TTL 后删除。

## 8. 安全和跨端约束

- 所有客户端都通过 capability model 判断功能是否可用，不能通过猜测平台名称分支业务逻辑。
- shared core 不包含秘密；SecretStore 由 Web server Vault、桌面 OS keychain、Android Keystore 分别实现。
- 所有 hostId、jumpHostId、transferId 和 runId 按 owner 查询并重新校验。
- SFTP 路径拒绝 NUL、控制字符和规范化后的 .. 越界结果。
- SFTP 和批量执行不能绕过 Host Key policy。
- 错误响应只返回稳定错误码、可理解文案和 request id。
- 日志不得包含密码、私钥、passphrase、cookie、token、完整命令变量值或原始文件内容。
- transfer 和 command run 使用服务端内存 TTL 清理；应用重启后明确返回任务不存在，不伪造继续执行状态。
- Web、桌面、Android 的 UI 可以不同，但必须共享相同的状态语义、错误码和操作确认规则。

## 9. 验收指标

### P0

- 浏览器刷新、容器重启和重新解锁后，工作区的主机标签和布局可恢复。
- 导出文件没有导出密码时无法解密；导入失败不会修改现有 Vault。
- 连接失败能指出阶段；短暂断线不会静默丢失输入。

### P1

- 用户可以在同一主机上下文中完成目录浏览和上传/下载，不需再次输入凭据。
- 文件传输可显示状态、取消并重试；半文件不会替代目标文件。
- 20 台主机的批量命令能看到逐主机状态，执行前能确认完整目标列表。

### P2

- 用户能查看最近活动和批量任务摘要。
- 保存结果的任务可按主机查看输出并比较两次执行结果。

### 跨端验收

- shared core 在 Node、浏览器 TypeScript 编译目标下无平台专属 import。
- Web adapter 能覆盖所有 P0/P1 capability。
- 为桌面和 Android 提供明确的 adapter interface 和 capability contract，不要求本阶段交付原生 UI。

## 10. 发布切片

### Slice 1：可靠底座

shared core contracts、工作区持久化、Vault bundle、连接诊断、重连和 ProxyJump。

### Slice 2：文件闭环

SFTP 目录、上传下载、进度、取消、重试和权限错误。

### Slice 3：重复操作提效

Snippets、参数展开、安全批量 exec、逐主机结果。

### Slice 4：专业化

活动日志、批量结果保存、输出比较和审计筛选。

### Slice 5：企业和平台扩展

桌面壳、Android 客户端、团队账号、RBAC、SSO、共享凭据、端口转发和其他协议。

每个 slice 都必须通过 unit、integration、OpenSSH fixture、DOM 和 E2E 测试；后续 slice 不得改变前一 slice 的安全默认值。
