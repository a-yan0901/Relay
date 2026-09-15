# 跨端与跨平台基础

Relay 当前以 Web app 为核心客户端，服务端负责 SSH、SFTP、批量命令和 Vault 的执行边界。桌面版后续覆盖 Windows 和 Linux，Android 版复用同一套 shared core、错误码和 wire protocol，再替换 transport 与 secret store；本阶段不绑定 Tauri、Electron 或移动 UI 框架，也不提前实现原生 UI。

## 不变的核心

- `src/shared/core/models.ts` 定义 Host、Workspace、SFTP transfer、CommandRun、Activity 和 capability 模型。
- `src/shared/core/ports.ts` 定义 `SessionTransport`、`FileTransport`、`CommandTransport`、`HostStore` 和 `SecretStore`。
- `src/shared/validation.ts`、错误码和状态机在所有客户端复用。
- Host Key 确认、跳板路径、SFTP 路径规范化、批量目标确认、输出上限和审计脱敏是跨端不变量。

## Web adapter

`src/web/platform/web-adapters.ts` 提供 HTTP/WSS、浏览器 WebSocket 和 Web 端 secret 限制的适配实现，并以 contract tests 固定跨端语义。当前 Web-first 页面仍保留少量应用生命周期、主机 CRUD 和轮询的薄 API wiring；这些调用不进入 shared core，后续桌面/Android 客户端可直接复用 ports 和 models。Web 不在 `localStorage` 或 `sessionStorage` 保存主密码、服务器凭据、导出密码、bundle、token 或命令输出。

服务端通过 `GET /api/capabilities` 返回版本化能力集合。客户端应按 capability 判断功能是否可用；不能根据平台名称复制业务分支。未支持的操作统一返回 `CAPABILITY_UNAVAILABLE`。

## Desktop / Windows / Linux / Android 适配要求

Windows/Linux 桌面端可以使用 OS keychain 或桌面安全存储，Android 端使用 Android Keystore；三者仍需保持同样的状态语义和确认步骤。替换 transport 时必须保留：

- 每一跳独立的 Host Key 校验与可解释诊断；
- 远程路径拒绝控制字符和越界 `..`；
- 多主机执行前展示完整目标、展开命令、并发、超时和输出保存选项；
- 结果按主机隔离，输出有大小和 TTL 限制；
- 活动日志只记录脱敏结构化摘要，不记录交互式 shell 原始输入输出。

平台差异应存在于 adapter，不应进入 shared core 或改变服务端的安全默认值。
