# Relay 跨端验收交接任务书

**交接日期：** 2026-09-20
**上一版交接文档基线：** `30c9b5b`（`main`）
**本次文档修订：** 当前修订提交（以本文件所在 commit 为准）
**当前仓库交接基线：** `14c809d`；最后一个业务代码提交为 `f24283a`，`14c809d` 仅更新验证交接。旧 APK/portable 记录仍保留在历史续验段落，不作为当前制品。
**验收机器应检出：** `14c809d`；生成物必须以本文件最新交接段落记录的文件名、大小、SHA-256 和工具链复核。
**适用范围：** Android 真机/可用模拟器验收；Windows 实机验收作为并行任务保留
**对应计划：** [Relay 独立 Windows 与 Android 客户端实施计划](../plans/2026-09-17-relay-windows-android-implementation.md)
**对应矩阵：** [Relay 跨端验收矩阵](./2026-09-18-relay-cross-platform-acceptance-matrix.md)

## 1. 当前进度和交接结论

| 范围 | 当前状态 | 已有证据 | 交接后仍需补充 |
| --- | --- | --- | --- |
| Web/服务端 | ✅ 自动化基线可复现 | 当前代码基线的串行全量 Vitest `164` 个文件通过、`1` 个跳过；`757` 个测试通过、`2` 个跳过；服务端定向 `45` 文件/`203` 测试；typecheck、lint、build、Chromium E2E `5/5` | 无本次自动化交接阻塞项 |
| Windows | 🟡 打包与隔离恢复已复核，平台门禁未完成 | 当前 NSIS/Portable 制品、Electron ABI 149 native load、隔离 userData 三轮强制终止/重启恢复和 CI artifact 均有证据 | 签名、旧版本升级/回滚、安装器崩溃恢复、打包后完整 SSH/SFTP/Vault/UI 任务链 |
| Android | ⛔ 当前真机批次不可验证 | 当前只有独立 `emulator-5554`；JVM `38/38`、模拟器 instrumentation `9/9`、Debug APK `9D79…` 已复核；手机和平板未上线，历史两台真机证据保留但不代表当前制品状态 | 两台真机 A-01～A-17、Host Key/私钥失败矩阵、网络/生命周期/URI/低内存和实机跨端回传 |
| Vault bundle v1 | 🟡 加密边界已有固定向量，完整跨端 payload 尚未验收 | Android 已通过 Node V1 envelope 解密向量；Web/Windows 单端导入导出测试存在 | A-17：Web/Windows↔Android 固定 payload 正反向导入导出、错误输入和数据不变性 |
| 云同步 | ⏸️ 不在本期客户端验收 | 可选 ports 和数据边界已保留 | 按独立云同步计划推进，不在本任务书中验证 |

本次最新交接以 `emulator-5554` 的自动化证据和当前仓库基线为准；两台 Android 16 真机当前不在 ADB 列表，不能把历史真机记录扩展到当前 APK。用户提供的 SSH 主机仍是后续真机回归的目标环境。

后文早期真实设备段落是历史证据；第 48 节是当前 Android 设备状态，第 49 节是当前 Windows 多轮恢复状态，二者优先于早期“当前 APK 已安装两台真机”等摘要。

历史模拟器验证：`adb devices` 曾返回 `emulator-5554 device`；旧 APK `8F307F...` 在本地 in-process `ssh2` fixture 上完成 Host Key 展示、信任和 Shell 建立。该证据仅用于自动化回归溯源，不替代真实服务器证据。

### 真实 Android 设备补充证据（2026-09-19）

- 设备：Xiaomi `2407FRK8EC`、Xiaomi `25091RP04C`，均为 Android 16/API 36、arm64-v8a；以下是本节早期设备回归记录。当前制品和安装状态以第 11 节为准。
- 历史制品：源码 `d3c4c62`，APK 8,633,367 bytes，SHA-256 `D740E4D58BAA208E38D2F1DE51B86C6973745EF8C718D48C255FEBAF9D6B9BA8`；后续已由第 2 节记录的 `158F...ED045` APK 替代。
- 测试主机：明确使用用户提供的 `106.14.61.92:22`、账号 `t2` 和用户提供的密码；密码不写入仓库。两台设备均返回同一 `ssh-ed25519` 指纹 `SHA256:DW4b509womrL6B4XC9tjbWFZsVNzPy6I1lBcFWiz5kI`，确认后连接成功。
- UI 重开与输入回归：每台设备连续 3 轮执行关闭当前 Shell、重新打开 Host、等待 raw native `terminal.status=connected`、聚焦 Console 并输入 `whoami`；6/6 轮均成功返回 `t2`，Console 输入框均可聚焦，活动终端标签均显示 `status-dot-green`。
- native bridge smoke：两台设备均通过真实 JSch 连接读取 `/tmp`（每台返回 19 项），并完成终端 `resize`、写入测试命令和关闭会话；该证据证明真实设备到 SSH/SFTP 的原生通路可用。
- 续验 UI smoke：两台设备从“需要重新打开”的 Console 状态重新打开 Host；`2407FRK8EC` 输入 `echo REAL_SERVER_2407`、`25091RP04C` 输入 `echo REAL_SERVER_25091` 均得到真实远端回显和 `t2` 提示符。`25091RP04C` 真实 SFTP UI 浏览 `/` 返回 36 项，跳转 `/tmp` 返回 25 项。
- 边界：本次没有把上述结果扩大为完整平台验收；Host Key 变更拒绝、私钥认证、SFTP 上传/下载/取消/重试、网络切换、返回键/软键盘、锁屏/进程回收、低内存和 A-17 仍保持待执行。
- 口径：本地 in-process SSH fixture 仅用于可重复自动化回归，不作为本次真机结论的测试服务器。

## 2. 产物位置、溯源和工具链

仓库不包含以下生成物；它们当前位于 Windows checkout 的 gitignored 生成目录，不会随 `git clone`、`git checkout` 或本次文档 commit 交付。交接执行人应从受控制品来源取得同 hash 文件：

### Android Debug APK

- 文件：`apps/android/android/app/build/outputs/apk/debug/app-debug.apk`
- 应用 ID：`cn.ayan.relay`
- 应用代码基线：本次 Android 内置主题同步修订（随本次文档修订提交）
- 构建时间（文件时间，Asia/Shanghai）：`2026-09-19 20:52:24`
- 大小：`8,633,755` bytes
- SHA-256：`561351D1B83050CD3F60D358675366E4379BF7AC146D290440C601300314AA9B`
- 构建命令：

  ```powershell
  $env:JAVA_HOME = 'C:\path\to\jdk-21'
  $env:ANDROID_HOME = 'C:\path\to\Android\Sdk'
  $env:ANDROID_SDK_ROOT = $env:ANDROID_HOME
  Push-Location apps/android
  npm run build:web
  npx cap copy android
  Pop-Location
  Push-Location apps/android/android
  & 'C:\path\to\gradle-9.3.1\bin\gradle.bat' :app:testDebugUnitTest :app:assembleDebug --offline --max-workers=1 --console=plain
  Pop-Location
  ```

  本轮 wrapper 声明 `8.14.3` 的发行版下载不可用，实际使用已缓存的 Gradle `9.3.1`；`testDebugUnitTest` 用时约 1 分 14 秒，`assembleDebug` 用时约 27 秒且 73 项任务均为 up-to-date；交接机须记录实际版本，不应把本轮描述成首次建立 Gradle classpath。

### Windows x64 制品

- 生成命令：`npm run package:windows`；脚本使用 `node_modules/electron/dist`，NSIS 与 portable 分别输出到 `dist/releases/nsis` 和 `dist/releases/portable`，不依赖外部 Electron 下载。
- NSIS 文件：`dist/releases/nsis/Relay-0.1.0-x64.exe`；构建时间 `2026-09-19 14:47:08`；大小 `127,632,075` bytes；SHA-256 `979E3D6CECD611AE99F3DE3CA41D3E6A298A5906196B685B61318A5853FDF20F`；签名 `NotSigned`。
- Portable 文件：`dist/releases/portable/Relay-0.1.0-x64.exe`；构建时间 `2026-09-19 14:50:42`；大小 `113,552,550` bytes；SHA-256 `82F8D40377037DF2392CFF2B20F7ED0E537C7011D118EEDFC99C01B37C0CAC7D`；签名 `NotSigned`。
- Electron `44.4.1` ABI `149` 下 `argon2`、`better-sqlite3`、`cpu-features` 加载通过；NSIS 静默安装、启动存活 5 秒、静默卸载通过。当前仍未做升级迁移、崩溃恢复和打包后完整 SSH/SFTP/Vault/UI 任务链验收。

上述文件当前只存在于本机 gitignored 生成目录，不会随仓库 clone/checkout 交付。本仓库未配置可追溯的 GitHub Release 附件、制品服务器或跨机器共享目录；交接执行人应通过受控的 `scp`、SFTP 或共享目录复制，并在目标机再次运行 SHA-256 比对上述 hash。最终签收前必须补一条持久制品来源（URL、Release 附件或共享目录路径）；若没有该来源，状态只能保持 🟡。

以下是上一轮 Linux 构建记录中的工具链信息，不代表当前 Windows checkout 已具备同样环境，也不等同于已经锁定的产物源码 commit：

| 项目 | 版本/配置 |
| --- | --- |
| Node / npm | `v22.22.3` / `10.9.8` |
| JDK | OpenJDK `21.0.12` |
| Gradle | `9.3.1`（本轮使用已缓存发行版；wrapper 仍声明 `8.14.3`） |
| Kotlin | `2.0.21` |
| Android min/compile/target SDK | `24` / `36` / `36` |
| Android SDK Platform | `platforms;android-36` |
| Android Build Tools | `35.0.0` |
| Android Platform Tools | `37.0.1` |
| Android command-line tools | `13.0` |
| Android SSH 库 | `com.github.mwiede:jsch:2.27.7` |

产物重新构建时必须把“构建源码 commit、构建时间、上述工具链、产物文件名、SHA-256”写入同一份制品清单；当前清单缺失是最终签收前的 P0 任务。

## 3. 交接责任与设备要求

| 角色 | 责任 | 交付物 |
| --- | --- | --- |
| Relay 开发维护人 | 提供可追溯产物、维护本计划/矩阵、处理失败项并提交修复 | 制品清单、代码 commit、更新后的文档 |
| 交接验收执行人 | 在目标 Android 设备执行 A-01～A-17，保存脱敏证据 | 本文件结果列、截图/日志、设备信息 |
| 评审人 | 复核证据是否达到客观门槛，决定是否勾选任务 | 签收结论或阻塞项 |

验收设备最低规格（用于本轮技术预览，不改变 manifest 的 `minSdk 24`）：Android 10/API 29 或更高、arm64-v8a、至少 4 GB 实体内存、至少 2 GB 可用存储、可用 `adb`，并能访问测试 SSH/SFTP 主机。目标设备可用后，计划在 1 个工作日内完成首轮 A-01～A-17；实际开始/完成时间必须写入结果回填记录。

结果回填位置是本文件的“结果/证据”列；验收执行人提交脱敏截图和日志，Relay 开发维护人将回填后的文档以 commit 推送，并同步更新实施计划和验收矩阵。若验收执行人不能直接提交仓库，则通过受控渠道交付证据，由维护人代为提交。

## 4. Android 交接机器准备

1. 复制 APK 后先校验 SHA-256；优先使用 Android 真机，或使用已启用硬件加速/KVM 的模拟器。
2. 开启开发者选项和 USB 调试，确认：

   ```bash
   adb devices
   ```

   设备状态必须是 `device`，不能是 `offline` 或 `unauthorized`。

3. 安装并启动：

   ```bash
   adb install -r app-debug.apk
   adb shell monkey -p cn.ayan.relay 1
   ```

4. 准备一台可测试的 SSH 主机和可回滚测试数据：至少包含密码与私钥认证账号各一套；准备不少于 300 项的目录、可读写目录和至少 32 MiB 的测试文件，并准备可安全变更/恢复 Host Key 的一次性主机。不要在截图、日志或测试文件中使用真实生产密钥。
5. 本期 Local 模式不需要 Relay URL、Web cookie、账号或云服务；不要为了测试 Android 客户端启动 Web server 或配置云端地址。

## 5. 必须逐项执行的 Android 验收

结果状态只允许使用 `待执行`、`通过`、`失败`、`阻塞`；空白单元格不算结果。每个“通过”都要附版本、操作结果和截图/日志路径；“阻塞”必须写明阻塞原因、责任人和下一步。

| 编号 | 验收任务 | 预期结果 | 结果/证据 |
| --- | --- | --- | --- |
| A-01 | 首次打开、创建 Host、保存凭据 | 不需要 Relay URL 或 cookie；Host 重启后仍存在 | 待执行 |
| A-02 | 首次 Host Key 确认 | 首次连接明确展示指纹；确认后可连接，拒绝则不建立 Shell | 通过（真实主机密码路径）：两台 Android 16 真机在 `106.14.61.92:22` 展示 `ssh-ed25519` 指纹 `SHA256:DW4b509womrL6B4XC9tjbWFZsVNzPy6I1lBcFWiz5kI`；点击“信任并连接”后均成功建立 Shell。旧模拟器 fixture 结果仅保留为历史回归证据。 |
| A-03 | Host Key 变化 | 指纹变化硬失败，不得沿用旧信任记录自动放行 | 通过：`25091RP04C` 真机连接局域网 SSH fixture，Host Key 更换后真实 UI 显示 `HOST KEY CHANGED`；拒绝后返回指纹不一致且再次连接仍显示变化，只有显式替换才建立新 Shell。脱敏证据：[Android Host Key/私钥 CDP 证据](./evidence/2026-09-19-android-host-key-private-key-cdp.md)。 |
| A-04 | 密码和私钥认证 | 两种已支持认证方式分别成功/失败可解释；私钥内容不出现在 UI 日志 | 部分证据；已补齐私钥正向链路、错误私钥/口令及 malformed Base64 私钥失败映射：`25091RP04C` 真实 UI/native 事件返回 `SSH_AUTH_FAILED` 并显示“远程服务器认证失败”。关闭 Capacitor verbose bridge 日志后，专用合成哨兵未出现在 logcat/WebView 存储；系统备份和完整密码/私钥失败矩阵仍待执行。证据：[私钥正向](./evidence/2026-09-19-android-host-key-private-key-cdp.md)、[私钥失败](./evidence/2026-09-19-android-private-key-failure-cdp.md)、[日志边界](./evidence/2026-09-19-android-secret-log-boundary.md)。 |
| A-05 | Console 输入、输出、复制粘贴 | 中文/长输入不乱序；复制可用；粘贴有明确确认；底部最后一行完整可见 | 待执行；两台真机连续 3 轮关闭/重开后输入 `whoami`，6/6 返回 `t2`；本轮分别输入 `echo REAL_SERVER_2407`/`echo REAL_SERVER_25091` 得到远端回显，`2407FRK8EC` 重装后又输入 `echo REAL_SERVER_2407_REINSTALLED` 得到真实回显。复制、粘贴确认、中文/长输入和底部布局仍待完整走查。 |
| A-06 | 断网后恢复 | 网络切换/短暂断开显示真实 `reconnecting` 或 `interrupted`；恢复后按交互约定重连，不伪造 connected | 待执行 |
| A-07 | Android 返回键 | 先关闭最上层对话框/工作区/Console；根页面再交回系统退出 | 待执行；`25091RP04C` 从 Console 发送系统返回键后回到 Server 列表，完整弹层/根页面退出顺序仍待走查。 |
| A-08 | 软键盘、旋转和安全区 | 输入框不被键盘遮挡；横竖屏无横向溢出；旋转后工作区状态可恢复 | 待执行 |
| A-09 | SFTP 全屏浏览 | 文件列表可完整浏览；单层纵向滚动；快速过滤按 name 实时模糊匹配；大目录可继续翻页 | 待执行；`25091RP04C` 已在真实主机 UI 浏览 `/`（36 项）和 `/tmp`，输入过滤 `relay-native` 后当前页收敛为 1 项；又在真实主机创建 300 个一次性 1-byte 测试条目，Android UI 分页读取为 `128 + 128 + 44`，随后已从真实主机删除并确认测试目录不存在。完整滚动、触控安全区和旋转仍待走查。 |
| A-10 | SFTP 读写任务 | 上传、下载、取消、重试、部分失败均有明确结果；临时文件失败不会提交半文件 | 待执行；已有增量证据：`2407FRK8EC` 在真实主机完成 32 MiB 原生 URI 上传，远端大小/SHA-256 与源一致；约 35% 取消后既有完整目标保持不变且无 staging，暂停/继续从约 11 MiB 断点完成。`25091RP04C` 又将 `/tmp/relay-native-32m.bin` 下载到 `Download/relay-native-32m.bin`，大小 `33,554,432` bytes、SHA-256 与远端一致，Transfer Center `已完成 · 100%`；小文件系统选择器上传/下载也已完成，远端 `/` 无写权限任务 0% 后取消。完整重试、部分失败和全矩阵仍待执行。 |
| A-11 | SFTP URI 和分享 | 使用系统文件选择/保存/分享；任务结束释放 URI 权限；拒绝权限有可理解提示 | 待执行；真实系统文件选择与 DocumentsUI 保存已走通；传输完成后 Activity 内仍可观察到临时 URI grant，`force-stop` 后重启 Relay 才清空 `readUriPermissions/writeUriPermissions`。任务结束立即释放、拒绝权限提示和分享仍待执行。 |
| A-12 | Vault 锁定和重开 | 锁定后秘密不可读取；正确解锁恢复；错误密码/损坏 bundle 不覆盖旧数据 | 待执行 |
| A-13 | App 重启、锁屏、进程回收 | 本地数据仍在；旧 SSH descriptor 不被伪装复用；恢复后显示真实 `needs-reopen`、`interrupted` 或可重连状态 | 待执行；`25091RP04C` force-stop/重启后 Host 与 Vault 数据仍在，旧 Console 显示“需要重新连接”，重新打开后建立新 Shell；锁屏、旋转和完整进程回收证据仍待执行。 |
| A-14 | 主题和界面偏好 | 用户选定主题、字号、grid/list 等偏好重启后保持；未选择时使用默认主题 | 待执行；新增部分证据：两台 Android 16 真机均在真实 APK 上选中 `Everforest Dark`、字号 `16px`，随后 `force-stop`、重启并解锁；两台均再次显示 Everforest、字号 16，`relay.ui.preferences.v1` 保持 `theme=everforest-dark,fontSize=16`。本轮未完成 grid/list 和完整视觉走查，故不标记整体通过。证据：[Android 偏好重启 CDP 证据](./evidence/2026-09-19-android-preferences-restart-cdp.md) |
| A-15 | 低内存行为 | 大目录/大文件操作不明显失控；取消/退出后资源释放；无持续增长的输出/文件缓冲 | 待执行；`25091RP04C` 大目录分页期间采样 PSS `270,324 KB`，返回 Server 后 30 秒采样降至 `251,874 KB`，未观察到 OOM/ANR；当前还缺少按任务书要求的 2 分钟基线、同时进行 32 MiB 传输的每 5 秒采样和完整 `dumpsys meminfo` 摘要，因此不回填为通过。 |
| A-16 | 秘密和网络边界 | 普通 logcat、WebView 持久化和系统备份中不出现密码/私钥/Vault 明文；客户端不要求本地 HTTP 监听 | 部分证据；`25091RP04C` 使用合成哨兵复核时，关闭 Capacitor verbose bridge 日志后 logcat、`localStorage`、`sessionStorage`、IndexedDB 均无匹配；app manifest `allowBackup=0`，且未发现 Relay/5173/3000/4173 监听。系统备份导出/恢复、长时间日志审计仍待执行。证据：[Android 私密字段日志边界](./evidence/2026-09-19-android-secret-log-boundary.md)。 |
| A-17 | Vault bundle v1 跨端固定向量 | Web/Windows 导出 → Android 预览/应用 → Android 导出 → Web/Windows 导入；字段、计数、错误密码/篡改和原数据不变性均符合固定向量 | 待执行 |

## 6. 客观操作与判定标准

以下操作使用测试数据，不使用生产密码、私钥或 Host Key。任何“通过”必须同时满足操作结果和证据要求。

### A-06 网络切换

1. 清空日志：`adb logcat -c`；打开一个持续输出的测试 Shell，例如每秒输出一次序号，持续至少 30 秒。
2. 在 Shell 活跃时关闭 Wi-Fi 或开启飞行模式至少 10 秒，再恢复网络；从断网开始观察 30 秒。
3. 通过截图记录状态变化，并执行 `adb logcat -d -v threadtime` 保存脱敏日志。

判定：网络丢失后 5 秒内不能继续显示虚假的 `connected`；根据 profile 的 reconnect 设置，应显示 `reconnecting`/`interrupted`，或在旧 descriptor 不可复用时显示 `needs-reopen`。网络恢复后 30 秒内必须出现真实重连成功或明确的重新打开动作；不得出现两个并行 Shell、重复输入或无状态输出。若设备无法控制网络，结果为“阻塞”，不能按通过处理。

### A-10 SFTP 取消、部分失败和临时文件

1. 测试主机准备 300 个目录项和一个 32 MiB 文件；执行一次完整浏览、下载和上传。
2. 第二次下载/上传在约 25% 进度时点击取消；第三次将目标目录改为无写权限，验证失败；随后恢复权限并重试成功。
3. 检查远端最终文件：取消或失败时不能以目标文件名留下部分内容；临时文件应被删除或明确标记为未提交；重试后只存在一份完整文件。

判定：每次操作在 UI 中有成功/取消/失败结果，取消后 5 秒内任务进入终态；部分失败不影响其他任务；失败不会覆盖已有完整目标文件。证据包括任务详情截图、远端 `ls -l`/校验和结果和脱敏 logcat。

### A-13 进程回收与状态恢复

1. 创建并保存 Host，打开 SSH Shell，确认输出正常；返回首页后执行 `adb shell am force-stop cn.ayan.relay`。
2. 使用 `adb shell monkey -p cn.ayan.relay 1` 重启应用，检查 Host/Vault/偏好和任务记录，再手动重新打开该 Host。

判定：本地数据仍存在；旧 SSH descriptor 不被伪装成可用连接；旧 Console 显示 `needs-reopen`、`interrupted` 或真实可重连状态；重新打开创建新 Shell，不能出现重复事件或两个远端 Shell。证据包括操作时间线、前后截图和 `adb logcat -d -v threadtime`。

### A-15 低内存边界

1. 在验收设备空闲 2 分钟后记录基线：`adb shell dumpsys meminfo cn.ayan.relay`。
2. 重复 A-09 的 300 项目录浏览，并执行 A-10 的 32 MiB 上传/下载；每 5 秒记录一次：`adb shell dumpsys meminfo cn.ayan.relay`。
3. 取消任务、关闭 SFTP、等待 30 秒后再次记录；必要时只执行系统允许的 GC/回收操作，不重启应用来掩盖泄漏。

判定（相对该设备基线）：任务期间 PSS 峰值不超过基线 +128 MiB；任务结束 30 秒后 PSS 不超过基线 +32 MiB；无 OOM、ANR、崩溃、持续增长的输出/文件缓冲。超过阈值或无法采样时为“失败/阻塞”，不能仅凭“操作完成”通过。记录设备内存规格和完整 `dumpsys meminfo` 摘要。

### A-16 日志、备份和网络边界

1. 使用唯一但无敏感含义的测试标记 `RELAY_TEST_SECRET_MARKER` 作为测试密码的一部分，清空日志后执行保存、连接、锁定和重开。
2. 检查日志：`adb logcat -d -v threadtime | rg -F 'RELAY_TEST_SECRET_MARKER'`，结果必须为空；同时检查 WebView 目录：

   ```bash
   adb exec-out run-as cn.ayan.relay find . -maxdepth 4 -type f -print
   adb exec-out run-as cn.ayan.relay sh -c "grep -R -F 'RELAY_TEST_SECRET_MARKER' app_webview 2>/dev/null || true"
   ```

3. 检查备份配置：`adb shell dumpsys package cn.ayan.relay | rg -i 'allowBackup|backupAgent|dataExtractionRules'`，并用 APK manifest 工具复核 `android:allowBackup="false"`。
4. 检查监听端口：取得 PID 后执行 `adb shell ss -lntp`；不得出现由 Relay app 持有的 HTTP/TCP 监听，也不得要求 5173 或 `0.0.0.0` 服务。

判定：测试标记不出现在普通 logcat 或 WebView 持久化目录；备份配置不允许应用数据自动备份；应用无本地 HTTP/TCP listener。`run-as`、`ss` 或备份命令不可用时，必须记录为“阻塞”并用等价的 APK/设备证据补充，不能默认为通过。

### A-17 Vault bundle v1 跨端固定向量

1. 先登记一份不含真实秘密的固定 bundle v1 向量：固定明文 payload、导出密码、KDF 参数、AAD、序列化 JSON、SHA-256 和预期 Host/Identity/Group/Profile 计数。当前 Android 已有的 `AndroidBundleCryptoTest.decryptsTheNodeV1EnvelopeVector` 只覆盖空 Host/Group 的加密 envelope，不能替代完整 payload 向量；完整向量文件/清单在本项执行前由 Relay 开发维护人登记。
2. 在 Web 或 Windows 导出该固定向量，记录 bundle SHA-256；在 Android 执行预览和应用，核对计数、字段、Host Key 信任记录和冲突策略。
3. 在 Android 再导出，分别导入 Web 和 Windows；对随机 nonce 等允许变化的字段做规范化比较，对业务字段逐项比较。
4. 用错误密码、篡改一个 ciphertext 字节和不支持版本重复预览；目标端旧数据、Vault 和偏好必须保持不变。

判定：正向链路 Web↔Windows↔Android 均成功，错误输入均失败且无半应用数据；固定向量文件、密码处理记录、两次方向的计数/字段对比和失败证据齐全。A-17 未通过时，任务 5、10、14 不得勾选；责任人为 Relay 开发维护人，交接验收执行人负责在设备上完成 Android 两端操作。

## 7. 证据回填要求

交接机器完成后，回填本文件的“结果/证据”列，并附以下最小信息：

- 设备型号、Android 版本、ABI、应用版本和 APK SHA-256。
- `adb devices`、安装结果和出现问题时的相关 `logcat` 片段；日志必须脱敏。
- A-01 至 A-17 的待执行/通过/失败/阻塞结果；失败项写明复现步骤、期望、实际结果，阻塞项写明责任人和下一步。
- SSH/SFTP 测试主机类型和功能范围，不记录密码、私钥、真实 Host Key 私密材料。
- 对 UI 问题附竖屏/横屏截图；对生命周期问题附操作时间线。
- 结果提交后，由开发者把证据同步到实施计划和验收矩阵；没有设备证据的项目继续保持 🟡/⏳，不能直接勾选计划任务。

## 8. 当前不应执行的操作

- 不在内存不足的开发机上再次启动 Android 模拟器。
- 不为了“通过验收”把 Android SSH/SFTP 路径改成调用 Web 服务或 Relay 服务。
- 不把 APK 能安装、Kotlin 能编译或 JVM 测试通过，等同于真机验收通过。
- 不把真实密码、私钥、恢复密钥或生产 Host Key 放入 issue、截图、普通日志或测试 bundle。

## 9. 2026-09-19 Windows 复审回填

### 已完成的真实主机 UI smoke

- 运行入口：本机 root Electron，使用 `npm run build:windows` 后启动；不是 portable 安装包。
- 测试主机：`106.14.61.92:22`，账号 `t2`；认证材料未写入仓库、日志或本任务书。
- UI 结果：Host Key 已信任后打开 Shell，输入 `echo WINDOWS_UI_STABLE` 返回远端提示符；关闭 Console 后重新进入 Host，输入 `echo WINDOWS_UI_REOPEN_STABLE` 同样返回远端提示符。两次连接各自只有一个 native session，未出现自动重连循环或 `SSH_CONNECTION_FAILED`。
- 对应代码边界：renderer 使用相对 file URL 资源；preload 内置 `zod`；close/open 通过队列串行；native request ID 每个 Shell 唯一；open 响应完成前 resize 不调用 native session；clean close 使用统一 desktop service instance。
- 自动化证据：native/Windows 定向测试 7 个文件、30 个测试通过；`npm run typecheck`、`npm run lint`、`npm run build:windows` 通过。Web/Server 完整基线和 Android 真机证据仍以本任务书前文记录为准。

### Windows 当前阻塞项

- 历史记录：当时本机缺少 Visual Studio/MSVC，`node-gyp` native rebuild 阻塞，portable 重试又遇到外部 builder 下载 `ETIMEDOUT`。该阻塞已通过安装 Build Tools、重建 native module，并把打包脚本固定到本地 Electron 分发目录解除；最终制品和证据见第 11 节。
- 签名、升级迁移、崩溃恢复和打包后完整 SSH/SFTP/Vault/UI 任务链仍未完成，不能因为本次 installer/portable 生成成功而提前勾选 Windows 发布门禁。

### 下一步验收顺序

1. 在具备 Visual Studio/MSVC 的 Windows 机器上完成 native rebuild、package、安装/升级/退出重开和 ABI 证据。
2. 在同一台 Windows 机器上补 SFTP UI、Vault lock/reopen、文件/剪贴板能力和低内存边界。
3. Android 继续按 A-01～A-17 回填；当前两台真机的真实 SSH/SFTP smoke 不替代剩余 UI、Host Key 变更、私钥、生命周期、网络切换和低内存验收。

## 10. 2026-09-19 Android/Web/Server 续验记录

- 真实测试主机再次明确为用户提供的 `106.14.61.92:22`、账号 `t2`；本地 in-process SSH fixture 没有用于本轮真机结论。两台真机从“需要重新打开”的 Console 状态重新打开 Host 后，分别输入 `echo REAL_SERVER_2407` 和 `echo REAL_SERVER_25091`，均得到远端回显和 `t2` 提示符；这证明命令实际可输入，不以绿色状态点单独判定通过。
- `25091RP04C` 已在真实 SFTP UI 浏览远端 `/`（36 项）并跳转 `/tmp`（25 项）。初次通过非用户手势的 HTML 文件选择器自动化没有形成传输任务，不能作为证据；随后真实 MIUI 文件选择器上传和 DocumentsUI 下载均完成 100%，但 A-10/A-11 的大文件取消、重试、部分失败、任务结束 URI 释放和分享仍不得回填为通过。
- Android 验证使用 JDK 21、已缓存 Gradle 9.3.1、单 worker、离线模式；`:app:testDebugUnitTest :app:assembleDebug` 成功，`:app:connectedDebugAndroidTest` 在 `2407FRK8EC` 完成 2/2。connected test 结束后 runner 清理了目标 APK；`2407FRK8EC` 随后曾返回 `INSTALL_FAILED_USER_RESTRICTED`，恢复设备安装权限后 `adb install -r --no-streaming` 返回 `Success`，并完成真实服务器首次指纹确认、登录和命令回显。当前两台真机均安装 APK。
- `25091RP04C` 部分 A-16 检查结果：普通 logcat 无 `relay-device-test-2026` 标记，`run-as` app-private 数据无该标记，`ss -lntp` 未发现 Relay app 或 5173/3000/4173 监听；`aapt dump xmltree` 显示 APK `android:allowBackup` 为 `0`。因未按 A-16 要求使用专用无敏感标记密码完成全流程，这些记录只算部分证据。
- Web/Server 标准全量回归复跑通过：161 个测试文件通过、1 个跳过；727 个测试通过、2 个跳过；E2E 4/4。此前一次全量运行的 `sync-routes` 5 秒超时经针对文件 13/13 通过后复跑通过，未修改测试超时或把 `--isolate=false` 结果当作验收依据。
- Android SFTP 系统交互续验：`25091RP04C` 的真实 MIUI 文件选择器上传到用户服务器 `/tmp` 和 DocumentsUI 下载均显示 100%，本机保存结果为 33,817 bytes；远端根目录无写权限路径的 0% 任务已取消。该结果不替代 A-10 的大文件取消/重试/部分失败矩阵。
- URI 观察：传输完成后 Activity 内仍存在本轮 URI grant；`force-stop` 后重新启动 Relay 时 grants 已清空。由于尚未证明每个任务结束立即释放、拒绝权限和分享路径，A-11 继续保持待执行。
- 手机重装后续验：`2407FRK8EC` 启动已安装 APK，使用用户提供的 `106.14.61.92:22`、账号 `t2` 建立真实 SSH Shell；确认指纹 `SHA256:DW4b509womrL6B4XC9tjbWFZsVNzPy6I1lBcFWiz5kI` 后，Console 执行 `echo REAL_SERVER_2407_REINSTALLED` 返回同名远端回显和 `t2` 提示符。该结果只更新安装和真实输入证据，不改变其余待执行门禁。

## 11. 2026-09-19 最终实现与制品复审（提交 `bde17c4`）

### Android 原生 URI 上传

- `ACTION_OPEN_DOCUMENT` 选择结果由 native store 持有 opaque handle；WebView 仅接收 `sourceId/name/size`，原生以 32 KiB 有界缓冲读取 URI，通过单条 SFTP 连接写入 `${target}.relay-part-${transferId}`，完成后 rename 到最终路径。
- `2407FRK8EC` 对用户提供的 `106.14.61.92:22`、账号 `t2` 完成 32 MiB 上传：远端 `33,554,432` bytes，SHA-256 `83ee47245398adee79bd9c0a8bc57b821e92aba10f5f9ade8a5d1fae4d8c4302`，与设备源文件一致。
- 取消测试在约 35% 进入 `已取消`，既有完整目标保持原大小和 SHA-256，staging 文件不存在；暂停测试在约 34% 进入 `已暂停，可继续`，点击继续重新选择同一源后从约 11 MiB 断点完成。A-10 仍不能整体标成通过，A-11 的 Activity 内立即释放、拒绝权限和分享仍待执行。

### Windows 制品与打包效率

- `npm run package:windows` 已在当前工作树成功完成；新增 `--config.electronDist=node_modules/electron/dist` 后不再访问外部 Electron 下载，NSIS/portable 输出目录分离，避免 artifact 覆盖。
- NSIS：`127,632,075` bytes，SHA-256 `979E3D6CECD611AE99F3DE3CA41D3E6A298A5906196B685B61318A5853FDF20F`；portable：`113,552,550` bytes，SHA-256 `82F8D40377037DF2392CFF2B20F7ED0E537C7011D118EEDFC99C01B37C0CAC7D`；两者签名状态均为 `NotSigned`。
- Electron ABI `149` 下 `argon2`、`better-sqlite3`、`cpu-features` 原生加载通过；NSIS 静默安装、启动进程存活 5 秒、静默卸载通过。升级迁移、崩溃恢复、签名和打包后完整任务链仍不是本轮通过项。

### 最终自动化门禁

- `npm run typecheck`、`npm run lint`、`npm run build`、`npm run build:windows`、Android `:app:testDebugUnitTest :app:assembleDebug`、定向 Web/native 31 测试均通过；全量 `npm test -- --no-file-parallelism --maxWorkers=1 --reporter=dot` 为 161 个文件通过、1 个跳过，731 个测试通过、2 个跳过。
- 当前交接结论：代码和技术预览制品已可复现，真实服务器已验证 Android 原生大文件上传的成功/取消/暂停续传边界；A-03～A-09、A-11～A-17、Windows 升级/崩溃/打包后完整任务链、签名及持久制品来源仍保持未完成。

## 12. 2026-09-19 URI 权限复核与 32 MiB 下载续验（提交 `b094ee9`）

- 当前 Debug APK：`8,633,755` bytes，SHA-256 `42F5C183FB0CB4F6DAAAFA0825E8F3C41408B7CEF39A7F92390016AB85A6F19F`；`2407FRK8EC`、`25091RP04C` 均重新安装成功。Android JVM 单测与 `assembleDebug` 在 JDK 21 / Gradle 9.3.1 / offline / 单 worker 下成功。
- `25091RP04C` 在真实主机 `106.14.61.92:22` 上下载 `/tmp/relay-native-32m.bin` 到 `Download/relay-native-32m.bin`，Transfer Center `已完成 · 100%`；最终大小 `33,554,432` bytes，设备端 SHA-256 `83ee47245398adee79bd9c0a8bc57b821e92aba10f5f9ade8a5d1fae4d8c4302`，与远端一致。
- 新增的 Activity/application 双重 revoke best-effort 已随本 APK 验证，但传输完成后 `dumpsys activity permissions` 仍显示当前 `MainActivity` 持有选择 URI 的临时 grant；`force-stop cn.ayan.relay` 后重启才清空。该结果记录为 Android/MIUI 临时授权边界，A-11 仍为 `待执行`，不宣称立即释放通过。

## 13. 2026-09-19 Android 返回、过滤与进程恢复增量

- `25091RP04C` 在真实 SFTP `/tmp` 输入 `relay-native` 后当前页从 26 项收敛到 1 项；从 Console 发送系统返回键后回到 Server 列表。A-07/A-09 的完整弹层、滚动、分页和安全区仍待执行。
- 对同一设备执行 `force-stop cn.ayan.relay` 并重新启动，Vault 解锁后 `Provided Acceptance Host` 仍存在；原 Console 显示“此 Console 需要重新连接”，点击重新打开后建立新的真实 Shell。该结果支持 A-13 的数据保留/descriptor 不复用边界，但锁屏、旋转和完整进程回收仍未完成。

## 14. 2026-09-19 打包版 Windows 与 Android 大目录/内存增量

### Windows 打包后任务链

- 从当前 NSIS 构建的 `dist/releases/nsis/win-unpacked/Relay.exe` 启动打包内容，连接用户提供的真实主机 `106.14.61.92:22`、账号 `t2`；Shell 实际回显 `echo PACKAGED_WINDOWS_UI`，并返回远端 `t2` 提示符。
- 打包 UI 的 SFTP 工作区读取真实 `/` 目录 36 项，跳转 `/tmp` 后过滤 `relay-native` 收敛到 `relay-native-32m.bin` 1 项；不是只验证 root Electron 或绿色状态。
- 锁定 Vault 后重新解锁，`Provided Acceptance Host`、Host Key 信任记录和最近连接记录仍在。随后对已建立 Shell 的打包进程树做一次明确的强制终止并重新启动；解锁后旧 Console 显示“此 Console 需要重新连接”，点击“重新打开”建立新 Shell，输入 `echo PACKAGED_WINDOWS_AFTER_CRASH` 得到真实远端回显。该条通过一个打包版崩溃/恢复场景，但不替代升级迁移、多次崩溃、打包后文件下载保存、签名和持久制品来源验收。

### Android 300 项目录与内存采样

- `25091RP04C` 在用户提供的真实主机上创建一次性目录 `/tmp/relay-memory-suite` 和 300 个 1-byte 条目；Android SFTP UI 真实读取三页，页大小为 `128`、`128`、`44`，随后通过真实 Shell 删除目录并回显清理确认，未留下测试目录。
- 同一轮采样中，大目录页完成前 PSS 为 `270,324 KB`；返回 Server 后每 5 秒采样，约 30 秒后稳定在 `251,874 KB`。未观察到 OOM、ANR 或崩溃；但尚未按 A-15 形成合格的 2 分钟基线，也未在 32 MiB 上传/下载同时采样，因此 A-15 仍为待执行。

## 15. 2026-09-19 固定跨端 bundle 回归与拒绝安装重试

- 新增固定、合成的跨端向量 `tests/fixtures/vault-bundle-v1-full-vector.json`，Android instrumentation 使用同一份资产。向量包含 2 个 Host、2 个 Group、2 个 Identity、1 个 Terminal Profile、包含空格和中文的标签、PEM 私钥、Group 部分连接配置和 Group/Inline 凭据来源；不含真实凭据。bundle SHA-256 为 `eb5ac0fcd78ff260b7ca686caf33bc9d8ac4f14b7542503acf0768ed510fccf0`，解密 payload SHA-256 为 `aaaf965d4077c724126daab6bb1603b1619ce3ddf981d1bcad2443cc67ae202f`。
- Web/Server 固定向量测试 `tests/unit/server/vault-bundle.test.ts`：6/6 通过，覆盖 preview/apply 计数、标签、PEM 私钥、继承的 Group Identity、部分 connection profile、jump host 和 terminal profile。Android instrumentation `AndroidBundlePayloadInstrumentedTest`：`2407FRK8EC` 与 `25091RP04C` 各 5/5 通过，覆盖加密解包和完整 payload 解析；当前 `app-debug.apk` 为 `8,633,755` bytes，SHA-256 `EC1366A3943ED4879E639D1F3D8AA75BE57F3E983E3F66AC82F00CB325E57A18`。
- 本轮修正四个跨端边界：标签不再错误复用 native safe-id 校验；私钥 PEM 允许 CR/LF；Group 的连接配置按可选 patch 校验；`credentialSource` 统一支持 canonical string，并保留旧 object 形状兼容，同时校验 identity 引用一致性。Android 本地创建/更新私钥也复用多行文本校验。
- `25091RP04C` 的普通 app APK 安装首次返回 `INSTALL_FAILED_USER_RESTRICTED`；随后使用 `adb push` 后执行 `pm install -r --user 0` 返回 `Success`，测试 APK 也安装成功，固定向量 instrumentation 最终 5/5 通过。该设备当前安装阻塞已解除；安装回退命令不包含任何凭据。
- 当前结论仍为 A-17 `待执行/部分证据`：Node → Android 的固定向量解密/解析和 Android 两台真机验证已完成，但 Android → Web/Windows 的真实导出回传、完整 UI 冲突处理和 Windows 端实测仍未完成，不能把 A-17 或相关平台发布门禁标为通过。

## 16. 2026-09-19 URI 授权模式修复与在线真机复验

- 实现更新：`AndroidUploadSourceStore` 保存实际 URI mode flags 与 persistable 状态；`RelayNativePlugin` 传递选择结果的读写 flags；Android 上传结束、失败、取消以及文件保存 writer 的 close/cancel 都按实际授权模式执行 persistable release 与 best-effort revoke。新增 JVM 测试先红后绿，验证授权 metadata 不丢失。
- 最新 Debug APK：`8,633,755` bytes，SHA-256 `068A16E94F09EA90C97F609DD456BDEE0874F830FC57668C364A8C997DB18C89`。`:app:testDebugUnitTest` 与 `:app:assembleDebug` 均 `BUILD SUCCESSFUL`；在线 `25091RP04C` 的上一轮已安装版本完成 `AndroidBundlePayloadInstrumentedTest` 5/5，本轮重装阶段被系统拒绝，没有把 0 tests 记作通过。
- 真机上传证据：`25091RP04C` 经真实 MIUI 文件选择器选择 `relay-uri-check.json`，向 `106.14.61.92:22` 的 `t2` 主机上传 `/tmp/relay-uri-grant-check.json`；远端 `5,176` bytes，SHA-256 `169800b9708c5bc818d64cf3410f566469b65809bcbd3ef9401e4a12a8b4f783`，与合成源一致。测试 Host、远端临时文件和设备文件均已清理。
- URI 结论：传输后 Activity 内仍显示本轮临时 grant；`force-stop cn.ayan.relay` 后再检查已无该 URI grant，说明没有留下持久化 grant，但尚不能宣称 Activity-owned 临时 grant 在任务终态即时消失。A-11 仍待执行；拒绝权限和分享也未覆盖。
- 设备边界：本轮 `2407FRK8EC` 不在线，`adb connect 192.168.1.2:40019` 超时，重试安装返回 `device not found`；因此本节所有新增在线真机证据仅适用于 `25091RP04C`。
- 本轮再次触发 `25091RP04C` 安装时，Gradle 与设备侧 ADB fallback 都返回 `INSTALL_FAILED_USER_RESTRICTED`；connected instrumentation 因安装失败为 0 tests。已确认设备 `USB安装` 与 `USB调试（安全设置）` 为开启，但仍需在设备侧解除 MIUI 安装策略后才能重新安装。
- 后续复核显示 `25091RP04C` 仍在线；`2407FRK8EC` 的 `adb connect 192.168.1.2:40019` 被目标端主动拒绝（Windows socket 10061），`get-state` 为 `device not found`。责任人需在 2407 端重新开启并保持无线调试后再执行安装回退。

## 17. 2026-09-19 Windows 打包版启动与定向回归

- 从 `dist/releases/nsis/win-unpacked/Relay.exe` 启动打包版，真实渲染页标题为 `Relay SSH Workspace`，桌面 preload IPC 可用；调用 `vault.status` 返回 `locked`。本次只读取锁定页和状态，没有解锁或写入现有桌面 Vault。
- Windows `local-runtime`、main/preload 与 Server 固定 bundle 定向测试共 4 个文件、20 个测试通过；这补充了 Windows 启动/IPC/本地 runtime 的自动化证据，但不替代打包后完整 SSH/SFTP/Vault 任务链、升级迁移、签名和持久制品来源验收。

## 18. 2026-09-19 Windows 固定 bundle 回归与 Android 安装重试

- Windows IPC 已用固定 `vault-bundle-v1-full-vector.json` 完成 preview/apply 回归：2 Host、2 Group、2 Identity、1 个导入 terminal profile，以及标签、PEM 私钥、Group Identity 继承、jump host 和错误/篡改无写入回滚均由测试断言覆盖。测试发现并修复共享 `toHostMetadata` 丢失 `terminalProfileId` 的字段映射问题。
- `tests/unit/windows/local-runtime.test.ts` 6/6 通过；全量 Vitest 为 161 个文件通过、1 个跳过，734 个测试通过、2 个跳过。该结果不替代打包版 UI 的完整 SSH/SFTP/Vault 验收。
- 本轮对 `25091RP04C`（`192.168.1.3:46545`）再次触发最新 Debug APK 安装；APK 推送完成，但安装返回 `INSTALL_FAILED_USER_RESTRICTED: Install canceled by user`，因此没有新增安装成功或 connected instrumentation 证据。
- `2407FRK8EC`（`192.168.1.2:40019`）仍返回 Windows socket 10061、`device not found`，未进入安装阶段。责任人仍需在设备侧解除 25091 的 MIUI 安装授权，并在 2407 端恢复无线调试后再执行真机回归。

## 19. 2026-09-19 Web 回归与 Windows 打包版 Vault 重启验证

- Web Playwright 当前复跑 4/4 通过，覆盖 Vault/Host Key/终端多标签和锁定、SFTP 上传下载/取消、批量任务、断线恢复、窄屏布局及主题持久化。
- 最新 Windows 制品：NSIS `127,632,261` bytes、SHA-256 `D79B07850B80F1E714C07EDB543EB0CA1CCBDC4E071BC74E2743904F93F95858`；portable `113,552,538` bytes、SHA-256 `26C498BB91315FC39DF3DC4AA527FD9A06ED80700D177DA6F1FFAA49C931B99A`。两者 `Get-AuthenticodeSignature` 均为 `NotSigned`，签名和可追溯持久制品来源仍未完成。
- 独立 `userData` 打包版通过真实 renderer/preload IPC 完成首次 Vault setup、Host/workspace 保存、锁定、错误密码拒绝、正确解锁；停止并重新启动进程后，Vault 初始为 locked，解锁后 Host/workspace 恢复。未读取或修改现有桌面 Vault。
- Windows `local-runtime` 重启回归 7/7 通过；当前全量 Vitest 为 161 个文件通过、1 个跳过，735 个测试通过、2 个跳过；typecheck/lint 通过。
- 本节只推进 Web/Windows 证据，不改变 Android 安装阻塞结论：`25091RP04C` 仍需设备侧解除 `INSTALL_FAILED_USER_RESTRICTED`，`2407FRK8EC` 仍需恢复无线调试。

## 20. 2026-09-19 Windows 打包版真实主机 SSH/SFTP 验证

- 最新 NSIS 解压版使用独立 `userData`，经真实 renderer/preload IPC 连接用户提供的 `106.14.61.92:22`、账号 `t2` 主机；Host Key 指纹为 `SHA256:DW4b509womrL6B4XC9tjbWFZsVNzPy6I1lBcFWiz5k`，显式信任后 Shell 状态为 `connected`。
- 通过 native IPC 写入固定合成命令标记并收到真实远端回显；同一 Host 的 `files.listPage` 读取 `/` 返回 16 项并带 cursor；随后关闭 Shell 并锁定 Vault，状态为 `locked`。密码只通过临时进程环境变量传入，未写入脚本、仓库或日志。
- 该证据补上 Windows 打包版真实密码认证、首次 Host Key 信任、终端输入和 SFTP 分页；A-03 的指纹变化拒绝、A-04 私钥路径、完整 A-10 传输矩阵、升级迁移、签名和持久制品来源仍待执行。

## 21. 2026-09-19 双真机重新安装与原生测试复核

- 当前 Debug APK 为 `8,633,755` bytes，SHA-256 `068A16E94F09EA90C97F609DD456BDEE0874F830FC57668C364A8C997DB18C89`。
- `2407FRK8EC`（Android 16/API 36）使用 mDNS ADB serial `adb-8DWSM7Y9IBCMPJSC-oak1zL._adb-tls-connect._tcp`，重新安装返回 `Success`；`:app:connectedDebugAndroidTest` 完成 `7/7`。
- `25091RP04C`（Android 16/API 36）使用 `192.168.1.3:46545`，重新安装返回 `Success`；`:app:connectedDebugAndroidTest` 完成 `7/7`。
- 之前记录的 `INSTALL_FAILED_USER_RESTRICTED` 作为历史阻塞保留，但不再是本轮两台设备的状态。A-03 已由 `25091RP04C` 真机 Host Key 变化实测回填为通过；A-04、A-06～A-08、A-10～A-17 仍需按本任务书补齐人工操作和证据。

## 22. 2026-09-19 Windows 认证边界回归

- Windows 本地 runtime 已补齐私钥传递和 Host Key 变化拒绝回归：合成私钥/口令从 Vault 读取后到达 SSH adapter；已保存指纹变化并拒绝后返回 `HOST_KEY_MISMATCH`，不会降级为 `INTERNAL_ERROR`，也不会自动替换旧信任。
- `tests/unit/windows/local-runtime.test.ts` 与 `tests/unit/server/host-key-policy.test.ts` 定向 `15/15` 通过；全量测试、类型检查、lint、Web/Server/Windows 构建均通过。
- 修复版 NSIS 为 `127,632,446` bytes、SHA-256 `79B7E5306CCF919C57D892ACA2345B91ACB4CB2BBAEE21873F0CA07C395D08F2`；portable 为 `113,553,011` bytes、SHA-256 `2742E04BC86F3891755F3FCFB018349FD27DD6BEA6EE5BCD1B8039EB8720ED4E`；签名状态均为 `NotSigned`。这部分仍属于 Windows 自动化/打包证据，不替代真实 Windows UI 认证和升级验收。
## 23. 2026-09-19 Android A-03/A-04 真机 UI 增量

- `25091RP04C` 通过真实 WebView UI 连接局域网 SSH fixture；更换 Host Key 后显示 `HOST KEY CHANGED`，拒绝后保留旧信任并再次拒绝，显式替换后才建立新 Shell。A-03 回填为通过。
- 同一真机使用临时 Ed25519 私钥连接用户提供的 `106.14.61.92:22`/`t2`，收到 `ANDROID_PRIVATE_KEY_ACCEPTED` 远端回显；随后补测错误私钥/口令，UI/native 返回 `SSH_AUTH_FAILED` 和“远程服务器认证失败”。临时公钥、私钥和 Android 临时 Server 均已清理；A-04 的 logcat、WebView 持久化和系统备份秘密扫描仍待执行。
- 脱敏证据：[Android Host Key/私钥 CDP 证据](./evidence/2026-09-19-android-host-key-private-key-cdp.md)。
## 24. 2026-09-19 Android 私钥失败路径回归

- JSch `invalid privatekey`/passphrase 类解析失败此前被错误映射为可重试的 `SSH_CONNECTION_FAILED`，导致 UI 最终只显示“此 Console 需要重新连接”。新增 Android 单元回归并将其映射为 `SSH_AUTH_FAILED`。
- `25091RP04C` 新 APK 真实 native 事件为 `connecting` → `SSH_AUTH_FAILED` → `failed` → `terminal.close`；真实 UI 显示“远程服务器认证失败”和“编辑 Server 凭据”，不再进入重连循环。
- 当前 APK `8,633,755` bytes，SHA-256 `5017F5ADBCCFA724D2601CD61AA9AED0893D229AA6B42966BB233FFC8A3FFDAE`；两台真机 `:app:connectedDebugAndroidTest` 各 `7/7` 通过，随后均重新安装该 APK 返回 `Success`。
- 脱敏证据：[Android 私钥失败路径 CDP 证据](./evidence/2026-09-19-android-private-key-failure-cdp.md)。A-04 仍不整体标记通过，待补秘密扫描和完整密码/私钥失败矩阵。

## 25. 2026-09-19 双真机重试与 Android 日志边界复核

- 最新 Debug APK 为 `8,633,755` bytes，SHA-256 `B66C9A27786A9996CE9658CBEC3A6AA8A8ACEEC7C0032C0D9FACD9ECD74AD058`；构建使用 JDK 21、缓存 Gradle 9.3.1、offline、单 worker。新增 Android 单元回归覆盖 `fromBase64: invalid base64 data`，将 malformed 私钥继续映射为 `SSH_AUTH_FAILED`。
- `:app:connectedDebugAndroidTest` 在 `25091RP04C` 和 `2407FRK8EC` 均完成 `7/7`，Gradle 返回 `BUILD SUCCESSFUL`。runner 结束后首次再次安装曾返回 `INSTALL_FAILED_USER_RESTRICTED`；随后重新触发安装，`adb`/`pm` 安装均成功，两台设备的 `cn.ayan.relay` package path 均已复核存在。
- Android 配置新增 `android.loggingBehavior: 'none'`，用于关闭 Capacitor verbose bridge 的插件 payload 日志。使用一次性合成哨兵进行真实设备复核时，logcat、WebView `localStorage`/`sessionStorage`/IndexedDB 未发现哨兵；临时 Host 已删除。该证据不包含任何真实凭据或哨兵值。
- APK manifest 的 `android:allowBackup` 仍为 `false`；系统备份导出/恢复、长时间进程日志审计和完整 A-16 失败矩阵仍未完成，因此 A-04/A-16 不回填为整体通过。
- 脱敏证据：[Android 私密字段日志边界](./evidence/2026-09-19-android-secret-log-boundary.md)。

## 26. 2026-09-19 Android 内置主题同步与双真机重启复验

- 根因：Web 偏好会把主题保存为 `builtin:<theme>` 的 terminal profile；Android 原生此前只返回/接受 `builtin:termius`，解锁时读取默认 profile 会把用户刚选的主题覆盖回 Termius。该修复新增与 shared `terminal-appearance.ts` 对齐的五套 Android 内置 profile，并让 list/getDefault/setDefault 使用同一组定义。
- TDD/构建：新增 `AndroidBuiltinTerminalProfilesTest`；先以未实现的 helper 运行得到 unresolved reference 红灯，再实现后 `:app:testDebugUnitTest --tests cn.ayan.relay.AndroidBuiltinTerminalProfilesTest` 通过 2/2；随后 `:app:testDebugUnitTest :app:assembleDebug --offline --no-daemon --max-workers=1 --console=plain` 返回 `BUILD SUCCESSFUL`。
- 当前 APK：`apps/android/android/app/build/outputs/apk/debug/app-debug.apk`，大小 `8,633,755` bytes，SHA-256 `561351D1B83050CD3F60D358675366E4379BF7AC146D290440C601300314AA9B`。`adb install -r -g --no-streaming` 在 `2407FRK8EC`（mDNS serial `adb-8DWSM7Y9IBCMPJSC-oak1zL._adb-tls-connect._tcp`）和 `25091RP04C`（`192.168.1.3:46545`）均返回 `Success`。
- 两台设备均完成真实 UI 验证：使用 `dsjb@123` 解锁 Vault，在偏好设置选择 `Everforest Dark`、字号 `16px`；强制停止 `cn.ayan.relay`，重新启动并解锁后，两台设备的 DOM 主题仍为 `everforest-dark`，字号 select 为 `16`，`relay.ui.preferences.v1` 保持 `fontSize=16` 和 `theme=everforest-dark`。`25091RP04C` 的 `Provided Acceptance Host` 仍保留，旧 Console 明确显示需重新打开；本轮未覆盖 grid/list、旋转、软键盘和完整视觉走查。
- 结论：修复了 A-14 的 Android 主题复位缺陷，A-14 仍按任务书保持“待执行（部分证据）”；不扩大为 Android 平台整体通过。脱敏操作记录：[Android 偏好重启 CDP 证据](./evidence/2026-09-19-android-preferences-restart-cdp.md)。

## 27. 2026-09-19 Android Console 自动恢复修复与复测

- 发现并修复恢复流程缺陷：`needs-reopen` 原先关闭了 `autoConnect`，并把 native 进程重启后的旧 Shell 失效暴露成“此 Console 需要重新连接”。现在恢复标签自动创建新 Shell；native 状态收到 `needs-reopen` 时自动清理旧 socket、放弃旧 service instance 并立即重连。只有自动重试耗尽才进入普通失败操作入口。
- 回归证据：TerminalPanel/TerminalSession 定向测试 `33/33`；`npm run typecheck`、`npm run lint`、`npm run build:web`、Android `:app:testDebugUnitTest :app:assembleDebug` 通过。APK `8,633,649` bytes，SHA-256 `D4A1C69F5549109A91BE9428FFCBBDC2580EB2C18D321864A6869034416DAB90`。
- 安装交接：`25091RP04C`（`192.168.1.3:46545`）与 `2407FRK8EC`（mDNS serial `adb-8DWSM7Y9IBCMPJSC-oak1zL._adb-tls-connect._tcp`）均执行 `adb install -r -g --no-streaming` 并返回 `Success`。安装命令仍为：`adb -s <serial> install -r -g --no-streaming app-debug.apk`。
- `25091RP04C` 实机复测：force-stop/重启、Vault 解锁后，`Provided Acceptance Host`/Console 自动恢复，未出现 `.terminal-recovery` 或“此 Console 需要重新连接”，状态点绿色；真实测试主机执行 `echo FINAL_RESTART_INPUT_OK_25091` 并回显成功。
- `2407FRK8EC` 本轮设备处于系统锁屏（`isKeyguardShowing=true`），未能进入 Relay UI；因此只记录安装成功，不记录该设备的自动恢复通过。设备解锁后需重新执行 A-05 重启恢复及命令回显，并继续完成复制/粘贴、网络切换、生命周期和其余 A-01～A-17 清单。

## 2026-09-20 最新批次：移动锁入口与启动恢复竞态

- Web/Server 全量：Vitest `162/163` 文件（`162` 通过、`1` 跳过），`740/742` 测试通过；Playwright Chromium `5/5`；typecheck、lint、build、build:windows 均通过。
- 产品修复：启动/解锁的 workspace hydration 完成前不展示可操作 Server 页面，避免异步恢复把用户操作入口卸载；窄屏终端顶部新增紧凑可见的 Vault 锁定入口。Web 320px/390px 终端回归已通过。
- Android 构建产物：`apps/android/android/app/build/outputs/apk/debug/app-debug.apk`，`8,305,939` bytes，SHA-256 `72E538719BF2C926CB3CC0602BE384B641FCD34C92B886C9D3B6ECB21973B683`。`npm run build:android:debug` 已在 JDK 21、SDK、Gradle wrapper 8.14.3、offline、单 worker 下成功；`apps/android/run-gradle.mjs` 已消除 Windows 下 `./gradlew` 启动失败。
- Android 部署约束：遵循“不卸载、不反复安装”的要求，本批次没有安装新 APK。只读状态为：2407 mDNS 设备在线但仍运行旧 APK；25091 `192.168.1.3:46545` 当前 offline，且 `pm path cn.ayan.relay` 无结果。待 25091 恢复 ADB/解除安装限制后，再用该 APK 和测试 APK 做一次统一部署与 A-01～A-17 全量回归。
- Windows 最新制品：NSIS `127,554,507` bytes / SHA-256 `CF6375567AB6FB471D19C6E97ABC74E9BA1EE821595F1E88A3D65664653110A3`；Portable `113,554,529` bytes / SHA-256 `DF17F53536DBB336039406DB766C15F2DE2D6F17E7DFC350BEE150D358766F90`；两者 `NotSigned`。签名、升级迁移、持久制品来源仍为发布阻塞。
- 本批次未改变验收边界：Android A-04 完整失败矩阵/A-06 网络切换/A-08 软键盘旋转安全区/A-11 URI 释放/A-15 低内存/A-17 双向 bundle，以及 Windows 完整发布任务链仍需后续统一验收。

## 28. 2026-09-19 当前 Windows 制品与 Android 2407 续验

- 当前源码 `9150f85`：`npm run build`、`npm run build:windows`、`npm run package:windows` 均成功；全量 Vitest `161` 个文件通过、`1` 个跳过，`738` 个测试通过、`2` 个跳过。
- NSIS：`dist/releases/nsis/Relay-0.1.0-x64.exe`，`127,632,215` bytes，SHA-256 `92F08B8F99B573EE84306243C97A84A544B88DB0C2223601A49AFE1CECEBA3B3`；portable：`dist/releases/portable/Relay-0.1.0-x64.exe`，`113,554,151` bytes，SHA-256 `6AD0CF9035C8D04C09C67B233B522B6BEACE8EFA1E2BE81ECA986FCC7CE32158`。两者 `MZ` PE 校验通过，`Get-AuthenticodeSignature=NotSigned`。
- 使用独立临时 `userData` 的 Playwright Electron runner，真实验证当前 NSIS 解压版：首次 Vault 创建、Host 保存、Host Key 信任、真实 SSH 命令 `PACKAGED_CURRENT_BUILD_OK`；关闭再启动后恢复 Console，`.terminal-recovery` 数量为 `0`，绿色状态为 `1`，`PACKAGED_RESTART_AUTO_RECONNECT_OK` 远端回显成功。临时数据已清理。
- `2407FRK8EC` 解锁后已安装当前 APK，创建/保存 `Provided Acceptance Host`，完成真实 Host Key trust、SSH 登录和 `INITIAL_INPUT_OK_2407` 回显。force-stop/重启阶段 mDNS ADB 通道掉线，重新发现的 `192.168.1.2:35857` 连接超时；因此 A-05 的第二台设备重启恢复仍需重新稳定无线调试后补测。
- Windows 升级迁移、签名与持久制品来源仍未完成；Android 复制/粘贴、网络切换、软键盘/旋转/安全区、URI 即时释放、长时低内存、双向 bundle 及其余 A-01～A-17 仍按清单逐项回填。

## 2026-09-19 Console 恢复状态隐藏修复

- 复审发现自动恢复虽已创建新 Shell，但恢复初始态和 native `needs-reopen` 事件仍可能把内部状态短暂发布到标签/Quick Switcher。现已将该状态收敛为内部恢复标记：UI 与 app reducer 只接收 `connecting`/`reconnecting`，不再显示“此 Console 需要重新连接”，也不要求用户点击恢复。
- `tests/unit/web/app-state.test.ts`、`tests/unit/web/terminal-session.test.ts`、TerminalPanel/Workspace 定向套件共 `67/67` 通过；`ssh-productivity.spec.ts` `3/3` 通过；`npm run typecheck` 与 `npm run lint` 通过。
- 本项只改变恢复状态的可见性，不改变 Host Key、凭据错误、网络断开或自动重试耗尽时的真实错误入口；这些情况仍按原有安全边界显示明确错误。

## 2026-09-19 当前版本全量验收问题清单

本轮以源码 `10fb70f` 为当前版本，先完成全量自动化和一次打包版验收；在本清单关闭前不再为单个问题重复打包部署。

### 已通过的当前版本门禁

- Web/Server：Vitest `161/162` 个文件通过、`739` 个测试通过、`2` 个跳过；Playwright 全量 `4/4`；`typecheck`、`lint`、`build`、`build:windows` 通过。
- Windows 当前 NSIS/portable 均生成成功：NSIS `127,632,032` bytes / SHA-256 `7E9A2676AE6CE83BD4755ADBFD4AE1AEA20D82870CC59183E0012D4D7658DB18`；portable `113,553,207` bytes / SHA-256 `3405E9984EB764771A784E7500E5A886A4F65915AB54A0B2635EFF2BB915A52A`。两者 PE 为 `MZ`，Authenticode 为 `NotSigned`。当前 NSIS 解压版已一次性完成 Vault、错误密码、真实 SSH 输入、SFTP `/tmp` 列表/过滤和重启自动恢复，`.terminal-recovery=0`。
- Android：Web 资源已同步；在 JDK 21、Android SDK 正确指向后编译/打包成功，当前 APK `8,633,646` bytes / SHA-256 `0DF9842E67D91346C175B0CC104163D62CF626DD12CC40033AC8DB3C78614195`；`25091RP04C` connected instrumentation `7/7`。

### 当前问题与阻塞

| 分组 | 范围 | 当前问题 | 统一处理方式 |
| --- | --- | --- | --- |
| 设备阻塞 | Android 2407 | 本轮 Gradle 记录 `0 tests`，随后测试 APK 安装返回 `INSTALL_FAILED_USER_RESTRICTED`；不是产品测试失败，需在设备端解除安装限制后重跑。 | 先完成设备设置/ADB 稳定性处理，再与 Android 全量回归一起部署一次。 |
| 产品验收 | Android A-01、A-05～A-15 | 当前 APK 尚未对两台设备完成本轮完整清单；复制/粘贴、中文/长输入、断网切换、返回栈、软键盘/旋转/安全区、SFTP 重试/部分失败、URI 即时释放/拒绝/分享、Vault 损坏包、锁屏/进程回收、grid/list 视觉、2 分钟低内存并发采样仍缺证据。 | 先集中修复可修复的 URI、bundle、恢复和 UI 边界；再用同一 APK 做 A-01～A-16 一次性回归。不能用单台设备或状态点替代另一台。 |
| 跨端产品 | Android A-17 | 固定向量 Node→Android 解密/解析已有证据，但 Android→Web/Windows 导出回传、Windows 实机导入、冲突和旧数据不变性未闭环。 | 集中补 Android service/round-trip 自动化和 Web/Windows 规范化比较；最后用设备 UI 做一次正反向验收。 |
| 发布门禁 | Windows | 当前打包版主链路已通过，但签名、升级迁移、持久制品来源和系统文件保存/完整任务链仍未通过。 | 集中处理发布配置/证书/升级脚本；完成后只重新生成一次发布制品并复验。 |
| 工具环境 | Android 构建 | 本机默认环境缺少 `ANDROID_HOME`/`ANDROID_SDK_ROOT` 且默认 Java 为 17；项目要求 SDK 和 JDK 21。 | 使用固定 JDK 21/SDK 入口重跑；必要时补充构建入口说明，不把环境错误归因于业务代码。 |

本清单是“当前版本全量验收”的问题基线；修复阶段按分组合并，修复完成前不更新为通过，也不单项重新打包。

## 2026-09-20 批次统一验收回填（`e1c6246`）

本批次按“集中修复后统一构建、统一部署、一次全量回归”执行；没有针对单个问题反复打包。

### Web / Server

- Vitest：`161` 个文件通过、`1` 个跳过；`739` 个测试通过、`2` 个跳过。
- Playwright Chromium E2E：`4/4` 通过。
- `typecheck`、`lint`、`build`、`build:windows`：通过。

### Windows 打包版

- NSIS：`127,632,018` bytes，SHA-256 `6B362AD8438AE7EF30FA3E64C6219D92D8BF3A740263BFD5C7AF783D44ED926C`。
- Portable：`113,553,206` bytes，SHA-256 `B1D9F17BB3BB9C29E4FF63407171465676A953DCC45A9BBF37CC9A67A0B390ED`。
- 两个 PE 制品的 `Get-AuthenticodeSignature` 均为 `NotSigned`，签名仍是发布门禁。
- 同一批次的 NSIS 解压版完成独立 smoke：Vault 创建、错误 Vault 密码拒绝、真实 Host Key 指纹核验、SSH 命令输入、SFTP 目录读取/过滤、重启后 Console 自动重连和继续输入均通过。

### Android 真机

- APK：`8,717,527` bytes，SHA-256 `15DD7B81D6B1C2859E4869E3ECC0AD70F574FF9A6983136A7159B1F18752A479`。
- 使用 JDK 21、SDK、Gradle 9.3.1、offline、单 worker 完成编译；统一 Gradle 命令已执行 `testDebugUnitTest`、`connectedDebugAndroidTest`、`assembleDebug`。
- 两台设备的 connected runner 均在安装阶段报告 `0 tests`；最终原因是设备侧 `INSTALL_FAILED_USER_RESTRICTED: Install canceled by user`，不是测试断言失败。
- 只对最终 APK 各尝试一次保留数据的 `adb install -r -g --no-streaming`：`2407FRK8EC` 成功，`25091RP04C` 仍被系统拒绝。没有卸载 Android 应用，也没有重复触发 25091 安装。
- 复用 2407 已安装 APK，通过 ADB 转发的 WebView CDP 完成 Vault/Server、Host Key、真实 SSH 命令、SFTP 读取和返回 Console；移动终端视图中的桌面式 `.secure-pill-action` 不可见，锁定/解锁入口尚未形成可验收的移动端证据，应补充移动端可见入口或明确交互路径。

### 当前阻塞与边界

- 25091 的系统安装策略仍阻塞真机 APK/测试 APK 部署；需要设备侧解除安装限制后，再用当前 APK 做一次完整验收。
- A-05～A-17 中的复制粘贴、断网切换、返回键/旋转/安全区、URI 即时释放、低内存基线和 Android→Web/Windows bundle 回传仍未闭环。
- Windows 签名、升级迁移、持久制品来源和完整发布任务链仍未通过。上述项目保持“待执行/阻塞”，不因自动化或局部真机 smoke 变绿。

## 2026-09-20 账户同步 WebSocket owner 隔离修复与批量验证

- 根因：账户同步打开后，Host 的持久化 owner 是认证账号，但终端 WebSocket 的异步 message/status/close/error 回调使用了默认 owner；因此真实 `open` 请求返回 `HOST_NOT_FOUND` 并触发重连循环。抓包和 SQLite owner 对照已确认该因果链。
- 修复：握手阶段从 `SessionStore` 捕获认证会话 owner；终端 gateway 的 SSH 状态和 WebSocket 生命周期在 `runWithOwnerId` 中执行；operation gateway 使用握手会话 owner 订阅事件。新增终端 gateway 账号隔离集成回归。
- 证据：终端/操作 gateway 集成测试 `10/10`；`ACCOUNT_SYNC_E2E=true npm run test:e2e -- --project=chromium --workers=1 tests/e2e/account-sync.spec.ts` 为 `4/4`；全量 Vitest `162/163` 文件、`742/744` 测试；Chromium E2E `5/5`；typecheck、lint、build、build:windows 均通过。
- 本批次未安装、卸载或重复安装 Android；遵循“尽量选择不需要授权的安装方式”的约束。固定 JDK 21/SDK、offline、单 worker 下 `:app:testDebugUnitTest` 为 `36/36`、`:app:assembleDebugAndroidTest` 编译成功；当前 Android 仍只保留已有设备状态，服务端和本地测试均不替代新 APK 真机验收。
- 验收边界不变：A-04 完整失败矩阵、A-06 网络切换、A-08 软键盘/旋转/安全区、A-11 URI 即时释放、A-15 长时低内存、A-17 Android→Web/Windows 双向 bundle，以及 Windows 签名/升级/持久制品来源和完整发布任务链仍未闭环。

## 29. 2026-09-20 Android 本地验证入口与部署约束

- 新增根目录命令 `npm run test:android:local`（`apps/android` 的 `test:local`），固定执行 Web 构建、Capacitor 同步、`:app:testDebugUnitTest` 和 `:app:assembleDebugAndroidTest --offline --no-daemon --max-workers=1`。本次执行 `BUILD SUCCESSFUL`，Gradle `93` 个任务中 `18` 个执行、`75` 个复用缓存；Android JVM 测试报告为 `36/36` 通过。
- 统一部署时使用 `npm run install:android:debug -- <serial> [apk-path]`；该命令采用 `adb push` + `pm install -r --user 0`，保留现有应用数据，避免 `adb install -g` 的权限授予路径，不执行卸载、`pm clear` 或自动重试。
- 该入口明确不执行 `connectedDebugAndroidTest`、ADB、安装、卸载、`pm clear` 或其他设备数据操作；适用于本地快速回归，避免为单个问题重复授权和重装 Android 应用。
- 当前交接仍受设备可达性限制：本机 `adb devices -l` 无设备，用户提供的测试主机没有 `adb`，已知无线 ADB 端点不可达。设备恢复后使用同一批次制品一次部署，再按 A-01～A-17 全量回填；本地测试通过不将真机项目自动标记为通过。

## 30. 2026-09-20 Windows 旧库启动迁移回归

- `tests/unit/windows/local-runtime.test.ts` 新增旧版 SQLite 启动迁移和跨 runtime 分块 bundle 往返场景：旧库缺少现代 Host/Group 字段，`createWindowsLocalRuntime` 启动后自动执行 `migrate`，Vault 解锁后仍能读取旧 Host、分组关系、连接覆盖配置和解析后的 profile；定向套件 `11/11` 通过。
- 该条只关闭 Windows 代码级启动迁移证据；签名安装包的真实升级、回滚、崩溃后数据保留和持久制品来源仍是发布门禁，待 Windows 安装环境补验。

## 31. 2026-09-20 全量回归与设备路径复核

- Web/Server 全量 Vitest：`162` 个测试文件通过、`1` 个跳过；`744` 个测试通过、`2` 个跳过（共 `746` 个测试）。该计数包含 Windows 旧库启动迁移和跨 runtime 分块 bundle 往返回归。
- Android 设备路径复核：本机 `adb devices -l` 为空；用户测试主机的 `t2` 会话没有可调用的 `adb`，USB 设备只有 QEMU Tablet，没有 Android 真机；远端已有 ADB server 仅监听 `127.0.0.1:5037`。当前不能从本机部署两台设备，因此不执行安装、不卸载、不清理数据。
- 交接结论：Web/Server 自动化和 Windows local-runtime 代码级证据继续有效；Android A-01～A-17、Windows 安装包升级/签名/持久制品来源仍需目标环境证据，不因全量 Vitest 通过提前关闭。

## 32. 2026-09-20 Windows 制品来源工作流

- 新增 `.github/workflows/windows-package.yml`，支持 `workflow_dispatch` 和 `v*` 标签；Windows runner 会执行 `npm ci`、typecheck、lint、`npm run package:windows`，生成 NSIS/Portable 和 `release-manifest.json`（大小、SHA-256、Authenticode 状态），并上传 90 天受控制品。
- 当前只完成工作流定义和静态条款检查，尚未产生 GitHub Actions run、Release 附件或签名文件；因此 Windows 持久制品来源、签名和真实升级门禁仍保持未完成。

## 33. 2026-09-20 Web/Server Chromium 端到端复验

- 当前提交重新执行 `npm run test:e2e -- --project=chromium --workers=1`，Playwright `5/5` 通过，耗时 `43.1s`；E2E 配置中的 Web、Server、Cloud 构建服务均完成启动。
- 本次复验未安装、卸载或清理 Android 应用数据，也未改变 Windows 制品；它只更新 Web/Server 自动化证据，不关闭 Android 真机 A-01～A-17 或 Windows 发布门禁。

## 34. 2026-09-20 Windows CI 首次运行与 Electron runtime 修复

- GitHub Actions run `35465104633`（提交 `3289ced`）已真实运行；checkout、Node、`npm ci`、typecheck、lint 均通过，失败步骤为 `Build Windows packages`。
- 根因是干净 `npm ci` 后 Electron 包没有自动生成 `node_modules/electron/dist`，而 `package:windows` 显式使用该路径。新增 `apps/windows/ensure-electron.mjs` 与 `prepare:windows-electron`：缺失时调用 Electron 官方 `install.js`，CI 在打包前显式执行，`package:windows` 也自带该准备步骤。
- 本机在清理依赖后直接执行 `npm run package:windows` 已完成 NSIS/Portable 打包；该结果只证明修复后的本地打包链路，待新 Actions run 成功并上传 manifest 后，才能补齐 Windows 持久制品来源证据。
- 本批次未触发 Android 安装、卸载或清理数据；Android A-01～A-17、Windows 签名/升级/完整发布任务链边界保持不变。

## 35. 2026-09-20 Windows CI 修复后复跑通过

- GitHub Actions run `35466675429`（提交 `28b43e7`）已通过；`npm ci`、typecheck、lint、Electron runtime 准备、NSIS/Portable 打包、`release-manifest.json` 生成和 artifact 上传均成功。
- artifact 名称为 `Relay-Windows-main-28b43e7eb39d1d5b2e71121750faec2c94bd80fc`，压缩包大小 `240,657,050` bytes，保留至 `2026-12-18`；run 页面：`https://github.com/a-yan0901/Relay/actions/runs/35466675429`。
- 该条只关闭 Windows CI 和持久制品来源证据；artifact 的 Authenticode 状态仍为 `NotSigned`，Windows 签名、真实升级/回滚、崩溃恢复和完整安装包任务链仍未通过。Android 本批次仍未安装、卸载或清理数据。

## 2026-09-20 部署与 URI 句柄交接补充

- 当前 Debug APK：`apps/android/android/app/build/outputs/apk/debug/app-debug.apk`，`8,655,609` bytes，SHA-256 `73716BA21E71B0DB6B191831C43A9024B7997EA52F516533E989206518D1F625`。该 APK 已完成本地 Android JVM/AndroidTest APK 编译和 `assembleDebug`，本批次没有下发到设备。
- 设备恢复后只执行一次按批次部署：`npm run install:android:debug -- <serial> <apk-path>`。脚本使用 `adb push` 后 `adb shell pm install -r --user 0`，不卸载、不 `pm clear`、不使用 `-g`，以保留 Vault/Host/Console 数据；安装被系统拒绝时先处理设备授权/安全策略，不循环重装。
- Web/Android bridge 新增 `files.releaseUploadSource`，用于创建传输失败、取消未消费源句柄、锁定和重试失败的 best-effort 清理。A-11 仍要求真机确认任务结束后 URI grant 即时释放、权限拒绝提示和分享链路；本地测试不能替代这些步骤。

## 36. 2026-09-20 当前提交批次回归交接（`f3be86e`）

- 全量 Vitest 首轮使用仓库默认 5 秒窗口时，`sync-routes.test.ts` 有 1 个超时；定向该文件 `13/13` 通过。采用 `--testTimeout=15000 --hookTimeout=15000 --no-file-parallelism --maxWorkers=1` 后全量为 `162` 文件通过、`1` 跳过，`745` 测试通过、`2` 跳过。交接时必须记录该参数；首轮超时不计作通过，也不应误报为产品同步故障。
- 当前 Web/Server/Cloud 构建、typecheck、lint、Windows 主进程/预加载构建通过；Chromium E2E `5/5` 通过。Windows 当前 NSIS/Portable 均成功生成，分别为 `127,707,203` bytes / `DA35DD72C4EBDEF104C530516DD4F8A25E38D5A3E1D17C62EC1B04BDC649B408` 与 `113,685,227` bytes / `B03FDFA48079B85F53D66AAF72A66ED0F187DC719D73A60E2B0733A586F19F06`，Authenticode 均为 `NotSigned`。
- Android 本地入口 `npm run test:android:local`、`npm run build:android:debug` 均成功；当前 Debug APK 为 `8,655,609` bytes，SHA-256 `73716BA21E71B0DB6B191831C43A9024B7997EA52F516533E989206518D1F625`。固定向量 Android bundle instrumentation 已编译，未在本批次真机运行。
- 设备状态：本机 `adb devices -l` 无设备，本批次未安装、卸载或清理 Android 数据。设备恢复后按一次统一交接批次运行 `npm run install:android:debug -- <serial> <apk-path>`；该路径使用 `adb push` + `pm install -r --user 0`，不使用 `-g`、不卸载、不 `pm clear`、不自动重试。随后两台设备按 A-01～A-17 全量测试，集中回填问题，不按单个问题反复部署。
- 交接边界：A-05/A-06/A-08/A-11/A-15/A-17 的真机证据，以及 Windows 签名、升级/回滚、崩溃恢复和持久制品来源仍未闭环；当前不能宣称跨平台验收完成。

## 37. 2026-09-20 固定向量回归与标准测试入口（`0766a9b`）

- AndroidTest 新增固定完整向量的 chunked import→preview→apply 回归，覆盖 1 KiB 分块、错误密码、篡改 authTag、无部分写入以及 Host/Group/Identity/Profile/标签/私钥字段。它已编译进 AndroidTest APK；没有设备时不记录为 instrumentation 通过。
- Vitest 已在配置中固化 15 秒测试与 hook 超时；标准串行命令 `npm test -- --no-file-parallelism --maxWorkers=1 --reporter=dot` 通过 `162` 文件、`745` 测试，分别跳过 1 和 2 项。
- 本批次仍不安装、不卸载、不清理 Android 数据。设备恢复后只执行一次 `npm run install:android:debug -- <serial> <apk-path>`，随后按 A-01～A-17 全量测试；A-17 真机双向回传、A-11 即时 URI grant、Windows 签名/升级/持久制品来源仍是未闭环门禁。

## 38. 2026-09-20 独立 Android 模拟器全量 instrumentation 交接

### 自动化结果

- 设备为独立本机 AVD `homeops-api35`，Android 35、x86_64、2 GB，ADB serial `emulator-5554`；该设备不是用户提供的手机或平板。
- 在 `apps/android` 执行 `node run-gradle.mjs :app:connectedDebugAndroidTest --offline --no-daemon --max-workers=1 --console=plain`，Gradle 返回 `BUILD SUCCESSFUL`。
- `cn.ayan.relay.AndroidBundlePayloadInstrumentedTest` 报告 `9` 个测试全部通过，`0` 跳过、`0` 失败。其中 `importsTheFullFixedVectorThroughChunkedAndroidBridgeWithoutPartialWrites` 实际覆盖并通过 1 KiB 分块导入、错误密码、篡改 authTag 无部分写入和完整实体字段恢复。

### 验收边界

- 本条仅作为 Android 自动化回归证据，不回填两台真机的 A-01～A-17，也不关闭 A-17 的 Android→Web/Windows 实际导出回传、Windows 导入、冲突和旧数据不变性验收。
- 本轮没有向真机安装、卸载、`pm clear` 或修改已有数据。真机恢复后继续使用 `npm run install:android:debug -- <serial> <apk-path>`，由脚本执行 `adb push` + `pm install -r --user 0`，不申请 `-g`、不卸载、不清数据、不循环重装，然后一次性按清单回归。
- Windows 签名、升级/回滚、崩溃恢复和持久制品来源仍保持未闭环；不能因本次模拟器 `9/9` 通过宣称跨平台验收完成。

## 39. 2026-09-20 独立模拟器 WebView UI smoke 交接

- 当前 Debug APK 仅向独立 AVD `emulator-5554` 执行一次保留数据部署：`npm run install:android:debug -- emulator-5554 <apk-path>`；脚本使用 `adb push` + `pm install -r --user 0`，返回 `Success`，没有 `-g`、卸载或 `pm clear`。
- WebView CDP 页面标题为 `Relay SSH Workspace`。自动化创建 Vault 并保存合成 Host `Emulator Fixture Host` 后，执行 `adb shell am force-stop cn.ayan.relay` 和重新启动；锁定页出现，错误密码被拒绝并显示“主密码错误或 Vault 已损坏”，正确解锁后原 Host 仍显示。
- 该条只交接模拟器 UI 子路径证据：Vault/Host 持久化、锁定、错误解锁和重开。它不回填真机 A-01、A-12、A-13，不覆盖真实 SSH、锁屏/旋转/软键盘、低内存，也不关闭 A-17。

## 40. 2026-09-20 Windows 当前 NSIS 解压版隔离持久化交接

- 当前 NSIS 解压版 `dist/releases/nsis/win-unpacked/Relay.exe`（NSIS `127,707,203` bytes / SHA-256 `DA35DD72C4EBDEF104C530516DD4F8A25E38D5A3E1D17C62EC1B04BDC649B408`）使用临时 `--user-data-dir` 启动。
- Playwright Electron runner 首次创建 Vault 并保存合成 `Packaged Smoke Host`；关闭进程后再次启动，解锁 Vault 后 Host 成功恢复，输出 `Relay SSH Workspace` / `persistedHost=true`。临时 userData 已清理，未接触本机现有 Relay 数据。
- 该证据只覆盖当前打包版的 Vault/Host 持久化和一次退出重开；旧版本安装包升级/回滚、签名、崩溃恢复多轮以及真实 SSH/SFTP/UI 完整任务链仍需 Windows 安装环境补验。

## 41. 2026-09-20 Web/Server 回归与 Windows CI artifact 交接

- 服务端定向回归共 `45` 个文件、`203` 个测试，全部通过；`npm run typecheck`、`npm run lint` 通过。Chromium E2E `npm run test:e2e -- --project=chromium --workers=1` 为 `5/5`，用时 `49.2s`。
- GitHub Actions run `35472655232`（commit `6e3ed06`）全部成功：`npm ci`、typecheck、lint、Electron runtime 准备、NSIS/Portable 打包、`release-manifest.json` 和 artifact 上传均通过。
- artifact 名称为 `Relay-Windows-main-6e3ed06aaa5e2e1b0297bfefc96c60e134f68f15`，压缩包大小 `240,656,840` bytes，保留至 `2026-12-18`；run 页面：`https://github.com/a-yan0901/Relay/actions/runs/35472655232`。
- 该条补齐 Windows 持久制品来源交接；artifact 中的 Authenticode 仍为 `NotSigned`，Windows 签名、旧版本升级/回滚、崩溃恢复多轮和完整安装包任务链仍保持未闭环。

## 2026-09-20 Android→Windows bundle 交接证据

- 当前模拟器 `emulator-5554` 保持原安装和数据，通过 WebView CDP 调用已存在的 Android 原生 bridge 完成一次 bundle export；本轮没有卸载、`pm clear`、反复安装或新增运行时授权。
- 合成 bundle：`1,401` bytes，SHA-256 `8a5f8ab17127cfe7c08479f746709e8dc2324524a2c9f698b3cd4a492eba39f4`；`webssh-vault` v1，Argon2id 参数 `19456/2/1/32`。不记录导出密码，不包含真实凭据。
- Windows 侧使用隔离内存数据库 `createWindowsLocalRuntime({ dataDir: ':memory:' })`：预览得到 `1 Host / 0 Group / 0 Identity`、`conflicts=0`；应用结果为 `importedHosts=1`。
- 错误导出密码、篡改 `payload.authTag` 均返回拒绝，拒绝后目标库无写入；再次预览得到 `1` 个 Host 冲突，按 `hostConflicts=skip`、`groupConflicts=reuse`、`identityConflicts=reuse` 应用后 `skippedHosts=1`，最终仍为 `1` Host。

### A-17 状态更新

- 本轮将 A-17 的“Android 导出→Windows local-runtime 导入、错误输入、冲突和原数据不变性”标记为自动化部分通过。
- 尚未通过的边界：两台真实 Android 设备上的完整清单、Android→Web 实际导入、Windows 打包 UI 实际导入、Web/Windows→Android 反向导入，以及真实设备上的双向字段核对。因此 A-17 总项仍为“部分完成”，不能据此宣布跨端验收闭环。

## 2026-09-20 保留数据的 Android 固定向量预览

- 在现有 `emulator-5554` 上通过 WebView 原生 bridge 执行固定向量导入：共 `5` 个 `1 KiB` 分块，预览结果为 `2 Host / 2 Group / 2 Identity`、`conflicts=0`。
- 错误导出密码和篡改 `payload.authTag` 均被拒绝；本轮只预览、未执行 `apply`，因此没有改写当前模拟器 Vault/Host 数据，也没有卸载、清库、重复安装或新增授权。
- 该条补充 Web/Windows→Android 的真实 bridge 预览证据；两台真机的应用/字段核对、Android→Web 实际导入和 Windows 打包 UI 导入仍是 A-17 未完成边界。

## 42. 2026-09-20 移动窄屏 Vault 锁入口修复

- 发现并修复 `max-width: 620px` 下主工作区头部隐藏 Vault 锁按钮的问题；非嵌入式 `.secure-pill` 现在以紧凑图标按钮显示，既有 `aria-label`/`title` 不变，Console 嵌入式锁入口保持原样。
- TDD 结果：缺少选择器时定向测试按预期失败；实现后 CSS 测试 `2/2`、关联 Web DOM 测试 `20/20`，`npm run build:web` 与 `npm run lint` 通过。
- 交接策略：本轮不重新安装、卸载、清库或新增 Android 授权；实际设备验证纳入下一次统一部署与全量验收批次，避免为单个问题反复重装。

### Android 包构建交接（未部署）

- 为验证 Web 修复已同步进入 Android WebView 资源，使用 session-only JDK 21/Android SDK 执行 `npm run build:android:debug`，`BUILD SUCCESSFUL`（36s；73 tasks，21 executed，52 up-to-date）。
- Debug APK：`8,655,609` bytes，SHA-256 `FA9986C4EE05D14FF7C1ADAAB49D9FD96E7E916209F5F6E33555F853470F6F44`。
- 该 APK 仅构建未安装；恢复真机连接后按统一批次用数据保留方式部署，不执行卸载、`pm clear`、`-g` 或重复授权。

## 43. 2026-09-20 A-11 SAF grant 失败分支清理

- 发现边界：SAF 已返回 URI 但原生 executor 不可用、调用抛异常或处理返回失败时，插件原先没有在 Activity 回调边界立即撤销 grant。
- 已修复 open/save 两条回调：成功响应继续交给 source/file writer 负责后续释放；失败响应、executor 缺失和异常路径立即走统一的 Activity/application context best-effort revoke。
- TDD/验证：新增 `AndroidUriGrantGuardTest`，`2/2` 通过；`npm run test:android:local` 构建成功；TypeScript 全量 `162` 文件、`746` tests 通过、`2` skipped，typecheck/lint 通过。
- 最新 Debug APK：`8,655,609` bytes，SHA-256 `9D79BC8B7B9B63215E00655360C73C88FEB6A074DB1A14173842D4621A3DA608`，仅构建未安装。本条仍不能把 A-11 标成真机通过，任务结束立即释放、权限拒绝和分享需设备证据。

## 44. 2026-09-20 Windows CI 当前提交制品

- GitHub Actions run `35475857178`（commit `4eb33df`）已成功完成 checkout、`npm ci`、源码校验、Electron runtime 准备、NSIS/Portable 打包、`release-manifest.json` 生成和 artifact 上传。
- artifact 名称为 `Relay-Windows-main-4eb33df7b193e9652857e0284b181623f208c67c`，压缩包大小 `240,657,371` bytes，保留至 `2026-12-18`；run URL：`https://github.com/a-yan0901/Relay/actions/runs/35475857178`。
- 当前 SSH 凭据可用于 Git 操作，但 Actions artifact 下载接口要求 GitHub Web/API 登录；本轮未伪造或猜测包内哈希/签名字段。Windows 真签名、旧版本升级/回滚、崩溃恢复多轮和完整安装包任务链仍保持未完成。

## 45. 2026-09-20 Android 数据保留部署短路

- `apps/android/install-debug.mjs` 现在先只读 `pm path` 和设备端 APK SHA-256；与本地 APK 完全一致时直接跳过 `adb push`/`pm install`，避免重复安装和再次触发设备授权。
- 未安装、哈希不同、哈希读取失败或输出格式异常时，仍使用 `adb push` + `pm install -r --user 0`；不使用 `-g`，不卸载、不 `pm clear`。
- TDD/验证：策略测试先因模块缺失失败，补实现后 `4/4` 通过；`node --check`、策略 smoke、`typecheck`、`lint`、`git diff --check` 通过。本轮未调用安装脚本、未改变模拟器或真机数据。

## 46. 2026-09-20 当前提交全量回归与 Windows CI

- 当前提交 `96de623` 的串行全量 Vitest 为 `163` 个文件通过、`1` 个跳过；`750` 个测试通过、`2` 个跳过；该结果包含 Android 部署策略测试。
- GitHub Actions run `35476843161` 已成功完成 checkout、`npm ci`、typecheck/lint、Electron runtime 准备、NSIS/Portable 打包、manifest 生成和 artifact 上传。
- artifact 为 `Relay-Windows-main-96de6238285c1253c680836d315b595812b94436`，大小 `240,657,718` bytes，保留至 `2026-12-18`；run URL：`https://github.com/a-yan0901/Relay/actions/runs/35476843161`。
- 本条只确认当前提交的自动化回归和可追溯 Windows CI 制品；Windows 真签名、旧版本升级/回滚、崩溃恢复多轮和两台 Android 真机 A-01～A-17 仍未闭环。

## 47. 2026-09-20 Windows 定向回归与 CI 并发策略

- 当前工作区执行 Windows 定向 Vitest：`tests/unit/windows` 共 `6` 个文件、`30` 个测试全部通过。
- `npm run build:windows` 通过 Web、Electron main 和 preload 三段构建；仅有既有 Vite chunk size 提示，无构建失败。
- `.github/workflows/windows-package.yml` 已加入 `paths-ignore`（文档目录）和同分支 `concurrency.cancel-in-progress`；后续文档-only 提交不再重复打包，新代码提交只保留最新 Windows package run。

## 48. 2026-09-20 Android 当前构建与集中 instrumentation 交接

- Android Gradle 环境入口已在提交 `f24283a` 补齐自动探测：标准 SDK 路径、失效 `ANDROID_HOME`/`ANDROID_SDK_ROOT` 回退和 Java 21 选择均有单测；不依赖仓库内机器绝对路径。
- 环境单测 `7/7`、`npm run test:android:local`（JVM `38/38`，AndroidTest APK 编译）和无手工环境变量的 `npm run build:android:debug` 均通过；全量 Vitest `164` 文件通过、`757` 测试通过，另有 `1` 文件/`2` 测试按既有标记跳过。
- 当前 APK `8,655,609` bytes / SHA-256 `9D79BC8B7B9B63215E00655360C73C88FEB6A074DB1A14173842D4621A3DA608` 未因本次环境修复发生变化；本轮不新增设备安装、卸载、`pm clear` 或运行时授权。
- 当前 Debug APK 使用 session-only JDK 21/Android SDK、offline、单 worker 构建成功：`8,655,609` bytes，SHA-256 `9D79BC8B7B9B63215E00655360C73C88FEB6A074DB1A14173842D4621A3DA608`。
- 目前只有独立 AVD `emulator-5554` 在线；手机和平板没有出现在 `adb devices -l`，mDNS 为空，已知无线 ADB 端点不可达。本条不把模拟器证据写入两台真机 A-01～A-17 的结果列。
- 设备端先发现旧 APK 哈希 `73716…` 与当前 APK 不同，按 `install-debug.mjs` 的策略执行一次 `adb push` + `pm install -r --user 0`；没有显式卸载、`pm clear`、`-g` 或新增运行时授权。
- 在独立模拟器集中执行 `:app:connectedDebugAndroidTest --offline --no-daemon --max-workers=1 --console=plain`，`9/9` 通过、`0` 跳过、`0` 失败，Gradle `BUILD SUCCESSFUL`；固定向量分块导入测试实际执行通过。该 runner 结束后清理了目标包，随后只为恢复模拟器已知基线再次通过同一数据保留入口部署当前 APK，最终设备端哈希已复核与本地一致。
- 后续设备策略：优先 `npm run test:android:local` 做代码回归；真机恢复后一次构建、一次数据保留部署、一次全量清单回归，不为单个问题拆分安装。A-01～A-17、真实设备生命周期/URI grant 证据和 A-17 跨端实机交接仍未完成。

## 49. 2026-09-20 Windows 打包版多轮崩溃恢复交接

- 当前 NSIS 解压版 `dist/releases/nsis/win-unpacked/Relay.exe`（`127,707,203` bytes，SHA-256 `DA35DD72C4EBDEF104C530516DD4F8A25E38D5A3E1D17C62EC1B04BDC649B408`）使用隔离临时 `--user-data-dir` 连续执行 3 轮启动、Host 创建/读取、强制终止和重启。
- 三轮均输出窗口标题 `Relay SSH Workspace`，每轮均恢复 `Packaged Recovery Host`；临时 userData 已清理，未读写本机现有 Relay 数据。
- 当前 Portable 制品为 `113,685,227` bytes，SHA-256 `B03FDFA48079B85F53D66AAF72A66ED0F187DC719D73A60E2B0733A586F19F06`。NSIS/Portable 的 `Get-AuthenticodeSignature` 均为 `NotSigned`。
- 本条只补强解压版多轮本地恢复；Windows 签名、旧版本安装包升级/回滚、安装器崩溃恢复和完整打包 SSH/SFTP/UI 任务链仍未完成。

## 50. 2026-09-20 当前 NSIS 安装器隔离门禁

- 对当前 `dist/releases/nsis/Relay-0.1.0-x64.exe` 使用临时安装目录执行静默安装，退出码 `0`；安装目录中的 `Relay.exe` 和卸载程序均存在。
- 从临时安装目录启动 `Relay.exe --user-data-dir=<临时目录>`，进程存活 5 秒；随后静默卸载退出码 `0`，安装目录已删除，临时 userData 已清理。
- 本条补齐当前 NSIS 安装/启动/卸载证据；签名、旧版本升级/回滚、安装器崩溃恢复和完整打包 SSH/SFTP/UI 任务链仍未完成。

## 51. 2026-09-20 跨制品数据保留替换交接

- 早期解压版 `dist/releases/win-unpacked/Relay.exe` 在隔离 userData 中创建合成 `Upgrade Preservation Host`；当前 NSIS 包安装到临时目录后复用同一 userData，解锁后成功读回该 Host。
- 当前 NSIS 临时安装包随后静默卸载退出码为 `0`，安装目录和 userData 均已清理；全过程未接触本机现有 Relay 数据。
- 该条补充跨制品数据保留证据，但没有可追溯的旧版本 NSIS 安装包和不同版本号，不能替代真正的旧版本安装→升级→回滚验收。
