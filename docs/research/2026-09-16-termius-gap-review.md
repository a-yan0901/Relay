# Termius 体验差距复核

日期：2026-09-16

## 1. 复核口径

本次只比较高频 SSH 工作流，不把 Termius 的商业套餐、云服务和多协议数量直接等同为 Relay 的产品目标。重点观察：

> 找到主机 → 复用身份 → 打开工作区 → 终端、文件和命令协同 → 断线后得到可信状态。

Termius 官方资料显示，Vault 负责承载主机、分组、身份、端口转发、known hosts 和 snippets 等连接资产；Workspace 提供按任务组织连接、Focus/Split 视图和恢复上下文；Snippets 支持跨设备复用和批量执行；SFTP 有独立 tab、传输队列和暂停/恢复/重试等任务体验。相关能力还按 Starter、Pro、Team、Business 等套餐分层。[Vaults](https://termius.com/blog/meet-vaults) · [Workspaces](https://termius.com/blog/workspaces) · [Snippets](https://termius.com/blog/snippets-sharing-is-on) · [SFTP on mobile](https://termius.com/blog/rethinking-sftp-for-mobile) · [官方定价](https://termius.com/pricing)

这些页面用于确认产品能力和交互方向，不作为独立的可用性实验数据。

## 2. 四维对比

| 维度 | Termius 的体验标杆 | Relay 当前实现 | 主要差距 | 优先级 |
| --- | --- | --- | --- | --- |
| 功能性 | Vault/Group/Host 资产模型；可复用身份；Workspace、Snippet、SFTP、批量操作；更完整的端口转发、Mosh、Telnet、Serial、RDP/VNC 等协议能力 | Host/Group/Identity、嵌套分组和有限继承；SSH、四级 ProxyJump、SFTP CRUD/传输、Snippet、批量命令、Workspace 模板和最多四 pane | 没有端口转发、Mosh、Telnet、Serial、RDP/VNC、Agent Forwarding、远程编辑器、团队/云同步；四 pane 低于公开的 16 pane/broadcast 方向 | P1：任务闭环；P2：协议/协作 |
| 易用性 | 资产保存后接近一键连接；按任务恢复 Workspace；Snippet 快速复用并可批量作用于多个主机；移动端也保持同一上下文 | 搜索、收藏、分组、最近连接排序；Identity 可复用；主机/分组目标选择、命令预览、Snippet palette、模板确认、SFTP 面包屑和统一 Dialog | 主机侧仍缺少独立 Recent/Tag 入口；筛选状态较少；没有 16 pane broadcast；Identity 的用户名目前是 metadata，Host 仍必须单独填写用户名；移动端生命周期尚未落地 | P1 |
| UI 体验 | 多 tab、Focus/Split、清晰的当前任务上下文、快捷跳转、传输进度和恢复提示，跨设备交互保持一致 | Web-first 视觉层、Server 工作区、终端 tab、split/grid、四类主题、响应式窄屏、键盘快捷键、焦点管理、状态/错误/队列反馈 | 当前 UI 仍是单页 Web 工作台，信息密度、快捷键覆盖、pane 数量、批量广播和 SFTP 桌面化能力不如成熟客户端；还需要真实设备下的视觉/响应式走查 | P1：手工 QA；P2：体验增强 |
| 可靠性 | 同一 tab 自动重连、Workspace 恢复、后台连接感知；SFTP 任务可暂停/恢复/重试；成熟客户端对网络切换有较强容错 | Vault 加密、Host Key TOFU/变更阻断、ProxyJump 每跳校验、连接诊断、自动重连、session/live 状态、重启后的 interrupted/needs-reopen、持久化 transfer/command 终态、原子上传和审计脱敏 | 进程重启不保留远端 shell；传输重试从 0 开始，不是真正断点续传；Web adapter 当前将上传源聚合成 Blob、下载聚合成单块 Uint8Array；没有移动后台挂起/网络切换实现 | P0/P1 |

结论：Relay 在“自托管、单 Vault、Web-first 的可信 SSH 工作台”这个范围内，核心高频链路已经从 MVP 提升到可用闭环；与 Termius 的最大差距已从基础连接能力转为三类增量：协议/协作广度、成熟客户端的任务上下文密度、弱网与大文件的恢复能力。

## 3. 统一核心复核

本轮重点不是把 Web UI 搬到原生端，而是确认未来端侧不会复制业务规则：

~~~text
shared core
  models / validation / errors / state machines
  group + connection inheritance / target snapshot / path rules
  CoreRuntime + store/transport ports + capability contract
        ↑                         ↑
Web/React UI                 Web adapter
                              HTTP/WSS/File/Blob/FormData
~~~

当前边界已经满足：

- `src/shared/core` 不依赖 Node、DOM、React、浏览器存储、WebSocket、HTTP 或 `ssh2`。
- `App.tsx` 通过注入的 `CoreRuntime` 工作；`main.tsx` 才选择 Web adapter。未来桌面/Android 应复用 shared core、ports、状态语义和 contract tests，但按平台重写 UI 与生命周期编排，不直接复用 Web DOM 组件。
- Host、Identity、Group、Workspace、Snippet、SFTP、Command 的 DTO 和错误/终态语义由 shared contract 约束；浏览器 `File`/`Blob`/`FormData` 只在 Web 边界转换。
- Web 做服务端 capability 交集协商；原生端可在相同协议上再叠加本地 keychain、Keystore、本地 SSH 或移动网络能力。
- Host credential source 具备 inline/identity/group 互斥不变量；Group 继承身份和连接 profile 的解析在连接、SFTP、命令和导入/导出链路共用。旧版本 Host 的连接 profile 会在迁移时转成显式 host override，避免加入分组继承后配置被默认值覆盖。
- 跨端验收已经有可执行证据：`tests/fixtures/core-runtime-contract.ts` 的同一组断言同时覆盖真实 Web adapter、desktop native-like fake 和 Android native-like fake；`FileTransport.download()` resolve 后统一得到 `AsyncIterable<Uint8Array>`，导入/导出只使用 `Uint8Array`，fake 不引入 DOM/HTTP/WebSocket。

尚未属于统一核心的内容：云同步、团队 Vault/RBAC、远端 shell 的跨进程持久化、端口转发/Mosh 等协议、原生 UI。它们应分别增加 capability、数据归属、密钥/生命周期和兼容性设计，不直接塞进当前 `CoreRuntime`。

## 4. 建议的下一阶段

1. **P0：完成可靠性验收**：真实网络切换、服务重启、重复提交、长时间 SFTP、取消清理和 session 恢复的 E2E/人工走查；优先把 Web 下载/上传改为真正的流式 adapter。
2. **P1：补齐任务上下文**：Recent、Tags、保存的筛选视图、更多快捷键和更明确的当前 Workspace 状态；评估 pane 模型从四格扩展为可配置 N 格，但不把 16 格硬编码进 shared core。
3. **P1：身份模型补充用户名策略**：明确 Host username 与 Identity username 是“Host 覆盖”还是“Identity 默认 + Host 可选覆盖”，并把解析结果放进 shared connection configuration，避免不同端各自解释。
4. **P2：大文件和弱网**：为 `ByteStream` 增加真正的进度/取消/恢复语义，设计可验证的远端临时文件续传和校验；当前 retry 从 0 开始的行为应明确标注为“重新执行”。
5. **P2：协议扩展**：端口转发、Agent Forwarding、Mosh 等各自建立 adapter/capability 和安全审计 spec；不要为了追赶功能表把协议实现直接放进 shared core。

## 5. 验收门槛

- shared boundary 静态检查、Web/server 双 TypeScript target、fake/Web adapter contract tests 全部通过。
- `tests/unit/shared/core-adapter-contract.test.ts`、`tests/unit/shared/native-adapter-contract.test.ts` 和 `tests/unit/web/web-adapters.test.ts` 必须运行同一套 CoreRuntime contract；这项跨端门槛已在本轮补齐。
- Host Key、ProxyJump、credential source、group inheritance、import/export、任务重启终态和 SFTP 路径规则必须有自动化回归。
- 每个新增端侧能力遵循：`shared contract → fake contract test → adapter → UI`；原生端必须证明自己遵守同一错误码、确认步骤和任务终态。
