# Android 私密字段日志边界复核

**复核日期：** 2026-09-19
**设备：** `25091RP04C`（Android 16/API 36）
**关联 APK：** `app-debug.apk`，8,633,755 bytes；当前复核构建 SHA-256：`B66C9A27786A9996CE9658CBEC3A6AA8A8ACEEC7C0032C0D9FACD9ECD74AD058`

日志哨兵扫描直接执行于同日的前一构建 `DA17306211950D0E03CA367029313F3245FE887CDC7909AD526BF7363F5903E0`；当前 `B66C...` 构建只新增 JSch malformed Base64 错误映射，保留相同的 Capacitor 日志配置。

## 复核范围

- 使用只含合成数据的临时 Host payload，在私钥和口令字段中放入一次性、无业务含义的哨兵值；未使用用户真实私钥或密码。
- 清空设备 logcat 后，通过 WebView CDP 调用原生 Host/Shell bridge，再检查普通 logcat、WebView `localStorage`、`sessionStorage` 和 IndexedDB。
- 测试结束删除临时 Host，并通过 native `hosts.list` 确认没有残留。

## 发现与修复

- 修复前，Capacitor Android `Bridge` 的 verbose callback 日志会把插件调用的 `methodData` 序列化到 logcat；该形状可能包含私钥和口令字段。证据只记录字段形状，不保留任何真实或合成秘密值。
- `apps/android/capacitor.config.ts` 已设置 `android.loggingBehavior: 'none'`，并重新执行 Capacitor sync，使配置进入 Android 资源。
- 修复后，logcat 未匹配到哨兵值；WebView 三类存储也未匹配到哨兵值。APK manifest 同时保持 `android:allowBackup="false"`。
- JSch 的 malformed private-key Base64 错误也已归类为 `SSH_AUTH_FAILED`，避免错误私钥被误报为可重试连接失败；对应 Android 单元回归通过。

## 设备回归

- 最新 APK 的 `:app:connectedDebugAndroidTest` 在 `25091RP04C` 和 `2407FRK8EC` 均完成 `7/7`，Gradle 返回 `BUILD SUCCESSFUL`。
- connected runner 清理应用后曾再次触发 `INSTALL_FAILED_USER_RESTRICTED`；重新触发安装后，两台设备均成功安装当前 APK，并通过 `pm path cn.ayan.relay` 验证 package path 存在。

## 未覆盖边界

这不是完整 A-16 通过证据：尚未完成系统备份导出/恢复、长时间进程日志审计及所有密码/私钥失败组合。因此 A-04/A-16 仍保持部分证据或待执行状态。
