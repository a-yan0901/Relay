# Relay 跨端验收矩阵

本矩阵对应 [独立 Windows 与 Android 客户端实施计划](../plans/2026-09-17-relay-windows-android-implementation.md)、[统一体验设计](../specs/2026-09-17-relay-windows-android-unified-experience-design.md) 和 [跨端验收交接任务书](./2026-09-18-relay-cross-platform-handoff.md)。

状态含义：`✅` 有当前自动化/构建证据；`🟡` 代码和自动化已覆盖，但缺少目标平台证据；`⛔` 当前环境无法验证，不能按完成处理。

| 用户任务 / 安全边界 | Web | Windows | Android | 当前证据 | 完成所需补证 |
| --- | --- | --- | --- | --- | --- |
| Host 搜索、收藏、grid/list、标签过滤 | ✅ | 🟡 | 🟡 | Web DOM/E2E；native runtime 复用 HostStore | Windows 窗口和 Android 触控走查 |
| 创建/编辑/删除 Host 与本地 Vault | ✅ | 🟡 | 🟡 | Web E2E；Windows IPC/native contract；Android JVM/编译 | 两端安装后持久化和锁定走查 |
| 首次 Host Key 确认、变更拒绝 | ✅ | 🟡 | 🟡 | Server/Windows/Android 状态机和定向测试；两台 Android 16 真机已在用户提供的 `106.14.61.92:22` 上完成同一真实指纹的 native trust 和建 Shell | Windows 实机连接、Android Host Key 变更拒绝 |
| SSH 输入、复制/粘贴、断连重连 | ✅ | 🟡 | 🟡 | Web E2E、TerminalSession/Native socket 测试；两台 Android 16 真机在真实主机上连续 3 轮关闭/重开，均收到 raw `terminal.status=connected`，`whoami` 返回 `t2` 且 Console 可输入 | Windows 原生 ABI、Android 真机网络切换、复制/粘贴和完整 UI 走查 |
| 多标签、分屏与移动单 pane | ✅ | 🟡 | 🟡 | Web 320/390px E2E；共享 runtime capability | Windows/Android UI 和生命周期走查 |
| SFTP 浏览、过滤、分页、变更、上传下载 | ✅ | 🟡 | 🟡 | Web E2E；服务端分页；native bridge/JVM contract；两台 Android 16 真机已通过真实主机读取 `/tmp`，每台返回 19 项 | 两端真实 UI SFTP、上传/下载/取消和部分失败 |
| SFTP 单层滚动、终端最后一行可见 | ✅ | 🟡 | 🟡 | Web 窄视口几何断言 | Windows 窗口和 Android 软键盘/安全区 |
| Vault 锁定、重开、任务恢复状态 | ✅ | 🟡 | 🟡 | Web/Windows/Android 本地实现与 JVM/DOM 测试 | 崩溃、重启、锁屏/进程回收 |
| 主题、字号、grid/list 偏好持久化 | ✅ | 🟡 | 🟡 | Web E2E 主题持久化与第三方 `data-theme` 隔离 | 两端重启后视觉走查 |
| Vault bundle v1 正反向导入导出 | ✅ | 🟡 | 🟡 | shared/native bundle、分块、错误输入测试；Android 已有 Node V1 加密 envelope 固定向量 | [交接任务书 A-17](./2026-09-18-relay-cross-platform-handoff.md) 的 Web↔Windows↔Android 完整 payload 固定向量实测 |
| 原生安全边界：无 HTTP/cookie、IPC/bridge allowlist | ✅ | 🟡 | 🟡 | Windows policy/IPC 测试；Android bridge schema/JVM 测试 | 目标设备检查端口、日志、备份和 URI |
| 低内存边界与产物 | ✅ | 🟡 | 🟡 | Web/Server/Windows 构建；portable PE；Debug APK ZIP；单 worker 构建 | 目标平台 RSS/ABI/签名测量，且制品来源/源码 commit 必须可追溯 |

## 当前可复现证据

- Web/Server/Cloud：`npm run build`、`npm run typecheck`、`npm run lint`、`npm test -- --no-file-parallelism --maxWorkers=1 --reporter=dot` 和 `npm run test:e2e -- --project=chromium`；默认 E2E 4/4 通过，Playwright 共享数据目录固定单 worker。
- Windows（历史预览记录，非本轮新产物）：源码 commit `75cc630` 上曾执行 `npm run build:windows` 和 `npm run package:windows:portable`；本机残留 `dist/releases-portable-preview/Relay-0.1.0-x64.exe`，SHA-256 `1A7B61C6DD7C846BD0CC924A05FA812032A83691CE7D76ECAC2106413359D04C`，大小 457,281,531 bytes，签名状态为 `NotSigned`。`npmRebuild=false` 的预览包不能替代 Windows native ABI、安装/升级和完整任务链验收。
- Android：源码 commit `d3c4c62` 上设置 `JAVA_HOME`、`ANDROID_HOME`/`ANDROID_SDK_ROOT`，以 JDK 21 + Gradle 9.3.1、单 worker 执行 `:app:testDebugUnitTest` 和 `:app:assembleDebug`；两项均返回 `BUILD SUCCESSFUL`，APK 大小 8,633,367 bytes，SHA-256 为 `D740E4D58BAA208E38D2F1DE51B86C6973745EF8C718D48C255FEBAF9D6B9BA8`。该 APK 已重新安装到两台 Android 16 真机 `2407FRK8EC`、`25091RP04C`；两台真机对用户提供的 `106.14.61.92:22` 密码主机完成 Host Key trust、`/tmp` SFTP 列举（19 项/台）、终端 resize/写入/关闭，并连续 3 轮关闭/重开后输入 `whoami` 返回 `t2`。SFTP 上传下载取消、私钥、变更 Host Key、生命周期、网络切换和其余 A-01～A-17 仍需设备验收。构建工具链和制品溯源要求记录在交接任务书中。

- 说明：本地 in-process SSH fixture 只用于可重复的自动化回归；上述 Android 真机结论使用的是用户提供的 `106.14.61.92:22`，账号为 `t2`，密码未写入仓库。

## 任务状态与门禁边界

- 当前仍未完成：任务 4–14；其中任务 5 的完整跨端 bundle v1 固定向量由[交接任务书 A-17](./2026-09-18-relay-cross-platform-handoff.md)执行，未通过前不能勾选任务 5、10 或 14。
- 任务 15 仍是 🟡 的未来同步兼容性预留，但不属于本期 Windows/Android 客户端发布门禁；本期只要求云服务缺席时本地功能不受影响。
- 矩阵不把 Web 浏览器验证、portable 生成或 APK 安装/启动 smoke 视为 Windows/Android 完整验收；Android 交接机器应按任务书逐项回填结果，不以“能安装 APK”替代 SSH、SFTP、Vault、生命周期和低内存边界验证。

## 2026-09-19 复审增量：Windows 实际 UI 证据与打包边界

### 已新增的 Windows 证据

- 在本机 root Electron UI 中使用真实主机 `106.14.61.92:22`、账号 `t2` 完成 Host Key 已信任后的 Shell 打开；终端输入 `echo WINDOWS_UI_STABLE` 得到回显和 `t2` 提示符。
- 关闭 Console 后重新进入同一 Host，输入 `echo WINDOWS_UI_REOPEN_STABLE` 仍得到回显和 `t2` 提示符；两次打开均只有一个稳定 native session，没有连续重连、`SSH_CONNECTION_FAILED` 或重复 Shell。
- 相关实现和测试覆盖了 file URL 资源、sandbox preload schema、close/open 顺序、唯一 native request ID、open 完成前 resize 竞态和 clean-close service instance。Windows/native 定向套件为 7 个测试文件、30 个测试通过；类型检查、lint 和 `build:windows` 通过。

### 仍不能勾选的边界

- 上述是 root Electron 开发运行时的真实服务器 UI smoke，不是签名安装包验收。`package:windows` 因缺少 Visual Studio/MSVC 的 `node-gyp` native rebuild 阻塞；portable 重试还受到外部 builder 下载超时影响。旧的 gitignored portable 文件不得当作本轮新产物或 ABI 证据。
- Windows 安装/升级/退出重开、native ABI、SFTP UI、低内存和完整任务链仍保持 `🟡`；Android 的 A-01～A-17 仍按交接任务书逐项维护，不因 Windows smoke 自动变更状态。
