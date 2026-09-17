# Relay Android client boundary

本目录固定 Android Capacitor 插件的最小边界，React 侧通过 `src/web/platform/android-bridge.ts` 调用，不允许把任意文件路径、命令或网络地址透传给原生层。`android/` 是可同步的 Capacitor 工程，`RelayNativePlugin.kt` 已注册到 `MainActivity`；SSH/Vault/SFTP executor 仍需在原生可行性门槛后接入。

本地命令：

```bash
npm run build:android:debug
npm run build:android:release
```

当前环境已准备 JDK 21、Gradle wrapper、Android API 36 和 Build Tools 35.0.0；Kotlin 编译与 debug APK 打包已通过。仍没有 Android 真机/模拟器，Keystore、SSH/SFTP executor、生命周期和真实连接任务仍未宣称完成；不能用 Web Relay 服务代替 Android 独立客户端验证。

原生实现必须满足：

- 每个请求带 `version/requestId/operation/payload`，只接受 allowlist 操作；响应必须关联同一 `requestId`。
- 事件带 `generation/sequence` 以及 `sessionId` 或 `transferId`，输出和文件流单块不超过 32 KiB，事件处理不得积压无界队列。
- Vault 主密码、私钥、passphrase 只能进入受信原生方法，不写日志、通知、WebView 存储或系统备份。
- Host Key、远程路径、传输目标和取消逻辑由原生层再次校验；进程恢复时重新读取任务状态，旧 Shell 句柄显示 `needs-reopen`。

低内存构建默认使用 `org.gradle.jvmargs=-Xmx768m`、单 worker、关闭 Gradle 并行；真实 CI/发布机可在测量峰值后单独提高预算。

在具备 Android SDK 和真机后，先完成密码/私钥、PTY、逐跳 Host Key、ProxyJump、SFTP、取消与断线释放的真机 PoC，再锁定 SSH 库版本。
