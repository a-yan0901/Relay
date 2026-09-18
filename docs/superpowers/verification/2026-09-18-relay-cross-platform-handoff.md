# Relay 跨端验收交接任务书

**交接日期：** 2026-09-19
**上一版交接文档基线：** `30c9b5b`（`main`）
**本次文档修订：** 当前修订提交（以本文件所在 commit 为准）
**APK 构建源码基线：** `d3c4c62`；**Windows portable 历史预览源码基线：** `75cc630`。后续重新构建必须以新的源码 commit、构建时间、工具链和制品哈希为准。
**验收机器应检出：** Android 验收使用 `d3c4c62`；Windows root Electron UI smoke 使用本轮最新源码，Windows portable 验收必须使用与重新构建制品清单匹配的新源码 commit。
**适用范围：** Android 真机/可用模拟器验收；Windows 实机验收作为并行任务保留
**对应计划：** [Relay 独立 Windows 与 Android 客户端实施计划](../plans/2026-09-17-relay-windows-android-implementation.md)
**对应矩阵：** [Relay 跨端验收矩阵](./2026-09-18-relay-cross-platform-acceptance-matrix.md)

## 1. 当前进度和交接结论

| 范围 | 当前状态 | 已有证据 | 交接后仍需补充 |
| --- | --- | --- | --- |
| Web | ✅ 自动化基线可复现 | 标准全量回归 161 个测试文件通过、1 个跳过；727 个测试通过、2 个跳过；typecheck、lint、build、E2E 4/4 | 无本次交接阻塞项 |
| Windows | 🟡 root Electron 技术预览 | root Electron 真实服务器 UI smoke、IPC/native contract、`build:windows`；历史 portable SHA-256 已记录，但本轮没有新的可交接包 | Windows native ABI、安装/升级迁移、退出/重开、SSH/SFTP 任务链 |
| Android | 🟡 已完成有限设备 SSH/UI 证据，不代表平台完成 | Kotlin 编译、JVM 单元测试、connected instrumentation 2/2、Debug APK 构建；源码 `d3c4c62` 的 APK 曾安装到两台 Android 16 真机，真实主机 UI 重开后两台均可输入命令；`25091RP04C` 已浏览真实 `/` 和 `/tmp` | SFTP 上传/下载/取消、私钥、Host Key 变更、URI、返回键、软键盘、锁屏/进程回收、网络切换、低内存和 A-01～A-17 其余项目；`2407FRK8EC` 当前安装恢复受设备侧限制 |
| Vault bundle v1 | 🟡 加密边界已有固定向量，完整跨端 payload 尚未验收 | Android 已通过 Node V1 envelope 解密向量；Web/Windows 单端导入导出测试存在 | A-17：Web/Windows↔Android 固定 payload 正反向导入导出、错误输入和数据不变性 |
| 云同步 | ⏸️ 不在本期客户端验收 | 可选 ports 和数据边界已保留 | 按独立云同步计划推进，不在本任务书中验证 |

本机历史上有一次 AOSP 软件模拟器因缺少 `/dev/kvm` 处于 `adb offline` 后退出；`emulator-5554` 的 fixture 结果仅作为历史可重复回归证据，不作为本次真实主机验收结论。当前交接以两台 Android 16 真机和用户提供的 SSH 主机为准。

历史模拟器验证：`adb devices` 曾返回 `emulator-5554 device`；旧 APK `8F307F...` 在本地 in-process `ssh2` fixture 上完成 Host Key 展示、信任和 Shell 建立。该证据仅用于自动化回归溯源，不替代真实服务器证据。

### 真实 Android 设备补充证据（2026-09-19）

- 设备：Xiaomi `2407FRK8EC`、Xiaomi `25091RP04C`，均为 Android 16/API 36、arm64-v8a；本轮开始时两台均重新安装同一 Debug APK（应用 ID `cn.ayan.relay`），安装返回 `Success`，并成功启动 `MainActivity`。connected instrumentation 结束后 runner 清理了 `2407FRK8EC` 的 APK，当前 `25091RP04C` 仍安装，`2407FRK8EC` 恢复安装返回 `INSTALL_FAILED_USER_RESTRICTED`。
- 制品：源码 `d3c4c62`，APK 8,633,367 bytes，SHA-256 `D740E4D58BAA208E38D2F1DE51B86C6973745EF8C718D48C255FEBAF9D6B9BA8`。
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
- 构建时间（文件时间，Asia/Shanghai）：`2026-09-19 00:37:47`
- 大小：`8,633,367` bytes
- SHA-256：`D740E4D58BAA208E38D2F1DE51B86C6973745EF8C718D48C255FEBAF9D6B9BA8`
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

### Windows portable 预览包

- 文件：`dist/releases-portable-preview/Relay-0.1.0-x64.exe`
- 构建时间（文件时间，Asia/Shanghai）：`2026-09-18 19:19:34`
- 大小：`457,281,531` bytes
- SHA-256：`1A7B61C6DD7C846BD0CC924A05FA812032A83691CE7D76ECAC2106413359D04C`
- 构建命令（PowerShell）：`$env:ELECTRON_MIRROR='https://npmmirror.com/mirrors/electron/'; $env:npm_config_electron_mirror=$env:ELECTRON_MIRROR; npm run package:windows:portable`
- 说明：该文件已在 Windows checkout 生成并完成 SHA-256 校验，签名状态为 `NotSigned`；打包使用 `npmRebuild=false`，不能替代 Windows native ABI、安装/升级、退出/重开和完整 SSH/SFTP 任务链验收。

上述文件当前只存在于本机 gitignored 生成目录，不会随仓库 clone/checkout 交付。本仓库未配置可追溯的 GitHub Release 附件、制品服务器或跨机器共享目录；交接执行人应通过受控的 `scp`、SFTP 或共享目录复制，并在目标机再次运行 `sha256sum` 比对上述 hash。最终签收前必须补一条持久制品来源（URL、Release 附件或共享目录路径）和最终源码 commit；若没有该来源，状态只能保持 🟡。

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
| A-03 | Host Key 变化 | 指纹变化硬失败，不得沿用旧信任记录自动放行 | 待执行 |
| A-04 | 密码和私钥认证 | 两种已支持认证方式分别成功/失败可解释；私钥内容不出现在 UI 日志 | 待执行 |
| A-05 | Console 输入、输出、复制粘贴 | 中文/长输入不乱序；复制可用；粘贴有明确确认；底部最后一行完整可见 | 待执行；两台真机连续 3 轮关闭/重开后输入 `whoami`，6/6 返回 `t2`；本轮再分别输入 `echo REAL_SERVER_2407`/`echo REAL_SERVER_25091` 得到远端回显。复制、粘贴确认、中文/长输入和底部布局仍待完整走查。 |
| A-06 | 断网后恢复 | 网络切换/短暂断开显示真实 `reconnecting` 或 `interrupted`；恢复后按交互约定重连，不伪造 connected | 待执行 |
| A-07 | Android 返回键 | 先关闭最上层对话框/工作区/Console；根页面再交回系统退出 | 待执行 |
| A-08 | 软键盘、旋转和安全区 | 输入框不被键盘遮挡；横竖屏无横向溢出；旋转后工作区状态可恢复 | 待执行 |
| A-09 | SFTP 全屏浏览 | 文件列表可完整浏览；单层纵向滚动；快速过滤按 name 实时模糊匹配；大目录可继续翻页 | 待执行；`25091RP04C` 已在真实主机 UI 浏览 `/`（36 项）和 `/tmp`（25 项），过滤、分页、滚动和安全区仍待完整走查。 |
| A-10 | SFTP 读写任务 | 上传、下载、取消、重试、部分失败均有明确结果；临时文件失败不会提交半文件 | 待执行；`25091RP04C` 通过真实 MIUI 文件选择器上传 33,817-byte PNG 到用户服务器 `/tmp`，Transfer Center `已完成 · 100%`；再通过 Android DocumentsUI 下载回本机，保存文件 33,817 bytes 且 Transfer Center `已完成 · 100%`。远端 `/` 无写权限时任务 0% 后取消；32 MiB/25% 取消、重试、部分失败和临时文件断言仍待执行。 |
| A-11 | SFTP URI 和分享 | 使用系统文件选择/保存/分享；任务结束释放 URI 权限；拒绝权限有可理解提示 | 待执行；真实系统文件选择与 DocumentsUI 保存已走通；传输完成后 Activity 内仍可观察到临时 URI grant，`force-stop` 后重启 Relay 才清空 `readUriPermissions/writeUriPermissions`。任务结束立即释放、拒绝权限提示和分享仍待执行。 |
| A-12 | Vault 锁定和重开 | 锁定后秘密不可读取；正确解锁恢复；错误密码/损坏 bundle 不覆盖旧数据 | 待执行 |
| A-13 | App 重启、锁屏、进程回收 | 本地数据仍在；旧 SSH descriptor 不被伪装复用；恢复后显示真实 `needs-reopen`、`interrupted` 或可重连状态 | 待执行 |
| A-14 | 主题和界面偏好 | 用户选定主题、字号、grid/list 等偏好重启后保持；未选择时使用默认主题 | 待执行 |
| A-15 | 低内存行为 | 大目录/大文件操作不明显失控；取消/退出后资源释放；无持续增长的输出/文件缓冲 | 待执行 |
| A-16 | 秘密和网络边界 | 普通 logcat、WebView 持久化和系统备份中不出现密码/私钥/Vault 明文；客户端不要求本地 HTTP 监听 | 待执行；`25091RP04C` 部分检查未发现 logcat/app-private 测试标记、Relay/5173/3000/4173 监听，APK manifest `allowBackup=0`；完整专用标记密码、WebView、备份和设备日志流程仍待执行。 |
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

- `npm run package:windows` 在本机缺少 Visual Studio/MSVC 时被 `node-gyp` native rebuild 阻塞；portable 打包重试还遇到外部 builder 下载 `ETIMEDOUT`。因此本次没有新的可交接 Windows installer/portable artifact，也没有签名、ABI、安装升级或卸载证据。
- 现有 gitignored portable 文件如果时间早于本节记录，只能作为历史预览，不能回填为本次产物。后续交接必须在具备 MSVC 和稳定 builder 下载的 Windows 机器上重新构建，并记录源码 commit、生成时间、文件大小、SHA-256、签名状态和安装/升级结果。

### 下一步验收顺序

1. 在具备 Visual Studio/MSVC 的 Windows 机器上完成 native rebuild、package、安装/升级/退出重开和 ABI 证据。
2. 在同一台 Windows 机器上补 SFTP UI、Vault lock/reopen、文件/剪贴板能力和低内存边界。
3. Android 继续按 A-01～A-17 回填；当前两台真机的真实 SSH/SFTP smoke 不替代剩余 UI、Host Key 变更、私钥、生命周期、网络切换和低内存验收。

## 10. 2026-09-19 Android/Web/Server 续验记录

- 真实测试主机再次明确为用户提供的 `106.14.61.92:22`、账号 `t2`；本地 in-process SSH fixture 没有用于本轮真机结论。两台真机从“需要重新打开”的 Console 状态重新打开 Host 后，分别输入 `echo REAL_SERVER_2407` 和 `echo REAL_SERVER_25091`，均得到远端回显和 `t2` 提示符；这证明命令实际可输入，不以绿色状态点单独判定通过。
- `25091RP04C` 已在真实 SFTP UI 浏览远端 `/`（36 项）并跳转 `/tmp`（25 项）。初次通过非用户手势的 HTML 文件选择器自动化没有形成传输任务，不能作为证据；随后真实 MIUI 文件选择器上传和 DocumentsUI 下载均完成 100%，但 A-10/A-11 的大文件取消、重试、部分失败、任务结束 URI 释放和分享仍不得回填为通过。
- Android 验证使用 JDK 21、已缓存 Gradle 9.3.1、单 worker、离线模式；`:app:testDebugUnitTest :app:assembleDebug` 成功，`:app:connectedDebugAndroidTest` 在 `2407FRK8EC` 完成 2/2。connected test 结束后 runner 清理了目标 APK；该设备随后两次安装尝试均返回 `INSTALL_FAILED_USER_RESTRICTED`，当前需在设备端确认安装提示/厂商安装权限，不能静默改动设备安全设置。`25091RP04C` 当前仍安装 APK。
- `25091RP04C` 部分 A-16 检查结果：普通 logcat 无 `relay-device-test-2026` 标记，`run-as` app-private 数据无该标记，`ss -lntp` 未发现 Relay app 或 5173/3000/4173 监听；`aapt dump xmltree` 显示 APK `android:allowBackup` 为 `0`。因未按 A-16 要求使用专用无敏感标记密码完成全流程，这些记录只算部分证据。
- Web/Server 标准全量回归复跑通过：161 个测试文件通过、1 个跳过；727 个测试通过、2 个跳过；E2E 4/4。此前一次全量运行的 `sync-routes` 5 秒超时经针对文件 13/13 通过后复跑通过，未修改测试超时或把 `--isolate=false` 结果当作验收依据。
- Android SFTP 系统交互续验：`25091RP04C` 的真实 MIUI 文件选择器上传到用户服务器 `/tmp` 和 DocumentsUI 下载均显示 100%，本机保存结果为 33,817 bytes；远端根目录无写权限路径的 0% 任务已取消。该结果不替代 A-10 的大文件取消/重试/部分失败矩阵。
- URI 观察：传输完成后 Activity 内仍存在本轮 URI grant；`force-stop` 后重新启动 Relay 时 grants 已清空。由于尚未证明每个任务结束立即释放、拒绝权限和分享路径，A-11 继续保持待执行。
