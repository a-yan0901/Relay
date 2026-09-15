# SSH Productivity 路线图交付说明

日期：2026-09-15

## 1. 版本定位

本版本将 Web SSH MVP 演进为 Web-first、local-first 的生产力工作台，围绕一条完整任务链交付：

> 找到主机 → 可靠连接 → 在同一上下文传文件/执行命令 → 查看结果 → 断线后恢复。

Web 是当前唯一的一等客户端。服务端继续维护单实例、单 Vault、单用户边界；跨端能力通过 shared core、`CoreRuntime`、wire protocol、capability 和 adapter contract 预留，不在本版本引入桌面或移动 UI 框架。

## 2. 已交付能力与优先级

### P0：可靠底座

- 持久化工作区保存 tab 意图、活动 tab、分屏模式、比例和筛选状态。
- 浏览器刷新时使用当前标签页的非敏感 sessionStorage 描述尝试复接 live session；应用进程重启后恢复 tab 意图并创建新 shell，不伪造旧会话仍存活。
- Vault bundle 使用独立导出密码和 Argon2id/AES-GCM 加密，支持导出、解密预览、冲突确认和事务导入；导出密码不进入 bundle、数据库或日志。
- 连接统一经过阶段诊断、按主机保存的 Keepalive/自动重连策略和资源生命周期；Host Key 首次连接需确认，已知指纹变化硬失败。

### P1：高频任务闭环

- 主机支持最多四级有序 ProxyJump；每一跳独立使用 Host Key policy，服务端按 owner 重新解析跳板图并拒绝缺失主机、环和超长路径。
- SFTP 与 SSH 共用认证、Host Key 和跳板路径，支持目录列表、元数据、新建目录、重命名、删除、上传和下载。
- 上传先写 `${target}.relay-tmp-${transferId}`，完成后原子重命名；失败或取消会尽力清理临时文件，不把半文件暴露为目标文件。
- 传输队列提供 queued/running/completed/failed/cancelled 状态、进度、取消和失败重试；路径拒绝 NUL、控制字符、反斜杠和规范化后的目录越界。
- Snippets 使用 Vault 加密 payload 和显式 `{{variable}}` 变量；批量执行前展示主机、展开命令、并发、超时和输出保存选项。
- 批量任务默认并发 4、最大 16，单主机默认超时 60 秒，单主机输出默认上限 256 KiB；多主机和高风险命令需要显式确认，单台失败不会隐藏其他主机结果。

### P2：复盘和审计

- 活动面板显示连接、工作区、SFTP 和批量任务的结构化摘要，并支持按事件类型和主机筛选。
- 批量结果按主机隔离；只有用户选择保存输出时才写入加密存储，结果超出 TTL 后清理，活动链接显示“结果已过期，需要重新执行”。
- 审计 metadata 只允许 runId、transferId、targetCount、successCount、failureCount、durationMs 等固定非敏感字段；不写入完整命令、变量值、凭据、终端内容或文件内容。

## 3. 跨端与跨平台基础

`src/shared/core` 提供平台无关的模型、状态机、错误码、能力集合、`CoreRuntime` 和 ports。完整 runtime 需要覆盖 Vault session、Host/Identity/Group/Workspace/Snippet/Activity store、ConnectionProbe、Session/File/Command transport、SecretStore 和 ImportExportPort；它不依赖 Node、DOM、React、浏览器 WebSocket、浏览器文件对象或 ssh2。

Web adapter 提供 HTTP/WSS、Cookie、浏览器 WebSocket、服务端文件传输和服务端 Vault 边界。当前 Web-first 页面仍有少量应用生命周期、主机 CRUD 和轮询的薄 API wiring，这是待收口的架构 gap，不得作为未来客户端的业务范式。未来桌面版可在 Windows/Linux 通过桌面 shell 接入 OS keychain；Android 通过 Keystore 接入；两者可以替换为本地 SSH，也可以继续使用服务端 transport，但都必须实现相同的 shared ports：

- Host Key 确认、跳板诊断和错误语义不变；
- SFTP 路径规范化和批量目标确认不变；
- 并发、超时、输出上限、取消和 TTL 语义不变；
- 文件上传/下载和导入/导出使用 `Uint8Array`/`AsyncIterable<Uint8Array>`，不把浏览器 `File`/`Blob` 传播到 shared core；
- 活动日志保持结构化脱敏；
- 业务代码按 capability 判断可用性，不按平台名称复制分支；不支持时返回 `CAPABILITY_UNAVAILABLE`。

## 4. 数据与安全边界

- 持久化工作区只包含非敏感意图；terminalId 仅用于当前服务进程和浏览器 sessionStorage 的 live reattach。
- 主机密码、私钥、passphrase、Snippet 内容和选择保存的批量输出在服务端 Vault 解锁后按需使用，数据库中保持密文。
- 不在浏览器 localStorage/sessionStorage 保存主密码、主机凭据、导出密码、bundle、cookie、token 或命令输出。
- 应用重启后内存 SSH session、传输任务和批量任务不保证继续执行；服务端返回任务不存在或创建新 shell，而不是伪造恢复状态。
- 仍建议使用 HTTPS/WSS 反向代理、保护 `/data` 备份和宿主机运行用户，并把备份视为敏感数据。

## 5. 验证范围

交付验证覆盖：shared core 单元测试、fake/Web adapter contract tests、shared 静态依赖检查、服务端 repository/service/API 集成测试、真实 OpenSSH shell/SFTP 集成、浏览器 DOM 测试、Playwright 工作流、锁定与重启边界、Node/浏览器 TypeScript 编译、Lint 和 Web/Server 构建。

## 6. 明确后置项

端口转发、X11、RDP/VNC、Telnet、串口、远程编辑器、交互式终端录制、团队共享/RBAC/SSO、云端或第三方同步、实时协作，以及 Windows/Linux/Android 原生 UI 均不属于本版本交付。
