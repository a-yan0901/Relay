# Relay 跨端验收矩阵

本矩阵对应 [独立 Windows 与 Android 客户端实施计划](../plans/2026-09-17-relay-windows-android-implementation.md)、[统一体验设计](../specs/2026-09-17-relay-windows-android-unified-experience-design.md) 和 [跨端验收交接任务书](./2026-09-18-relay-cross-platform-handoff.md)。

状态含义：`✅` 有当前自动化/构建证据；`🟡` 代码和自动化已覆盖，但缺少目标平台证据；`⛔` 当前环境无法验证，不能按完成处理。

| 用户任务 / 安全边界 | Web | Windows | Android | 当前证据 | 完成所需补证 |
| --- | --- | --- | --- | --- | --- |
| Host 搜索、收藏、grid/list、标签过滤 | ✅ | 🟡 | 🟡 | Web DOM/E2E；native runtime 复用 HostStore | Windows 窗口和 Android 触控走查 |
| 创建/编辑/删除 Host 与本地 Vault | ✅ | 🟡 | 🟡 | Web E2E；Windows IPC/native contract；Android JVM/编译 | 两端安装后持久化和锁定走查 |
| 首次 Host Key 确认、变更拒绝 | ✅ | 🟡 | 🟡 | Server/Windows/Android 状态机和定向测试；两台 Android 16 真机已在用户提供的 `106.14.61.92:22` 上完成同一真实指纹的 native trust 和建 Shell | Windows 实机连接、Android Host Key 变更拒绝 |
| SSH 输入、复制/粘贴、断连重连 | ✅ | 🟡 | 🟡 | Web E2E、TerminalSession/Native socket 测试；两台 Android 16 真机在真实主机上连续 3 轮关闭/重开，均收到 raw `terminal.status=connected`，`whoami` 返回 `t2` 且 Console 可输入；本轮又分别输入 `echo REAL_SERVER_2407`/`echo REAL_SERVER_25091` 得到真实远端回显 | Windows 原生 ABI、Android 真机网络切换、复制/粘贴和完整 UI 走查 |
| 多标签、分屏与移动单 pane | ✅ | 🟡 | 🟡 | Web 320/390px E2E；共享 runtime capability | Windows/Android UI 和生命周期走查 |
| SFTP 浏览、过滤、分页、变更、上传下载 | ✅ | 🟡 | 🟡 | Web E2E；服务端分页；native bridge/JVM contract；Android 真实主机证据包括两台设备 `/tmp` 各 19 项、本轮 `25091RP04C` 的 `/` 36 项和 `/tmp` 25 项；2407 真机 32 MiB 原生 URI 上传完成并校验哈希，取消保留既有目标且无 staging，暂停/继续从断点完成；25091 系统选择器上传与 DocumentsUI 下载均完成 100% | 两端真实 UI SFTP、重试/部分失败、完整 URI 任务边界和低内存 |
| SFTP 单层滚动、终端最后一行可见 | ✅ | 🟡 | 🟡 | Web 窄视口几何断言 | Windows 窗口和 Android 软键盘/安全区 |
| Vault 锁定、重开、任务恢复状态 | ✅ | 🟡 | 🟡 | Web/Windows/Android 本地实现与 JVM/DOM 测试 | 崩溃、重启、锁屏/进程回收 |
| 主题、字号、grid/list 偏好持久化 | ✅ | 🟡 | 🟡 | Web E2E 主题持久化与第三方 `data-theme` 隔离；Android 两台 Android 16 真机选择 Everforest/16px 后 force-stop、重启、解锁仍保持 | Windows 重启后视觉走查；Android grid/list、旋转、软键盘与完整视觉走查 |
| Vault bundle v1 正反向导入导出 | ✅ | 🟡 | 🟡 | shared/native bundle、分块、错误输入测试；Android 已有 Node V1 加密 envelope 固定向量 | [交接任务书 A-17](./2026-09-18-relay-cross-platform-handoff.md) 的 Web↔Windows↔Android 完整 payload 固定向量实测 |
| 原生安全边界：无 HTTP/cookie、IPC/bridge allowlist | ✅ | 🟡 | 🟡 | Windows policy/IPC 测试；Android bridge schema/JVM 测试 | 目标设备检查端口、日志、备份和 URI |
| 低内存边界与产物 | ✅ | 🟡 | 🟡 | Web/Server/Windows 构建；NSIS/portable PE；Electron ABI 149 native load；Debug APK；单 worker 构建 | 目标平台 RSS/低内存、签名和持久制品来源；Android 设备内存采样 |

## 当前可复现证据

- Web/Server/Cloud：`npm run build`、`npm run typecheck`、`npm run lint`、`npm test -- --no-file-parallelism --maxWorkers=1 --reporter=dot` 和 `npm run test:e2e -- --project=chromium`；标准全量回归为 161 个测试文件通过、1 个跳过，727 个测试通过、2 个跳过；E2E 4/4 通过，Playwright 共享数据目录固定单 worker。
- Windows（历史预览记录，非本轮新产物）：源码 commit `75cc630` 上曾执行 `npm run build:windows` 和 `npm run package:windows:portable`；本机残留 `dist/releases-portable-preview/Relay-0.1.0-x64.exe`，SHA-256 `1A7B61C6DD7C846BD0CC924A05FA812032A83691CE7D76ECAC2106413359D04C`，大小 457,281,531 bytes，签名状态为 `NotSigned`。`npmRebuild=false` 的预览包不能替代 Windows native ABI、安装/升级和完整任务链验收。
- Android（历史设备回归记录）：源码 commit `d3c4c62` 的 APK 大小 8,633,367 bytes，SHA-256 为 `D740E4D58BAA208E38D2F1DE51B86C6973745EF8C718D48C255FEBAF9D6B9BA8`；本条的真机 SSH/SFTP 结果继续有效，但当前 APK 制品以交接任务书第 2 节的 `158F...ED045` 为准。两台真机对用户提供的 `106.14.61.92:22` 密码主机完成 Host Key trust、`/tmp` SFTP 列举（19 项/台）、终端 resize/写入/关闭，并连续 3 轮关闭/重开后输入 `whoami` 返回 `t2`；手机重装后另有 `echo REAL_SERVER_2407_REINSTALLED` 真实回显，真实 UI 中完成两台 Console 命令回显和 `25091RP04C` 的 `/`/`/tmp` 浏览。SFTP 完整任务矩阵、私钥、变更 Host Key、生命周期、网络切换和其余 A-01～A-17 仍需设备验收。构建工具链和制品溯源要求记录在交接任务书中。

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

- 上述 root Electron smoke 记录形成时，`package:windows` 还受 MSVC 和外部 Electron 下载阻塞；该历史阻塞已在最终复审中解除。当前 NSIS/portable 制品、ABI 和安装证据以本文末节为准，仍不是签名发布验收。
- Windows 升级/退出重开、打包后 SFTP/Vault UI、低内存和完整任务链仍保持 `🟡`；Android 的 A-01～A-17 仍按交接任务书逐项维护。

## 2026-09-19 续验增量：Android 真实 UI 与安全边界

- 两台 Android 16 真机均使用用户提供的 `106.14.61.92:22`/`t2`，从 Console 的“需要重新打开”状态执行重新打开；`2407FRK8EC` 输入 `echo REAL_SERVER_2407`、`25091RP04C` 输入 `echo REAL_SERVER_25091` 均得到远端回显和 `t2` 提示符。该证据专门覆盖“状态点变绿但命令不可输入”的风险，不把绿色状态单独视为通过。
- `25091RP04C` 真实 SFTP UI 浏览 `/` 得到 36 项，跳转 `/tmp` 得到 25 项；初次非用户手势文件选择器自动化没有形成传输任务，不能作为证据；随后真实系统选择器上传/下载均已完成 100%，其余大文件取消/重试/部分失败和 SAF URI 边界仍待补平台证据。
- `25091RP04C` 的部分安全检查无秘密标记、无 app-private 标记、无 Relay/常用开发端口监听；APK manifest 的 `android:allowBackup` 为 `0`。这不能替代使用专用无敏感标记密码完成的完整 A-16 过程。
- `2407FRK8EC` 的 connected instrumentation 2/2 已通过；runner 清理 APK 后设备曾拒绝 `adb install -r`（`INSTALL_FAILED_USER_RESTRICTED`），随后安装权限恢复，`adb install -r --no-streaming` 返回 `Success`，并在真实服务器上完成首次指纹确认、登录和 `echo REAL_SERVER_2407_REINSTALLED` 回显。该历史阻塞不改变 connected test 结果，也不再是当前安装状态阻塞。
- `25091RP04C` 已通过真实 MIUI 文件选择器上传一个 33,817-byte 文件到用户服务器 `/tmp`，并通过 Android DocumentsUI 保存对话框下载回本机；两次 Transfer Center 均显示 100%。根目录无写权限时的 0% 上传任务已取消。32 MiB/25% 取消、重试、部分失败和任务结束立即释放 URI 仍保持待验收；force-stop 后重启时 URI grant 已清空。

## 2026-09-19 续验追加：手机重装后的真实服务器命令验证

- 当前两台 Android 真机均在线且安装同一 Debug APK；`2407FRK8EC` 重装后重新创建/保存的 Host 指向用户提供的 `106.14.61.92:22`、账号 `t2`，首次连接显示真实 `ssh-ed25519` 指纹并在确认后建立 Shell。
- 手机端修正 Host 独立凭据后，Console 实际执行 `echo REAL_SERVER_2407_REINSTALLED`，返回同名远端回显和 `t2` 提示符。该结果证明输入已送达真实测试主机，不以状态点变绿替代命令验证。
- 本条不把本地 in-process SSH fixture 当作真机证据；密码仍未写入仓库、日志或文档。A-01～A-17 未覆盖的验收边界继续保持原状态。

## 2026-09-19 最终实现与发布复审（提交 `bde17c4`）

- Android 原生上传链路已补齐：系统选择器返回的 URI 保留在 native store，WebView 只拿到 opaque `sourceId`，原生以 32 KiB 缓冲通过单条 SFTP 连接写入 `.relay-part-<transferId>`，完成后原子 rename；取消/失败清理 staging，既有最终目标不被覆盖。
- `2407FRK8EC` 在用户提供的 `106.14.61.92:22`、账号 `t2` 上完成 32 MiB 上传，远端大小 `33,554,432` bytes、SHA-256 `83ee47245398adee79bd9c0a8bc57b821e92aba10f5f9ade8a5d1fae4d8c4302`；取消约 35% 后保留既有完整目标且无 staging，暂停/继续从约 11 MiB 断点完成。该结果是 A-10 的实机增量证据，未把整个 A-10/A-11 标成通过。
- Windows `package:windows` 已固定使用本地 `node_modules/electron/dist`，避免 Electron 下载超时，并将 NSIS/portable 分目录输出。当前制品：NSIS `127,632,075` bytes / SHA-256 `979E3D6CECD611AE99F3DE3CA41D3E6A298A5906196B685B61318A5853FDF20F`；portable `113,552,550` bytes / SHA-256 `82F8D40377037DF2392CFF2B20F7ED0E537C7011D118EEDFC99C01B37C0CAC7D`；均为 `NotSigned`。Electron ABI 149 的 `argon2`、`better-sqlite3`、`cpu-features` 加载通过，NSIS 安装/启动/卸载通过。
- 当前自动化门禁：`npm run typecheck`、`npm run lint`、`npm run build`、`npm run build:windows`、Android `:app:testDebugUnitTest :app:assembleDebug`、定向 Web/native 31 测试和全量 Web/Server 731 测试通过（161 文件通过、1 跳过；2 测试跳过）。Android A-03 已有真实 UI 通过证据；剩余门禁仍包括 A-04、A-05～A-09、A-11～A-17、Windows 升级迁移/崩溃恢复/打包后完整任务链，以及签名和持久制品来源。

## 2026-09-19 URI 权限复核与 32 MiB 下载续验（提交 `b094ee9`）

- 当前 APK SHA-256 为 `42F5C183FB0CB4F6DAAAFA0825E8F3C41408B7CEF39A7F92390016AB85A6F19F`；两台 Android 真机均重新安装成功。`25091RP04C` 从用户提供的真实主机下载 32 MiB 文件到本机，大小与 SHA-256 均一致，Transfer Center 显示 100%。
- Android executor 已做 Activity/application 双重 revoke best-effort，但真实设备在任务结束后仍显示 Activity-owned 临时 URI grant，只有 force-stop 后清空。因此 A-11 继续保持 `🟡/待执行`，不能按代码调用或传输成功替代权限释放验收。

## 2026-09-19 Android 返回、过滤与进程恢复增量

- `25091RP04C` 的真实 SFTP UI 在 `/tmp` 输入 `relay-native` 过滤后当前页显示 1 项；系统返回键从 Console 回到 Server 列表。该证据不替代完整滚动/分页、弹层返回栈和安全区验收。
- 对同一设备执行 `force-stop` 后重启，Vault/Host 数据保留，旧 Console 显示需要重新连接；重新打开后建立新 Shell。锁屏、旋转和完整进程回收仍保持未完成。

## 2026-09-19 打包版 Windows 与 Android 大目录/内存增量

- 打包版 Windows 入口 `dist/releases/nsis/win-unpacked/Relay.exe` 已连接用户提供的真实 `106.14.61.92:22`/`t2` 主机，实际回显 `echo PACKAGED_WINDOWS_UI`；SFTP UI 读取 `/` 36 项、跳转 `/tmp` 并过滤 `relay-native` 得到 1 项。锁定/解锁后 Host 与信任记录保持；强制终止打包进程树后重启，旧 Console 显示需要重新连接，重新打开后 `echo PACKAGED_WINDOWS_AFTER_CRASH` 得到真实回显。该证据只覆盖一个打包版崩溃恢复场景，升级迁移和完整打包任务链仍保持 🟡。
- `25091RP04C` 在真实主机创建 300 个一次性 1-byte 条目，Android SFTP UI 分页为 `128 + 128 + 44`，随后删除并确认目录清理；大目录页前后 PSS 采样为 `270,324 KB` 到约 30 秒后的 `251,874 KB`。无 OOM/ANR；A-15 因缺少合格 2 分钟基线和同时 32 MiB 传输采样，仍不能标记为通过。

## 2026-09-19 固定跨端 bundle 回归与安装复核

- 固定合成向量 `tests/fixtures/vault-bundle-v1-full-vector.json` 及 Android 资产副本已同步，覆盖 2 Host、2 Group、2 Identity、1 Terminal Profile、中文/空格标签、PEM 私钥、Group 部分 profile、jump host 和 canonical string `credentialSource`；不含真实凭据。bundle SHA-256：`eb5ac0fcd78ff260b7ca686caf33bc9d8ac4f14b7542503acf0768ed510fccf0`，payload SHA-256：`aaaf965d4077c724126daab6bb1603b1619ce3ddf981d1bcad2443cc67ae202f`。
- Node 固定向量测试 6/6 通过；两台 Android 16 真机的 `AndroidBundlePayloadInstrumentedTest` 各 5/5 通过。当前 Debug APK `8,633,755` bytes，SHA-256 `EC1366A3943ED4879E639D1F3D8AA75BE57F3E983E3F66AC82F00CB325E57A18`。本轮同时修复标签、PEM 换行、Group 部分 profile 和 `credentialSource` string/object 兼容边界。
- `25091RP04C` 普通 app 安装曾返回 `INSTALL_FAILED_USER_RESTRICTED`；改用 `adb push` + `pm install -r --user 0` 返回 `Success`，测试 APK 安装并完成 5/5。该设备安装阻塞已解除。
- 该证据把 bundle 行标记为“已有固定向量部分证据”，仍不等同于 A-17 通过：Android → Web/Windows 的真实导出回传、Windows 实机导入及完整冲突/原数据不变性闭环仍待补齐；因此矩阵中的 Windows/Android 完整发布状态继续保持 `🟡`。

## 2026-09-19 URI 授权模式修复与在线真机复验

- Android URI source handle 现在保留实际 `READ|WRITE` mode flags 和 persistable 取得结果；上传、保存 writer 的成功/失败/取消路径均按实际 flags 释放，Android JVM 红绿测试、Debug 构建和在线 `25091RP04C` connected instrumentation 5/5 通过。
- 当前 APK SHA-256：`068A16E94F09EA90C97F609DD456BDEE0874F830FC57668C364A8C997DB18C89`，大小 `8,633,755` bytes。`25091RP04C` 通过真实 MIUI 文件选择器上传合成固定文件到用户主机 `/tmp`，远端 `5,176` bytes、SHA-256 `169800b9708c5bc818d64cf3410f566469b65809bcbd3ef9401e4a12a8b4f783`，随后清理 Host、远端文件和设备文件。
- 传输完成后 Activity 内仍能观察到当前临时 URI grant；`force-stop` 并重启 Relay 后该 grant 清空，未证明有持久化 grant，但也未证明 Activity-owned 临时 grant 可在任务结束瞬间消失。A-11 仍为 `🟡/待执行`，权限拒绝提示和分享未覆盖。
- 2407 本轮处于不可达状态（`adb connect 192.168.1.2:40019` 超时，安装重试返回 `device not found`），本条不把 25091 的证据扩展到 2407。
- 安装重试边界：`25091RP04C` 的 Gradle 自动安装和设备侧 `pm install -r --user 0` 均被 MIUI 以 `INSTALL_FAILED_USER_RESTRICTED` 拒绝，connected 本次为 0 tests；本轮不把最新 APK 标记为已安装。
- 后续复核：`25091RP04C` 仍在线；`2407FRK8EC` 的 `adb connect 192.168.1.2:40019` 返回 Windows socket 10061（目标端主动拒绝），因此不新增 2407 安装或 connected 证据。

## 2026-09-19 Windows 打包版启动与定向回归

- `dist/releases/nsis/win-unpacked/Relay.exe` 可启动真实打包渲染页 `Relay SSH Workspace`，preload IPC 可调用，`vault.status` 返回 `locked`；本轮未解锁或写入现有桌面 Vault。
- Windows `local-runtime`、main/preload 与 Server 固定 bundle 定向测试共 4 个文件、20 个测试通过。该证据只覆盖启动/IPC/本地 runtime 和固定向量回归，Windows 完整 SSH/SFTP/Vault 任务链、升级迁移、签名及持久制品来源仍保持未完成。

## 2026-09-19 Windows 固定 bundle 回归与 Android 安装重试

- Windows IPC 固定向量现已覆盖 preview/apply 的计数、字段继承、终端 profile、Group/Inline 凭据来源、jump host，以及错误密码和篡改 bundle 的无写入回滚；期间修复了共享 Host metadata 映射遗漏 `terminalProfileId` 的问题。
- Windows `local-runtime` 定向测试 6/6 通过；全量 Vitest 为 161/162 个测试文件通过（1 个跳过），734/736 个测试通过（2 个跳过）。这只证明本地 runtime/共享映射，不扩大为 Windows 打包版完整任务链通过。
- 对 `25091RP04C`（`192.168.1.3:46545`）再次执行安装：设备在线，APK 传输成功，但 `adb install -r -g --no-streaming` 再次返回 `INSTALL_FAILED_USER_RESTRICTED: Install canceled by user`；本轮仍为安装阻塞，不能记录为 APK 已安装或 connected tests 通过。
- `2407FRK8EC`（`192.168.1.2:40019`）当前连接仍被目标端主动拒绝（10061），没有新增该设备安装证据。

## 2026-09-19 Web 回归与 Windows 打包版 Vault 重启验证

- Web Playwright 复跑 4/4 通过：Vault/Host Key/终端多标签和锁定、SFTP 上传下载/取消、批量任务、断线恢复、窄屏布局和主题持久化均有真实浏览器证据。
- Windows 最新 `build:windows` 与 `package:windows` 通过；NSIS 为 `127,632,261` bytes、SHA-256 `D79B07850B80F1E714C07EDB543EB0CA1CCBDC4E071BC74E2743904F93F95858`，portable 为 `113,552,538` bytes、SHA-256 `26C498BB91315FC39DF3DC4AA527FD9A06ED80700D177DA6F1FFAA49C931B99A`。两者签名状态均为 `NotSigned`，不能回填为签名发布通过。
- 隔离 `userData` 的打包版经过真实 renderer/preload IPC 完成 Vault setup、Host/workspace 保存、lock、错误密码拒绝、unlock，并在进程重启后恢复 Host/workspace；Windows 本地 runtime 重启回归 7/7 通过。这补强了 Windows Vault/持久化证据，但仍不替代升级迁移、完整打包 SSH/SFTP/UI 任务链和签名验收。
- 当前全量 Vitest 为 161/162 个测试文件通过（1 个跳过），735/737 个测试通过（2 个跳过）；typecheck 和 lint 通过。

## 2026-09-19 Windows 打包版真实主机 SSH/SFTP 验证

- 最新 NSIS 解压版在独立 `userData` 中经真实 renderer/preload IPC 连接 `106.14.61.92:22` 的 `t2` 主机；Host Key 指纹 `SHA256:DW4b509womrL6B4XC9tjbWFZsVNzPy6I1lBcFWiz5k` 显式 trust 后 Shell 为 `connected`，固定合成命令标记获得真实回显。
- 同一打包版 Host 经 `files.listPage` 读取远端 `/` 返回 16 项和下一页 cursor，关闭 Shell 后锁定 Vault，状态为 `locked`。这证明打包版真实密码认证、Host Key 首次信任、Shell 输入和 SFTP 分页链路；不扩大为私钥、指纹变更拒绝或完整传输矩阵通过。

## 2026-09-19 双真机安装与 connected instrumentation 回填

- 当前 Debug APK：`8,633,755` bytes，SHA-256 `068A16E94F09EA90C97F609DD456BDEE0874F830FC57668C364A8C997DB18C89`。
- `2407FRK8EC`（Android 16/API 36）通过恢复后的 mDNS ADB 通道安装成功，`:app:connectedDebugAndroidTest` 为 `7/7` 通过。
- `25091RP04C`（Android 16/API 36）通过 `192.168.1.3:46545` 安装成功，`:app:connectedDebugAndroidTest` 为 `7/7` 通过。
- 这次回填只证明安装和自动化原生测试门槛已恢复；Host Key 变更、私钥认证、网络切换、完整 SFTP 失败矩阵、生命周期/低内存/秘密边界和 A-17 仍以矩阵原状态为准。

## 2026-09-19 Windows Host Key 与私钥认证边界回归

- Windows runtime 新增回归：保存的合成私钥/口令确实进入 SSH adapter；已信任指纹变化并选择拒绝时，IPC 稳定返回 `HOST_KEY_MISMATCH`，而不是 `INTERNAL_ERROR`，旧指纹信任不被静默替换。
- 定向测试 `15/15` 通过；全量 Vitest `161` 个文件、`737` 个测试通过，`typecheck`、`lint`、Web/Server/Windows 构建均通过。
- 修复版 NSIS/portable 制品已重新生成并校验，但均为 `NotSigned`；Windows 真实 UI 私钥认证、真实 Host Key 变化和升级迁移仍保持 `🟡`，不提前标记为平台发布通过。
## 2026-09-19 Android A-03/A-04 真机 UI 增量

- `25091RP04C` 真实 UI 完成 Host Key 变化、拒绝保留旧信任、再次拒绝和显式替换闭环；A-03 已有可追溯脱敏证据。
- 同一真机使用临时 Ed25519 私钥连接用户测试主机并收到 `ANDROID_PRIVATE_KEY_ACCEPTED` 远端回显；A-04 仍只记录私钥正向增量，错误凭据、日志保密性和完整失败矩阵未通过。
- 证据文件：[Android Host Key/私钥 CDP 证据](./evidence/2026-09-19-android-host-key-private-key-cdp.md)。

## 2026-09-19 Android 私钥失败路径回归

- 新 APK 在 `25091RP04C` 上对故意不可用的私钥/口令返回 `SSH_AUTH_FAILED`，真实 UI 显示“远程服务器认证失败”；根因修复前的 `invalid privatekey` 映射已有单元测试红灯，修复后转绿。
- 两台 Android 16 真机各完成 `7/7` connected instrumentation，随后重新安装当前 APK 均返回 `Success`；当前 APK SHA-256 为 `5017F5ADBCCFA724D2601CD61AA9AED0893D229AA6B42966BB233FFC8A3FFDAE`。
- 该增量不把 A-04 整体标为通过；logcat、WebView 持久化、系统备份秘密扫描和完整密码/私钥失败矩阵仍待完成。证据：[Android 私钥失败路径 CDP 证据](./evidence/2026-09-19-android-private-key-failure-cdp.md)。

## 2026-09-19 双真机重试与 Android 日志边界复核

- 最新 Debug APK `8,633,755` bytes，SHA-256 `B66C9A27786A9996CE9658CBEC3A6AA8A8ACEEC7C0032C0D9FACD9ECD74AD058`；两台 Android 16 真机的 `:app:connectedDebugAndroidTest` 均完成 `7/7`，Gradle 返回 `BUILD SUCCESSFUL`。
- connected runner 清理应用后，首次重新安装曾在两台设备分别返回 `INSTALL_FAILED_USER_RESTRICTED`；再次触发安装后，两台设备均成功安装并通过 `pm path cn.ayan.relay` 复核。这只更新当前安装/原生测试状态，不把完整 Android 平台验收标为通过。
- `android.loggingBehavior: 'none'` 修复了 Capacitor verbose bridge 可能记录插件 payload 的边界。`25091RP04C` 的合成哨兵复核中，logcat、WebView `localStorage`、`sessionStorage`、IndexedDB 均无匹配，manifest `allowBackup=false`；系统备份导出/恢复和长时间日志审计仍待执行，A-16 保持 `🟡`。
- 相关脱敏证据：[Android 私密字段日志边界](./evidence/2026-09-19-android-secret-log-boundary.md)。A-04/A-06～A-17 未覆盖的人工边界以及 Windows 发布门禁继续保持原状态。

## 2026-09-19 Android 内置主题同步与偏好重启复验

- 根因已确认：Android 原生 terminal profile 只支持 `builtin:termius`，解锁时 `loadWorkspace` 读取默认 profile 会覆盖 Web 偏好中的非 Termius 主题；新增五套与 `src/shared/terminal-appearance.ts` 对齐的 Android 内置 profile，并统一 list/getDefault/setDefault 路径。
- `AndroidBuiltinTerminalProfilesTest` 先红后绿；目标单测 2/2 通过，随后 `:app:testDebugUnitTest :app:assembleDebug` 返回 `BUILD SUCCESSFUL`。当前 APK `8,633,755` bytes，SHA-256 `561351D1B83050CD3F60D358675366E4379BF7AC146D290440C601300314AA9B`。
- `2407FRK8EC`（mDNS ADB）与 `25091RP04C`（`192.168.1.3:46545`）均安装该 APK 成功。两台设备选择 `Everforest Dark` 和 `16px`，强制停止/重启/解锁后 DOM 仍为 `everforest-dark`、字号仍为 `16`，`relay.ui.preferences.v1` 仍保存相同主题和字号。
- 该条将 Android 主题/字号持久化从“仅有 Web 证据”更新为“两台真机部分证据”；grid/list、旋转、软键盘、安全区和完整视觉走查仍保持 🟡。证据：[Android 偏好重启 CDP 证据](./evidence/2026-09-19-android-preferences-restart-cdp.md)。

## 2026-09-19 Android Console 自动恢复复测

- 根因：恢复标签的 `recoveryStatus="needs-reopen"` 曾让 `TerminalPanel` 设置 `autoConnect: false`，并直接显示“此 Console 需要重新连接”。现已改为自动创建新 Shell；native `needs-reopen` 事件也会清理旧句柄后立即重连，用户不需要点击恢复。
- 当前 APK `8,633,649` bytes，SHA-256 `D4A1C69F5549109A91BE9428FFCBBDC2580EB2C18D321864A6869034416DAB90`；两台 Android 16 真机安装均返回 `Success`。Web/Session 定向回归 `33/33`，typecheck、lint、Web build、Android JVM/build 均通过。
- `25091RP04C` force-stop/重启并解锁后，`Provided Acceptance Host` 和 Console 保留，恢复条数量为 `0`、状态点为绿色；真实远端执行 `echo FINAL_RESTART_INPUT_OK_25091` 并收到回显，证明自动恢复后的 Shell 可输入。该证据更新 A-05 的“断连重连”部分，但 A-05 的复制/粘贴完整人工路径仍为 🟡。
- `2407FRK8EC` 本轮处于 Android 系统锁屏（`isKeyguardShowing=true`），只能确认安装成功，不能确认恢复 UI；不把 25091 结果扩展到 2407。A-06、A-08、A-15、A-17 及 Windows 未完成边界保持原状态。

## 2026-09-19 Windows 当前制品与 Android 2407 续验

- 当前源码 `9150f85` 的 `npm run build`、`npm run build:windows`、`npm run package:windows` 均通过；全量 Vitest `161` 个文件通过、`1` 个跳过，`738` 个测试通过、`2` 个跳过。
- 当前 NSIS：`127,632,215` bytes / SHA-256 `92F08B8F99B573EE84306243C97A84A544B88DB0C2223601A49AFE1CECEBA3B3`；portable：`113,554,151` bytes / SHA-256 `6AD0CF9035C8D04C09C67B233B522B6BEACE8EFA1E2BE81ECA986FCC7CE32158`。两者 PE 头均为 `MZ`，Authenticode 均为 `NotSigned`，不能标记为签名发布制品。
- 通过隔离 `userData` 的 Playwright Electron runner，NSIS 解压版真实完成 Vault/Host/Host Key/SSH 输入；重启同一打包实例后 `recoveryCount=0`、状态点绿色，重启后的远端命令回显成功。该证据将“打包版自动恢复”加入 Windows 证据，但 Windows 升级迁移和签名仍为 🟡。
- `2407FRK8EC` 已补做首次 Host Key trust、真实 SSH 登录和 `echo INITIAL_INPUT_OK_2407` 回显；在 force-stop/重启动作后 mDNS ADB 从原 serial 掉线，重新发现的 `192.168.1.2:35857` 连接超时，因此不把该设备的重启恢复标为通过。25091 的最终 APK 自动恢复证据仍有效。

## 2026-09-19 Console 恢复状态隐藏修复

- native Shell 失效后的 `needs-reopen` 现在只作为内部恢复标记；恢复初始态直接进入 `connecting`，收到 native 失效事件直接进入 `reconnecting` 并创建新 Shell，标签和 Quick Switcher 不再显示“此 Console 需要重新连接”。
- Web 定向单测 `67/67`、Playwright `ssh-productivity.spec.ts` `3/3`、typecheck、lint 均通过。该项加强 A-05/A-13 的“重启后自动恢复且命令可输入”边界，但不替代 Android 第二台设备、网络切换和进程回收实测。

## 2026-09-19 当前版本全量验收问题清单

- 当前源码 `10fb70f` 的 Web/Server 全量 Vitest 为 `161/162` 文件通过、`739` 测试通过、`2` 跳过；Playwright `4/4`；typecheck、lint、build、build:windows 均通过。
- 当前 Windows NSIS `127,632,032` bytes / `7E9A2676AE6CE83BD4755ADBFD4AE1AEA20D82870CC59183E0012D4D7658DB18`，portable `113,553,207` bytes / `3405E9984EB764771A784E7500E5A886A4F65915AB54A0B2635EFF2BB915A52A`，均 `NotSigned`；当前 NSIS 解压版一次性打包 smoke 已覆盖 Vault、错误密码、SSH 输入、SFTP 列表/过滤和重启自动恢复。
- 当前 Android APK `8,633,646` bytes / `0DF9842E67D91346C175B0CC104163D62CF626DD12CC40033AC8DB3C78614195`；JDK 21/SDK 指向修正后编译成功，`25091RP04C` connected instrumentation `7/7`。`2407FRK8EC` 记录 `0 tests` 后安装测试 APK 被 `INSTALL_FAILED_USER_RESTRICTED` 阻断，需解除设备限制后与 Android 全量清单一起重跑。
- 批量修复范围：Android A-01、A-05～A-17 中的真机缺口和可修复产品边界；Windows 签名/升级/持久制品来源；Android 构建环境入口。修复阶段不按单问题反复打包，问题清单关闭后再统一部署验收。

## 2026-09-20 最新批次验收状态（`e1c6246`）

| 范围 | 结果 | 证据与边界 |
| --- | --- | --- |
| Web / Server 自动化 | 通过 | Vitest `161/162` 文件、`739/741` 测试通过；Playwright `4/4`；typecheck/lint/build/build:windows 通过。 |
| Windows 安装包 | 部分通过 | NSIS/Portable 已生成并记录 SHA-256；同一批次独立 smoke 覆盖 Vault、错误密码、SSH、SFTP、重启自动重连；两个制品均 `NotSigned`。 |
| Android APK 构建 | 通过 | JDK 21/SDK/Gradle 9.3.1 offline 单 worker；APK `8,717,527` bytes，SHA-256 `15DD7B81D6B1C2859E4869E3ECC0AD70F574FF9A6983136A7159B1F18752A479`。 |
| Android 2407 真机 | 部分通过 | 复用已安装 APK 通过 WebView CDP 完成 Vault、Host Key、SSH 命令、SFTP 读取；移动终端锁定入口不可见，未宣称 A-01～A-17 全量通过。 |
| Android 25091 真机 | 阻塞 | 最终 APK 的一次 `adb install -r -g --no-streaming` 仍为 `INSTALL_FAILED_USER_RESTRICTED`；不重复安装，待设备侧解除策略。 |
| 跨端 bundle A-17 | 未闭环 | Android 新增 bundle round-trip 测试已编译，但本轮 connected instrumentation 未安装成功；Android→Web/Windows 实机回传仍缺证据。 |

本轮遵循批量验收原则：先执行同一版本全量检查，集中记录问题，再统一构建/部署；后续不因单个缺陷单独卸载、重装或重新打包。

## 2026-09-20 移动锁入口与启动恢复竞态修复后批次

| 范围 | 结果 | 证据与边界 |
| --- | --- | --- |
| Web / Server 自动化 | 通过 | Vitest `162/163` 文件（`162` 通过、`1` 跳过），`740/742` 测试通过；Playwright Chromium `5/5`；typecheck、lint、build、build:windows 通过。 |
| 启动恢复竞态 | 通过 | hydration 完成前不再展示可操作 Server 页面；刷新后工作区恢复不会把 Server 操作短暂卸载。host-to-terminal 和 SSH productivity 全量 E2E 通过。 |
| 移动 Vault 锁入口 | Web 通过 / Android 待部署 | 320px/390px 终端顶部锁按钮可见、可定位且为 `display:flex`；Android 新 APK 已包含修复，但本批次未重复安装，尚无新 APK 真机证据。 |
| Windows 安装包 | 部分通过 | NSIS `127,554,507` bytes / `CF6375567AB6FB471D19C6E97ABC74E9BA1EE821595F1E88A3D65664653110A3`；Portable `113,554,529` bytes / `DF17F53536DBB336039406DB766C15F2DE2D6F17E7DFC350BEE150D358766F90`；均 `NotSigned`。 |
| Android APK 构建 | 通过 | `npm run build:android:debug` 在 JDK 21/SDK、Gradle wrapper 8.14.3、offline、单 worker 下成功；APK `8,305,939` bytes / `72E538719BF2C926CB3CC0602BE384B641FCD34C92B886C9D3B6ECB21973B683`。 |
| Android 2407 真机 | 旧版本部分通过 | 设备仍在线且已安装旧 APK；本轮不重装。此前旧 APK 的 Vault/Host Key/SSH/SFTP CDP 主链路有效，新 hydration/锁入口未在设备上验收。 |
| Android 25091 真机 | 阻塞 | 当前 ADB serial `192.168.1.3:46545` 为 offline，且只读 `pm path cn.ayan.relay` 无结果；不重复触发安装，待设备侧恢复 ADB/解除安装策略。 |
| 跨端 bundle A-17 | 未闭环 | 本轮没有设备部署，Android→Web/Windows 回传和实机冲突验收仍缺证据。 |

本批次继续遵循批量验收原则：先集中修复 hydration、移动锁入口和 Windows Gradle 启动器，再统一构建；没有因单个问题卸载或重复安装 Android。A-04、A-06、A-08、A-11、A-15、A-17 以及 Windows 签名/升级/持久制品来源仍保持未完成。

## 2026-09-20 服务端账号 owner 隔离修复后批次

| 范围 | 结果 | 证据与边界 |
| --- | --- | --- |
| Web / Server 自动化 | 通过 | 全量 Vitest `162/163` 文件（`162` 通过、`1` 跳过），`742/744` 测试通过；Chromium E2E `5/5`；typecheck、lint、build、build:windows 通过。 |
| 账户同步 | 通过 | `ACCOUNT_SYNC_E2E=true` 的账户同步 E2E `4/4` 通过，覆盖注册、账号 owner Host 创建、Host 列表同步和终端连接；此前重复 `HOST_NOT_FOUND` 已由 owner 上下文修复消除。 |
| WebSocket 账号隔离 | 通过 | 终端/操作 gateway 集成回归 `10/10` 通过；握手后固定使用认证会话 owner，终端生命周期和操作事件订阅不再回落到默认 owner。 |
| Android 部署 | 未执行 | 遵循不卸载、不重复安装约束，本批次没有安装新 APK；固定 JDK 21/SDK、offline、单 worker 下 Android JVM 单测 `36/36`，测试 APK 编译成功；设备状态只做只读检查，真机新版本证据不因本地测试自动变绿。 |
| Windows | 部分通过 | Web/主进程/预加载构建通过；签名、升级迁移、持久制品来源和完整发布任务链仍未闭环。 |
| A-01～A-17 | 未整体通过 | 本批次只关闭服务端账号隔离回归；Android A-04、A-06、A-08、A-11、A-15、A-17 等人工/跨端门禁保持原状态。 |

本批次验证的是账号同步与 WebSocket owner 上下文，不替代 Android 真机清单、Windows 打包发布门禁或双向 bundle 交接。后续仍按问题分组集中修复，再统一构建、部署和全量验收。

## 2026-09-20 Android 本地验证入口

| 项目 | 结果 | 证据与边界 |
| --- | --- | --- |
| 本地 Android 回归入口 | 通过 | 新增根目录 `npm run test:android:local`，执行 Web 构建、Capacitor 同步、`:app:testDebugUnitTest` 与 `:app:assembleDebugAndroidTest`；JDK 21/SDK、offline、单 worker 下 `BUILD SUCCESSFUL`，Gradle `93` 个任务中 `18` 个执行、`75` 个复用缓存，Android JVM 报告为 `36/36`。 |
| 保留数据的 Android 部署入口 | 已定义，未执行 | 新增 `npm run install:android:debug -- <serial> [apk-path]`，使用 `adb push` + `pm install -r --user 0`，不调用 `-g`、卸载或 `pm clear`；仅在统一批次需要部署且设备在线时执行。 |
| 设备数据保护 | 通过 | 入口不调用 `connectedDebugAndroidTest`、ADB、安装、卸载或清理应用数据；设备不可用时只做本地编译和测试 APK 构建，不改变真机状态。 |
| Android 真机验收 | 阻塞 | 本机 ADB 当前无设备；用户提供的测试主机没有 `adb`；已知无线 ADB 端点当前不可达。上述本地结果不替代 A-01～A-17 的真机证据。 |

本入口用于提高离线回归效率；设备恢复后按批次统一部署和全量验收，不针对单个问题反复卸载、重装或重新授权。

## 2026-09-20 Windows 旧库启动迁移回归

| 项目 | 结果 | 证据与边界 |
| --- | --- | --- |
| Windows local runtime 旧库迁移与 bundle 往返 | 通过 | `tests/unit/windows/local-runtime.test.ts` 创建缺少现代字段的旧版 SQLite，再由真实 `createWindowsLocalRuntime` 启动并自动迁移；另以两个 local runtime 验证分块导出→导入；Host、分组和显式/解析连接 profile 保持可读，定向测试 `11/11`。 |
| Windows 安装包升级 | 未闭环 | 代码级迁移已有证据，但签名安装包的旧版本安装 → 新版本升级 → 数据/配置保留 → 回滚/崩溃恢复仍需在 Windows 安装环境验证；不因单测标记 Windows 发布门禁通过。 |

## 2026-09-20 全量回归与设备路径复核

| 范围 | 结果 | 证据与边界 |
| --- | --- | --- |
| Web / Server 全量 Vitest | 通过 | `162` 个测试文件通过、`1` 个跳过；`744` 个测试通过、`2` 个跳过（共 `746` 个测试）。新增 Windows 迁移和 bundle 往返测试已包含在内。 |
| 本机 Android ADB | 阻塞 | `adb devices -l` 无设备，不能进行安装或 connected instrumentation。 |
| 用户测试主机 Android 设备路径 | 阻塞 | `t2` 会话没有可调用的 `adb` 命令；USB 只有 QEMU Tablet，没有 Android 真机；已有 ADB server 仅监听远端 `127.0.0.1:5037`，没有可供本机使用的设备桥接。 |

该复核证明的是设备路径缺失，不是 Android 产品测试失败；在设备恢复前不执行安装、卸载或数据清理。
