# Relay 独立 Windows 与 Android 客户端设计

**日期：** 2026-09-17

**状态：** 已按独立客户端方向修订；原生实现尚未交付。

## 产品边界

Relay 的目标是多端、多平台独立客户端。Windows 与 Android 安装后分别拥有本地数据、Vault、SSH/SFTP 执行能力；用户填写目标 SSH 主机即可连接，不需要先部署或填写 Relay 服务地址。账号及云端服务只用于后续跨设备加密同步，不参与 SSH 连接、SFTP 或本地工作区的基本流程。本期交付范围是 Windows 桌面版与 Android app；云端同步服务只保留可选接口和数据格式，不作为本期验收项。

当前 Web 继续使用既有 Relay 服务端执行 SSH。此前 [平台 shell 草案](./2026-09-16-relay-platform-shell-design.md) 的“Android 首版 server-mediated”及本文件上一版的“Android 配置 Relay 服务”属于已被本次产品决定取代的方案。历史文档保留决策记录；本期实施以本文件为准。

## 现有基础与缺口

[跨平台架构](../../architecture/cross-platform.md) 中 `src/shared/core` 已有领域模型、状态机、错误码、Host/Workspace/Session/File/Command 等 ports、capability 和 runtime；Web 有 `src/web/platform/web-adapters.ts` 及 React 页面。现有 `ssh2`、SFTP、Vault 和 SQLite 实现在 `src/server`，依赖 Node，不能直接在 Android 上运行。因此“核心统一”目前指统一业务契约与规则，尚不意味着 SSH 协议引擎是一份可在 Android 原生环境直接执行的代码。本期要补齐 Android 本地执行 adapter，并让两端通过同一 `CoreRuntime` 契约呈现一致行为。

## 架构决定

| 层 | Web 现状 | Windows 本期 | Android 本期 |
| --- | --- | --- | --- |
| UI | React 页面和主题 | 同一 React 页面，桌面窗口/菜单适配 | 同一 React 页面，手机导航/触控/软键盘适配 |
| 领域核心 | `src/shared/core` | 复用同一 TypeScript 核心 | WebView 中复用同一 TypeScript 核心 |
| SSH/SFTP | Node `ssh2` 服务端 | 应用内置本地 Node 执行端，复用现有实现 | Android 原生 SSH/SFTP adapter，通过受限 bridge 实现 shared ports |
| 数据/Vault | 当前 Relay 实例的 SQLite/Vault | 用户设备上的独立 SQLite/Vault 目录 | Android app 私有存储中的本地库/Vault，密钥由 Keystore 保护 |
| 账号/云同步 | 现有 Web/自托管切片 | 可选接口保留，首版不依赖账号 | 可选接口保留，首版不依赖账号 |

选择共用 React UI 与平台 shell，保留当前 Web 视觉与交互语义；Windows 采用 Electron，本地执行端单独进程；Android 采用 Capacitor 与原生插件。本设计不要求在不同 CPU/运行时直接运行同一份 `ssh2` 二进制。统一的是领域规则、DTO、状态、错误码、测试契约、页面和设计 token；协议实现经 `SessionTransport`、`FileTransport`、`SecretStore` 等端口适配。Android 原生层仍须再次执行 Host Key 与路径等安全校验，不能只信任 WebView UI。

Windows Electron 的 main/renderer 分离见 [官方进程模型](https://www.electronjs.org/docs/latest/tutorial/process-model)；Capacitor 提供 Android 原生插件与 Web UI 桥接，见 [官方文档](https://capacitorjs.com/docs)。Android SSH 库须先在真实 Android 环境验证密码、私钥、PTY、Host Key、ProxyJump 和 SFTP。候选 Apache MINA SSHD 官方明确表示未正式验证 Android 兼容性，不能把它的存在当成已通过的技术选型，见 [Android 支持说明](https://github.com/apache/mina-sshd/blob/master/docs/android.md)。若候选库无法满足本期能力矩阵，应在选择库前以原生 PoC 比较替代方案，不改变独立客户端要求。

## 本地数据与未来同步

两端安装后即提供 Local 模式：Host、Identity、Group、Snippet、Workspace、终端主题、Host Key 信任和 Vault 保存在本机；断开互联网但目标 SSH 主机在局域网可达时仍能连接。普通应用数据与秘密分层：Windows 使用现有加密 Vault 和用户专属数据目录，Android 使用 app 私有库加 Keystore 包装的密钥；主密码、私钥和 passphrase 不进入 WebView 的 localStorage、日志或普通备份。

保留 `CoreRuntime` 的可选 `account`、`devices`、`sync` ports、设备标识与版本化加密快照格式。云服务未接入时不实例化这些 ports、不发任何云请求，UI 显示“仅此设备”并隐藏不可用的登录/同步动作。已有 Web/自托管同步实现不得被误写为本期独立云服务已经部署。未来登录并解锁 Vault 后才允许同步 Host、Identity、Group、Snippet、工作区模板/偏好及经确认的 Host Key；live Shell、终端输出、SFTP 文件和任务运行态仍不上传。未来云服务必须独立于两个客户端，客户端本地 SSH 不依赖其在线状态。

## 一致体验与平台适配

共享 Host grid/list、搜索、连接状态、主题、终端、全屏 SFTP、传输中心和错误文案。Windows 保持左侧分组、快捷键、右键菜单、多标签/分屏；Android 使用搜索优先、单 pane、触控长按菜单、软键盘工具条和系统返回。两者由相同 React 组件与设计 token 派生，允许布局与输入方式变化；Host Key、批量命令预览、重连和传输终态保持相同业务语义。移动端必须验证字体缩放、旋转、软键盘避让、终端最后一行与 SFTP 滚动。

共享层不得导入 DOM、Node、Electron 或 Android API。Windows renderer 无 Node 权限，原生功能经 allowlist preload/IPC；本地执行端仅监听 loopback，并校验本地调用者。Android bridge 仅暴露明确操作，不允许任意文件路径、网络地址或命令透传；文件选择使用系统授权 URI，传输结束释放权限。Android 连接、Shell、SFTP 和批量任务全部在设备上执行；网络切换或 app 进后台后先查询本地真实状态，再显示 `reconnecting`、`interrupted` 或 `needs-reopen`。任何平台不得凭 UI 缓存伪造 `connected`。

## 验收

在未部署 Relay 云服务、未登录账号、未填写 Relay 服务地址的条件下，Windows 与 Android 各自完成：创建 Host 和凭据、首次 Host Key 确认与变更拒绝、SSH Shell 输入/复制/重连、SFTP 浏览与上传下载、Vault 锁定/重新打开、主题选择与本地数据持久化。两端断开账号网络但目标 SSH 主机仍可达时，基本操作继续可用。共享 contract 与原生真实设备走查都要通过；Android 的原生 SSH 库、Keystore、文件 URI 和后台恢复必须有设备证据。云同步仅验证可选 port 缺席时本地工作完整，不把云服务当作本期交付。

本期不做云端同步服务、团队 Vault、跨设备 live session 迁移、Android 后台常驻 SSH 或 Windows 第二套 SSH 引擎。发布签名与应用商店上架作为后续发布流程单列。
