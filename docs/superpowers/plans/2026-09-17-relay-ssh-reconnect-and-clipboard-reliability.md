
# Relay SSH Reconnect and Clipboard Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复 SSH2 远端重置导致的 Node 崩溃、让异常 Console 能自动重连并在网络恢复后创建新的 Shell，同时让 HTTP 部署下的 Console 复制能力不再因粘贴能力缺失而置灰。

**Architecture:** 保持现有 SSH2 resource、SessionManager、Terminal Gateway 和 TerminalSessionController 分层。SSH2 resource 对每个已建立 Client 安装持久化错误监听并以幂等方式终止 Channel；Gateway 使用现有 interrupted、SSH_CONNECTION_FAILED 和 SESSION_NEEDS_REOPEN 语义区分自动重连与人工重新打开；Web platform 将 ClipboardPort 拆分为读写能力，使用 legacy copy 支持 HTTP 写入，TerminalPanel 只按实际能力启用复制或粘贴。

**Tech Stack:** Node.js 22+, TypeScript, ssh2, Fastify, WebSocket, React 19, xterm.js, Vitest, React Testing Library, Playwright。

**Spec:** `docs/superpowers/specs/2026-09-17-relay-ssh-reconnect-and-clipboard-reliability-design.md`

## Global Constraints

- 不新增数据库迁移、依赖或终端协议版本；复用现有 SSH_CONNECTION_FAILED、interrupted、needs-reopen 和连接退避配置。
- 所有已建立的 ssh2 Client（包括 ProxyJump 每一跳）必须有持久化 error listener；原始错误消息不得进入浏览器或普通日志。
- Channel、ConnectionResource、Session 和 WebSocket 的关闭路径必须幂等；正常 exit 和用户主动关闭不得触发自动重连。
- 已成功连接的 Controller 必须清除 reattachOnly，使旧 Shell 失效后可以创建新 Shell；服务实例变化和会话失效仍需人工重新打开。
- ClipboardPort 的 canRead/canWrite 为可选字段，未提供字段的既有平台 double 按读写均可处理。
- HTTP legacy copy 只能在用户手势触发的写操作中使用；不得读取、持久化或记录剪贴板内容。
- 保持当前紧凑工作区布局，不恢复完整旧版顶部 Toolbar；本次修复右键菜单、Ctrl/Cmd+C 和现有 toolbar callback 的能力判断。
- 每个任务采用“先写失败测试 → 运行确认失败 → 最小实现 → 聚焦验证 → 提交”；提交前只 stage 当前任务文件。
- 工作区已有改动必须保留；执行前后检查 git status --short，不使用 git reset、git checkout 或覆盖式写入。
- 变更风险分级：单模块任务只跑聚焦测试；SSH2、Gateway、Controller、Platform Port 跨层任务完成后运行全量测试和受影响 E2E。

---

## 文件与模块地图

### 服务端 SSH 生命周期

- src/server/ssh/ssh2-adapter.ts：ssh2 Client 建连、ProxyJump、Ssh2ConnectionResource、SshChannelBridge 和底层错误映射。
- src/server/ssh/types.ts：SSH resource、Channel 和连接回调契约；本次尽量不扩展公共接口。
- src/server/ssh/session-manager.ts：Session 注册、detach/reattach、输出缓冲和 Channel close 后释放。
- src/server/ws/terminal-gateway.ts：Channel 事件到 WebSocket status/error/exit 的转换，以及异常通知去重。

### Web Console 生命周期

- src/web/hooks/use-terminal-session.ts：WebSocket Controller、重连退避、服务实例校验、网络事件和手动 reconnect。
- src/shared/protocol.ts：确认现有 interrupted、reconnecting、needs-reopen 与错误事件契约，无需新增字段。
- src/shared/core/state-machines.ts：确认 SSH_CONNECTION_FAILED 的 retryable 语义仍与产品规则一致。

### Clipboard 与 Console 交互

- src/shared/core/ports.ts：ClipboardPort 的可选读写能力标记。
- src/web/platform/browser-system-services.ts：安全上下文检测、legacy copy host 和 ClipboardPort 实现。
- src/web/platform/web-adapters.ts：只要读或写能力存在就暴露平台服务。
- src/web/components/TerminalPanel.tsx：右键复制/粘贴、Ctrl/Cmd+C/V、toolbar callback 和反馈。
- src/web/components/TerminalWorkspace.tsx：保持当前紧凑工作区布局，不在本次恢复完整旧 Toolbar。

### 测试

- tests/unit/server/ssh2-adapter.test.ts：FakeClient/FakeChannel 的 post-ready reset 回归。
- tests/integration/server/terminal-gateway.test.ts：异常 Channel 生命周期、错误通知和新 Shell 重开。
- tests/unit/web/terminal-session.test.ts：Controller 对 SSH 错误、网络、reattachOnly 和退避的状态验证。
- tests/unit/web/browser-system-services.test.ts：HTTP legacy copy、读写能力分离和稳定错误。
- tests/unit/web/web-adapters.test.ts：write-only ClipboardPort 暴露。
- tests/unit/web/terminal-panel.dom.test.tsx：选择复制、粘贴禁用和右键菜单状态。
- tests/e2e/host-to-terminal.spec.ts、tests/e2e/ssh-productivity.spec.ts：现有 Console 连接与生产力流程回归。

---

### Task 1: 为已建立的 ssh2 Client 建立持久化错误防线

**Files:**
- Modify: src/server/ssh/ssh2-adapter.ts，调整 connectClient()、Ssh2ConnectionResource 和 SshChannelBridge 的内部生命周期。
- Test: tests/unit/server/ssh2-adapter.test.ts。

**Interfaces:**
- Consumes: 现有 SshConnectCallbacks.onDiagnostic/onStatus、Ssh2ClientLike 和 SshChannel。
- Produces: Ssh2ConnectionResource 对所有已建立 Client 的 error 事件进行归一化、通知活动 Channel、关闭 Client，并保证重复事件幂等；不新增公共 SSH 类型。

- [ ] **Step 1: 写 post-ready ECONNRESET 失败测试**

在 tests/unit/server/ssh2-adapter.test.ts 增加测试，先建立 resource 和 shell，再让 FakeClient 发出带 code: ECONNRESET 的 error：

~~~ts
it('contains a post-ready ECONNRESET without throwing and closes the active shell once', async () => {
  const client = new FakeClient();
  const statuses: string[] = [];
  const diagnostics: Array<{ status: string; code?: string }> = [];
  const resource = await new Ssh2ResourceAdapter({ clientFactory: () => client }).connect(config({ type: 'password', password: 'fixture-password' }), {
    onHostKey: async () => true,
    onStatus: (status) => statuses.push(status),
    onDiagnostic: (event) => diagnostics.push({ status: event.status, code: event.code })
  });
  const channel = await resource.openShell();
  let channelClosed = 0;
  channel.on('close', () => { channelClosed += 1; });
  channel.on('error', () => {});

  expect(() => client.emit('error', Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }))).not.toThrow();
  expect(channelClosed).toBe(1);
  expect(client.endCalls).toBe(1);
  expect(statuses.at(-1)).toBe('closed');
  expect(diagnostics).toContainEqual(expect.objectContaining({ status: 'failed', code: 'SSH_CONNECTION_FAILED' }));
});
~~~

- [ ] **Step 2: 运行失败测试确认当前 bug**

Run: npm test -- tests/unit/server/ssh2-adapter.test.ts

Expected: 新测试失败，FakeClient 在没有 post-ready error listener 时抛出未处理 error 事件。

- [ ] **Step 3: 实现持久化 Client error listener 和 resource 终止路径**

按以下边界修改 ssh2-adapter.ts：

1. 连接阶段的临时 listener 仍负责 ready 前失败；ready 后不得移除最后一个安全 error listener。
2. Ssh2ConnectionResource 为 clients 中每个 Client 安装内部 handleClientError，记录一次 tcp/channel failed diagnostic，映射错误为 AppError('SSH_CONNECTION_FAILED')，并调用资源级终止函数。
3. 为 SshChannelBridge 增加仅供 resource 使用的连接故障关闭入口：先向已有 listener 发出一次 error，再触发 close；没有 listener 时不抛出 EventEmitter 未处理 error。
4. resource 级终止函数使用 closed/failureNotified 保护，关闭活动 Bridge、反向结束所有 Client、最多调用一次 callbacks.onStatus?.('closed')。
5. close()、Client close、Channel close 和 post-ready error 可以任意顺序到达而不重复关闭或重复诊断。
6. ProxyJump 的每个 Client 都走同一持久化 listener 逻辑；不能只给 finalClient 安装监听。

- [ ] **Step 4: 运行服务端聚焦测试**

Run: npm test -- tests/unit/server/ssh2-adapter.test.ts tests/unit/server/session-manager.test.ts

Expected: 全部 PASS，并且原有凭据映射、PTY、Channel data/stderr、close 和诊断测试保持通过。

- [ ] **Step 5: 检查差异并提交**

Run: git diff --check && git status --short

Expected: 只有 ssh2-adapter.ts 和对应单元测试有改动；无 whitespace error。

Commit: git add src/server/ssh/ssh2-adapter.ts tests/unit/server/ssh2-adapter.test.ts && git commit -m "fix: contain post-ready ssh connection errors"

---

### Task 2: 明确 Gateway 的异常断连与正常退出语义

**Files:**
- Modify: src/server/ws/terminal-gateway.ts，调整 attachChannel() 的 Channel 状态标记、错误通知和 close 分支。
- Test: tests/integration/server/terminal-gateway.test.ts。
- Reference: src/server/ssh/session-manager.ts，确认不需要改变既有 close/release 语义；只有测试发现 Session 没有释放时才在同一任务修正幂等释放。

**Interfaces:**
- Consumes: SshChannel 的 error/exit/close 事件、SshSessionManagerPort.reattach/open、现有 TerminalServerEvent。
- Produces: 正常 exit 继续发送 exit + closed；异常 Channel failure 发送一次 SSH_CONNECTION_FAILED + interrupted；新 WebSocket 可用同一 requestId 创建新 Shell。

- [ ] **Step 1: 写异常 reset 和新 Shell 集成测试**

在 terminal-gateway.test.ts 使用已有 ChallengeAdapter/FakeChannel 增加测试：连接并信任 Host Key 后，对第一个 Channel 发出 error 和 close，验证客户端收到一次 retryable error 与 interrupted；关闭旧 socket 后使用相同 requestId 打开第二个 socket，验证 adapter.channels.length 增加且第二个 socket 收到 connected。

测试断言应覆盖：

~~~ts
expect(events.filter((event) => event.type === 'error' && event.code === 'SSH_CONNECTION_FAILED')).toHaveLength(1);
expect(events.some((event) => event.type === 'status' && event.state === 'interrupted')).toBe(true);
expect(adapter.channels).toHaveLength(2);
~~~

同时保留现有正常 channel.emit('exit', 0) 和显式 close 的行为断言，证明它们不会产生 retryable error。

- [ ] **Step 2: 运行网关测试确认失败**

Run: npm test -- tests/integration/server/terminal-gateway.test.ts

Expected: 新测试失败，当前 Gateway 将异常 Channel close 直接报告为 closed，不会发送 interrupted，也不会证明新 Shell 已建立。

- [ ] **Step 3: 实现 Gateway 的异常通知去重**

在 registerTerminalGateway() 的连接级闭包状态中增加三个内部标记：

- channelExited：收到远程 exit 后设为 true；
- explicitCloseRequested：处理 client close 控制消息时设为 true；
- channelFailureNotified：异常 error/close 路径只通知一次。

调整 attachChannel()：

1. exit listener 先记录 channelExited 再转发原有 exit 事件。
2. error listener 调用统一的 notifyUnexpectedChannelFailure()，发送现有 TerminalErrorEvent（SSH_CONNECTION_FAILED、远程连接异常）并发送 status: interrupted。
3. close listener 在 active 且没有 exit、显式关闭和既有 failure 通知时调用同一通知函数；已通知 failure 时不再发送 closed 覆盖 interrupted。
4. openTerminal 中的 SshConnectCallbacks.onStatus 对 closed 做同一判定：active 且没有 exit、显式关闭和既有 failure 通知时调用 notifyUnexpectedChannelFailure()，否则才发送 closed，避免 resource closed 与 Channel error 产生状态抖动。
5. sendStatus 保持去重；客户端关闭 WebSocket 后由现有 cleanup('socket') detach，SessionManager 若已释放旧 Channel 则新 open 自然进入创建新 Shell 路径。
6. 显式 close 只保留现有关闭流程，不触发 failure 通知。

- [ ] **Step 4: 运行网关与 SessionManager 聚焦测试**

Run: npm test -- tests/integration/server/terminal-gateway.test.ts tests/unit/server/session-manager.test.ts

Expected: 异常重连、新 Shell、正常退出、显式关闭、Host Key 和凭据流程全部 PASS。

- [ ] **Step 5: 检查并提交**

Run: git diff --check && git status --short

Expected: 只包含 Gateway 及其集成测试的相关改动。

Commit: git add src/server/ws/terminal-gateway.ts tests/integration/server/terminal-gateway.test.ts && git commit -m "fix: classify unexpected terminal channel disconnects"

---

### Task 3: 让 TerminalSessionController 对 SSH 故障自动重连

**Files:**
- Modify: src/web/hooks/use-terminal-session.ts，增加 retryable error 分类、失效 socket 处置、reattachOnly 生命周期和网络恢复逻辑。
- Test: tests/unit/web/terminal-session.test.ts。
- Verify: src/shared/protocol.ts 与 src/shared/core/state-machines.ts 的现有状态/错误契约不需要扩展。

**Interfaces:**
- Consumes: TerminalServerEvent、现有 reconnectBaseMs/reconnectMaxMs/reconnectMaxAttempts、navigator online/offline。
- Produces: SSH_CONNECTION_FAILED 可进入 interrupted/reconnecting；永久错误仍进入 failed/needs-reopen；连接成功后后续重试使用新 Shell 语义。

- [ ] **Step 1: 添加 retryable server error 和 reattachOnly 回归测试**

在 terminal-session.test.ts 增加测试场景：

1. 第一个 FakeSocket open 并收到 connected；随后注入 error event SSH_CONNECTION_FAILED，验证当前 socket 被关闭/解绑、snapshot 进入 reconnecting，到达 fake timer 后创建第二个 socket。
2. 第二个 socket 的 open 消息必须包含同一 requestId，但不得包含 reattachOnly；第二个 socket 发送 connected 后 snapshot 回到 connected。
3. SSH_AUTH_FAILED 仍然进入 failed 且不会创建第二个 socket。
4. offline 时 reset 错误不创建 socket；触发 online 后立即恢复调度。
5. 正常 exit 后收到 closed 不创建新的 socket。

示例断言：

~~~ts
first.message(JSON.stringify({ type: 'error', code: 'SSH_CONNECTION_FAILED', message: '远程连接异常' }));
expect(controller.snapshot.state).toBe('reconnecting');
vi.advanceTimersByTime(250);
expect(FakeSocket.instances).toHaveLength(2);
expect(JSON.parse(lastSocket().sent[0] as string)).not.toHaveProperty('reattachOnly');
~~~

- [ ] **Step 2: 运行 Controller 失败测试**

Run: npm test -- tests/unit/web/terminal-session.test.ts

Expected: retryable error 当前被 retryBlocked 阻断，且 reattachOnly 仍会在恢复连接时保留；新测试至少有一项 FAIL。

- [ ] **Step 3: 实现错误分类和失效 socket 重连**

在 TerminalSessionController 内按以下规则修改：

1. 增加 isRetryableConnectionError(code)，当前只把 SSH_CONNECTION_FAILED 作为自动重连错误；SSH_AUTH_FAILED、HOST_KEY_MISMATCH、PROTOCOL_INVALID_MESSAGE 和 SESSION_NEEDS_REOPEN 不自动重试。
2. handleServerEvent('error') 对 retryable 错误记录 interrupted 诊断，更新错误提示，解绑并关闭当前 socket，然后调用现有退避调度；不能让随后 socket close 再重复调度。
3. 增加 reconnectExhausted 或等价的独立标记，与永久错误使用的 retryBlocked 分离；最大次数耗尽显示“自动重连次数已用尽，请重新连接；原来的远程 Shell 不再可用，重新打开会创建新的 Shell”语义。
4. handleNetworkOffline() 保留 interrupted，清除 timer；handleNetworkOnline() 对 retryable interrupted/failed 状态清除 exhausted 标记并调度一次连接，对永久错误不操作。
5. 在收到 status: connected 后设置 reattachOnly = false，并重置 retry attempt、timer 和 error；这样工作区恢复成功后，未来远端 reset 可以创建新 Shell。
6. reconnect() 清理 retry/exhausted 标志；needs-reopen 时清理 serviceInstanceId，保持现有人工重新打开行为。
7. handleClose() 继续对 WebSocket 意外断开使用现有退避策略，对正常 close、1008 和 stopped 保持当前语义。

- [ ] **Step 4: 运行 Controller 与状态机聚焦测试**

Run: npm test -- tests/unit/web/terminal-session.test.ts tests/unit/shared/core-state-machines.test.ts tests/unit/shared/protocol.test.ts

Expected: 新增的 retryable error、网络恢复、reattachOnly 清除和永久错误测试全部 PASS，已有指数退避和服务实例变更测试不回归。

- [ ] **Step 5: 检查并提交**

Run: git diff --check && git status --short

Expected: 只有 use-terminal-session.ts 和对应测试有任务相关改动。

Commit: git add src/web/hooks/use-terminal-session.ts tests/unit/web/terminal-session.test.ts && git commit -m "fix: reconnect terminals after remote ssh failures"

---

### Task 4: 拆分 ClipboardPort 读写能力并加入 HTTP legacy copy

**Files:**
- Modify: src/shared/core/ports.ts，给 ClipboardPort 增加可选 canRead/canWrite。
- Modify: src/web/platform/browser-system-services.ts，增加 BrowserClipboardHost.legacyCopy、默认 DOM fallback、能力检测和写入 fallback。
- Modify: src/web/platform/web-adapters.ts，按任一剪贴板能力暴露 ClipboardPort。
- Test: tests/unit/web/browser-system-services.test.ts、tests/unit/web/web-adapters.test.ts。

**Interfaces:**
- Consumes: BrowserSystemHosts.secureContext、原生 navigator.clipboard、可注入的 legacyCopy。
- Produces: ClipboardPort { readText, writeText, canRead?, canWrite? }；HTTP legacy copy 时 canRead 为 false、canWrite 为 true。

- [ ] **Step 1: 写能力分离和 legacy copy 失败测试**

在 browser-system-services.test.ts 增加：

~~~ts
it('keeps copy available on insecure origins when legacy copy exists', async () => {
  const legacyCopy = vi.fn(() => true);
  const services = createBrowserSystemServices({
    secureContext: false,
    clipboard: { readText: vi.fn(async () => 'not readable'), writeText: vi.fn(async () => undefined) },
    legacyCopy
  });

  expect(services.capabilities).toEqual(expect.objectContaining({ clipboardRead: false, clipboardWrite: true }));
  expect(services.clipboard?.canRead).toBe(false);
  expect(services.clipboard?.canWrite).toBe(true);
  await services.clipboard?.writeText('selected output');
  expect(legacyCopy).toHaveBeenCalledWith('selected output');
  await expect(services.clipboard?.readText()).rejects.toMatchObject({ code: 'CAPABILITY_UNAVAILABLE' });
});
~~~

再增加 native write rejected 后使用 legacy copy 的测试，以及 legacy copy 返回 false 时返回 CAPABILITY_UNAVAILABLE 的测试。保留“无 legacyCopy 的不安全上下文读写均不可用”回归。

- [ ] **Step 2: 运行浏览器服务失败测试**

Run: npm test -- tests/unit/web/browser-system-services.test.ts

Expected: 当前 BrowserSystemHosts 没有 legacy copy，且 insecure context 会把 write capability 判为 false；新测试 FAIL。

- [ ] **Step 3: 实现能力拆分和 DOM fallback**

按以下顺序实现：

1. BrowserClipboardHost 增加 legacyCopy?: (text: string) => boolean | void；BrowserSystemHosts 保持可注入，方便 jsdom 测试。
2. defaultBrowserSystemHosts() 在存在 document.createElement、document.body/documentElement 和 document.execCommand 时提供 legacyCopy：创建隐藏 textarea，写入文本，聚焦并选择，调用 execCommand('copy')，最后恢复选择/焦点并移除节点。
3. detectBrowserSystemCapabilities() 将 clipboardRead 限定为 secure context + native read；将 clipboardWrite 定义为 secure context + native write 或 legacyCopy 存在。
4. createClipboardPort() 返回 canRead/canWrite，readText() 只调用 native read；writeText() 优先 native write，失败或不可用时调用 legacyCopy；所有失败统一抛出 CAPABILITY_UNAVAILABLE。
5. createWebAdapters() 将 clipboard 暴露条件改为 clipboardRead 或 clipboardWrite，避免 write-only Port 被丢弃。

- [ ] **Step 4: 添加 Web adapter 暴露测试并运行聚焦验证**

在 web-adapters.test.ts 用注入的 platformServices 传入 { clipboard: { canRead: false, canWrite: true, ... } }，验证 runtime.platformServices 保留该 Port；再运行：

~~~bash
npm test -- tests/unit/web/browser-system-services.test.ts tests/unit/web/web-adapters.test.ts
~~~

Expected: 全部 PASS；原生安全上下文、文件保存和通知测试保持通过。

- [ ] **Step 5: 检查并提交**

Run: git diff --check && git status --short

Expected: 只包含 shared Port、浏览器服务、Web adapter 和对应测试改动。

Commit: git add src/shared/core/ports.ts src/web/platform/browser-system-services.ts src/web/platform/web-adapters.ts tests/unit/web/browser-system-services.test.ts tests/unit/web/web-adapters.test.ts && git commit -m "fix: expose write-only browser clipboard capability"

---

### Task 5: 让 TerminalPanel 按实际剪贴板能力启用复制

**Files:**
- Modify: src/web/components/TerminalPanel.tsx，拆分 copy/paste capability 判断、右键菜单 disabled 状态和 toolbar callback。
- Test: tests/unit/web/terminal-panel.dom.test.tsx。
- Reference: src/web/components/TerminalWorkspace.tsx，确认当前紧凑布局继续传递 clipboard；不增加新的顶部大工具条。

**Interfaces:**
- Consumes: ClipboardPort.canRead/canWrite，既有 xterm selection、context menu、快捷键和反馈状态。
- Produces: 有 canWrite !== false 的 ClipboardPort 时提供 onCopy 和右键复制；只有 canRead !== false 时提供 onPaste，未提供能力标记的旧测试 double 保持兼容。

- [ ] **Step 1: 写 write-only ClipboardPort DOM 测试**

在 terminal-panel.dom.test.tsx 增加：

~~~ts
it('keeps copy enabled while paste is unavailable on a write-only clipboard', async () => {
  testState.selectionActive = true;
  const clipboard: ClipboardPort = {
    canRead: false,
    canWrite: true,
    readText: vi.fn(async () => 'unavailable'),
    writeText: vi.fn(async () => undefined)
  };
  const onToolbarChange = vi.fn();
  render(<TerminalPanel terminalId="terminal-1" host={host} active onClose={() => {}} clipboard={clipboard} onToolbarChange={onToolbarChange} />);

  const toolbar = onToolbarChange.mock.calls[0]?.[1] as { onCopy?: () => Promise<void>; onPaste?: () => Promise<void> };
  expect(toolbar.onCopy).toEqual(expect.any(Function));
  expect(toolbar.onPaste).toBeUndefined();
  fireEvent.contextMenu(document.querySelector('.terminal-canvas')!, { clientX: 100, clientY: 80 });
  expect(screen.getByRole('menuitem', { name: /^复制/ })).not.toHaveAttribute('aria-disabled', 'true');
  expect(screen.getByRole('menuitem', { name: /^粘贴/ })).toHaveAttribute('aria-disabled', 'true');
});
~~~

另加无 canWrite 或 canWrite 为 false 时复制 callback 不提供、有选区时右键复制保持禁用的断言。

- [ ] **Step 2: 运行 TerminalPanel 失败测试**

Run: npm test -- tests/unit/web/terminal-panel.dom.test.tsx

Expected: 当前代码只判断 clipboard 对象是否存在，会错误提供粘贴 callback，并无法验证 write-only 能力的正确 disabled 状态；新测试 FAIL 或暴露不符合预期的菜单状态。

- [ ] **Step 3: 实现读写能力判断**

在 TerminalPanel.tsx 增加兼容函数：

~~~ts
const clipboardCanRead = (clipboard?: ClipboardPort): boolean => clipboard !== undefined && clipboard.canRead !== false;
const clipboardCanWrite = (clipboard?: ClipboardPort): boolean => clipboard !== undefined && clipboard.canWrite !== false;
~~~

使用规则：

1. terminalContextItems.copy.disabled = !clipboardCanWrite(clipboard) 或 !terminalHasSelection。
2. terminalContextItems.paste.disabled = !clipboardCanRead(clipboard)。
3. toolbar state 的 onCopy 只在 clipboardCanWrite 为 true 时提供，onPaste 只在 clipboardCanRead 为 true 时提供。
4. copySelection 和 pasteClipboard 保留现有空选区、确认、错误反馈；不能因为按钮可用而绕过粘贴确认。
5. Ctrl/Cmd+C 只有在可写且有选区时拦截为复制；否则继续把 Ctrl+C 交给远端。
6. 依赖数组使用 capability 计算结果，避免浏览器服务切换后闭包仍使用旧状态。

- [ ] **Step 4: 运行 UI 聚焦测试**

Run: npm test -- tests/unit/web/terminal-panel.dom.test.tsx tests/unit/web/terminal-workspace.dom.test.tsx

Expected: write-only clipboard、右键复制、粘贴确认、Ctrl+C 远端中断语义和现有工作区测试全部 PASS；当前紧凑 topbar 不增加额外空间。

- [ ] **Step 5: 检查并提交**

Run: git diff --check && git status --short

Expected: 只包含 TerminalPanel 及其测试的任务相关改动。

Commit: git add src/web/components/TerminalPanel.tsx tests/unit/web/terminal-panel.dom.test.tsx && git commit -m "fix: enable console copy independently from paste"

---

### Task 6: 完成跨层验证、浏览器回归和计划记录

**Files:**
- Modify: docs/superpowers/plans/2026-09-17-relay-ssh-reconnect-and-clipboard-reliability.md，在任务完成后记录状态、commit 和验证证据。
- Verify: src/server/ssh/ssh2-adapter.ts、src/server/ws/terminal-gateway.ts、src/web/hooks/use-terminal-session.ts、src/web/platform、src/web/components/TerminalPanel.tsx。

**Interfaces:**
- Consumes: Task 1–5 的已提交实现和测试。
- Produces: 可复现的验证记录；只有所有必要命令通过后才能标记完成。

- [ ] **Step 1: 运行所有受影响的聚焦测试**

Run:

~~~bash
npm test -- \
  tests/unit/server/ssh2-adapter.test.ts \
  tests/unit/server/session-manager.test.ts \
  tests/integration/server/terminal-gateway.test.ts \
  tests/unit/web/terminal-session.test.ts \
  tests/unit/web/browser-system-services.test.ts \
  tests/unit/web/web-adapters.test.ts \
  tests/unit/web/terminal-panel.dom.test.tsx \
  tests/unit/web/terminal-workspace.dom.test.tsx
~~~

Expected: 所有受影响测试 PASS。

- [ ] **Step 2: 运行静态检查和构建**

Run:

~~~bash
npm run typecheck
npm run lint
npm run build:web
npm run build:server
~~~

Expected: TypeScript、ESLint、Web build 和 Server build 全部成功。

- [ ] **Step 3: 运行受影响 E2E**

Run:

~~~bash
npm run test:e2e -- tests/e2e/host-to-terminal.spec.ts tests/e2e/ssh-productivity.spec.ts
~~~

Expected: Console 建连、工作区恢复、网络重连 UI、右键/快捷键生产力路径没有回归；如果环境未启动服务，记录明确的环境原因，不把未执行误记为通过。

- [ ] **Step 4: 运行全量测试**

Run: npm test

Expected: 全部 Vitest 文件通过。由于本次修改涉及 Node 进程崩溃防护、WebSocket 生命周期和共享平台 Port，这一步属于必要的全量门槛。

- [ ] **Step 5: 做最终差异审计并更新计划**

Run:

~~~bash
git status --short
git diff --check
git log -6 --oneline
~~~

在本计划对应任务下记录实际完成日期、commit hash、聚焦测试、E2E、全量测试结果和任何环境限制。确认没有数据库、信任白名单、.env.local 或用户既有数据改动。

- [ ] **Step 6: 提交验证记录**

Commit: git add docs/superpowers/plans/2026-09-17-relay-ssh-reconnect-and-clipboard-reliability.md && git commit -m "docs: track ssh reconnect and clipboard reliability verification"

---

## 完成定义

只有同时满足以下条件，才可以把本计划标记为完成：

- Task 1–5 的失败测试先红后绿，并分别留下实现 commit。
- ECONNRESET 在 post-ready ssh2 Client 上不会造成 Node 未处理异常。
- Gateway 和 Controller 能区分异常断连、正常退出、主动关闭和需要重新打开。
- 远端 Shell 失效后，自动重连成功时使用新的 Shell；网络恢复能够继续连接。
- HTTP legacy copy 能支持复制，粘贴能力不足不会再把复制永久置灰。
- 聚焦测试、typecheck、lint、两个构建和受影响 E2E 通过；npm test 全量通过。
- 最终 git status 只剩下明确属于本任务的提交前记录或保持 clean，数据库和信任白名单未被替换。
