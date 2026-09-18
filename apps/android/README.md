# Relay Android client boundary

本目录固定 Android Capacitor 插件的受限边界，React 侧通过 `src/web/platform/android-bridge.ts` 调用，不允许把任意文件路径、命令或网络地址透传给原生层。`android/` 是可同步的 Capacitor 工程，`RelayNativePlugin.kt` 已注册到 `MainActivity`；当前已接入本地 Vault/SQLite、SSH/PTY、Host Key、ProxyJump、SFTP 浏览/变更/分块传输，以及 Android 确认框和 SAF 文件保存。

本地命令：

```bash
npm run build:android:debug
npm run build:android:release
```

当前环境已准备 JDK 21、Gradle wrapper、Android API 36 和 Build Tools 35.0.0；JSch 2.27.7 依赖可离线复用。Kotlin 编译和 Android 单元测试已通过，但仍没有 Android 真机/模拟器，因此 Keystore 实机行为、SSH/SFTP 真实连接、后台生命周期和安装任务不能宣称完成；不能用 Web Relay 服务代替 Android 独立客户端验证。

当前 Android native capability 已包含本地 Snippet 管理；Snippet 内容在 Android Vault 中按记录加密，WebView 只在用户打开编辑器时读取命令模板，不会读取主机凭据。

原生实现必须满足：

- 每个请求带 `version/requestId/operation/payload`，只接受 allowlist 操作；响应必须关联同一 `requestId`。
- 事件带 `generation/sequence` 以及 `sessionId` 或 `transferId`，输出和文件流单块不超过 32 KiB，事件处理不得积压无界队列。
- Vault 主密码、私钥、passphrase 只能进入受信原生方法，不写日志、通知、WebView 存储或系统备份。
- Host Key、远程路径、传输目标和取消逻辑由原生层再次校验；进程恢复时重新读取任务状态，旧 Shell 句柄显示 `needs-reopen`。
- 当前 native capability 只广告已接入的本地工作区、身份/分组、终端外观、Vault bundle、Snippet、批量命令、SSH/ProxyJump、SFTP 和有限断点传输；Activity 审计、外部导入、后台 UI 恢复和真实设备验证仍隐藏为后续增量。命令与传输任务的状态会写入 app-private SQLite，进程重启或 Vault 锁定时运行中的任务标记为 `interrupted`，解锁后可读取有限历史结果。批量命令限制为最多 8 台主机、4 个原生 worker、每目标 16 KiB 输出；Vault bundle 通过 32 KiB 分块跨越 64 KiB Capacitor 帧，原生侧最多保留一个带 TTL 的导入/导出/预览缓冲。

低内存构建默认使用 `org.gradle.jvmargs=-Xmx768m`、单 worker、关闭 Gradle 并行；真实 CI/发布机可在测量峰值后单独提高预算。

在具备 Android SDK 和真机后，先完成密码/私钥、PTY、逐跳 Host Key、ProxyJump、SFTP、取消与断线释放的真机 PoC，再将当前 SSH 库候选转为发布选型。
