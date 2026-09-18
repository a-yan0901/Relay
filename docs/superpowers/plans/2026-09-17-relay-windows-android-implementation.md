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

## 状态快照（2026-09-18）

复选框只表示该任务已经通过计划中的最终验收门禁；下表单独记录当前实现进度，避免把“代码已落地”误读成“真实平台已交付”。

| 任务 | 当前状态 | 已有证据 | 剩余门禁 |
| --- | --- | --- | --- |
| 1 共享 contract | 🟡 主要 contract、capability 和 UI 增量已落地 | shared/native contract、Web/DOM 定向测试、[三端验收矩阵](../verification/2026-09-18-relay-cross-platform-acceptance-matrix.md) | 三端最终视口走查 |
| 2 浏览器调用抽离 | 🟡 平台 ports、系统能力和下载边界已抽离 | Web/native TypeScript、定向 ESLint/DOM 测试 | 完整跨端路径审计 |
| 3 手机布局与输入 | 🟡 返回键、移动工具条、SFTP 布局和过滤已实现 | DOM 测试、Web 构建 | 真机软键盘、安全区、最后一行和滚动走查 |
| 4 Android SSH 可行性 | 🟡 JSch 候选和执行器已接入 | Kotlin 编译、Android JVM 测试 | 真机认证、PTY、Host Key、ProxyJump、SFTP 资源释放 |
| 5 Vault bundle v1 | 🟡 Android 端格式/加解密/冲突应用已实现 | bundle 定向测试、分块边界测试 | Web↔Windows↔Android 固定向量正反向实测 |
| 6 Electron shell | 🟡 shell、preload、导航和打包配置已实现 | Windows TS/构建、IPC 测试 | Windows 安装包启动和窗口行为 |
| 7 Windows 本地 runtime | 🟡 SQLite/Vault/SSH/SFTP/IPC 闭环代码已实现 | `build:windows`、IPC/服务端定向测试 | Windows 原生 ABI、升级迁移、崩溃恢复和任务链 |
| 8 Windows 系统能力 | 🟡 文件句柄、剪贴板、确认、偏好已接入 | 受影响 TypeScript/DOM 测试 | Windows 实机安装/退出/重开/无监听检查 |
| 9 Android bridge | 🟡 有界帧、事件代际/序列、队列和文件流已实现 | Android JVM、native bridge/core 定向测试 | 真机乱序、取消、进程回收和大文件 |
| 10 Android 本地数据/Vault | 🟡 本地 store、Keystore、Vault、模板和导入导出已实现 | Android JVM/编译 | 锁屏、重启、备份排除和秘密不入 WebView 实测 |
| 11 Android SSH Shell | 🟡 Shell、Host Key、ProxyJump、重连代码已实现 | Kotlin 编译/JVM 测试 | 真机网络切换、后台/前台和认证走查 |
| 12 Android SFTP/批量任务 | 🟡 SFTP、任务持久化、分页和有界传输已实现 | Android JVM、跨端分页/服务测试 | 真机浏览、上传下载、重试、取消和部分失败 |
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

验证记录（2026-09-18）：

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
- 最新跨端回归（2026-09-18）：`npm test -- --no-file-parallelism --maxWorkers=1 --reporter=dot` 完成 161 个测试文件、720 个测试，全部通过；`npm run typecheck`、`npm run lint`、`npm run build`（Web/Server/Cloud）和 `npm run build:windows` 全部通过。Android Debug APK 已通过单 worker Gradle 构建、APK ZIP 完整性检查；Windows x64 portable 预览包已通过 PE 格式检查和 Linux Electron 启动烟测。为避免原生构建产物被误当源码，ESLint 明确忽略 Capacitor 的 `app/build` 与 `app/src/main/assets` 生成目录。当前仍缺 Windows 实机 ABI/升级验证、NSIS（本机构建缺 Wine）和 Android 真机 SSH/SFTP/Keystore/生命周期验证，不能据此将任务 14 标记完成。
- 本轮增量回归（2026-09-18）：`npm run test:e2e -- --workers=1` 通过 4/4；HostCard、ContextMenu、ServerContextMenu、TerminalSession 定向测试通过 4 个文件、27 个测试；`npm run typecheck`、`npm run lint`、`npm run build`、Server/Cloud 产物 Node ESM 加载和 `npm run build:windows` 全部通过。`npm run package:windows:portable` 已验证可复现 Windows x64 portable 预览包，PE 检查通过，最新 SHA256 为 `91af49081e8a477a99fe5993ace1777797115f0b32355249cd31ebf4bb435478`。修正 Android `build:debug` 脚本后，使用 `ANDROID_HOME=/usr/lib/android-sdk ANDROID_SDK_ROOT=/usr/lib/android-sdk npm run build:android:debug` 通过真实 `:app:assembleDebug` 构建（73 actionable tasks，单 worker、无 daemon），最新 Debug APK 已通过 ZIP 完整性检查，SHA256 为 `8978bb8d9d4a8a4d0298456cb9dbc169c72ea760ee3fdb0fd8e5d65b61302a6a`；`testDebugUnitTest` 通过 7 个 suite、25 个测试。真实 Windows/Android 设备证据仍缺失。
## 当前设备交接状态（2026-09-18）

- Android 代码、Kotlin 编译、JVM 单元测试、Debug APK 构建已完成；当前开发机内存不足，停止继续启动 Android 模拟器。
- 本机尝试过 AOSP x86_64 软件模拟器，但没有 `/dev/kvm`，设备长期处于 `adb offline` 后退出；该过程没有形成安装、SSH/SFTP 或生命周期验收证据，也不再作为后续验证路径。
- Android APK 已交接到 [跨端验收交接任务书](../verification/2026-09-18-relay-cross-platform-handoff.md)，由内存充足且有 Android 真机/可用模拟器的机器执行。任务 4–14 仍保持未完成；任务 15 只是未来同步兼容性预留，不属于本期客户端发布门禁。必须把设备结果和日志/截图回填后才能勾选。
- Windows 仍等待 Windows 主机上的安装、原生 ABI、升级迁移和本地任务链验证；Linux portable 包仅是交接预览，不替代 Windows 验收。
- 当前工作区确实保留了 APK 和 portable 包，但两个路径都被 `.gitignore` 忽略，产物不会随 `git clone` 或 `git checkout` 出现；没有 Release 附件、制品服务器或共享目录作为持久来源。最终签收前必须重新生成或登记可访问的制品来源，并记录源码 commit、工具链版本和 SHA-256；交接任务书中的当前路径只表示本机缓存位置。

当前最重要的发布阻塞项是实际 Electron Windows 安装/ABI/升级验证，以及交接机器上的 Android SSH 库/Keystore/URI/生命周期验证和剩余本地能力；在这些完成前，代码只能称为可测试的跨端基础设施与原生执行器增量，不能称为两个平台客户端已交付。云同步仍按本计划作为后续独立能力，不在本增量中模拟或宣称完成。
