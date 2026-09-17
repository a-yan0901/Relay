# Relay Android client boundary

本目录固定 Android Capacitor 插件的最小边界，React 侧通过 `src/web/platform/android-bridge.ts` 调用，不允许把任意文件路径、命令或网络地址透传给原生层。

当前仓库环境没有 Android SDK、JDK/Gradle、Capacitor Android 工程或真实设备，因此这里先提交可审查的插件契约和内存限制；任务 4/11/12 的 SSH/SFTP 真机验证仍是发布前置条件，不能用 Web Relay 服务代替。

原生实现必须满足：

- 每个请求带 `version/requestId/operation/payload`，只接受 allowlist 操作；响应必须关联同一 `requestId`。
- 事件带 `generation/sequence` 以及 `sessionId` 或 `transferId`，输出和文件流单块不超过 32 KiB，事件处理不得积压无界队列。
- Vault 主密码、私钥、passphrase 只能进入受信原生方法，不写日志、通知、WebView 存储或系统备份。
- Host Key、远程路径、传输目标和取消逻辑由原生层再次校验；进程恢复时重新读取任务状态，旧 Shell 句柄显示 `needs-reopen`。

在具备 Android 工具链后，使用 Capacitor Android 工程承载 `RelayNativePlugin.kt`，并先完成密码/私钥、PTY、逐跳 Host Key、ProxyJump、SFTP、取消与断线释放的真机 PoC，再锁定 SSH 库版本。
