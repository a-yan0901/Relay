
# Relay SSH 重连与剪贴板可靠性设计

**状态：** 已确认设计，待按实施计划执行（2026-09-17）。

## 1. 目标

本次修复覆盖三个直接影响 Console 可用性的跨层问题：

1. 远端重置 SSH 连接时，ssh2 的 ECONNRESET 不得以未处理 error 事件的形式让 Node 进程崩溃。
2. SSH Shell 异常断开时，Console 要区分“原 Shell 已失效，需要创建新 Shell”和“网络暂时中断，可以自动重连”，并在网络恢复后继续连接。
3. HTTP 部署下，浏览器即使不能读取系统剪贴板，也应尽可能支持复制；复制不应因为粘贴能力不可用而永久置灰。

## 2. 当前根因

### 2.1 ssh2 连接错误没有稳定的生命周期监听器

src/server/ssh/ssh2-adapter.ts 的 connectClient() 在连接阶段使用一次性 error 监听器。收到 ready 后，清理逻辑移除了该监听器；Ssh2ConnectionResource 当前只监听最终 Client 的 close，没有为已经建立的 Client 保留 error 监听器。因此远端在连接建立后发出 ECONNRESET 时，Node EventEmitter 找不到 error listener，会抛出未处理异常。

ProxyJump 链路上的每个 Client 都有同样的风险，不能只修最终目标 Client。

### 2.2 远端 Shell 断开没有进入前端的可重试路径

SshSessionManager 已经会在 Channel close 时释放旧 Session，这为重新创建 Shell 提供了正确的服务端基础。但 terminal-gateway.ts 目前把 Channel close 统一通知为 closed，而 use-terminal-session.ts 收到 error 后会无条件设置 retryBlocked。结果是：

- WebSocket 断开可以走已有的指数退避重连；
- SSH Channel 在 WebSocket 仍存活时断开，却不会自动建立新的 WebSocket/Shell；
- 从工作区恢复的 Console 如果仍保留 reattachOnly，即使旧 Shell 已经释放，后续重试也可能只尝试 reattach，无法创建新 Shell。

### 2.3 剪贴板能力被读写能力绑定

browser-system-services.ts 要求安全上下文、readText 和 writeText 同时存在，web-adapters.ts 也只有在读写能力同时可用时才暴露 ClipboardPort。用户通过 http://IP:5173 访问时，浏览器通常禁止异步读取剪贴板，但复制仍可以通过用户手势和 document.execCommand('copy') 完成；当前实现把这种写入能力也隐藏了，导致 Console 复制菜单长期置灰。

## 3. 设计决策

### 3.1 SSH2 错误隔离和一次性关闭

- 连接阶段继续使用临时 error/ready/close 监听器，确保认证失败仍能通过现有 AppError 映射返回。
- Client ready 后，必须保留持久化 error listener；ProxyJump 的每一跳和最终 Client 都安装该 listener。
- 持久化监听器只把底层错误转换为应用层连接故障，不向客户端暴露原始错误文本；ECONNRESET 使用 SSH_CONNECTION_FAILED。
- Ssh2ConnectionResource 负责把一次底层连接故障广播给活动 Channel、生成一次失败诊断、关闭所有 Client，并只发送一次 closed 状态。
- SshChannelBridge 在资源因连接故障终止时触发自己的 error/close 生命周期；重复的 Client error、Channel close 或显式 close() 都必须幂等。
- 连接故障不能让 EventEmitter 重新抛出 error；没有上层 listener 时，Bridge 也必须安全吞掉已归一化的内部错误。

### 3.2 网关与 Console 的断连语义

继续复用现有协议字段和错误码，不新增协议版本：

- 正常远程进程退出：发送现有 exit，随后 closed；不自动重连。
- 用户主动关闭：保持现有关闭流程；不自动重连。
- Channel 出现 error，或在没有 exit、没有显式关闭的情况下异常 close：发送一次 SSH_CONNECTION_FAILED，并将状态标记为 interrupted。
- ssh2 resource 的 closed 回调也必须经过同一判定：连接仍 active 且没有 exit/显式关闭时视为异常断连，不能直接覆盖为 closed。
- Gateway 要对异常通知去重，避免同一个 reset 同时产生多次错误和多次重连。
- Channel 已被 SessionManager 释放后，新的 WebSocket 使用同一 Console 的 requestId 再次 open 时，若没有可 reattach 的旧 Session，服务端创建新的 Shell。

前端状态规则：

- SSH_CONNECTION_FAILED 在已有连接上的语义是可重试；关闭当前失效 WebSocket，使用现有指数退避策略重新创建 WebSocket。
- 自动重连使用同一 terminalId/requestId，但已成功建立过连接的 Controller 不再发送 reattachOnly，以便旧 Shell 消失后创建新的 Shell。
- 网络离线时暂停计时器，进入 interrupted；online 事件恢复后立即调度一次连接。
- 认证失败、Host Key 错误、协议错误、服务实例变化和 SESSION_NEEDS_REOPEN 仍是人工处理路径，不自动循环。
- 自动重试耗尽时保留 failed 状态和明确文案；用户点击“重新连接/重新打开”时清理阻塞标志并创建新的连接。

### 3.3 剪贴板能力拆分

在跨端 Port 上增加可选能力标记，兼容现有平台和测试 double：

~~~ts
export interface ClipboardPort {
  readText(): Promise<string>;
  writeText(text: string): Promise<void>;
  canRead?: boolean;
  canWrite?: boolean;
}
~~~

- 未提供标记的旧 Port 按读写均可兼容处理。
- readText 仍只在安全上下文且浏览器提供异步读取时可用。
- writeText 在安全上下文优先使用 navigator.clipboard.writeText；不可用或失败时，在存在文档 execCommand('copy') 的浏览器中使用临时 textarea 降级。
- 降级复制只在用户操作回调中执行，不持久化剪贴板内容，不把内容写入日志。
- web-adapters.ts 只要 clipboardRead 或 clipboardWrite 成立就暴露 ClipboardPort。
- TerminalPanel 分别根据 canRead 和 canWrite 控制粘贴与复制；有选区且可写时复制可用，可读能力不足只禁用粘贴。
- 本次保持当前紧凑工作区布局，不恢复占用大块空间的旧版完整顶部工具条；修复右键菜单、Ctrl/Cmd+C 和现有 toolbar callback 的能力判断。若后续需要新增显式顶部复制按钮，另立 UI 任务。

## 4. 非目标

- 不新增 SSH 重试协议版本、数据库表或迁移。
- 不把原始 Node/ssh2 错误消息传给浏览器。
- 不在服务端无限重试 SSH；重试节奏由现有连接配置和前端 WebSocket Controller 管理。
- 不绕过 Host Key、凭据确认或高风险粘贴确认。
- 不在 HTTP 环境中伪造剪贴板读取能力。
- 不恢复完整旧版 Toolbar，不改变已经完成的顶部空间压缩。

## 5. 验收标准

### SSH2 与服务端

- 已建立的目标 Client 和 Jump Client 收到带 code: ECONNRESET 的 error 时，Node 进程不崩溃。
- 一个 reset 最多生成一个连接失败诊断、一个可重试错误和一次资源关闭。
- Channel 监听者能收到 error/close，SessionManager 最终释放旧 Session。
- 正常 Shell exit 和显式关闭不会被误判为异常重连。

### Console 重连

- 已连接 Console 模拟远端 reset 后进入 interrupted/reconnecting，并在退避时间后创建新的 WebSocket。
- 新的 open 请求不会携带过期的 reattachOnly，旧 Shell 已释放时会创建新 Shell。
- 浏览器离线期间不创建连接；网络恢复后自动恢复连接。
- 认证、Host Key、服务重启和会话失效仍停留在人工处理状态。
- 自动重试耗尽后显示“此 Console 需要重新连接 / 原来的远程 Shell 不再可用 / 重新打开会创建新的 Shell”语义。

### 剪贴板

- HTTPS/安全上下文中的原生读写行为保持不变。
- HTTP 且只有 legacy copy 时，复制能力为 true、粘贴能力为 false。
- 右键菜单有选区时复制可执行；没有选区时复制仍按现有语义禁用。
- HTTP 下粘贴不可用时不会影响复制，也不会将不可用的粘贴误报为可用。
- 浏览器 Clipboard API 或 legacy copy 失败时显示稳定的能力错误和现有反馈文案。

## 6. 验证策略

先跑 SSH2、网关、Session Controller、浏览器服务和 TerminalPanel 聚焦测试；跨层行为完成后运行 typecheck、lint、Web build 和相关 E2E；所有实现完成后运行 npm test 全量测试，因为本次修改触及 Node 进程稳定性、WebSocket 生命周期和 shared Platform Port。
