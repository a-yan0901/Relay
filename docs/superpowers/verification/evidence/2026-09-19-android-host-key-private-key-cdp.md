# Android 真机 Host Key 变化与私钥认证证据

**日期：** 2026-09-19
**设备：** `25091RP04C`，Android 16/API 36；ADB `192.168.1.3:46545`
**APK：** `app-debug.apk`，8,633,755 bytes，SHA-256 `068A16E94F09EA90C97F609DD456BDEE0874F830FC57668C364A8C997DB18C89`

## A-03 Host Key 变化

1. 在 Android 真机 WebView 中创建临时密码 Server，连接本机局域网 SSH fixture `192.168.1.5:22222`，首次指纹为 `SHA256:Mwpc9/BUKSNLtRQItaoaS2hk0KsSQtDwD+THaZNZ09o`。
2. 显式信任后关闭 Console；停止 fixture 并以同一地址/端口启动不同 Host Key 的 fixture，新指纹为 `SHA256:3RMCc2uAJSamXqa8XS0y0DsilvmorT8eermilfSQ5Ak`。
3. 重新打开 Server 时真实 UI 显示 `HOST KEY CHANGED`，同时显示旧/新算法和 SHA-256 指纹。
4. 点击“拒绝并保留旧信任”后，UI 显示“远程主机指纹与已保存指纹不一致”；再次打开仍显示 Host Key 变化，证明旧信任没有被静默替换。
5. 只有点击“信任并替换 Host Key”后才重新建立 Shell；Server 卡片随后显示新指纹。

结论：A-03 在该 Android 16 真机、可控真实 SSH fixture 上通过。fixture、临时 Server 和连接数据已清理。

## A-04 私钥认证增量

1. 生成仅用于本轮的临时 Ed25519 私钥，并以 `private_key` 方式创建 Android Server，目标为用户提供的 `106.14.61.92:22`/`t2` 测试主机。
2. 真机 UI 首次显示真实 Host Key 指纹；显式信任后，使用私钥认证建立 Shell。
3. Console 输入 `echo ANDROID_PRIVATE_KEY_ACCEPTED`，收到同名远端回显和 `t2` 提示符。

本条只记录私钥正向链路；错误私钥/错误口令、日志中不出现私钥以及完整 A-04 失败矩阵仍待执行。临时公钥已从测试主机 `authorized_keys` 移除，私钥已从本机临时目录删除。
