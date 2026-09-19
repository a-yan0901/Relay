# Android 偏好重启 CDP 证据

日期：2026-09-19（Asia/Shanghai）

## 范围

验证 Android 原生 terminal profile 与 Web 偏好主题之间的同步，重点覆盖“选择主题/字号 → 强制停止进程 → 重启 → 解锁 Vault → 偏好仍保持”。本记录不保存 Vault 主密码、服务器密码、私钥或 Host Key 原文。

## 设备和制品

| 设备 | Android | ADB serial | 结果 |
| --- | --- | --- | --- |
| Xiaomi `2407FRK8EC` | 16 / API 36 | `adb-8DWSM7Y9IBCMPJSC-oak1zL._adb-tls-connect._tcp` | 安装成功、复验通过 |
| Xiaomi `25091RP04C` | 16 / API 36 | `192.168.1.3:46545` | 安装成功、复验通过 |

APK：`apps/android/android/app/build/outputs/apk/debug/app-debug.apk`
大小：`8,633,755` bytes
SHA-256：`561351D1B83050CD3F60D358675366E4379BF7AC146D290440C601300314AA9B`

两台设备执行：

```text
adb install -r -g --no-streaming app-debug.apk
```

均返回 `Success`。

## 操作和观察

1. 启动 `cn.ayan.relay`，使用预置测试 Vault 主密码解锁；主密码只在设备 UI 操作中输入，未写入本记录。
2. 打开“偏好设置”，选择 `Everforest Dark`，将“终端字号”设为 `16px`。
3. 通过 ADB 执行 `am force-stop cn.ayan.relay`，再使用 `monkey -p cn.ayan.relay 1` 启动应用。
4. 再次解锁 Vault，并通过 WebView CDP 读取 UI 和 `localStorage`：

```text
document.documentElement.dataset.relayTheme === "everforest-dark"
document.querySelector("select[aria-label=\"终端字号\"]").value === "16"
localStorage.getItem("relay.ui.preferences.v1")
  === "{\"theme\":\"everforest-dark\",\"fontSize\":16,\"serverViewMode\":\"list\"}"
```

两台设备均满足以上断言；偏好面板重新打开后选中卡片为 `Everforest Dark`，字号 select 为 `16`。`25091RP04C` 的 `Provided Acceptance Host` 仍在，旧 Console 显示“此 Console 需要重新连接”，没有把失效的原生 Shell 伪装成已连接。

## 结论和边界

本证据确认 Android 内置主题 profile 不再在解锁时把主题复位为 Termius，A-14 的主题/字号部分已通过重启复验。grid/list、旋转、软键盘、安全区和完整视觉走查不在本轮证据内，因此 A-14 整体仍保持待执行。
