# Android 真机私钥失败路径证据

**日期：** 2026-09-19
**设备：** `25091RP04C`，Android 16/API 36；ADB `192.168.1.3:46545`
**APK：** `app-debug.apk`，8,633,755 bytes，SHA-256 `5017F5ADBCCFA724D2601CD61AA9AED0893D229AA6B42966BB233FFC8A3FFDAE`

## A-04 错误私钥/口令

1. 在新 APK 上初始化本地 Vault，创建仅用于本轮的 `private_key` Server；测试私钥和口令均为故意不可用的合成测试数据，不记录其内容。
2. 真机 UI 发起连接后，native 事件顺序为 `connecting` → `terminal.error(code=SSH_AUTH_FAILED)` → `failed` → `terminal.close(clean=false)`。
3. UI 显示“远程服务器认证失败”和“编辑 Server 凭据”，没有进入可重试的 `SSH_CONNECTION_FAILED` 循环，也没有显示私钥内容。
4. 删除临时 Server 后，native `hosts.list` 返回空列表；未向测试主机、本仓库或证据文件写入私钥/口令。

## 回归修复

- 根因是 JSch 的 `invalid privatekey`/passphrase 类异常此前被映射为可重试的 `SSH_CONNECTION_FAILED`。
- `AndroidJschConnectionTest.mapsPrivateKeyParsingFailuresToAuthenticationFailure` 先在旧实现上失败，加入映射后定向测试通过。
- `:app:assembleDebug`、`:app:connectedDebugAndroidTest` 均成功；两台设备各完成 `7/7` instrumentation。connected 测试完成后两台设备再次安装当前 APK，ADB 安装均返回 `Success`。

本证据只补齐 A-04 错误私钥/口令的增量；完整 logcat、WebView 持久化和系统备份秘密扫描仍需单独完成。
