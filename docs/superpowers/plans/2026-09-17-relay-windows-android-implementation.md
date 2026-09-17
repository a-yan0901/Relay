# Relay 独立 Windows 与 Android 客户端实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**目标：** Windows 与 Android 安装后都能在本机保存数据并直接连接 SSH/SFTP，复用 Web 的 UI、主题和 shared core；云同步留待后续。

**架构：** Windows Electron 内置现有 Node/SQLite/Vault/ssh2 执行端；Android Capacitor 使用共享 React UI 与 TypeScript core，通过受限插件接入设备本地 Vault、数据存储、SSH/SFTP。两个客户端的 Local 模式均不需要 Relay 服务地址或账号。

**技术栈：** React/TypeScript/Vite、`src/shared/core`、Electron、现有 Node/Fastify/SQLite/ssh2、Capacitor Android、Kotlin、Android Keystore。Android SSH 库在任务 4 的实机可行性门槛后锁定版本，不预先宣称已验证。

**设计：** [独立 Windows 与 Android 客户端设计](../specs/2026-09-17-relay-windows-android-unified-experience-design.md)。

## 全局约束

- SSH、SFTP、本地 Vault 和工作区必须在各自设备上运行；云服务不存在时功能照常可用。
- 复用 `CoreRuntime`、shared 模型、状态机、错误码、Host Key/SFTP 路径和任务契约；Android 原生层独立执行安全校验。
- 账号/设备/同步 ports 保持可选；本期不实现或模拟已存在的独立云服务，不发云请求。
- 三端共享 React 组件与设计 token；Windows 和 Android 只适配布局、输入、系统能力和生命周期。
- Windows renderer 不启用 Node 集成；loopback 执行端限定来源。Android 秘密不进入 WebView 持久化或日志。
- 每个任务完成时附 commit、验证命令和证据；按风险执行受影响范围检查，跨接口、凭据、原生构建和数据迁移执行全量门禁。

## M0：共享边界和 Android 可行性门槛

- [ ] **任务 1：固定三端功能与 UI contract。** 检查 `src/shared/core/ports.ts`、`runtime.ts`、`tests/fixtures/core-runtime-contract.ts` 与 `src/web/App.tsx`。新增独立本地 runtime 的 contract：账号 ports 缺席仍可创建 Host、解锁 Vault、打开 Shell、浏览 SFTP；capability 如实降级。为 Host grid/list、终端、SFTP 全屏、主题、重连建立桌面与 360/390px UI 基准。交付：单一任务链和测试矩阵。
- [ ] **任务 2：抽离 WebView/桌面系统边界。** 修改 `src/web/App.tsx`、`src/web/platform/browser-system-services.ts`、`src/shared/core/ports.ts`，新增平台 UI service 及受影响组件测试。将文件选择/保存、剪贴板、确认、外部链接、网络/生命周期和系统返回改为可注入能力；不让 Electron/Android 类型进入 shared。交付：同一 React 页面可接入 Web、Windows、Android runtime。
- [ ] **任务 3：手机布局与输入。** 修改 `src/web/styles.css`、`src/web/components/TerminalWorkspace.tsx`、`SftpWorkspace.tsx`、`HostList.tsx`，增加窄屏交互测试。实现搜索优先、单 pane、软键盘工具条、触控菜单、SFTP 单层滚动及终端最后一行可见；保持共享主题和状态文案。交付：手机视口 Web 先跑通任务链。
- [ ] **任务 4：Android 原生 SSH 技术验证。** 在 `apps/android/` 建立最小 Kotlin/Capacitor 实验工程；对候选库在 Android 真机/模拟器验证密码与私钥认证、PTY resize、Shell 流、首次与变更 Host Key、ProxyJump、SFTP list/upload/download、取消和断线资源释放。记录 API/ABI、支持算法、依赖许可和失败项；候选 Apache MINA SSHD 的 Android 支持不受上游正式保证，需有实测证据。只有所选库通过本期要求才进入任务 8，不能用远端 Relay 服务绕过门槛。交付：选型记录及可运行原生 PoC。

## M1：Windows 独立桌面版

- [ ] **任务 5：受限 Electron shell。** 新增 `apps/windows/main.ts`、`preload.ts`、打包配置及根构建脚本。只加载本地 UI，启用 sandbox/context isolation，IPC 采用明确 allowlist；测试外部 URL、未知 IPC 和多实例行为。交付：Windows 可启动安装包/解压包。
- [ ] **任务 6：内置本地执行端与数据库。** 修改 `src/server/index.ts` 的启动配置边界，新增 `apps/windows/server-process.ts`、`data-dir.ts`。将现有 Node server build 作为 app 子进程，监听随机 loopback 端口，SQLite/Vault 放用户 app data；健康检查后才打开窗口，崩溃显示恢复动作。验证新装、重启、端口占用、数据不丢和异常停止。交付：免账号、免远端 Relay 服务可直连目标 SSH。
- [ ] **任务 7：Windows 系统能力与任务链。** 新增 `src/web/platform/desktop-adapters.ts`，接入文件选择/保存、剪贴板、通知、窗口休眠/恢复。沿用 shared Host Key、SFTP、终端和主题状态；恢复时查询本地执行端真实 session/task。Windows 实机验证密码/私钥、Host Key 拒绝、SFTP 上传下载、Vault 锁定、主题持久化和关闭重开。交付：独立 Windows 技术预览。

## M2：Android 独立 app

- [ ] **任务 8：本地数据与 Vault。** 在 `apps/android/` 实现 app 私有数据库和 Vault/Keystore 插件，`src/web/platform/android-adapters.ts` 实现 `HostStore`、`IdentityStore`、`GroupStore`、`WorkspaceStore`、`SnippetStore`、`TerminalProfileStore`、`SecretStore`、`VaultSessionPort`。先以 shared contract 和本机重启/锁屏用例验证模型、版本、加密、清除、导入导出；不得把私钥或主密码送到 WebView 持久化。交付：飞行模式下仍能管理本地 Host/Vault。
- [ ] **任务 9：本机 SSH Shell 与 Host Key。** 将任务 4 选定的库封装为 Android 插件，`android-adapters.ts` 实现 `ConnectionProbe`、`SessionTransport`。映射 shared 连接 profile、每一跳 Host Key 确认、密码/私钥认证、PTY resize、输出事件、主动关闭与重连；原生层再次校验安全不变量。测试首连、指纹变化、ProxyJump、ECONNRESET 等价断线、后台/前台与网络切换。交付：手机不依赖 Relay 服务可直连 SSH。
- [ ] **任务 10：本机 SFTP、文件 URI 与批量任务。** `android-adapters.ts` 实现 `FileTransport`、`CommandTransport`、`ActivityStore`、`ImportExportPort`，Android 插件接入系统文件选择/分享和流式传输。路径规范化、任务目标快照、并发/超时/输出上限、终态和脱敏审计与 shared/server 契约一致；取消时释放 URI 和 SSH 资源。真实设备验证浏览、上传下载、重试、批量执行取消及部分失败。交付：Android 独立客户端核心任务闭环。
- [ ] **任务 11：移动生命周期与 UI 完成。** 处理系统返回、旋转、动态字体、软键盘、锁屏与进程回收；重新打开先读取本地工作区和任务实际状态。验证完整“找 Host → Host Key → Shell → SFTP → 锁定/恢复”任务链、主题恢复、终端最后一行和无双滚动；修复本机状态误报。交付：Android APK 技术预览及真机验证记录。

## M3：统一回归与云同步预留

- [ ] **任务 12：三端 contract 与发布检查。** 使用 `tests/fixtures/core-runtime-contract.ts` 和 `tests/unit/shared/native-adapter-contract.test.ts` 覆盖 Web、Windows、Android runtime；分别补真实 Windows 和 Android 任务走查。验证无云服务、无账号、无 Relay 服务地址仍可访问目标 SSH 主机；断开互联网但局域网 SSH 可达时继续可用。检查秘密/日志/备份和 Host Key 错误路径，执行 `npm run lint`、`npm run typecheck`、`npm test`、`npm run build` 及原生构建/设备测试。记录当前无法在 CI 实机验证的范围，不用模拟器结论替代真机结论。交付：两端发布判定和已知限制。
- [ ] **任务 13：同步接口只做未来兼容性检查。** 确认两端的稳定 Host/Identity/Workspace/主题 schema、设备标识和可选 `account`/`devices`/`sync` ports 可接入未来加密 envelope；云服务缺席时 UI 不显示可用同步状态，任何本地 SSH 操作不调用云接口。独立云端服务和跨设备恢复另立项目与计划。交付：不依赖云的客户端及可追踪的后续接口清单。

## 追踪与退出条件

M0 是 Windows 和 Android 的共同依赖；任务 4 是 Android SSH 的硬门槛。M1 与 M2 可在 M0 后并行推进；两端均通过任务 12 才称为本期完成。每个勾选项必须附对应 commit、针对性测试、真实平台结果和未解决缺陷；本计划未勾选的任务不视为已实现。云端同步服务不在本期完成范围内。
