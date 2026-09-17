# Relay 独立 Windows 与 Android 客户端实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**目标：** Windows 与 Android 安装后都能在本机保存数据并直接连接 SSH/SFTP，复用 Web 的 UI、主题和 shared core；云同步留待后续。

**架构：** Windows Electron 通过受限 IPC 复用本机 Node/SQLite/Vault/ssh2 服务类，不启动 Fastify 或 HTTP；Android Capacitor 使用共享 React UI 与 TypeScript core，通过受限插件接入设备本地 Vault、数据存储、SSH/SFTP。两个客户端的 Local 模式均不需要 Relay 服务地址或账号。

**技术栈：** React/TypeScript/Vite、`src/shared/core`、Electron、现有 Node/SQLite/ssh2 服务类、Capacitor Android、Kotlin、Android Keystore。Fastify 仅用于独立 Web 版。Android SSH 库在任务 4 的实机可行性门槛后锁定版本，不预先宣称已验证。

**设计：** [独立 Windows 与 Android 客户端设计](../specs/2026-09-17-relay-windows-android-unified-experience-design.md)。

## 全局约束

- SSH、SFTP、本地 Vault 和工作区必须在各自设备上运行；云服务不存在时功能照常可用。
- 复用 `CoreRuntime`、shared 模型、状态机、错误码、Host Key/SFTP 路径和任务契约；Android 原生层独立执行安全校验。
- 账号/设备/同步 ports 保持可选；本期不实现或模拟已存在的独立云服务，不发云请求。
- 三端共享 React 组件与设计 token；Windows 和 Android 只适配布局、输入、系统能力和生命周期。
- Windows renderer 不启用 Node 集成；桌面版不启动 TCP/HTTP 监听、不使用 Web cookie。Android 秘密不进入 WebView 持久化或日志。
- 所有平台的同一命令、确认、错误码、状态和主题 token 一致；Android 允许针对触控、系统返回和软键盘调整布局。
- 每个任务完成时附 commit、验证命令和证据；按风险执行受影响范围检查，跨接口、凭据、原生构建和数据迁移执行全量门禁。

## M0：共享边界和 Android 可行性门槛

- [ ] **任务 1：固定三端功能与 UI contract。** 检查 `src/shared/core/ports.ts`、`runtime.ts`、`tests/fixtures/core-runtime-contract.ts` 与 `src/web/App.tsx`。新增独立本地 runtime contract：账号 ports 缺席时创建 Host、解锁 Vault、打开 Shell、浏览 SFTP；本地 capability 用 `createCapabilitySet()` 表达实际能力，不把 Web 服务端能力复制过来。为 Host grid/list、终端、SFTP 全屏、主题、重连建立 Web/Windows/360px/390px 基准，记录同名动作、确认、状态和结果。交付：可逐项打勾的三端任务矩阵。
- [ ] **任务 2：抽离浏览器专用调用。** 审计 `src/web/App.tsx`、`TerminalPanel.tsx`、`src/web/theme.ts`、`src/web/state/app-state.ts`、`src/web/hooks/use-terminal-session.ts` 中的 `window.confirm`、`/api/transfers`、文件选择/保存、`window.open`、local/sessionStorage、WebSocket 和网络事件。修改 `src/shared/core/ports.ts` 与 `src/web/platform/browser-system-services.ts`，增加可注入的确认、文件、偏好存储、网络/生命周期和外链能力；Web 端保持原行为，并用组件测试覆盖取消、权限拒绝、重载和主题恢复。纯 DOM 焦点/渲染仍留 UI。交付：Windows/Android UI 路径不直接请求 Web API。
- [ ] **任务 3：手机布局与输入。** 修改 `src/web/styles.css`、`src/web/components/TerminalWorkspace.tsx`、`SftpWorkspace.tsx`、`HostList.tsx`，增加窄屏交互测试。实现搜索优先、单 pane、软键盘工具条、触控长按菜单、系统返回、SFTP 单层滚动及终端最后一行可见；菜单命令与桌面右键共用一份动作定义。交付：手机视口 Web 先跑通相同任务链。
- [ ] **任务 4：Android 原生 SSH 技术验证。** 在 `apps/android/` 建最小 Kotlin/Capacitor 实验工程；在真机验证密码与私钥认证、PTY resize、Shell 流、首次与变更 Host Key、ProxyJump、SFTP list/upload/download、取消和断线资源释放。记录 Android API/ABI、算法、依赖许可和失败项；Apache MINA SSHD 不受上游正式 Android 兼容性保证，须用实测决定。没有覆盖所需功能的库就比较替代方案，不以远端 Relay 服务绕过独立客户端目标。交付：锁定库版本、最小可运行 PoC 与验收记录；本任务只阻塞 Android SSH 任务，不阻塞 Windows。
- [ ] **任务 5：跨端 Vault bundle v1 兼容契约。** 检查 `src/server/vault/types.ts`、`src/server/vault/crypto.ts`、`src/server/workspace/vault-bundle-service.ts` 和 `src/shared/import/types.ts`。生成不含真实秘密的固定测试向量，明确 bundle 格式、Argon2id 参数、AES-GCM nonce/tag/AAD、字段编码、重复 Host/Identity 的冲突策略、错误码；Web/Windows 导出后 Android 导入及反向导出均须通过，错误密码/损坏载荷保持原数据不变。v1 只含 Host、Identity、Group、终端 profile/default profile；Snippet/Workspace 的跨设备迁移不在本期 v1 中。Android 内部库可以不同，便携格式必须相同。交付：版本化格式说明与正反向契约测试。

## M1：Windows 独立桌面版

- [ ] **任务 6：受限 Electron shell。** 新增 `apps/windows/main.ts`、`preload.ts`、打包配置及根构建脚本。只加载包内静态 UI，启用 sandbox/context isolation，禁用 Node integration 与任意导航；preload 只暴露枚举的业务调用和系统能力。测试未知 IPC、外部 URL、第二实例和窗口销毁后订阅清理。交付：可启动的 Windows 安装包/解压包。
- [ ] **任务 7：本地服务类组合与 IPC runtime。** 从 `src/server/app.ts` 提取可复用的 Vault/SQLite/Host/SFTP/SSH/Command 服务构造，Web 路由继续使用原实例；新增 `apps/windows/local-runtime.ts`、`apps/windows/ipc-contract.ts`、`src/web/platform/desktop-adapters.ts`。main 或 utility process 初始化用户 app data 数据库，adapter 以版本化 `requestId + operation + payload` 调用服务类，映射全部 `CoreRuntime` 必选 ports；Shell/任务使用按 id 订阅事件，文件大流经原生文件句柄，关闭幂等。不调用 `startServer()`，不打开 TCP 端口，不使用 cookie。打包时验证 `better-sqlite3`、`argon2`、`ssh2` 的 Electron/Windows 运行时兼容和目标架构，并检查升级后数据库仍可打开。测试操作 allowlist、参数/大小校验、失败码、进程崩溃、数据恢复及 Web API 回归。交付：Windows 免账号本地 SSH/SFTP 闭环。
- [ ] **任务 8：Windows 系统能力与任务链。** 接入本地文件选择/保存、剪贴板、通知、窗口休眠/恢复与偏好持久化；按任务矩阵验证菜单、主题、Host Key、传输、终端复制粘贴和 Vault 锁定。Windows 实机检查安装/升级/退出/重开，以及无本地监听端口、无远端 Relay 地址。交付：独立 Windows 技术预览。

## M2：Android 独立 app

- [ ] **任务 9：Android bridge 与事件/流契约。** 新增 `apps/android/` 插件接口与 `src/web/platform/android-bridge.ts`：操作帧包含 `version/requestId/operation/payload`，事件包含 `sessionId` 或 `transferId`、代际、单调 `sequence`；类型/大小/权限由两侧校验，失败映射 shared 错误码。Shell 先订阅再连接，迟到事件丢弃；同步 `write/resize/close` 在 adapter 入有界队列，原生失败回传诊断。文件流以最多 32 KiB/块、4 个未确认块的 `ack` 窗口为默认上限，取消/失败释放 URI 与 SSH 句柄；原生直传也须证明有界内存。以乱序、重复、进程回收、取消和大文件用例验证。交付：可用于 Vault/SSH/SFTP 的稳定 bridge。
- [ ] **任务 10：本地数据、Vault 与便携格式。** 在 `apps/android/` 实现私有数据库、Keystore 包装和 Vault 插件；`src/web/platform/android-adapters.ts` 实现 `HostStore`、`IdentityStore`、`GroupStore`、`WorkspaceStore`、`SnippetStore`、`TerminalProfileStore`、`SecretStore`、`VaultSessionPort` 与 `ImportExportPort`。依任务 5 的 bundle v1 向量验证导入导出；原生层校验字段与版本，事务性应用，损坏/错误密码不改写旧数据。测试重启、锁屏、系统备份排除、飞行模式与秘密不进 WebView 持久化。交付：本机 Host/Vault 独立可用。
- [ ] **任务 11：本机 SSH Shell 与 Host Key。** 将任务 4 选定的库接入任务 9 的 bridge，`android-adapters.ts` 实现 `ConnectionProbe`、`SessionTransport`。映射 shared profile、逐跳 Host Key 挑战/确认、密码/私钥认证、PTY resize、输出、主动关闭与重连；旧挑战不得放行新连接。测试首连、指纹变化、ProxyJump、断线、后台/前台与网络切换。交付：手机不依赖 Relay 服务可直连 SSH。
- [ ] **任务 12：本机 SFTP 与批量任务。** `android-adapters.ts` 实现 `FileTransport`、`CommandTransport`、`ActivityStore`；Android 插件接入系统 URI 文件选择/分享和任务 9 的流协议。原生层执行远端路径规范化、目标快照、并发/超时/输出上限、取消和脱敏审计；capability 只广告真实已支持的行为。真实设备验证浏览、上传下载、重试、批量取消和部分失败。交付：Android 独立客户端核心任务闭环。
- [ ] **任务 13：移动生命周期与 UI 完成。** 处理系统返回、旋转、动态字体、软键盘、锁屏与进程回收；重新打开先读取本地工作区和任务实际状态。按任务矩阵比对 Web/Windows/Android 的菜单语义、错误与主题；验证终端最后一行和 SFTP 无双滚动。交付：Android APK 技术预览及真机验证记录。

## M3：统一回归与云同步预留

- [ ] **任务 14：三端 contract 与发布检查。** 使用 `tests/fixtures/core-runtime-contract.ts` 和 `tests/unit/shared/native-adapter-contract.test.ts` 覆盖 Web、Windows、Android runtime；分别补真实 Windows 和 Android 任务走查。验证无云服务、无账号、无 Relay 服务地址仍可访问目标 SSH 主机；断开互联网但局域网 SSH 可达时继续可用。检查 Windows 无 TCP 监听、Android 秘密/日志/备份与 Host Key 错误路径，执行 `npm run lint`、`npm run typecheck`、`npm test`、`npm run build` 及原生构建/设备测试。三端逐项比对 Host、终端、SFTP、主题和确认交互；记录 CI 缺失的真实平台证据。交付：两端发布判定和已知限制。
- [ ] **任务 15：同步接口只做未来兼容性检查。** 确认两端的稳定 Host/Identity/Workspace/主题 schema、设备标识和可选 `account`/`devices`/`sync` ports 可接入未来加密 envelope；云服务缺席时 UI 不显示可用同步状态，任何本地 SSH 操作不调用云接口。独立云端服务和跨设备恢复另立项目与计划。交付：不依赖云的客户端及可追踪的后续接口清单。

## 追踪与退出条件

任务 1–3 是共同依赖，任务 4 只阻塞 Android SSH，任务 5 阻塞 Android bundle 导入；Windows 与 Android 可并行推进。两端均通过任务 14 才称为本期完成。每个勾选项必须附对应 commit、针对性测试、真实平台结果和未解决缺陷；本计划未勾选的任务不视为已实现。云端同步服务不在本期完成范围内。

## 当前实施记录（2026-09-18）

以下是已落地但尚未达到“任务完成”标准的增量；未勾选任务仍需按上面的真实平台门禁验收：

- M0/共享边界：已加入 `NativeOperationPort`、事件代际/序列、Android bridge、共享 native `CoreRuntime` 和原生终端 socket 适配；平台 ports 还覆盖确认对话框、外链和有界文件写入。Web 仍默认使用 Web adapter，浏览器 File System Access API 不可用时回退到小文件下载。
- M1/Windows：已加入实际 Electron main/preload shell、版本化 IPC allowlist、sender 校验、窗口导航防护、本地 SQLite/Vault/SSH/SFTP/命令/导入导出组合、剪贴板桥接，以及 Host Key/凭据交互和 ECONNRESET 回归测试。文件导出使用临时文件句柄、32 KiB 分块写入和关闭后替换；`npm run build:windows` 已通过，但真实 Windows 安装、原生 ABI、升级迁移和实机任务走查仍未完成。
- M2/Android：已生成 Capacitor Android 工程，注册 Kotlin `RelayNative` 插件并接入共享操作/文件流边界；JDK 21、Gradle 8.14.3、Android API 36、Build Tools 35.0.0 已在当前环境可用，Kotlin 编译和 debug APK 打包已通过。插件当前仍是安全边界，尚未接入 Android Vault/Keystore、SSH/SFTP executor、URI 文件流和真实设备验证，因此不能宣称 Android 独立 SSH/SFTP 客户端完成。
- 内存预算：原生文件与终端传输使用 32 KiB 单块；终端输入使用每会话最多 8 条、总量 64 KiB 的有界队列，超限显式报错；Windows 默认最多 4 个 SSH 会话、每会话 64 KiB 脱离缓冲、最多 4 个下载流、最多 32 个可重连请求；IPC/事件订阅和 payload 也有上限。验证默认关闭文件并行并限制 worker，避免在无 Swap 主机上同时启动多份 Node/Vite。

验证记录（2026-09-18）：

- `npm exec vitest -- run` 针对 8 个受影响测试文件，以 `--no-file-parallelism --maxWorkers=1` 执行：8 files、45 tests 通过。
- `npm exec tsc -- -p tsconfig.native.json --noEmit` 通过；改动的 Windows/native/Web TS/TSX 文件 ESLint 在 `--max-warnings 0` 下通过。
- `npm run typecheck` 通过。
- `npm run build:windows` 通过，包含 web、Electron main 和 preload 三段构建；`npx cap sync android` 通过。
- `./gradlew :app:compileDebugKotlin --no-daemon --max-workers=1 --console=plain` 和 `./gradlew :app:assembleDebug --no-daemon --max-workers=1 --console=plain` 通过；debug APK 已生成。当前没有 Android 真机/模拟器，因此安装、连接、生命周期和 SSH/SFTP 任务仍无设备证据。
- `npm test -- --no-file-parallelism --maxWorkers=1 --reporter=dot` 完成 159 个测试文件、695 个测试，695 个全部通过。期间修正了 bundle 导出仍回退到旧内置主题 ID 的实现缺陷，并将 shared core 边界测试收敛到真正的 `src/shared/core` 目录，避免把 cloud WebSocket 适配器误判为 core 依赖。

当前最重要的发布阻塞项是实际 Electron Windows 安装/ABI/升级验证，以及 Android 原生 SSH/SFTP executor、Keystore、URI 流和真机可行性门槛；在这些完成前，代码只能称为可测试的跨端基础设施和原生壳增量，不能称为两个平台客户端已交付。云同步仍按本计划作为后续独立能力，不在本增量中模拟或宣称完成。
