# Relay Cloud and Live Workspace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 登录同一账号的 Web、Windows、Android 端能打开其他端正在运行的工作区，并允许多个设备同时操作同一个真实 SSH 终端。

**Architecture:** 各端独立保存 Vault 并持有自己的 SSH 连接；账号级 Host/Identity/Group/Snippet/终端配置通过云端加密快照自动同步，设备级工作区状态分别保存。云服务通过 MySQL 保存两类端到端加密快照，通过 WSS 转发端到端加密实时帧。远端工作区的执行性操作回到拥有者，拥有者为并发输入排序。

**Tech Stack:** 现有 React/TypeScript `CoreRuntime`、Node/Fastify/ssh2、Electron、Capacitor/Kotlin、MySQL InnoDB、HTTPS/WSS。

**Spec:** [云端同步与跨端实时工作区设计](../specs/2026-09-17-relay-cloud-live-workspace-sync-design.md)。独立端基础按 [Windows/Android 计划](./2026-09-17-relay-windows-android-implementation.md) 先行；该计划中“云同步留待后续”的范围限制由本计划接续，不应误认为云能力已实现。

## Global Constraints

- Local 模式不需要账号或云服务；云中继绝不代替拥有者连接目标 SSH 主机。
- 同一终端允许多个授权设备同时输入；只有拥有者能分配输入序号并写入 SSH 通道。
- 同账号的 Host、Identity、Group、Snippet 和终端配置自动同步到所有受信端；设备级布局和真实 SSH session 保持独立。
- 云服务只保存加密快照和必要元数据；不记录终端输出、输入、SFTP 文件或密钥明文。
- 本机低内存部署默认 MySQL 连接池不超过 4、等待队列不超过 16；relay 单帧不超过 64 KiB、单连接缓冲不超过 256 KiB、单工作区观看端不超过 16；文件和密文大载荷必须流式/分块处理。
- Web 多账号 Vault 与 SSH session 隔离完成前，不允许开放多账号远端执行。
- Windows 不使用 Web cookie 或本地 HTTP 监听；Android 后台保活须显式前台服务。
- 本计划是未来实施清单；任何未勾选任务均不得表述为已交付。

## 文件边界与依赖

`src/shared/core/` 定义版本化快照、设备和实时帧契约；`src/cloud/` 是独立云 API/数据库/relay，不复用 Web `app.ts` 的 SQLite 身份域；`src/server/` 只负责 Web 本地执行端；`src/web/platform/` 注入本端或远端 adapter；`apps/windows/` 和 `apps/android/` 持有各自原生 SSH、存储和安全凭据。测试分别放 `tests/unit/shared/`、`tests/integration/cloud/`、`tests/integration/server/`、`tests/e2e/`。新增目录可随对应任务创建，不先造空壳。每个任务按“先失败测试→最小实现→针对性验证→审查/提交”的顺序独立交付；跨安全、协议、迁移或发布门槛执行全量验证。

## M0：冻结协议与安全门槛

- [ ] **任务 1：账号数据、设备工作区和快照 v2 契约。** 在 `src/shared/core/` 分别定义账号级配置 envelope 和设备级 workspace envelope、账号/设备/工作区 ID、owner、revision、CAS 冲突及稳定错误码；增加固定序列化测试向量。以 `tests/unit/shared/` 的 round-trip、错误版本、重复提交、跨账号 ID 和数据域混淆测试先红后绿；记录 Web v1 快照拆成账号配置与 Web 工作区的字段映射及不能迁移的 live 状态。交付版本化协议和三端共用类型。
- [ ] **任务 2：实时帧与多人输入契约。** 在 `src/shared/core/` 定义 `ownerEpoch`、`sessionId`、输出 `sequence`、`inputId`、拥有者确认 `inputSequence`、参与者状态、RPC 和尺寸策略。测试乱序/丢帧/重放、两参与者交错输入、重复 inputId、拥有者重启，以及 SSH 已写入但确认丢失时客户端显示“结果未知”且不自动重发；原始控制字符不可进入云普通日志。交付可在三端跑同一向量的编码/解码及状态机。
- [ ] **任务 3：加密与屏幕快照可行性门槛。** 为账号配置/设备工作区快照 AEAD、设备包装密钥、每对 owner-viewer 的实时流临时密钥写跨 Web/Windows/Android 测试向量，验证加入、撤销、离开和重协商；标明撤销不能清除设备已取得的旧明文。给 SSH 拥有者建立 headless 终端屏幕快照 PoC：两终端运行、观看端加入时看到完整当前屏幕，丢帧超窗可重新取快照，内存/scrollback 有上限。三平台与真机互通未过门槛前，不上线明文 relay 或把 256 KiB 输出缓存当屏幕快照。

## M1：独立云服务与持久同步

- [ ] **任务 4：MySQL schema 与事务。** 在 `src/cloud/` 增加 accounts/devices/sessions、账号配置 keys/heads/revisions、设备 workspaces/keys/heads/revisions/memberships/audit 迁移和独立最小权限配置；连接池采用默认 4 连接/16 排队并设硬上限。集成测试两账号隔离、两端并发写账号配置 CAS 仅一个成功、非拥有者写设备工作区拒绝、幂等重试和迁移回滚；测试使用隔离数据库，不触碰现有生产数据。交付可重复部署的 schema 和备份/恢复演练说明。
- [ ] **任务 5：认证、设备信任和密钥分发。** 实现 v2 登录/刷新/登出、设备列表/撤销、已信任设备批准或恢复密钥引入新设备；设备 session 只保存 token hash。以未认证、越权、撤销后即时拒绝、恢复密钥错误及账号密码重置无法解密为红灯用例。交付最小权限云 API；云端不持有 `K_account`/`K_workspace` 明文。
- [ ] **任务 6：账号数据与工作区快照 API。** 分别实现账号配置和设备工作区的 head、revision、加密快照 PUT/GET 与 `parentRevision` CAS；前者允许同账号受信端写，后者只允许拥有者写。载荷上限、AAD 字段、幂等键与冲突错误由任务 1 契约约束。集成测试两个设备离线修改账号配置后客户端保留未被 CAS 接受的分支、不静默覆盖、跨账号读写拒绝、撤销后下载拒绝。交付可离线排队、重试和冲突导出的持久同步闭环。
- [ ] **任务 7：WSS 路由与在线状态。** 实现 owner/viewer 出站连接、心跳 TTL、成员授权、限流、背压、订阅取消、撤销强制断开；relay 只转发加密帧且日志仅含脱敏元数据。集成测试拥有者断线、重连换 epoch、慢消费者、伪造 session/workspace ID、两观看端同时订阅及多实例部署时的一致路由。交付不执行 SSH 的云中继。

## M2：Web 本地拥有者与远端观看者

- [ ] **任务 8：Web 多账号本地隔离。** 在 `src/server/` 拆除 `ownerId='default'` 与单 Vault/SSH session 共享假设，按账号隔离本地数据库域、Vault、连接和设备凭据；保持现有 Web origin/session 入口。集成测试两个账号 Host/Identity/SSH/Workspace 相互不可见、注销后 socket 被撤销；在该任务完成前不开放 Web 多用户 live 入口。交付可安全充当 Web 执行端的隔离边界。
- [ ] **任务 9：Web 云同步与旧数据迁移。** Web 后端持有云设备凭据，把 SQLite v1 envelope 拆成一份 v2 账号配置及一份 Web 设备工作区状态，记录旧 hash 到两个新 revision 的对应、加密回滚副本和幂等标记。测试重复迁移、迁移中断、错误恢复密钥、云冲突与回滚；不把生产 MySQL 当测试库。交付本地数据不丢失的 v2 Web 同步。
- [ ] **任务 10：Web 拥有者代理。** 将现有 `src/server/ssh/session-manager.ts` 的真实 session 及 Host/SFTP/Command 服务映射到任务 2 的 owner 协议；加入屏幕状态快照、有界补发、输入去重/排序和 RPC 权限检查。两观看者交替输入同一 SSH 通道时仅一次写入、同序确认；关闭观看页面不关闭 owner session。交付 Web 端可被远程实时打开。
- [ ] **任务 11：账号配置自动同步与远端 CoreRuntime adapter。** 在 `src/web/platform/` 实现受信端登录后拉取/解密/原子应用账号配置，监听 head 更新，本地修改先提交再排队发布；另用云 relay 代理远端 Terminal/SFTP/Command/Workspace 执行，剪贴板、文件选择/保存仍使用观看端系统能力。测试两端 Host/Snippet 改动互见、离线后补同步、账号数据分叉、在线/离线/锁定/撤销切换、丢帧重取屏幕和取消 SFTP；禁止 viewer 在本机静默重连目标 SSH。交付 Web 端自动同步配置且可观看并操作其他端。

## M3：Windows、Android 与统一交互

- [ ] **任务 12：Windows owner/viewer。** 在独立 Electron 本地 runtime 上接任务 1–3、5–7 协议，登录后自动拉取/应用/发布账号配置；设备凭据入 OS keychain，main process 持有云 WSS 和 SSH；renderer 只用受限 IPC。测试与 Web 的 Host/Identity/Snippet 双向同步、离线冲突、两终端、后台/退出选择、两观看者同时输入、撤销及安装包重启；检查无本地 HTTP 监听和 Web cookie。交付 Windows 可自动同步账号配置、拥有并进入远端工作区。
- [ ] **任务 13：Android owner/viewer。** 在 Capacitor/Kotlin 本地 runtime 上接相同协议，登录后自动拉取/应用/发布账号配置，设备密钥入 Keystore；owner 后台可用只通过用户开启的前台服务和通知。真机测试与 Web/Windows 的 Host/Identity/Snippet 双向同步、网络切换、进程回收、两终端、软键盘交错输入、SFTP 有界流和撤销；无前台服务即显示离线。交付 Android 可自动同步账号配置、拥有并进入远端工作区。
- [ ] **任务 14：三端首页与远端 UI。** 共享设备卡片、搜索、账号配置同步状态和远端顶部归属标识；进入其他端直接展示它的实时 workspace 和两个终端，窄屏以标签切换。不提供“复制远端 Host 到当前端”作为常规流程，因为账号配置已经自动共享。测试“当前端/在线/连接中/锁定/离线快照/待恢复密钥/撤销/冲突”、多人输入提示、断开遮罩、返回本端、远端 SFTP 和主题一致性；离线快照只读。交付三端相同任务链与平台适配布局。

## M4：端到端与上线门槛

- [ ] **任务 15：跨端验收与安全复核。** 用同一账号 Web/Windows/Android 三实例验证 Host/Identity/Group/Snippet/终端配置自动双向同步，同时各端保留不同布局与 SSH session；跑两真实 Shell、三端交错输入、确认丢失时“结果未知”、远端 SFTP、断连重连、云离线 local 使用、设备撤销、账号级 CAS 冲突和 v1 拆分迁移；核验云数据库/普通日志没有敏感明文。对安全/协议/迁移/原生构建执行全量门禁，记录真机和 Windows 证据。失败项不得以 UI 模拟替代。
- [ ] **任务 16：部署与可回滚发布。** 在验证环境以 `api.ayan.org.cn` 的 HTTPS/WSS、nginx 反向代理、loopback 云服务和独立 MySQL schema 演练证书、WebSocket upgrade、限流、备份恢复、滚动重启、版本兼容与回滚；获得发布批准后才触碰现有主机配置/生产库。交付可安装的 Web/Windows/Android 版本和独立云服务部署记录，不把设计文档视为已上线。

## 进度记录

M0 是云协议前置门槛；M1 的快照 API 和 relay 可以分支并行，但都依赖身份/设备信任；M2 依赖 M0/M1；M3 依赖独立端本地能力和共享协议；M4 是发布门槛。每项勾选时附 commit、测试命令/结果、真实平台证据及未解决缺陷。旧 Windows/Android 计划负责 Local 客户端基线，本计划负责云与实时跨端能力，二者不能互相代替。
