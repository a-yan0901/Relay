# Relay 独立 Windows 与 Android 客户端实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**目标：** Windows 与 Android 安装后都能在本机保存数据并直接连接 SSH/SFTP，复用 Web 的 UI、主题和 shared core；云同步留待后续。

**架构：** Windows Electron 通过受限 IPC 复用本机 Node/SQLite/Vault/ssh2 服务类，不启动 Fastify 或 HTTP；Android Capacitor 使用共享 React UI 与 TypeScript core，通过受限插件接入设备本地 Vault、数据存储、SSH/SFTP。两个客户端的 Local 模式均不需要 Relay 服务地址或账号。

**技术栈：** React/TypeScript/Vite、`src/shared/core`、Electron、现有 Node/SQLite/ssh2 服务类、Capacitor Android、Kotlin、Android Keystore。Fastify 仅用于独立 Web 版。Android SSH 库在任务 4 的实机可行性门槛后锁定版本，不预先宣称已验证。

**设计：** [独立 Windows 与 Android 客户端设计](../specs/2026-09-17-relay-windows-android-unified-experience-design.md)。

**验收交接：** [跨端验收交接任务书](../verification/2026-09-18-relay-cross-platform-handoff.md)。

## 全局约束

- SSH、SFTP、本地 Vault 和工作区必须在各自设备上运行；云服务不存在时功能照常可用。
- 复用 `CoreRuntime`、shared 模型、状态机、错误码、Host Key/SFTP 路径和任务契约；Android 原生层独立执行安全校验。
- 账号/设备/同步 ports 保持可选；本期不实现或模拟已存在的独立云服务，不发云请求。
- 三端共享 React 组件与设计 token；Windows 和 Android 只适配布局、输入、系统能力和生命周期。
- Windows renderer 不启用 Node 集成；桌面版不启动 TCP/HTTP 监听、不使用 Web cookie。Android 秘密不进入 WebView 持久化或日志。
- 所有平台的同一命令、确认、错误码、状态和主题 token 一致；Android 允许针对触控、系统返回和软键盘调整布局。
- 每个任务完成时附 commit、验证命令和证据；按风险执行受影响范围检查，跨接口、凭据、原生构建和数据迁移执行全量门禁。

## 状态快照（2026-09-19）

复选框只表示该任务已经通过计划中的最终验收门禁；下表单独记录当前实现进度，避免把“代码已落地”误读成“真实平台已交付”。

| 任务 | 当前状态 | 已有证据 | 剩余门禁 |
| --- | --- | --- | --- |
| 1 共享 contract | 🟡 主要 contract、capability 和 UI 增量已落地 | shared/native contract、Web/DOM 定向测试、[三端验收矩阵](../verification/2026-09-18-relay-cross-platform-acceptance-matrix.md) | 三端最终视口走查 |
| 2 浏览器调用抽离 | 🟡 平台 ports、系统能力和下载边界已抽离 | Web/native TypeScript、定向 ESLint/DOM 测试 | 完整跨端路径审计 |
| 3 手机布局与输入 | 🟡 返回键、移动工具条、SFTP 布局和过滤已实现 | DOM 测试、Web 构建 | 真机软键盘、安全区、最后一行和滚动走查 |
| 4 Android SSH 可行性 | 🟡 JSch 候选和执行器已接入 | Kotlin 编译、Android JVM 测试；两台 Android 16 真机已完成用户指定密码主机的认证、Host Key 信任、PTY 基础操作和 SFTP 连接 smoke；2026-09-19 又在该真实主机上完成 3 轮关闭/重开/输入回归 | 私钥、ProxyJump、Host Key 变更、完整 SFTP 资源释放和异常边界 |
| 5 Vault bundle v1 | 🟡 Android 端格式/加解密/冲突应用已实现 | bundle 定向测试、分块边界测试 | Web↔Windows↔Android 固定向量正反向实测 |
| 6 Electron shell | 🟡 shell、preload、导航和打包配置已实现 | Windows TS/构建、IPC 测试；`npm run package:windows` 已用本地 Electron 目录产出 NSIS/portable，NSIS 安装、启动、卸载通过 | Windows 升级迁移和窗口行为 |
| 7 Windows 本地 runtime | 🟡 SQLite/Vault/SSH/SFTP/IPC 闭环代码已实现 | `build:windows`、IPC/服务端定向测试；Electron ABI 149 下 `argon2`、`better-sqlite3`、`cpu-features` 原生加载通过 | 升级迁移、崩溃恢复和打包后完整任务链 |
| 8 Windows 系统能力 | 🟡 文件句柄、剪贴板、确认、偏好已接入 | 受影响 TypeScript/DOM 测试；root Electron 真实主机 UI smoke，NSIS 安装/启动/卸载通过 | 打包后 SFTP/Vault/文件能力、退出重开和无监听检查 |
| 9 Android bridge | 🟡 有界帧、事件代际/序列、队列和文件流已实现 | Android JVM、native bridge/core 定向测试；两台真机已完成 native invoke、终端 resize/写入/关闭、SFTP list；2407 真机完成 32 MiB 原生 URI 流式上传、取消和暂停/继续 | 真机乱序、进程回收、URI 立即释放和低内存 |
| 10 Android 本地数据/Vault | 🟡 本地 store、Keystore、Vault、模板和导入导出已实现 | Android JVM/编译；第二台真机已创建测试 Vault 并保存真实测试 Host | 锁屏、重启、备份排除和秘密不入 WebView 实测 |
| 11 Android SSH Shell | 🟡 Shell、Host Key、ProxyJump、重连代码已实现 | Kotlin 编译/JVM 测试；两台 Android 16 真机已完成密码认证、首次 Host Key 信任、PTY resize、写入和关闭；在真实主机上连续 3 轮关闭/重开后 `whoami` 均返回 `t2` | 私钥、网络切换、后台/前台、Host Key 变更和完整认证走查 |
| 12 Android SFTP/批量任务 | 🟡 SFTP、任务持久化、分页和有界传输已实现 | Android JVM、跨端分页/服务测试；两台真机读取真实主机 `/tmp`，每台返回 19 项；2407 真机 32 MiB 上传完成并校验 SHA-256，取消保留既有目标且清理 staging，暂停/继续从断点完成 | 真机 UI 完整上传下载、重试、部分失败和 URI 任务边界 |
| 13 Android 生命周期/UI | 🟡 返回键、移动 UI、恢复语义已实现 | DOM、Android 编译 | 真机旋转、锁屏、软键盘和进程回收 |
| 14 三端统一回归 | ⏳ 尚未达到完成条件 | 已有本地 contract/定向验证 | Windows + Android 实机及发布检查 |
| 15 同步兼容性预留 | 🟡 可选 account/devices/sync ports 和本地优先边界已保留 | shared schema/能力边界 | 形成独立云同步 M4 计划；本期不实现云同步 |

## M0：共享边界和 Android 可行性门槛

- [ ] **任务 1：固定三端功能与 UI contract。** 检查 `src/shared/core/ports.ts`、`runtime.ts`、`tests/fixtures/core-runtime-contract.ts` 与 `src/web/App.tsx`。新增独立本地 runtime contract：账号 ports 缺席时创建 Host、解锁 Vault、打开 Shell、浏览 SFTP；本地 capability 用 `createCapabilitySet()` 表达实际能力，不把 Web 服务端能力复制过来。为 Host grid/list、终端、SFTP 全屏、主题、重连建立 Web/Windows/360px/390px 基准，记录同名动作、确认、状态和结果。交付：可逐项打勾的三端任务矩阵。
- [ ] **任务 2：抽离浏览器专用调用。** 审计 `src/web/App.tsx`、`TerminalPanel.tsx`、`src/web/theme.ts`、`src/web/state/app-state.ts`、`src/web/hooks/use-terminal-session.ts` 中的 `window.confirm`、`/api/transfers`、文件选择/保存、`window.open`、local/sessionStorage、WebSocket 和网络事件。修改 `src/shared/core/ports.ts` 与 `src/web/platform/browser-system-services.ts`，增加可注入的确认、文件、偏好存储、网络/生命周期和外链能力；Web 端保持原行为，并用组件测试覆盖取消、权限拒绝、重载和主题恢复。纯 DOM 焦点/渲染仍留 UI。交付：Windows/Android UI 路径不直接请求 Web API。
- [ ] **任务 3：手机布局与输入。** 修改 `src/web/styles.css`、`src/web/components/TerminalWorkspace.tsx`、`SftpWorkspace.tsx`、`HostList.tsx`，增加窄屏交互测试。实现搜索优先、单 pane、软键盘工具条、触控长按菜单、系统返回、SFTP 单层滚动及终端最后一行可见；菜单命令与桌面右键共用一份动作定义。交付：手机视口 Web 先跑通相同任务链。
- [ ] **任务 4：Android 原生 SSH 技术验证。** 在 `apps/android/` 建最小 Kotlin/Capacitor 实验工程；在真机验证密码与私钥认证、PTY resize、Shell 流、首次与变更 Host Key、ProxyJump、SFTP list/upload/download、取消和断线资源释放。记录 Android API/ABI、算法、依赖许可和失败项；Apache MINA SSHD 不受上游正式 Android 兼容性保证，须用实测决定。没有覆盖所需功能的库就比较替代方案，不以远端 Relay 服务绕过独立客户端目标。交付：锁定库版本、最小可运行 PoC 与验收记录；本任务只阻塞 Android SSH 任务，不阻塞 Windows。
- [ ] **任务 5：跨端 Vault bundle v1 兼容契约。** 检查 `src/server/vault/types.ts`、`src/server/vault/crypto.ts`、`src/server/workspace/vault-bundle-service.ts` 和 `src/shared/import/types.ts`。生成不含真实秘密的固定测试向量，明确 bundle 格式、Argon2id 参数、AES-GCM nonce/tag/AAD、字段编码、重复 Host/Identity 的冲突策略、错误码；Web/Windows 导出后 Android 导入及反向导出均须通过，错误密码/损坏载荷保持原数据不变。v1 只含 Host、Identity、Group、终端 profile/default profile；Snippet/Workspace 的跨设备迁移不在本期 v1 中。Android 内部库可以不同，便携格式必须相同。交付：版本化格式说明与正反向契约测试。

## M1：Windows 独立桌面版

- [ ] **任务 6：受限 Electron shell。** 新增 `apps/windows/main.ts`、`preload.ts`、打包配置及根构建脚本。只加载包内静态 UI，启用 sandbox/context isolation，禁用 Node integration 与任意导航；preload 只暴露枚举的业务调用和系统能力。测试未知 IPC、外部 URL、第二实例和窗口销毁后订阅清理。交付：可启动的 Windows 安装包/解压包。
- [ ] **任务 7：本地服务类组合与 IPC runtime。** 从 `src/server/app.ts` 提取可复用的 Vault/SQLite/Host/SFTP/SSH/Command 服务构造，Web 路由继续使用原实例；Windows 原生入口为 `apps/windows/local-runtime.ts`、`apps/windows/ipc-contract.ts`、`apps/windows/electron-main.ts`、`apps/windows/electron-preload.ts`，renderer 侧平台适配通过 `src/web/platform/native-port.ts`、`src/web/platform/native-platform-services.ts`、`src/web/platform/runtime-bootstrap.ts` 接入。main 或 utility process 初始化用户 app data 数据库，adapter 以版本化 `requestId + operation + payload` 调用服务类，映射全部 `CoreRuntime` 必选 ports；Shell/任务使用按 id 订阅事件，文件大流经原生文件句柄，关闭幂等。不调用 `startServer()`，不打开 TCP 端口，不使用 cookie。打包时验证 `better-sqlite3`、`argon2`、`ssh2` 的 Electron/Windows 运行时兼容和目标架构，并检查升级后数据库仍可打开。测试操作 allowlist、参数/大小校验、失败码、进程崩溃、数据恢复及 Web API 回归。交付：Windows 免账号本地 SSH/SFTP 闭环。
- [ ] **任务 8：Windows 系统能力与任务链。** 接入本地文件选择/保存、剪贴板、通知、窗口休眠/恢复与偏好持久化；按任务矩阵验证菜单、主题、Host Key、传输、终端复制粘贴和 Vault 锁定。Windows 实机检查安装/升级/退出/重开，以及无本地监听端口、无远端 Relay 地址。交付：独立 Windows 技术预览。

## M2：Android 独立 app

- [ ] **任务 9：Android bridge 与事件/流契约。** 新增 `apps/android/` 插件接口与 `src/web/platform/android-bridge.ts`：操作帧包含 `version/requestId/operation/payload`，事件包含 `sessionId` 或 `transferId`、代际、单调 `sequence`；类型/大小/权限由两侧校验，失败映射 shared 错误码。Shell 先订阅再连接，迟到事件丢弃；同步 `write/resize/close` 在 adapter 入有界队列，原生失败回传诊断。文件流以最多 32 KiB/块、4 个未确认块的 `ack` 窗口为默认上限，取消/失败释放 URI 与 SSH 句柄；原生直传也须证明有界内存。以乱序、重复、进程回收、取消和大文件用例验证。交付：可用于 Vault/SSH/SFTP 的稳定 bridge。
- [ ] **任务 10：本地数据、Vault 与便携格式。** 在 `apps/android/` 实现私有数据库、Keystore 包装和 Vault 插件；React 侧通过 `src/web/platform/android-bridge.ts`、`src/web/platform/native-port.ts`、`src/web/platform/native-platform-services.ts` 和 `src/shared/native/core-runtime.ts` 接入 `HostStore`、`IdentityStore`、`GroupStore`、`WorkspaceStore`、`SnippetStore`、`TerminalProfileStore`、`SecretStore`、`VaultSessionPort` 与 `ImportExportPort`，原生实现位于 `apps/android/android/app/src/main/java/cn/ayan/relay/RelayNativePlugin.kt`、`AndroidLocalStore.kt`、`AndroidVault.kt`、`AndroidBundleService.kt`。依任务 5 的 bundle v1 向量验证导入导出；原生层校验字段与版本，事务性应用，损坏/错误密码不改写旧数据。测试重启、锁屏、系统备份排除、飞行模式与秘密不进 WebView 持久化。交付：本机 Host/Vault 独立可用。
- [ ] **任务 11：本机 SSH Shell 与 Host Key。** 将任务 4 选定的库接入任务 9 的 bridge，React 侧仍通过 `src/web/platform/android-bridge.ts` 和 `src/shared/native/core-runtime.ts` 调用；Android 原生连接实现位于 `apps/android/android/app/src/main/java/cn/ayan/relay/AndroidJschConnection.kt`、`AndroidSshSession.kt`、`AndroidHostKeyRepository.kt` 和 `RelayNativePlugin.kt`。映射 shared profile、逐跳 Host Key 挑战/确认、密码/私钥认证、PTY resize、输出、主动关闭与重连；旧挑战不得放行新连接。测试首连、指纹变化、ProxyJump、断线、后台/前台与网络切换。交付：手机不依赖 Relay 服务可直连 SSH。
- [ ] **任务 12：本机 SFTP 与批量任务。** React 侧通过 `src/web/platform/android-bridge.ts` 和 `src/shared/native/core-runtime.ts` 调用；Android 原生任务与文件边界位于 `apps/android/android/app/src/main/java/cn/ayan/relay/AndroidLocalExecutor.kt`、`AndroidCommandRunner.kt`、`AndroidSshSession.kt`、`AndroidBundleService.kt` 和 `RelayNativePlugin.kt`。原生层执行远端路径规范化、目标快照、并发/超时/输出上限、取消和脱敏审计；capability 只广告真实已支持的行为。真实设备验证浏览、上传下载、重试、批量取消和部分失败。交付：Android 独立客户端核心任务闭环。
- [ ] **任务 13：移动生命周期与 UI 完成。** 处理系统返回、旋转、动态字体、软键盘、锁屏与进程回收；重新打开先读取本地工作区和任务实际状态。按任务矩阵比对 Web/Windows/Android 的菜单语义、错误与主题；验证终端最后一行和 SFTP 无双滚动。交付：Android APK 技术预览及真机验证记录。

## M3：统一回归与云同步预留

- [ ] **任务 14：三端 contract 与发布检查。** 使用 `tests/fixtures/core-runtime-contract.ts` 和 `tests/unit/shared/native-adapter-contract.test.ts` 覆盖 Web、Windows、Android runtime；分别补真实 Windows 和 Android 任务走查。验证无云服务、无账号、无 Relay 服务地址仍可访问目标 SSH 主机；断开互联网但局域网 SSH 可达时继续可用。检查 Windows 无 TCP 监听、Android 秘密/日志/备份与 Host Key 错误路径，执行 `npm run lint`、`npm run typecheck`、`npm test`、`npm run build` 及原生构建/设备测试。三端逐项比对 Host、终端、SFTP、主题和确认交互；记录 CI 缺失的真实平台证据。交付：两端发布判定和已知限制。
- [ ] **任务 15：同步接口只做未来兼容性检查。** 确认两端的稳定 Host/Identity/Workspace/主题 schema、设备标识和可选 `account`/`devices`/`sync` ports 可接入未来加密 envelope；云服务缺席时 UI 不显示可用同步状态，任何本地 SSH 操作不调用云接口。独立云端服务和跨设备恢复另立项目与计划。交付：不依赖云的客户端及可追踪的后续接口清单。

## 追踪与退出条件

任务 1–3 是共同依赖，任务 4 只阻塞 Android SSH，任务 5 是本次交接的跨端 Vault bundle 门禁并阻塞任务 10、14；Windows 与 Android 可并行推进。任务 4–14 是本期客户端发布门禁，全部通过任务 14 才称为本期完成。任务 15 仅是未来云同步兼容性预留，不是本期客户端完成条件。每个勾选项必须附对应 commit、针对性测试、真实平台结果和未解决缺陷；本计划未勾选的任务不视为已实现。云端同步服务不在本期完成范围内。

## 当前实施记录（2026-09-18）

以下是已落地但尚未达到“任务完成”标准的增量；未勾选任务仍需按上面的真实平台门禁验收：

- M0/共享边界：已加入 `NativeOperationPort`、事件代际/序列、Android bridge、共享 native `CoreRuntime` 和原生终端 socket 适配；平台 ports 还覆盖确认对话框、外链和有界文件写入。Web 仍默认使用 Web adapter，浏览器 File System Access API 不可用时回退到小文件下载。
- M1/Windows：已加入实际 Electron main/preload shell、版本化 IPC allowlist、sender 校验、窗口导航防护、本地 SQLite/Vault/SSH/SFTP/命令/导入导出组合、剪贴板桥接，以及 Host Key/凭据交互和 ECONNRESET 回归测试。文件导出使用临时文件句柄、32 KiB 分块写入和关闭后替换；`npm run build:windows` 已通过，但真实 Windows 安装、原生 ABI、升级迁移和实机任务走查仍未完成。
- M2/Android：已生成 Capacitor Android 工程，注册 Kotlin `RelayNative` 插件并接入共享操作/文件流边界；已加入 JSch 2.27.7 候选、app-private SQLite Host/Workspace store、Android Keystore + AES-GCM Vault、inline/Identity/Group 凭据、逐跳 Host Key 确认、PTY Shell、断线重连、ProxyJump、SFTP 浏览/目录变更/有界上传下载，以及 Android Confirm/SAF 文件写入。当前已补齐 Identity、Group、Workspace 状态/模板、终端 profile 的本地 CRUD 和 Vault bundle v1 的 Android 加解密、预览、冲突应用；Workspace 状态限制 32 KiB、模板限制 64 条；bundle 在 Android 上通过 32 KiB 分块跨越 64 KiB bridge 帧，原生最多保留一个有 TTL 的导入/导出/预览缓冲；Snippet 使用 Vault 密文存储，批量命令限制为最多 8 台主机、4 个 worker、每目标 16 KiB 输出，命令、传输和脱敏 Activity 状态写入 app-private SQLite，并在锁定/进程重启后恢复为 `interrupted`。native capability 只广告当前真实接入的本地工作区、Workspace 模板、Identity/Vault bundle、Snippet/批量命令、SSH/ProxyJump、SFTP、有限断点和 Activity 审计；外部配置导入已补齐 OpenSSH、SSH/Termius CSV、MobaXterm、Xshell、SecureCRT 五种有界文本解析，并对跳板机引用做名称/地址归一化。`c660d6e` 修复了 ProxyJump 目标会话关闭时跳板连接未统一释放的问题；`1834911` 让 bundle 导入直接消费 `CharSequence`，避免最多 8 MiB 导入缓冲在完成预览时再复制一份；`b9ac4f2` 增加 Workspace 模板 SQLite v7 迁移和原生 schema 校验。Kotlin 编译与 Android JVM 单元测试已通过，但后台 UI/进程恢复、真实设备与发布 ABI/签名仍未完成，不能宣称 Android 独立客户端交付。
- 内存预算：原生文件与终端传输使用 32 KiB 单块；终端输入使用每会话最多 8 条、总量 64 KiB 的有界队列，超限显式报错；Windows 默认最多 4 个 SSH 会话、每会话 64 KiB 脱离缓冲、最多 4 个下载流、最多 32 个可重连请求；IPC/事件订阅和 payload 也有上限。验证默认关闭文件并行并限制 worker，避免在无 Swap 主机上同时启动多份 Node/Vite。
- 共享导入/导出边界：`WorkspaceSettings` 顺序读取文件，外部配置总量限制 48 KiB，Vault bundle 限制 8 MiB，最多 4 个文件；原生 `FileWriter` 路径按 32 KiB 写入，避免导出时先构造整份 `Uint8Array`。对应提交 `132d12a`，WorkspaceSettings DOM 测试 7/7 通过。
- 低内存与桌面安全增量（2026-09-18）：Windows Vault 导入改为最多 8 MiB 的有界二进制块收集，避免逐块字符串和 `join` 的额外峰值；native Vault 导出在存在原生文件句柄时按 32 KiB 流式写入 renderer，保留完整字符串导出作为 Web/兼容回退。Android WebView 事件队列固定 8 条，输出/进度可丢弃、控制事件优先；Electron 导航仅允许当前 renderer 文件。对应定向验证：Windows/native/Web 23 个测试通过、native TypeScript 类型检查与 ESLint 通过、`npm run build:windows` 通过；Android JVM 测试通过。
- 原生恢复与输入缓冲增量（2026-09-18，`1142f0d`、`3c37281`、`4a47600`）：Windows/Android 不再持久化不可跨进程复用的 SSH descriptor；原生工作区重载后统一显示 `needs-reopen`，用户明确操作后才创建新 Shell，浏览器端仍先尝试服务端 reattach。原生 session 在生命周期关闭后不再进入自动重连循环，重开前释放旧 socket；Android Executor 与 JSch session 之间复用一次 UTF-8 输入缓冲并在完成后清零。对应 Web/native 定向测试通过，Android JVM 测试以单 worker、`-Xmx768m` 通过；真实后台/进程回收仍需设备验证。
- Android 返回键增量（2026-09-18，`4185685`）：MainActivity 将系统返回键转成可取消的 `relay:back` 事件，shared App 按最上层对话框、工作区和 Console 视图顺序关闭，根页面无可关闭内容时交回系统退出；未复制 Android 专用弹层状态。App DOM 17/17、native TypeScript 检查和受影响 ESLint 通过，Android Java/Kotlin 编译通过；真机软键盘、系统返回栈和旋转仍需设备走查。
- 原生能力声明修正（2026-09-18）：移除桌面原生核心错误暴露的 `session.reattach`；跨进程恢复不再作为原生能力，原生工作区必须由用户明确重新打开。native core 与 adapter contract 定向测试 9/9、受影响 ESLint 和 TypeScript 检查通过。
- 原生输入内存边界增量（2026-09-18）：终端输入队列改按 UTF-8 字节计量，不再以 JS 字符数放大 32 KiB 单次输入和 64 KiB 队列预算；shared runtime 与 WebView/native socket 共用无临时编码缓冲的字节长度计算。相关定向测试 12/12、受影响 ESLint 和 native TypeScript 检查通过。
- 原生早到输出缓存增量（2026-09-18）：Shell 订阅建立前的事件缓存增加每会话最多 16 条、累计 64 KiB 的双重上限，避免高频输出在 UI 尚未接管时按事件数累积；相关定向测试 13/13、受影响 ESLint 和 native TypeScript 检查通过。
- 平台系统能力抽离增量（2026-09-18）：`StoragePort` 注入 Web/Windows/Android UI 的本地偏好与 Web 会话恢复意图；`TerminalPanel` 粘贴确认只调用 `DialogPort`，无平台确认能力时不发送剪贴板内容；浏览器直链下载 fallback 收敛到 `DownloadPort` 与 `WebFileTransport`，UI 不再直接创建下载锚点或拼接传输 URL，原生端不会误走 Web 下载路径。相关 Web/DOM 测试、受影响 ESLint 和根 TypeScript 检查随本增量验证。
- 移动 Console 工具条增量（2026-09-18）：重新接通已有 `TerminalPanel` toolbar 状态，在窄屏底部提供复制、粘贴、搜索、清屏、全屏、重连和关闭等快捷操作；桌面顶部栏保持紧凑，打开 SFTP 时工具条隐藏；工具条状态映射按终端 ID 有界清理，避免已关闭 Console 残留。相关 Web/DOM 测试 31/31、受影响 ESLint、根 TypeScript 和 Web 构建通过；真实 Android 软键盘/安全区仍需设备走查。
- 大目录 SFTP 分页与写入器安全增量（2026-09-18，本轮提交）：新增共享 `SftpListPage`/游标协议和 `/list-page` Web 路由；服务端 ssh2 适配器使用 `opendir/readdir` 按页读取，Windows 复用同一服务，Android 原生按游标和名称过滤返回最多 256 项；Web SFTP 面板在分页模式只保留当前页，并限制返回游标历史为 32 条，避免把整个远端目录放入 UI 内存。达到 Android 文件写入器上限时改为取消临时文件，避免误提交导出文件。受影响测试 7 个文件、55/55 通过，根/native TypeScript、受影响 ESLint、Web/Windows/Server 构建通过；Android Kotlin 编译和此前 JVM 单元测试也通过。真实设备和 Windows 实机分页走查仍待完成。
- 交互与构建稳定性增量（2026-09-18）：Host 卡片右键改为捕获阶段处理，避免点到卡片内动作按钮时丢失 Server 菜单，同时保留标签专属右键菜单；上下文菜单首次定位/聚焦不再被布局滚动立即关闭。Playwright 主题回归同步到当前主题预览卡交互，主流程 E2E 4/4 通过。浏览器端远端异常重连不再主动调用规范禁止的 WebSocket `1011` 关闭码，改用合法的 `1000` 并保留自动重连语义；相关单测通过。Server/Cloud 构建脚本将 `ws` 标为 external，产物可直接被 Node ESM 加载，避免生产构建后启动崩溃。
- 跨平台回归增量（2026-09-18，本轮 Windows checkout）：Windows Playwright 配置改为使用 `webServer.env`，并加入可在非 Linux/root 环境运行的 in-process `ssh2` E2E fixture；共享 `.tmp-e2e-data` 的 E2E worker 固定为 1，避免多个 spec 并行初始化 Vault。默认 E2E 4/4 通过，覆盖 Vault、Host Key、终端、多标签、SFTP、批量命令、离线窄屏和旧 Shell 恢复为 `needs-reopen`。全量 Vitest 为 160 个文件通过、1 个跳过，719 个测试通过、2 个跳过；`npm run typecheck`、`npm run lint`、`npm run build` 和 `npm run build:windows` 通过。
- 原生制品与设备回归增量（2026-09-18，源码 `7caa316`）：Android 使用 JDK 21、Gradle 9.3.1、单 worker 构建，`testDebugUnitTest`、`connectedDebugAndroidTest`（2/2）和 `assembleDebug` 均通过；最终 Debug APK 为 8,633,239 bytes，SHA-256 `8F307F8DCC937BD7C6B0444B0834D83B0E7067D87F6FDB5F4DF41E621F2E4C52`。最终 APK 已安装到 `emulator-5554`（API 35/x86_64），首次连接显示并确认 `ssh-ed25519` Host Key 指纹 `SHA256:RrDNThMGT8sF6lsRsqnQ37vum6+6Q/NmrSXZCM2zf6g`，Host 卡片持久化为“指纹已验证”并记录最近连接；本轮未见 Relay SSH 错误日志。该证据只覆盖 Android Vault/Host 创建、首次 Host Key 和一次 Shell 建立，仍不替代 A-01～A-17 的完整验收。
- 真实设备回归增量（2026-09-18）：同一 Debug APK 已安装到两台 Android 16 真机 `2407FRK8EC`、`25091RP04C`。两台设备均使用用户指定的密码主机完成首次 Host Key native trust（指纹 `SHA256:DW4b509womrL6B4XC9tjbWFZsVNzPy6I1lBcFWiz5kI`）、再次连接测试、`/tmp` SFTP 列举（19 项/台）以及终端 resize/写入/关闭；密码未写入仓库。该条只证明真实设备原生 SSH/SFTP 通路，不能替代完整 UI、Host Key 变更、私钥、上传下载取消、生命周期和低内存验收。
- 真实服务器 UI 重开与输入回归（2026-09-19，源码 `d3c4c62`，APK SHA-256 `D740E4D58BAA208E38D2F1DE51B86C6973745EF8C718D48C255FEBAF9D6B9BA8`）：在 Xiaomi `2407FRK8EC` 和 `25091RP04C` 两台 Android 16 真机上，明确使用 `106.14.61.92:22`、账号 `t2` 的用户提供密码主机；两台均连续 3 轮执行“关闭当前 Shell→重新打开 Host→等待 raw native `terminal.status=connected`→聚焦 Console→输入 `whoami`”，每轮均返回 `t2`，终端标签状态均为 `status-dot-green`。本条最终真机结论不使用本地 fixture；fixture 仅保留为可重复回归测试工具。
- 历史记录：Windows x64 portable 包曾从源码 commit `75cc630` 在本机生成（`npm run package:windows:portable`，`npmRebuild=false`），文件 `dist/releases-portable-preview/Relay-0.1.0-x64.exe`，大小 457,281,531 bytes，SHA-256 `1A7B61C6DD7C846BD0CC924A05FA812032A83691CE7D76ECAC2106413359D04C`；Electron 44.4.1 已通过镜像下载，签名状态为 `NotSigned`。该包不是本轮新产物，也未证明 better-sqlite3/argon2 的 Windows Electron native ABI、升级迁移、安装/退出/重开和完整 SSH/SFTP 任务链。

验证记录（2026-09-18）：

> 追溯说明：以下带有 Linux 路径、旧制品 hash 或“没有 Android 真机/模拟器”描述的条目是早期构建记录，仅保留用于追溯；当前交接以本节后面的“跨平台回归增量（本轮 Windows checkout）”、“原生制品与设备回归增量”和“当前设备交接状态”为准。

- `npm exec vitest -- run` 针对 8 个受影响测试文件，以 `--no-file-parallelism --maxWorkers=1` 执行：8 files、45 tests 通过。
- `npm exec tsc -- -p tsconfig.native.json --noEmit` 通过；改动的 Windows/native/Web TS/TSX 文件 ESLint 在 `--max-warnings 0` 下通过。
- `npm run typecheck` 通过。
- `npm run build:windows` 通过，包含 web、Electron main 和 preload 三段构建；`npx cap sync android` 通过。
- `./gradlew :app:compileDebugKotlin --offline --no-daemon --max-workers=1 --console=plain`、`./gradlew :app:testDebugUnitTest --offline --no-daemon --max-workers=1 --console=plain` 和 `./gradlew :app:assembleDebug --offline --no-daemon --max-workers=1 --console=plain` 通过；当前 debug APK 约 8 MB。当前没有 Android 真机/模拟器，因此安装、连接、生命周期和 SSH/SFTP 任务仍无设备证据。Android 构建统一使用 `-Xmx768m`、单 worker、无并行，避免本机内存峰值叠加。
- 最新 Android 资源生命周期与低内存增量（`c660d6e`、`1834911`）使用 `./gradlew :app:testDebugUnitTest :app:assembleDebug --offline --no-daemon --max-workers=1 --console=plain` 复验通过：80 actionable tasks，8 executed、72 up-to-date，`BUILD SUCCESSFUL`；Debug APK 约 9.1 MB。仍无 Android 真机/模拟器，因此只能证明编译、JVM 单测和打包，不能替代 SSH/SFTP、Keystore、URI、后台生命周期的设备证据。
- Workspace 模板增量（`b9ac4f2`）通过同一低内存 Gradle 命令复验：22 个 Android JVM 单测通过，80 actionable tasks，8 executed、72 up-to-date，`BUILD SUCCESSFUL`；共享 native core、adapter、Android bridge 定向测试 11/11，TypeScript 类型检查和 `core-runtime.ts` ESLint 通过。
- 本次 Android 自动化/任务持久化增量另行通过 `:app:compileDebugKotlin`、`:app:testDebugUnitTest`（单 worker、离线）以及共享 native core、adapter、Android bridge 受影响测试 11/11；`src/shared/native/core-runtime.ts` ESLint 与 `git diff --check` 通过。
- 本次 Android Activity 与外部配置导入增量通过 `:app:testDebugUnitTest --offline --no-daemon --max-workers=1`；外部解析器覆盖 OpenSSH、CSV、MobaXterm、Xshell、SecureCRT，输入总量受 48 KiB 上限约束。另修正本地 SQLite 增量升级保护条件，并在插件销毁时将活动 Shell 标记为 `needs-reopen`；真实生命周期行为仍需设备验证。
- 本次原生恢复与输入缓冲增量的 Android 验证使用 `ANDROID_HOME=/usr/lib/android-sdk ANDROID_SDK_ROOT=/usr/lib/android-sdk ./gradlew :app:testDebugUnitTest --offline --no-daemon --max-workers=1 --console=plain`，53 actionable tasks、5 executed、48 up-to-date，`BUILD SUCCESSFUL`。首次未设置 SDK 路径的运行只停在 Gradle 配置阶段，不作为代码失败证据。
- `npm test -- --no-file-parallelism --maxWorkers=1 --reporter=dot` 完成 159 个测试文件、695 个测试，695 个全部通过。期间修正了 bundle 导出仍回退到旧内置主题 ID 的实现缺陷，并将 shared core 边界测试收敛到真正的 `src/shared/core` 目录，避免把 cloud WebSocket 适配器误判为 core 依赖。
- 历史跨端回归（Linux 旧工作树，已被本轮 Windows checkout 记录取代）：`npm test -- --no-file-parallelism --maxWorkers=1 --reporter=dot` 完成 161 个测试文件、720 个测试，全部通过；`npm run typecheck`、`npm run lint`、`npm run build`（Web/Server/Cloud）和 `npm run build:windows` 全部通过。Android Debug APK 已通过单 worker Gradle 构建、APK ZIP 完整性检查；Windows x64 portable 预览包已通过 PE 格式检查和 Linux Electron 启动烟测。该条不作为当前 Windows/Android 设备证据。
- 历史增量回归（Linux 旧工作树，已被本轮 Windows checkout 记录取代）：`npm run test:e2e -- --workers=1` 通过 4/4；`npm run package:windows:portable` 的旧包 SHA256 为 `91af49081e8a477a99fe5993ace1777797115f0b32355249cd31ebf4bb435478`，旧 Debug APK SHA256 为 `8978bb8d9d4a8a4d0298456cb9dbc169c72ea760ee3fdb0fd8e5d65b61302a6a`。该条只保留历史溯源，不代表当前制品或设备结果。
## 当前设备交接状态（2026-09-19）

- Android 代码、Kotlin 编译、JVM 单元测试、connected 测试（2/2）和 Debug APK 构建已完成；本条早期设备回归使用源码提交 `d3c4c62` 的 APK（SHA-256 `D740E4D58BAA208E38D2F1DE51B86C6973745EF8C718D48C255FEBAF9D6B9BA8`），当前 APK 制品以本文末节的 `158F...ED045` 为准。两台 Android 16 真机 `2407FRK8EC`、`25091RP04C` 已使用 `106.14.61.92:22` 的用户提供密码主机完成 Host Key trust、连接测试、`/tmp` SFTP 列举、终端 resize/写入/关闭，以及 3 轮关闭/重开后输入 `whoami` 返回 `t2`；`2407FRK8EC` 在重装后又完成首次指纹确认、真实登录和 `echo REAL_SERVER_2407_REINSTALLED` 回显。完整 SFTP、私钥认证、Host Key 变更、网络切换、锁屏/进程回收、低内存和 A-01～A-17 其余项目仍未完成。
- 之前的 AOSP 软件模拟器 `/dev/kvm` 阻塞记录仍保留为历史环境证据；当前真机 native smoke 已补充真实设备 SSH/SFTP 通路证据，但仍不应扩大解释为完整 Android UI 和生命周期验收。
- Android APK 已交接到 [跨端验收交接任务书](../verification/2026-09-18-relay-cross-platform-handoff.md)，由目标设备执行人继续回填。任务 4–14 仍保持未完成；任务 15 只是未来同步兼容性预留，不属于本期客户端发布门禁。
- Windows 当前已用提交 `bde17c4` 工作树执行 `npm run package:windows`，分别生成 NSIS/portable 制品；Electron ABI 149 下 `argon2`、`better-sqlite3`、`cpu-features` 加载和 NSIS 安装/启动/卸载已通过。升级迁移、崩溃恢复、签名及打包后完整 SSH/SFTP/Vault/UI 任务链仍未验收。
- APK 和 portable 包当前只存在于本机 gitignored 生成目录，不会随 `git clone` 或 `git checkout` 出现；当前没有可追溯的 Release 附件、制品服务器或共享目录作为持久来源。最终签收前必须登记可访问的制品来源，并记录源码 commit、工具链版本和 SHA-256。

当前最重要的发布阻塞项是 Windows 升级/崩溃/完整任务链/签名与持久制品来源，以及交接机器上的 Android URI 立即释放、生命周期、低内存和 A-03～A-17 剩余能力；在这些完成前，代码只能称为可测试的跨端基础设施与技术预览，不能称为两个平台客户端已完整交付。云同步仍按本计划作为后续独立能力，不在本增量中模拟或宣称完成。

## 2026-09-19 增量复审：Windows UI 与真实测试主机

- Windows root Electron UI 已使用本机 `npm run build:windows` 产物启动，并连接用户提供的真实 SSH 主机 `106.14.61.92:22`（账号 `t2`；密码未写入仓库）。UI 已完成 Host Key 已信任后的 Shell 打开、终端输入 `echo WINDOWS_UI_STABLE`、关闭 Console、重新打开 Host、再次输入 `echo WINDOWS_UI_REOPEN_STABLE`；两次均收到远端 `t2` 提示符和命令回显，生命周期诊断中没有重复打开循环或 `SSH_CONNECTION_FAILED`。
- 本轮修复了四个 Windows/native 生命周期问题：Electron file URL 使用相对 renderer 资源；sandbox preload 内置 `zod`；Windows preload 串行化 `sessions.close` 与下一次 `sessions.openShell`；原生 Shell 使用唯一 request ID、在 `sessions.openShell` 完成前不发送 resize，并将 clean close 的 service instance 统一为 `desktop-local`。
- 受影响的 native/Windows 定向回归为 7 个测试文件、30 个测试全部通过；`npm run typecheck`、`npm run lint`、`npm run build:windows` 全部通过。续验后的标准全量 Web/Server 回归为 161 个测试文件通过、1 个跳过，727 个测试通过、2 个跳过；Playwright E2E 为 4/4。
- 历史阻塞记录：本机曾缺少 Visual Studio/MSVC，且 builder 曾因外部 Electron 下载 `ETIMEDOUT`；随后已安装 Build Tools、重建 native module，并将 `package:windows` 固定到本地 Electron 分发目录。最终 NSIS/portable 制品、ABI 和安装证据见本文末节；签名、升级迁移和完整任务链仍未验收。

## 2026-09-19 续验：Android 真机、Web/Server 与安全边界

- 真实服务器证据继续使用用户提供的 `106.14.61.92:22`、账号 `t2`；本地 in-process SSH fixture 只用于自动化回归。两台设备均从“需要重新打开”的 Console 状态重新打开 Host 后，分别在真实远端输入 `echo REAL_SERVER_2407` 和 `echo REAL_SERVER_25091`，均收到远端命令回显和 `t2` 提示符，证明绿色状态对应的 Console 已恢复实际输入通路，而不是只看状态点颜色。
- `25091RP04C` 的真实 SFTP UI 已打开并浏览远端 `/`（36 项）和 `/tmp`（25 项）；初次通过非用户手势的 HTML 文件选择器自动化没有形成传输任务，不能作为证据。随后真实系统文件选择器和 DocumentsUI 的上传/下载 100% 证据见本节后续条目；32 MiB/25% 取消、重试、部分失败和完整 URI 交互仍保持待验收。
- Android 原生验证环境使用已安装的 JDK 21、缓存 Gradle 9.3.1、单 worker 和离线模式：`:app:testDebugUnitTest :app:assembleDebug` 成功；`:app:connectedDebugAndroidTest` 在 `2407FRK8EC` 完成 2/2。测试 runner 随后清理目标 APK，`adb install -r` 和 `--no-streaming` 曾返回 `INSTALL_FAILED_USER_RESTRICTED`；该历史阻塞随后已在设备侧恢复，重新安装返回 `Success`，并完成本任务书服务器的真实 UI 登录回显验证。
- `25091RP04C` 的安全检查：普通 logcat 无 `relay-device-test-2026` 标记，app-private 数据无该标记，`ss -lntp` 未发现 Relay app 或 5173/3000/4173 监听；`aapt dump xmltree` 显示 APK `android:allowBackup` 为 `0`。这些是部分 A-16 证据，不替代带专用标记密码的完整日志/WebView/备份流程。
- Web/Server 标准全量回归第一次出现 `sync-routes` 单测 5 秒超时，针对文件 13/13 通过后再次运行标准命令完整通过；该次复跑结果为 161 个测试文件通过、1 个跳过，727 个测试通过、2 个跳过，E2E 4/4。未修改超时阈值，也未把 `--isolate=false` 的污染结果当作验收证据。
- Android 系统文件交互续验：`25091RP04C` 通过真实 MIUI 文件选择器选取本地 33,817-byte PNG，上传到用户服务器 `/tmp` 后 Transfer Center 显示 `已完成 · 100%`；再通过 Android DocumentsUI 保存对话框下载回本机，保存文件为 33,817 bytes，Transfer Center 同样显示 `已完成 · 100%`。在远端 `/` 无写权限时，上传任务保持 0% 并被取消，未产生目标文件。该证据仍未覆盖 32 MiB/25% 取消、重试和部分失败矩阵。
- URI 边界：传输完成后当前 Activity 仍可观察到本轮选择产生的临时 URI grant；`force-stop` 后重启 Relay，`readUriPermissions/writeUriPermissions` 均清空，未形成持久化授权。A-11 的任务结束立即释放、拒绝权限提示和分享链路仍待单独验收，不能只凭进程重启后的清理判定通过。

## 2026-09-19 续验追加：手机重装后真实主机验证

- `2407FRK8EC` 已重新安装早期源码 `d3c4c62` 对应 Debug APK，`adb install -r --no-streaming` 返回 `Success`；该安装记录保留用于设备恢复溯源，当前安装以本文末节记录的 APK 为准。
- 手机首次重新连接 `106.14.61.92:22` 时展示并确认真实 `ssh-ed25519` 指纹 `SHA256:DW4b509womrL6B4XC9tjbWFZsVNzPy6I1lBcFWiz5kI`；修正端上 Host 独立凭据后建立远程 Ubuntu Shell，输入 `echo REAL_SERVER_2407_REINSTALLED` 得到同名远端回显和 `t2` 提示符。
- 本条使用的是用户提供的测试服务器；密码未写入代码、日志或任务书。本条只更新手机当前安装和真实 SSH 输入证据，不改变 A-01～A-17 其余待执行门禁。

## 2026-09-19 最终实现与制品复审（提交 `bde17c4`）

- Android 原生文件上传已从系统 `ACTION_OPEN_DOCUMENT` 选择器贯通到原生 JSch/SFTP：WebView 只收到不含文件字节的 `sourceId/name/size`，原生以 32 KiB 有界缓冲读取 `content://` URI，使用单条 SFTP 连接、`.relay-part-<transferId>` staging 和完成后 rename；暂停/取消/失败不会把半文件提交为最终目标。
- 真实主机 `106.14.61.92:22`、账号 `t2` 上，`2407FRK8EC` 使用 32 MiB 设备文件完成上传；远端大小为 `33,554,432` bytes，SHA-256 为 `83ee47245398adee79bd9c0a8bc57b821e92aba10f5f9ade8a5d1fae4d8c4302`，源文件和远端一致。取消测试在约 35% 时进入 `已取消`，原有完整目标保持原大小/哈希且没有 staging；暂停后继续从约 11 MiB 断点完成并再次校验一致。该证据仍不替代 A-11 的任务结束立即释放 URI、权限拒绝和分享链路验收。
- 两台 Android 16 真机 `2407FRK8EC`、`25091RP04C` 均安装当前 Debug APK；APK 大小 `8,633,755` bytes，SHA-256 `158F049680DBC0600D571F1A69FB835B84D2617C0CC677E69F5986FD010ED045`。构建使用 JDK 21、已缓存 Gradle 9.3.1、`--offline`、单 worker；`:app:testDebugUnitTest :app:assembleDebug` 成功。
- Windows 打包脚本已显式使用 `node_modules/electron/dist`，`npm run package:windows` 不再尝试外部 Electron 下载，并分别生成 NSIS 与 portable 输出，避免两个 target 覆盖同一 artifact 名称。NSIS `127,632,075` bytes、SHA-256 `979E3D6CECD611AE99F3DE3CA41D3E6A298A5906196B685B61318A5853FDF20F`；portable `113,552,550` bytes、SHA-256 `82F8D40377037DF2392CFF2B20F7ED0E537C7011D118EEDFC99C01B37C0CAC7D`；两者均为 `NotSigned`。Electron ABI 149 下三个 native module 加载通过，NSIS 静默安装、启动存活 5 秒、静默卸载通过。
- Web/Server 最终回归：`npm run typecheck`、`npm run lint`、`npm run build`、`npm run build:windows`、定向 Web/native 测试（4 文件、31 测试）和全量 `npm test -- --no-file-parallelism --maxWorkers=1 --reporter=dot`（161 文件通过、1 跳过；731 测试通过、2 跳过）均通过。仍未完成的是任务书 A-03～A-09、A-11～A-17 中明确列出的真实设备边界，以及 Windows 升级迁移/崩溃恢复/打包后完整任务链和持久制品来源。

## 2026-09-19 URI 权限复核与大文件下载续验（提交 `b094ee9`）

- Android executor 现在同时尝试 Activity 与 application context 的 `READ|WRITE` URI revoke；构建、JVM 单测和 Debug APK 均通过。当前 APK 大小 `8,633,755` bytes，SHA-256 `42F5C183FB0CB4F6DAAAFA0825E8F3C41408B7CEF39A7F92390016AB85A6F19F`，两台真机均返回 `adb install -r --no-streaming` 的 `Success`。
- `25091RP04C` 从用户提供的真实主机 `/tmp/relay-native-32m.bin` 下载到 `Download/relay-native-32m.bin`，最终大小 `33,554,432` bytes，设备端 SHA-256 为 `83ee47245398adee79bd9c0a8bc57b821e92aba10f5f9ade8a5d1fae4d8c4302`，与服务器和源文件一致；Transfer Center 显示 `已完成 · 100%`。
- 传输完成后 `dumpsys activity permissions` 仍显示选择 URI 由当前 `MainActivity` 持有的临时 grant；`force-stop cn.ayan.relay` 后重新启动才清空。该现象属于当前 Android/MIUI 交互边界，A-11 继续保持未完成，不能把 best-effort revoke 误记为立即释放通过。

## 2026-09-19 Android 返回、过滤与进程恢复增量

- `25091RP04C` 从真实 Console 发送系统返回键后回到 Server 列表；在 `/tmp` 输入过滤 `relay-native` 后当前页收敛为 1 项，证明真实设备过滤入口可达。完整弹层/根页面返回栈、滚动和分页仍未完成。
- 对同一设备执行 `force-stop cn.ayan.relay` 后重新启动，Vault 解锁后仍保留 `Provided Acceptance Host`；旧 Console 明确显示“此 Console 需要重新连接”，不是伪造 connected，点击重新打开后建立新的真实 Shell。锁屏、旋转和完整进程回收仍待验收。

## 2026-09-19 打包版 Windows 与 Android 大目录/内存增量

- 打包版 Windows `Relay.exe` 已在真实 `106.14.61.92:22`/`t2` 主机上完成 Shell 回显、SFTP `/` 浏览、`/tmp` 过滤、Vault 锁定/解锁和一次强制终止后的 Console 重新打开；`PACKAGED_WINDOWS_AFTER_CRASH` 真实远端回显已核对。该证据不替代升级迁移、签名、持久制品来源和完整打包下载链。
- `25091RP04C` 在真实主机创建并清理 300 个一次性条目，Android UI 分页读取 `128 + 128 + 44`；大目录过程 PSS 从 `270,324 KB` 采样到返回 Server 后约 30 秒的 `251,874 KB`。无 OOM/ANR，但 A-15 仍缺 2 分钟基线和 32 MiB 传输并行采样，保持未完成。

## 2026-09-19 固定跨端 bundle 回归与安装阻塞复核

- 新增合成固定向量 `tests/fixtures/vault-bundle-v1-full-vector.json` 及 Android instrumentation 资产，覆盖 2 Host、2 Group、2 Identity、1 Terminal Profile、空格/中文标签、PEM 私钥、Group 部分连接配置、jump host 与 canonical string `credentialSource`。bundle SHA-256 为 `eb5ac0fcd78ff260b7ca686caf33bc9d8ac4f14b7542503acf0768ed510fccf0`，payload SHA-256 为 `aaaf965d4077c724126daab6bb1603b1619ce3ddf981d1bcad2443cc67ae202f`；仅使用合成数据，不含真实凭据。
- Node/Server 固定向量测试 6/6 通过；`2407FRK8EC`、`25091RP04C` 两台 Android 16 真机 instrumentation 各 5/5 通过；Android JVM `testDebugUnitTest` 和 AndroidTest APK 构建通过。当前 Debug APK 大小 `8,633,755` bytes，SHA-256 `EC1366A3943ED4879E639D1F3D8AA75BE57F3E983E3F66AC82F00CB325E57A18`。
- 代码修复了四个跨端兼容缺陷：Web 标签不应使用 native safe-id 规则、PEM 私钥必须允许换行、Group profile 是可选 patch、`credentialSource` 应以 canonical string 表达并兼容旧 object 形状。Android 本地私钥创建/更新也采用多行文本边界校验。
- `25091RP04C` 普通 APK 安装曾被系统拒绝（`INSTALL_FAILED_USER_RESTRICTED`）；通过 `adb push` 后 `pm install -r --user 0` 成功，测试 APK 安装成功并完成 5/5。该安装阻塞已解除。
- A-17 仍保持部分证据：Node → Android 固定向量解密/解析已在两台真机完成，但 Android → Web/Windows 真实导出回传、Windows 端导入、完整冲突策略和发布门禁尚未完成；不能把跨端任务书或 Windows/Android 客户端宣称为完整交付。

## 2026-09-19 URI 授权模式修复与在线真机复验

- Android SAF 选择结果现在保留实际的 `READ|WRITE` mode flags 及是否成功取得 persistable grant；文件打开、保存、上传完成/失败/取消和 writer close/cancel 均按实际授权模式执行 release。补充的 Android JVM 红绿测试验证了 mode flags 与 persistable 状态不会丢失。
- 当前 APK `app-debug.apk` 为 `8,633,755` bytes，SHA-256 `068A16E94F09EA90C97F609DD456BDEE0874F830FC57668C364A8C997DB18C89`。JDK 21 / Gradle 9.3.1 / offline / 单 worker 下 `:app:testDebugUnitTest` 和 `:app:assembleDebug` 均成功；在线设备 `25091RP04C` 的上一轮已安装版本完成 5/5 connected instrumentation，本轮重装被设备系统拒绝。
- `25091RP04C` 使用真实 MIUI 文件选择器选择 `relay-uri-check.json`，向用户提供的 `106.14.61.92:22`、账号 `t2` 上传到 `/tmp/relay-uri-grant-check.json`；远端大小 `5,176` bytes，SHA-256 `169800b9708c5bc818d64cf3410f566469b65809bcbd3ef9401e4a12a8b4f783`，与固定合成源一致。测试 Host、远端临时文件和设备测试文件已清理。
- 传输完成时 `dumpsys activity permissions` 仍可看到当前 `MainActivity` 持有本轮的 Activity 临时 grant；`force-stop cn.ayan.relay` 后该 URI grant 不再出现，说明未留下持久化授权，但 Android/MIUI 不允许把 Activity-owned 临时 grant 证明为任务结束即时消失。A-11 继续保持待执行，拒绝权限和分享链路也未宣称通过。
- 本轮复验期间 `2407FRK8EC` 未在线：`adb connect 192.168.1.2:40019` 超时，重试安装返回 `device not found`；因此本条真机新证据只归属于 `25091RP04C`，不扩大为两台设备均已复验。
- 本轮随后再次触发在线设备 `25091RP04C` 安装：Gradle connected 及设备侧 `adb push` + `pm install -r --user 0` 均返回 `INSTALL_FAILED_USER_RESTRICTED`，connected 实际为 0 tests；因此最新 APK 只完成本地构建，不能记录为本轮真机安装成功。
- 后续设备复核：`25091RP04C` 仍在线；`2407FRK8EC` 的 `adb connect 192.168.1.2:40019` 当前由设备端主动拒绝（Windows socket 10061），`adb get-state` 返回 `device not found`，因此本轮没有新的 2407 安装证据。

## 2026-09-19 Windows 打包版启动与定向回归

- 从 `dist/releases/nsis/win-unpacked/Relay.exe` 启动打包版，真实渲染页标题为 `Relay SSH Workspace`，桌面 preload IPC 可用；调用 `vault.status` 返回 `locked`。本次只读取锁定页和状态，没有解锁或写入现有桌面 Vault。
- Windows `local-runtime`、main/preload 与 Server 固定 bundle 定向测试共 4 个文件、20 个测试通过；这补充了 Windows 启动/IPC/本地 runtime 的自动化证据，但不替代打包后完整 SSH/SFTP/Vault 任务链、升级迁移、签名和持久制品来源验收。

## 2026-09-19 Windows 固定 bundle 回归与 Android 安装重试

- 按 TDD 为 Windows IPC 增加固定 `vault-bundle-v1-full-vector.json` 的 preview/apply 回归，覆盖 2 个 Host、2 个 Group、2 个 Identity、终端 profile、标签、PEM 私钥、Group Identity 继承、jump host 及错误密码/篡改回滚。测试先暴露共享 `toHostMetadata` 映射遗漏 `terminalProfileId` 的真实缺陷，已补齐最小映射修复。
- `tests/unit/windows/local-runtime.test.ts` 定向结果为 6/6 通过；全量 Vitest 结果为 161 个测试文件通过、1 个跳过，734 个测试通过、2 个跳过。全量运行中的 jsdom Canvas/跨文档导航提示为既有测试环境提示，未形成失败。
- 本轮再次向在线设备 `192.168.1.3:46545`（`25091RP04C`）触发安装；设备连接和 APK 推送均成功，随后 `adb install -r -g --no-streaming` 返回 `INSTALL_FAILED_USER_RESTRICTED: Install canceled by user`，安装仍未完成，不能把本轮记为真机安装或 connected instrumentation 通过。
- `2407FRK8EC`（`192.168.1.2:40019`）仍由目标端主动拒绝连接（Windows socket 10061），未执行到安装阶段；两台设备的安装/测试状态继续分开记录。

## 2026-09-19 Web 回归与 Windows 打包版 Vault 重启验证

- Web Playwright 当前复跑 `npm run test:e2e -- --project=chromium` 为 4/4 通过，覆盖 Vault/Host Key/终端多标签与锁定、SFTP 上传下载和取消、批量任务、断线恢复、窄屏布局与主题持久化。
- 最新 `npm run build:windows` 和 `npm run package:windows` 均成功；NSIS `127,632,261` bytes、SHA-256 `D79B07850B80F1E714C07EDB543EB0CA1CCBDC4E071BC74E2743904F93F95858`，portable `113,552,538` bytes、SHA-256 `26C498BB91315FC39DF3DC4AA527FD9A06ED80700D177DA6F1FFAA49C931B99A`。两者 `Get-AuthenticodeSignature` 均为 `NotSigned`，签名仍是发布门禁。
- 使用独立 `--user-data-dir` 启动打包版并通过真实 renderer/preload IPC 完成：首次 Vault setup、Host 保存、workspace 保存、锁定、错误密码拒绝、正确解锁；停止进程后再次启动，状态先为 locked，解锁后 Host/workspace 均恢复。该证据不接触现有桌面用户数据。
- 新增 Windows 本地文件 runtime 重启回归后，定向 `local-runtime` 为 7/7；当前全量 Vitest 为 161 个文件通过、1 个跳过，735 个测试通过、2 个跳过；typecheck/lint 均通过。

## 2026-09-19 Windows 打包版真实主机 SSH/SFTP 验证

- 用最新 NSIS 解压目录的 `Relay.exe` 和独立 `userData`，通过真实 renderer/preload IPC 连接用户提供的 `106.14.61.92:22`、账号 `t2` 主机；首次 Host Key 指纹为 `SHA256:DW4b509womrL6B4XC9tjbWFZsVNzPy6I1lBcFWiz5k`，显式 trust 后 Shell 状态为 `connected`。
- Shell 通过 native IPC 写入固定合成标记并收到真实远端回显；同一 Host 再经 `files.listPage` 读取 `/`，返回 16 项并带分页 cursor，随后关闭 Shell、锁定 Vault，`vault.status` 返回 `locked`。本次密码仅通过临时进程环境变量传入，没有写入脚本、仓库或日志。
- 该证据补上 Windows 打包版真实密码认证、Host Key 首次信任、终端输入和 SFTP 分页链路；私钥认证、Host Key 变更拒绝、完整上传下载/失败矩阵、升级迁移、签名和持久制品来源仍未完成。

## 2026-09-19 双真机重试：安装与 connected instrumentation

- 当前 Debug APK 为 `8,633,755` bytes，SHA-256 为 `068A16E94F09EA90C97F609DD456BDEE0874F830FC57668C364A8C997DB18C89`。
- `2407FRK8EC`（Android 16/API 36）通过 mDNS ADB serial `adb-8DWSM7Y9IBCMPJSC-oak1zL._adb-tls-connect._tcp` 重新触发安装，`adb install -r -g --no-streaming` 返回 `Success`；`:app:connectedDebugAndroidTest` 完成 `7/7`，Gradle `BUILD SUCCESSFUL`。
- `25091RP04C`（Android 16/API 36）通过 `192.168.1.3:46545` 重新触发安装，`adb install -r -g --no-streaming` 返回 `Success`；`:app:connectedDebugAndroidTest` 完成 `7/7`，Gradle `BUILD SUCCESSFUL`。
- 本轮证明此前的 `INSTALL_FAILED_USER_RESTRICTED` 已不再阻塞这两台设备的当前 APK 安装和 connected instrumentation；2407 使用恢复后的 mDNS 通道，不把旧的 `192.168.1.2:40019` 拒绝状态当作当前设备结论。
- 该结果只回填“当前 APK 可安装且 Android 原生测试可在两台真机执行”；随后 `25091RP04C` 已完成 A-03 Host Key 变化拒绝/显式替换的真实 UI 验证，A-04、A-06～A-08、A-10～A-17 的完整人工验收仍按任务书保持未完成。
## 2026-09-19 Windows Host Key 与私钥认证边界回归

- `HostKeyPolicy` 的 Windows runtime 回归补上两条高风险边界：合成私钥和口令经过 Vault 解密后实际传给 SSH adapter；已信任 Host Key 变化后显式拒绝返回稳定的 `HOST_KEY_MISMATCH`，不再被通用异常降级为 `INTERNAL_ERROR`。首次 Host Key 拒绝仍不写入信任记录。
- 定向 `tests/unit/windows/local-runtime.test.ts` 与 `tests/unit/server/host-key-policy.test.ts` 共 `15/15` 通过；全量 Vitest `161` 个文件通过、`737` 个测试通过、`2` 个跳过，`typecheck`、`lint`、`build`、`build:windows` 均通过。
- 修复后重新生成 Windows 制品：NSIS `127,632,446` bytes / SHA-256 `79B7E5306CCF919C57D892ACA2345B91ACB4CB2BBAEE21873F0CA07C395D08F2`，portable `113,553,011` bytes / SHA-256 `2742E04BC86F3891755F3FCFB018349FD27DD6BEA6EE5BCD1B8039EB8720ED4E`；两者 `NotSigned`，真实签名仍是发布门禁。该证据覆盖 Windows runtime/打包产物边界，不替代真实 Windows UI 私钥登录和真实 Host Key 变化场景。
## 2026-09-19 Android A-03/A-04 真机 UI 增量

- `25091RP04C` 通过 WebView CDP 驱动真实 Android UI，连接局域网 SSH fixture `192.168.1.5:22222`；Host Key 更换后显示 `HOST KEY CHANGED`，拒绝保留旧信任，再次连接仍拒绝，显式替换后才建立 Shell。A-03 由此回填为通过。
- 同一真机使用临时 Ed25519 私钥连接用户提供的 `106.14.61.92:22`/`t2`，真实 Console 回显 `ANDROID_PRIVATE_KEY_ACCEPTED`；临时公钥、私钥和 Android 临时 Server 均已清理。A-04 仅回填私钥正向证据，错误凭据和日志保密性仍待执行。
- 脱敏操作记录：[Android Host Key/私钥 CDP 证据](../verification/evidence/2026-09-19-android-host-key-private-key-cdp.md)。

## 2026-09-19 Android 私钥失败路径回归

- `AndroidJschConnectionTest` 先复现旧实现将 JSch `invalid privatekey` 映射为 `SSH_CONNECTION_FAILED` 的失败，再将私钥解析/口令错误映射为 `SSH_AUTH_FAILED`；新 APK 的真实 native 事件和 UI 均显示可解释的认证失败，不再反复重连后退化为“需要重新连接”。
- 当前 APK `8,633,755` bytes / SHA-256 `5017F5ADBCCFA724D2601CD61AA9AED0893D229AA6B42966BB233FFC8A3FFDAE`；两台 Android 16 真机各完成 `7/7` connected instrumentation，随后重新安装当前 APK 均返回 `Success`。
- A-04 只新增错误私钥/口令增量，logcat、WebView 持久化、系统备份秘密扫描和完整失败矩阵仍未完成。证据：[Android 私钥失败路径 CDP 证据](../verification/evidence/2026-09-19-android-private-key-failure-cdp.md)。

## 2026-09-19 双真机重试与 Android 日志边界复核

- 最新 Debug APK `8,633,755` bytes，SHA-256 `B66C9A27786A9996CE9658CBEC3A6AA8A8ACEEC7C0032C0D9FACD9ECD74AD058`；新增 malformed private-key Base64 单元回归，JSch 解析错误统一映射为 `SSH_AUTH_FAILED`。
- `25091RP04C` 与 `2407FRK8EC` 的 `:app:connectedDebugAndroidTest` 均完成 `7/7`，Gradle 返回 `BUILD SUCCESSFUL`。connected runner 清理应用后首次再次安装曾返回 `INSTALL_FAILED_USER_RESTRICTED`；重新触发安装后两台设备均成功安装，package path 已复核存在。
- `apps/android/capacitor.config.ts` 新增 `android.loggingBehavior: 'none'`。在 `25091RP04C` 用一次性合成哨兵复核后，logcat、WebView `localStorage`/`sessionStorage`/IndexedDB 未发现哨兵；临时 Host 已清理，APK manifest 继续保持 `android:allowBackup=false`。
- 该复核只收紧 Android 私密字段日志边界，不改变任务门禁口径：系统备份导出/恢复、长时间日志审计、完整 A-04 失败矩阵以及 A-06～A-08、A-10～A-17 的真实人工验收仍未完成。证据：[Android 私密字段日志边界](../verification/evidence/2026-09-19-android-secret-log-boundary.md)。

## 2026-09-19 复审：Android 内置主题同步、内存边界与当前阻塞

- 修复了 Android 解锁时把 Web 偏好主题复位为 Termius 的跨端缺陷：原生端现在提供与 `src/shared/terminal-appearance.ts` 对齐的 `builtin:termius`、`builtin:termius-light`、`builtin:everforest-dark`、`builtin:tokyo-day`、`builtin:monokai`，并由 list/getDefault/setDefault 共用定义。`AndroidBuiltinTerminalProfilesTest` 先红后绿；随后 `:app:testDebugUnitTest :app:assembleDebug --offline --no-daemon --max-workers=1 --console=plain` 成功。
- 当前 Debug APK 为 `8,633,755` bytes，SHA-256 `561351D1B83050CD3F60D358675366E4379BF7AC146D290440C601300314AA9B`。两台 Android 16 真机安装均返回 `Success`；两台均选择 Everforest Dark/16px，force-stop、重启、解锁后仍保持主题和字号。该结果只补齐 A-14 的主题/字号部分，不等同于完整偏好验收。
- 内存约束保持显式：Android/Gradle 使用 JDK 21、缓存 Gradle 9.3.1、offline、单 worker，以避免本机低内存时 Gradle、Kotlin 和 dex 并行叠加；真实大目录采样曾从 `270,324 KB` PSS 降至约 `251,874 KB`，无 OOM/ANR，但缺少任务书要求的 2 分钟基线与 32 MiB 传输并行采样，A-15 不得标记通过。
- 模拟器阻塞原因未改变：AOSP 软件模拟器缺少 `/dev/kvm`，曾进入 `adb offline` 后退出；模拟器 fixture 仅用于自动化回归。当前验收以两台 Android 16 真机为准，不再把模拟器失败误写成产品失败，也不把真机有限证据扩大为平台完成。
- Android 转移验证边界：固定 bundle 已完成 Node → Android 解密/解析；真实设备还完成 32 MiB 上传、取消、暂停/继续和下载哈希校验。Android → Web/Windows 真实导出回传、Windows 导入、完整冲突策略仍未完成；URI 任务结束立即释放、拒绝权限与分享仍是 A-11 阻塞项。
- 当前发布阻塞仍包括：A-04 完整密码/私钥失败矩阵和系统备份审计，A-06 网络切换，A-08 软键盘/旋转/安全区，A-11 URI 权限，A-15 长时低内存，A-17 双向 bundle；Windows 升级迁移、签名、持久制品来源和打包后完整任务链也未完成。继续执行时必须逐项回填证据，不能以单元测试或状态点变绿替代真实任务结果。

## 2026-09-19 Android Console 自动恢复修复与双设备复测

- 根因已确认：`TerminalPanel` 对恢复标签传入 `recoveryStatus="needs-reopen"` 时显式设置了 `autoConnect: false`，同时把旧 native Shell 失效状态直接渲染为“此 Console 需要重新连接”，把本应由客户端完成的新 Shell 创建交给用户。
- 修复已落地：恢复标签统一自动连接；收到 native `needs-reopen` 状态时清理旧 socket/service instance，关闭旧句柄并立即创建新 Shell；移除面向用户的“此 Console 需要重新连接”恢复条。只有自动重试耗尽后仍失败，才显示普通错误和重试入口。新增 TerminalPanel/TerminalSession 回归测试，相关定向测试 `33/33` 通过；`npm run typecheck`、`npm run lint`、`npm run build:web` 和 Android `:app:testDebugUnitTest :app:assembleDebug --offline --no-daemon --max-workers=1` 均通过。
- 当前 Debug APK `apps/android/android/app/build/outputs/apk/debug/app-debug.apk` 大小 `8,633,649` bytes，SHA-256 `D4A1C69F5549109A91BE9428FFCBBDC2580EB2C18D321864A6869034416DAB90`；`adb install -r -g --no-streaming` 在 `25091RP04C`（`192.168.1.3:46545`）和 `2407FRK8EC`（mDNS serial `adb-8DWSM7Y9IBCMPJSC-oak1zL._adb-tls-connect._tcp`）均返回 `Success`。
- `25091RP04C` 强制停止 `cn.ayan.relay` 后重新启动，使用预置测试 Vault 主密码（未记录）解锁；`Provided Acceptance Host` 和 Console 标签均保留，DOM 中无 `.terminal-recovery`，状态点为绿色，并在用户提供的 `106.14.61.92:22`/`t2` 主机真实执行 `echo FINAL_RESTART_INPUT_OK_25091`，收到同名远端回显和 `t2` 提示符。该证据覆盖“重启后自动恢复且命令可输入”，不把绿色状态单独当作通过。
- `2407FRK8EC` 安装同一 APK 成功，但本轮重启后处于 Android 系统锁屏，`isKeyguardShowing=true`、当前焦点为 `NotificationShade`，无法读取 Relay UI 或恢复 Console；因此本轮不把 25091 的自动恢复结果扩展到 2407，待设备解锁后补测。
- 本轮不改变平台整体门禁：A-05 的复制/粘贴完整真机路径、A-06 网络切换、A-08 软键盘/旋转/安全区、A-15 长时低内存、A-17 双向 bundle，以及 Windows 升级/签名/持久制品来源和打包后完整任务链仍未完成。

## 2026-09-19 Windows 当前打包制品与 Android 第二台设备续验

- 当前源码 `9150f85` 的 `npm run build`、`npm run build:windows`、`npm run package:windows` 均成功；全量 Vitest 为 `161` 个文件通过、`1` 个跳过，`738` 个测试通过、`2` 个跳过。构建输出中的 Vite 大 chunk、Electron-builder 缺少 author/description 和 duplicate dependency 均为既有警告，不是失败。
- 当前 NSIS 制品 `dist/releases/nsis/Relay-0.1.0-x64.exe`：`127,632,215` bytes，SHA-256 `92F08B8F99B573EE84306243C97A84A544B88DB0C2223601A49AFE1CECEBA3B3`；portable 制品 `dist/releases/portable/Relay-0.1.0-x64.exe`：`113,554,151` bytes，SHA-256 `6AD0CF9035C8D04C09C67B233B522B6BEACE8EFA1E2BE81ECA986FCC7CE32158`。两者 PE 头为 `MZ`，`Get-AuthenticodeSignature` 为 `NotSigned`，签名仍是发布阻塞项。
- 使用独立临时 `userData` 的 Playwright Electron runner 启动当前 NSIS 解压版，真实完成 Vault 创建、测试 Host 保存、Host Key 信任、用户测试主机 Shell 建立和 `echo PACKAGED_CURRENT_BUILD_OK` 回显；关闭并重新启动后，解锁 Vault，`recoveryCount=0`、状态点为绿色，`echo PACKAGED_RESTART_AUTO_RECONNECT_OK` 真实回显。临时 userData 已清理，未接触本机现有 Relay 数据。
- `2407FRK8EC` 已解锁并安装当前 APK 后重新建立 `Provided Acceptance Host`，真实确认用户测试主机指纹，执行 `echo INITIAL_INPUT_OK_2407` 得到远端回显和 `t2` 提示符。随后执行 force-stop/重启时该设备的 mDNS ADB 通道掉线；发现服务转为 `192.168.1.2:35857`，连接尝试超时，因而本轮不能记录 2407 的重启后自动恢复结果。该项是设备无线调试连接阻塞，不把它归因于应用。
- 当前仍未完成的门禁不变：Android 2407 重启恢复需在 ADB 稳定后补测，A-05 复制/粘贴完整人工路径、A-06 网络切换、A-08 软键盘/旋转/安全区、A-11 URI 即时释放、A-15 长时低内存、A-17 双向 bundle，以及 Windows 升级迁移、签名、持久制品来源仍未通过。

## 2026-09-19 Console 自动恢复可见性复审

- 复查“重启后仍提示需要重新连接”的原因，确认问题不仅是 `autoConnect`，还包括恢复初始态和 native `needs-reopen` 事件向 app/UI 暴露了内部状态。
- 已把 native 句柄失效恢复改为完全无感：内部标记保留用于诊断，外部状态只显示连接中/重连中；旧 socket/service instance 清理后立即创建新 Shell。只有自动重试耗尽或真实认证/Host Key 错误才显示用户可操作的错误。
- 通过 Web 定向测试 `67/67`、Playwright 终端恢复 `3/3`、typecheck 和 lint；平台整体未完成门禁仍按验收矩阵维护，不因该修复提前标记 Android/Windows 全部验收通过。
