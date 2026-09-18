# Relay 跨端验收交接任务书

**交接日期：** 2026-09-18
**代码基线：** `1d6244d`（`main`）
**适用范围：** Android 真机/可用模拟器验收；Windows 实机验收作为并行任务保留
**对应计划：** [Relay 独立 Windows 与 Android 客户端实施计划](../plans/2026-09-17-relay-windows-android-implementation.md)
**对应矩阵：** [Relay 跨端验收矩阵](./2026-09-18-relay-cross-platform-acceptance-matrix.md)

## 1. 当前进度和交接结论

| 范围 | 当前状态 | 已有证据 | 交接后仍需补充 |
| --- | --- | --- | --- |
| Web | ✅ 自动化基线可复现 | 161 个测试文件/720 个测试通过；typecheck、lint、build、E2E 4/4 | 无本次交接阻塞项 |
| Windows | 🟡 可构建技术预览 | Electron shell、IPC/native contract、portable 包和 Linux 启动烟测 | Windows 主机安装、ABI、升级迁移、退出/重开、SSH/SFTP 任务链 |
| Android | 🟡 APK 可交接，不代表设备完成 | Kotlin 编译、JVM 单元测试、Debug APK 构建和 ZIP 完整性通过 | 真机安装、SSH/SFTP、Keystore、URI、返回键、软键盘、锁屏/进程回收、网络切换 |
| 云同步 | ⏸️ 不在本期客户端验收 | 可选 ports 和数据边界已保留 | 按独立云同步计划推进，不在本任务书中验证 |

本机内存不足，Android 软件模拟器没有形成有效设备连接：缺少 `/dev/kvm`，设备曾处于 `adb offline` 后退出。因此本机不再启动模拟器；Android 设备验收转移到内存充足且有真机或可用模拟器的机器。

## 2. 可交接产物

### Android Debug APK

- 文件：`apps/android/android/app/build/outputs/apk/debug/app-debug.apk`
- 应用 ID：`cn.ayan.relay`
- SHA-256：`8978bb8d9d4a8a4d0298456cb9dbc169c72ea760ee3fdb0fd8e5d65b61302a6a`
- 构建命令：

  ```bash
  ANDROID_HOME=/usr/lib/android-sdk \
  ANDROID_SDK_ROOT=/usr/lib/android-sdk \
  npm run build:android:debug
  ```

### Windows portable 预览包

- 文件：`dist/releases-portable-preview/Relay-0.1.0-x64.exe`
- SHA-256：`91af49081e8a477a99fe5993ace1777797115f0b32355249cd31ebf4bb435478`
- 说明：该文件已在 Linux 上完成 PE 格式检查和 Electron 启动烟测，不能替代 Windows 主机安装和原生 ABI 验收。

## 3. Android 交接机器准备

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

4. 准备一台可测试的 SSH 主机：至少包含一个密码或私钥认证账号；如要验证 SFTP，准备一个有足够文件数量的目录、可读写目录和一个较大文件。不要在截图、日志或测试文件中使用真实生产密钥。
5. 本期 Local 模式不需要 Relay URL、Web cookie、账号或云服务；不要为了测试 Android 客户端启动 Web server 或配置云端地址。

## 4. 必须逐项执行的 Android 验收

结果状态只允许使用 `通过`、`失败`、`阻塞`；每个“通过”都要附版本、操作结果和截图/日志路径。

| 编号 | 验收任务 | 预期结果 | 结果/证据 |
| --- | --- | --- | --- |
| A-01 | 首次打开、创建 Host、保存凭据 | 不需要 Relay URL 或 cookie；Host 重启后仍存在 | ☐ |
| A-02 | 首次 Host Key 确认 | 首次连接明确展示指纹；确认后可连接，拒绝则不建立 Shell | ☐ |
| A-03 | Host Key 变化 | 指纹变化硬失败，不得沿用旧信任记录自动放行 | ☐ |
| A-04 | 密码和私钥认证 | 两种已支持认证方式分别成功/失败可解释；私钥内容不出现在 UI 日志 | ☐ |
| A-05 | Console 输入、输出、复制粘贴 | 中文/长输入不乱序；复制可用；粘贴有明确确认；底部最后一行完整可见 | ☐ |
| A-06 | 断网后恢复 | 网络切换/短暂断开显示真实 `reconnecting` 或 `interrupted`；恢复后按交互约定重连，不伪造 connected | ☐ |
| A-07 | Android 返回键 | 先关闭最上层对话框/工作区/Console；根页面再交回系统退出 | ☐ |
| A-08 | 软键盘、旋转和安全区 | 输入框不被键盘遮挡；横竖屏无横向溢出；旋转后工作区状态可恢复 | ☐ |
| A-09 | SFTP 全屏浏览 | 文件列表可完整浏览；单层纵向滚动；快速过滤按 name 实时模糊匹配；大目录可继续翻页 | ☐ |
| A-10 | SFTP 读写任务 | 上传、下载、取消、重试、部分失败均有明确结果；临时文件失败不会提交半文件 | ☐ |
| A-11 | SFTP URI 和分享 | 使用系统文件选择/保存/分享；任务结束释放 URI 权限；拒绝权限有可理解提示 | ☐ |
| A-12 | Vault 锁定和重开 | 锁定后秘密不可读取；正确解锁恢复；错误密码/损坏 bundle 不覆盖旧数据 | ☐ |
| A-13 | App 重启、锁屏、进程回收 | 本地数据仍在；旧 SSH descriptor 不被伪装复用；恢复后显示真实 `needs-reopen`、`interrupted` 或可重连状态 | ☐ |
| A-14 | 主题和界面偏好 | 用户选定主题、字号、grid/list 等偏好重启后保持；未选择时使用默认主题 | ☐ |
| A-15 | 低内存行为 | 大目录/大文件操作不明显失控；取消/退出后资源释放；无持续增长的输出/文件缓冲 | ☐ |
| A-16 | 秘密和网络边界 | 普通 logcat、WebView 持久化和系统备份中不出现密码/私钥/Vault 明文；客户端不要求本地 HTTP 监听 | ☐ |

## 5. 证据回填要求

交接机器完成后，回填本文件的“结果/证据”列，并附以下最小信息：

- 设备型号、Android 版本、ABI、应用版本和 APK SHA-256。
- `adb devices`、安装结果和出现问题时的相关 `logcat` 片段；日志必须脱敏。
- A-01 至 A-16 的通过/失败/阻塞结果；失败项写明复现步骤、期望、实际结果。
- SSH/SFTP 测试主机类型和功能范围，不记录密码、私钥、真实 Host Key 私密材料。
- 对 UI 问题附竖屏/横屏截图；对生命周期问题附操作时间线。
- 结果提交后，由开发者把证据同步到实施计划和验收矩阵；没有设备证据的项目继续保持 🟡/⏳，不能直接勾选计划任务。

## 6. 当前不应执行的操作

- 不在内存不足的开发机上再次启动 Android 模拟器。
- 不为了“通过验收”把 Android SSH/SFTP 路径改成调用 Web 服务或 Relay 服务。
- 不把 APK 能安装、Kotlin 能编译或 JVM 测试通过，等同于真机验收通过。
- 不把真实密码、私钥、恢复密钥或生产 Host Key 放入 issue、截图、普通日志或测试 bundle。
