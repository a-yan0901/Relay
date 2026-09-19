# Relay Android client boundary

本目录固定 Android Capacitor 插件的受限边界，React 侧通过 `src/web/platform/android-bridge.ts` 调用，不允许把任意文件路径、命令或网络地址透传给原生层。`android/` 是可同步的 Capacitor 工程，`RelayNativePlugin.kt` 已注册到 `MainActivity`；当前已接入本地 Vault/SQLite、Workspace 状态与模板、SSH/PTY、Host Key、ProxyJump、SFTP 浏览/变更/分块传输，以及 Android 确认框和 SAF 文件保存。

本地命令：

```bash
# 按本机实际 SDK 路径设置；不要把该路径提交到仓库
export ANDROID_HOME=/usr/lib/android-sdk
export ANDROID_SDK_ROOT=/usr/lib/android-sdk
npm run build:android:debug
npm run build:android:release
```

Windows 开发机建议显式固定 JDK 21 和 Android SDK，并复用已经缓存的 Gradle；不要让首次构建在错误的 Java 17 或缺少 `ANDROID_HOME` 的环境下反复初始化：

```powershell
$env:JAVA_HOME = 'C:\Program Files\Microsoft\jdk-21.0.12.101-hotspot'
$env:ANDROID_HOME = "$env:LOCALAPPDATA\Android\Sdk"
$env:ANDROID_SDK_ROOT = $env:ANDROID_HOME
$env:Path = "$env:JAVA_HOME\bin;$env:Path"
npx cap copy android # Web bundle 未变化时无需重新 build:web/cap sync
cd android
.\gradlew.bat :app:testDebugUnitTest :app:assembleDebug --offline --no-daemon --max-workers=1 --console=plain
```

如果 wrapper 分发包尚未缓存，先在有网络的构建机完成一次 Gradle wrapper 下载；后续验证优先复用同一 Gradle/JDK/SDK 组合，避免把工具链初始化时间误报为测试耗时。

`build:android:debug` 使用单 worker、无 Gradle daemon 的 `assembleDebug`，适合低内存开发机；Debug APK 输出在 `android/app/build/outputs/apk/debug/app-debug.apk`。Release AAB 仍由 `build:android:release` 负责，签名和发布 ABI 需在发布机完成。

当前环境已准备 JDK 21、Gradle wrapper、Android API 36 和 Build Tools 35.0.0；JSch 2.27.7 依赖可离线复用。Kotlin 编译和 Android 单元测试已通过；两台 Android 16 真机可用于本地验收，但设备安装限制、后台生命周期、网络切换和发布 ABI 仍必须按交接清单逐项回填，不能用 Web Relay 服务代替 Android 独立客户端验证。

当前 Android native capability 已包含本地 Snippet 管理；Snippet 内容在 Android Vault 中按记录加密，WebView 只在用户打开编辑器时读取命令模板，不会读取主机凭据。

原生实现必须满足：

- 每个请求带 `version/requestId/operation/payload`，只接受 allowlist 操作；响应必须关联同一 `requestId`。
- 事件带 `generation/sequence` 以及 `sessionId` 或 `transferId`，输出和文件流单块不超过 32 KiB，事件处理不得积压无界队列。
- WebView 事件队列固定为 8 条；终端输出和传输进度在拥塞时可丢弃，但断开、重连和其它控制事件优先保留，避免低内存设备因无界积压或丢失状态而失控。
- 终端输入在 Executor 与 SSH session 之间复用一次 UTF-8 编码结果，并在写入完成后清零，避免短时保留两份相同输入缓冲。
- Android 系统返回键只转发为可取消的 `relay:back` 事件；React 先关闭最上层弹层或 Console 页面，根页面没有可关闭内容时才退出 Activity。
- Vault 主密码、私钥、passphrase 只能进入受信原生方法，不写日志、通知、WebView 存储或系统备份。
- Host Key、远程路径、传输目标和取消逻辑由原生层再次校验；进程恢复时重新读取任务状态，旧 Shell 句柄以内部 `needs-reopen` 事件触发新 Shell 自动创建，不要求用户手动恢复。
- 当前 native capability 只广告已接入的本地工作区/模板、身份/分组、终端外观、Vault bundle、Snippet、批量命令、SSH/ProxyJump、SFTP、有限断点传输和脱敏 Activity 审计；Workspace 状态最多 32 KiB，模板最多 64 条。外部 SSH 配置导入已支持 OpenSSH、SSH/Termius CSV、MobaXterm、Xshell 和 SecureCRT 的有界文本解析，单次文件总量不超过 48 KiB，未解密的外部密钥路径/受保护密码仍需用户补录。后台 UI 恢复、真实设备和发布 ABI 验证仍是后续门禁。命令、传输任务和安全摘要会写入 app-private SQLite，进程重启或 Vault 锁定时运行中的任务标记为 `interrupted`，解锁后可读取有限历史结果。批量命令限制为最多 8 台主机、4 个原生 worker、每目标 16 KiB 输出；Vault bundle 通过 32 KiB 分块跨越 64 KiB Capacitor 帧，原生侧最多保留一个带 TTL 的导入/导出/预览缓冲。

低内存构建默认使用 `org.gradle.jvmargs=-Xmx768m`、单 worker、关闭 Gradle 并行；真实 CI/发布机可在测量峰值后单独提高预算。

在具备 Android SDK 和真机后，先完成密码/私钥、PTY、逐跳 Host Key、ProxyJump、SFTP、取消与断线释放的真机 PoC，再将当前 SSH 库候选转为发布选型。
