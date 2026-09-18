# Relay 跨端验收矩阵

本矩阵对应 [独立 Windows 与 Android 客户端实施计划](../plans/2026-09-17-relay-windows-android-implementation.md)、[统一体验设计](../specs/2026-09-17-relay-windows-android-unified-experience-design.md) 和 [跨端验收交接任务书](./2026-09-18-relay-cross-platform-handoff.md)。

状态含义：`✅` 有当前自动化/构建证据；`🟡` 代码和自动化已覆盖，但缺少目标平台证据；`⛔` 当前环境无法验证，不能按完成处理。

| 用户任务 / 安全边界 | Web | Windows | Android | 当前证据 | 完成所需补证 |
| --- | --- | --- | --- | --- | --- |
| Host 搜索、收藏、grid/list、标签过滤 | ✅ | 🟡 | 🟡 | Web DOM/E2E；native runtime 复用 HostStore | Windows 窗口和 Android 触控走查 |
| 创建/编辑/删除 Host 与本地 Vault | ✅ | 🟡 | 🟡 | Web E2E；Windows IPC/native contract；Android JVM/编译 | 两端安装后持久化和锁定走查 |
| 首次 Host Key 确认、变更拒绝 | ✅ | 🟡 | 🟡 | Server/Windows/Android 状态机和定向测试 | Windows/Android 真机连接证据 |
| SSH 输入、复制/粘贴、断连重连 | ✅ | 🟡 | 🟡 | Web E2E、TerminalSession/Native socket 测试 | Windows 原生 ABI、Android 真机网络切换 |
| 多标签、分屏与移动单 pane | ✅ | 🟡 | 🟡 | Web 320/390px E2E；共享 runtime capability | Windows/Android UI 和生命周期走查 |
| SFTP 浏览、过滤、分页、变更、上传下载 | ✅ | 🟡 | 🟡 | Web E2E；服务端分页；native bridge/JVM contract | 两端真实 SSH/SFTP、取消和部分失败 |
| SFTP 单层滚动、终端最后一行可见 | ✅ | 🟡 | 🟡 | Web 窄视口几何断言 | Windows 窗口和 Android 软键盘/安全区 |
| Vault 锁定、重开、任务恢复状态 | ✅ | 🟡 | 🟡 | Web/Windows/Android 本地实现与 JVM/DOM 测试 | 崩溃、重启、锁屏/进程回收 |
| 主题、字号、grid/list 偏好持久化 | ✅ | 🟡 | 🟡 | Web E2E 主题持久化与第三方 `data-theme` 隔离 | 两端重启后视觉走查 |
| Vault bundle v1 正反向导入导出 | ✅ | 🟡 | 🟡 | shared/native bundle、分块、错误输入测试；Android 已有 Node V1 加密 envelope 固定向量 | [交接任务书 A-17](./2026-09-18-relay-cross-platform-handoff.md) 的 Web↔Windows↔Android 完整 payload 固定向量实测 |
| 原生安全边界：无 HTTP/cookie、IPC/bridge allowlist | ✅ | 🟡 | 🟡 | Windows policy/IPC 测试；Android bridge schema/JVM 测试 | 目标设备检查端口、日志、备份和 URI |
| 低内存边界与产物 | ✅ | 🟡 | 🟡 | Web/Server/Windows 构建；portable PE；Debug APK ZIP；单 worker 构建 | 目标平台 RSS/ABI/签名测量，且制品来源/源码 commit 必须可追溯 |

## 当前可复现证据

- Web/Server/Cloud：`npm run build`、`npm run typecheck`、`npm run lint`、`npm test -- --no-file-parallelism --maxWorkers=1 --reporter=dot` 和 `npm run test:e2e -- --project=chromium`；默认 E2E 4/4 通过，Playwright 共享数据目录固定单 worker。
- Windows：`npm run build:windows` 和 `npm run package:windows:portable`；本机生成 `dist/releases-portable-preview/Relay-0.1.0-x64.exe`，SHA-256 `F4181F7095B9453FCB0720BC436F54E22A0DCCC4F4E16C5F0FE71C5A0EF1A663`，大小 457,281,531 bytes。`npmRebuild=false` 的预览包不能替代 Windows native ABI、安装/升级和完整任务链验收。
- Android：设置 `JAVA_HOME`、`ANDROID_HOME`/`ANDROID_SDK_ROOT` 后，以 JDK 21 + Gradle 9.3.1、单 worker、离线依赖执行 `:app:compileDebugKotlin :app:testDebugUnitTest :app:assembleDebug`；Debug APK SHA-256 为 `4F84641808A110142B068F33A28F39D1251C37F14A33DC96318F75A72E19D5CA`，大小 8,284,171 bytes。本轮已安装到 `emulator-5554`（API 35/x86_64）并启动 `cn.ayan.relay/.MainActivity`；这只证明安装/启动 smoke，真 SSH/SFTP、Keystore、网络切换、锁屏/进程回收和 A-01～A-17 仍需设备验收。构建工具链和制品溯源要求记录在交接任务书中。

## 任务状态与门禁边界

- 当前仍未完成：任务 4–14；其中任务 5 的完整跨端 bundle v1 固定向量由[交接任务书 A-17](./2026-09-18-relay-cross-platform-handoff.md)执行，未通过前不能勾选任务 5、10 或 14。
- 任务 15 仍是 🟡 的未来同步兼容性预留，但不属于本期 Windows/Android 客户端发布门禁；本期只要求云服务缺席时本地功能不受影响。
- 矩阵不把 Web 浏览器验证、portable 生成或 APK 安装/启动 smoke 视为 Windows/Android 完整验收；Android 交接机器应按任务书逐项回填结果，不以“能安装 APK”替代 SSH、SFTP、Vault、生命周期和低内存边界验证。
