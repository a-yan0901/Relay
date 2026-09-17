# Relay Windows 与 Android 统一体验实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**目标：** 交付与 Web 共用产品界面和 shared core 的 Windows 桌面版及 Android app，并保留免账号使用与登录后加密同步。

**架构：** React 页面和设计 token 为三端共同 UI；Windows Electron 运行本地 Relay 执行端，Android Capacitor 使用用户指定的 Relay 服务。平台 API 通过 adapter 接入 `CoreRuntime`，连接、安全和同步语义沿用现有实现。

**技术栈：** React/TypeScript/Vite、`src/shared/core`、Node/Fastify/SQLite/ssh2、Electron、Capacitor Android。实施时先锁定兼容版本并记录 Windows/Android 构建环境；本计划不预设未经验证的版本号。

**设计：** [Windows 与 Android 统一体验设计](../specs/2026-09-17-relay-windows-android-unified-experience-design.md)。

## 全局约束

- 复用 shared core 的 Host Key、路径、会话、任务终态与同步语义；平台 UI 不自行放行操作。
- 未登录可使用当前执行端，登录且 Vault 解锁后才同步；Android 的免登录模式仍依赖用户指定的 Relay 服务。
- Windows renderer 不启用 Node 集成；本地执行端只监听 loopback，客户端来源与 IPC 权限须验证。
- Android 不关闭 TLS 校验，不通过 wildcard Origin 放行；系统文件 URI、凭据及 token 不进入普通 Web storage。
- 同一页面/组件和主题 token 服务三端；响应式布局、触控和系统返回允许平台适配。
- 每个任务先写能证明行为的失败用例，再实施、运行受影响范围验证并独立提交。跨模块接口、凭据/加密、数据迁移、构建依赖变更在对应里程碑执行全量验证；纯文档和局部 UI 不重复全量测试。

## 交付顺序与任务

### M0：共享 UI 与平台边界

- [ ] **任务 1：建立跨端 UI 基线。** 文件：`src/web/App.tsx`、`src/web/styles.css`、`src/web/theme.ts`、`src/web/components/**`、新增 `tests/ui/platform-layout.test.tsx`。先用当前 Web 截图和交互测试固定 Host grid/list、终端、全屏 SFTP、同步中心、主题选择、断连状态；在 360/390px 与桌面宽度验证软键盘模拟、无双层滚动和最后一行可见。记录不能共用的浏览器行为及其调用点。交付：可比较的桌面/移动任务清单和基准。
- [ ] **任务 2：抽离系统服务调用。** 文件：`src/shared/core/ports.ts`、`src/web/platform/browser-system-services.ts`、`src/web/App.tsx`、新增 `src/web/platform/platform-ui-services.ts` 与 `tests/unit/web/platform-ui-services.test.ts`。为文件选择/保存、确认框、外部链接、网络/生命周期事件定义最小可注入边界；先测权限拒绝、取消和断线，再把 `App.tsx` 的直接浏览器调用迁移到 Web 实现。保持现有 Web API 行为；`src/shared` 不出现 DOM/native 类型。交付：同一 UI 可由不同 shell 注入服务。
- [ ] **任务 3：统一窄屏导航和任务交互。** 文件：`src/web/App.tsx`、`src/web/components/TerminalWorkspace.tsx`、`SftpWorkspace.tsx`、`HostList.tsx`、`src/web/styles.css`、相关组件测试及 Playwright 走查。实现手机单 pane、Host 搜索、上下文操作、终端工具条、全屏 SFTP、系统返回可映射的导航状态；共享状态和文案，不复制业务组件树。交付：Web 窄屏先通过同一任务链，作为 Android UI 基础。

### M1：Windows 技术预览

- [ ] **任务 4：创建受限 Electron shell 与打包流水线。** 文件：新增 `apps/windows/main.ts`、`apps/windows/preload.ts`、`apps/windows/package.json`、构建配置、根 `package.json` 脚本及 shell 测试。锁定 Electron 版本；只加载随包发布的 UI，设置 sandbox、context isolation、禁用 renderer Node 权限；预加载脚本仅暴露明确的系统服务 IPC。测试未知 IPC、外部 URL 和第二窗口请求被拒绝。交付：可启动的 Windows 窗口与安装/解压包构建。
- [ ] **任务 5：托管本地 Relay 执行端。** 文件：`src/server/index.ts` 的启动配置边界、`apps/windows/server-process.ts`、`apps/windows/data-dir.ts`、对应进程/集成测试。将现有 server build 作为独立子进程，以用户 app data 的实例目录保存 SQLite/Vault；绑定 loopback 随机端口，健康检查后才打开 UI；关闭时幂等停止。加入单实例锁、重启与异常退出诊断、严格来源/会话校验。测试双启动、端口冲突、执行端崩溃、关闭重开及旧数据库保持不变。交付：无账号也能在本机管理 Host 并连接 SSH。
- [ ] **任务 6：Windows 系统交互和恢复。** 文件：新增 `apps/windows/system-services.ts`、`src/web/platform/desktop-adapters.ts`、对应测试。接入文件选择/保存、剪贴板、通知、窗口最小化/恢复和系统休眠；恢复后查询真实 session/transfer/command 状态。验证文件权限拒绝、Host Key 改变、SFTP 流和传输中断。交付：与 Web 同页面、同主题、同状态的 Windows 任务链。

### M2：Android 技术预览

- [ ] **任务 7：创建 Capacitor Android shell 与服务配置。** 文件：新增 `apps/android/` 的 Capacitor 配置、Android 工程、`src/web/platform/android-adapters.ts`、相关配置测试。锁定 Capacitor/Android 工具版本；本地打包 React 资源，首次启动配置 Relay HTTPS 地址并做连接/版本/capability 探测。服务切换时隔离会话和缓存；真实设备验证 cookie、Origin、WSS、TLS 证书与锁屏恢复。交付：免账号连接用户的 Relay 实例并进入同一 UI。
- [ ] **任务 8：Android 系统文件、输入和生命周期。** 文件：`apps/android/` 平台插件或配置、`src/web/platform/android-adapters.ts`、`src/web/components/TerminalPanel.tsx`、`SftpWorkspace.tsx` 及相关测试。接入系统文件选择/分享与流式传输、剪贴板、通知、系统返回、软键盘 inset、前后台/网络切换。确保取消和 URI 权限释放；恢复时重查 session/task，不能复用旧 Connected 标记。交付：真机上可完成 SSH、复制粘贴、SFTP、重连和锁定恢复。

### M3：跨实例同步与发布门槛

- [ ] **任务 9：独立执行端间的账号同步闭环。** 文件：优先扩展 `tests/e2e/account-sync.spec.ts`、`tests/integration/`、必要时 `src/server/api/` 与平台 adapter。搭建两个独立 SQLite/Vault 数据卷加独立账号/盲同步服务；验证 Windows 创建 Host/Identity/主题/工作区并启用同步后，Android 所连实例登录、解锁/恢复、预览、确认并接收允许的配置。验证冲突拒绝覆盖、设备撤销、登出保留本地数据、离线待同步；终端输出、live session 和 SFTP 内容不得上传。若现有服务部署拓扑不支持共享账号端点，先修复该边界再宣称跨平台同步。
- [ ] **任务 10：统一任务链与安全回归。** 文件：`tests/fixtures/core-runtime-contract.ts`、`tests/unit/shared/native-adapter-contract.test.ts`、各端 E2E/设备验证记录。三端跑相同 Host Key 拒绝/接受、连接重置/重连、SFTP 目录过滤和上传下载、批量命令确认、Vault 锁定、权限拒绝和主题恢复；Windows 真机检查安装/退出/数据目录，Android 真机检查 360/390px、旋转、软键盘和后台恢复。核心接口、凭据、构建及跨模块变更完成后执行 `npm run lint`、`npm run typecheck`、`npm test`、`npm run build` 及相关 E2E；记录 Windows/Android 原生构建和设备结果。交付：技术预览发布检查记录和已知限制。

## 追踪规则

每项任务在实施前补充对应分支/PR 或 commit、负责人、实际验证命令与证据链接；完成只在代码、测试和用户任务走查均有证据后勾选。M0 是两端依赖；M1 和 M2 在 M0 后可并行；M3 必须用两个真实独立执行端验收。首个 Windows 技术预览不等待 Android 完成，但“跨端同步完成”只能在任务 9 和 10 通过后声明。
