# Web SSH UX Workspace Optimization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 Web SSH 升级为终端优先、支持同一 Server 多 Console、状态可信、可恢复且可主题化的持续工作区。

**Architecture:** 使用客户端 reducer 管理独立的 `TerminalTabState`，每个 tab 对应一个现有 session controller，不改 SSH WebSocket 协议。主题和字号由独立的本地偏好模块提供给 CSS token 与 xterm；Server 最近连接继续复用现有数据库字段和 API。

**Tech Stack:** React 19、TypeScript、xterm.js、Fastify、SQLite、Vitest、Testing Library、Playwright。

**Spec:** `docs/superpowers/specs/2026-09-14-ux-workspace-design.md`

## Global Constraints

- 不降低 Vault、HttpOnly cookie、Origin 校验、host key TOFU/mismatch 和 SSH 凭据加密的安全边界。
- 多 Console 只新增客户端 tab 元数据，继续使用现有 `terminalId/requestId` 区分 WebSocket/SSH 会话。
- 主题、字号和终端恢复描述不得包含主密码、SSH 密码、私钥、passphrase 或 session token。
- 每个行为变更先写真实边界测试并观察失败，再写最小生产实现。
- 每个任务完成后运行对应聚焦测试；最终必须运行全量测试、lint、typecheck、build 和 E2E。

## 文件边界

- `src/web/state/app-state.ts`：tab 元数据和 reducer 行为。
- `src/web/hooks/use-terminal-session.ts`：连接快照和重连控制。
- `src/web/components/TerminalWorkspace.tsx`、`TerminalPanel.tsx`、`TerminalToolbar.tsx`：终端工作区和 tab 交互。
- `src/web/components/HostCard.tsx`、`HostForm.tsx`、`HostWorkspace.tsx`：Server 管理与最近连接。
- `src/web/theme.ts`、`src/web/App.tsx`、`src/web/styles.css`：偏好、壳层和视觉主题。
- `src/server/ws/terminal-gateway.ts`、`src/server/db/repositories.ts`：成功连接时间和会话状态边界。
- `tests/unit/web/*.test.ts(x)`、`tests/integration/server/*.test.ts`、`tests/e2e/host-to-terminal.spec.ts`：行为回归。

### Task 1: Multi-console state contract

**Files:**
- Modify: `src/web/state/app-state.ts`
- Test: `tests/unit/web/app-state.test.ts`

**Interfaces:**
- Produces `TerminalTabState.state`, `reconnectDelayMs`, `errorMessage` and reducer actions `terminalStatusUpdated`.

- [ ] **Step 1: Write the failing tests**

在 `app-state.test.ts` 增加以下行为断言：

```ts
it('opens multiple consoles for the same host and keeps them independent', () => {
  let state = initialAppState;
  state = appReducer(state, { type: 'terminalOpened', terminalId: 'tab-1', hostId: 'host-1' });
  state = appReducer(state, { type: 'terminalOpened', terminalId: 'tab-2', hostId: 'host-1' });
  state = appReducer(state, { type: 'terminalStatusUpdated', terminalId: 'tab-1', state: 'connected', reconnectDelayMs: 0, errorMessage: null });

  expect(state.terminals).toHaveLength(2);
  expect(state.terminals.find((tab) => tab.terminalId === 'tab-1')?.state).toBe('connected');
  expect(state.terminals.find((tab) => tab.terminalId === 'tab-2')?.state).toBe('closed');
});

it('removes only the requested console and activates the adjacent remaining tab', () => {
  let state = initialAppState;
  state = appReducer(state, { type: 'terminalOpened', terminalId: 'tab-1', hostId: 'host-1' });
  state = appReducer(state, { type: 'terminalOpened', terminalId: 'tab-2', hostId: 'host-1' });
  state = appReducer(state, { type: 'terminalOpened', terminalId: 'tab-3', hostId: 'host-2' });
  state = appReducer(state, { type: 'terminalActivated', terminalId: 'tab-2' });
  state = appReducer(state, { type: 'terminalClosed', terminalId: 'tab-2' });

  expect(state.terminals.map((tab) => tab.terminalId)).toEqual(['tab-1', 'tab-3']);
  expect(state.activeTerminalId).toBe('tab-1');
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `npm test -- tests/unit/web/app-state.test.ts`

Expected: FAIL because `terminalOpened` currently deduplicates only in the reducer test shape and `terminalStatusUpdated` does not exist.

- [ ] **Step 3: Implement the minimal state contract**

Initialize every new tab with `state: 'closed'`, `reconnectDelayMs: 0`, `errorMessage: null`; remove host-based deduplication from `terminalOpened`; update only the matching tab in `terminalStatusUpdated`; when closing the active tab select the previous adjacent tab or the first remaining tab.

- [ ] **Step 4: Run focused and existing web state tests**

Run: `npm test -- tests/unit/web/app-state.test.ts`

Expected: PASS with the new same-host and close behavior plus all existing reducer tests.

- [ ] **Step 5: Commit**

```bash
git add src/web/state/app-state.ts tests/unit/web/app-state.test.ts
git commit -m "feat: model independent terminal consoles"
```

### Task 2: Console tab and workspace interaction

**Files:**
- Modify: `src/web/App.tsx`, `src/web/components/TerminalWorkspace.tsx`, `src/web/components/TerminalToolbar.tsx`
- Test: `tests/unit/web/terminal-workspace.dom.test.tsx`

**Interfaces:**
- Consumes the reducer contract from Task 1.
- Produces independent tab labels, actual close buttons, new-console actions, per-host counts and status labels.

- [ ] **Step 1: Write failing DOM tests**

Add a same-host fixture with `tab-1` and `tab-2`, assert two tabs named `Production · 1` and `Production · 2`, assert two independent close buttons, and click the second “新建终端” action to verify `onConnectHost` is called with the host. Assert a `reconnecting` tab renders “重连中” and not a green connected status.

- [ ] **Step 2: Run the focused DOM test**

Run: `npm test -- tests/unit/web/terminal-workspace.dom.test.tsx`

Expected: FAIL because current tabs have no per-host numbering, no real close control, and all rail dots are green.

- [ ] **Step 3: Implement tab interactions**

Pass `onStatusChange` and tab metadata through `TerminalWorkspace`; create every new terminal from `handleOpenTerminal` with `crypto.randomUUID()`; render a stable per-host ordinal from the current terminal array; use a nested close button with `stopPropagation`; render `+ 新建终端` in the rail and toolbar; map terminal status to text/color classes.

- [ ] **Step 4: Run the focused DOM tests**

Run: `npm test -- tests/unit/web/terminal-workspace.dom.test.tsx`

Expected: PASS, including the existing host-key dialog and toolbar tests.

- [ ] **Step 5: Commit**

```bash
git add src/web/App.tsx src/web/components/TerminalWorkspace.tsx src/web/components/TerminalToolbar.tsx tests/unit/web/terminal-workspace.dom.test.tsx
git commit -m "feat: add multi-console tab interactions"
```

### Task 3: Stable terminal sizing and session status propagation

**Files:**
- Modify: `src/web/hooks/use-terminal-session.ts`, `src/web/components/TerminalPanel.tsx`, `src/web/styles.css`
- Test: `tests/unit/web/terminal-session.test.ts`, `tests/e2e/host-to-terminal.spec.ts`

**Interfaces:**
- Produces `onStatusChange(snapshot)` from `TerminalPanel` to the workspace.

- [ ] **Step 1: Write failing tests**

Extend the session test to assert the controller publishes `reconnecting` with its delay and clears host-key state on a non-awaiting status. Extend E2E to open the same fixture Server twice, assert both tabs exist, then assert `.terminal-panels` height remains within 1px over one second and host-key dialog/buttons stay inside the viewport.

- [ ] **Step 2: Run focused tests**

Run: `npm test -- tests/unit/web/terminal-session.test.ts` and `npm run test:e2e -- --project=chromium`

Expected: the same-host E2E flow cannot create two sessions before Task 2; current layout regression fails without the height constraints.

- [ ] **Step 3: Implement stable sizing and status propagation**

Use a definite desktop workspace height based on `100dvh`, add `min-height: 0` to each flex/grid shrink boundary, keep mobile height auto with a minimum, and retain a fixed scrollable host-key layer. Schedule ResizeObserver fitting through one animation frame and ignore duplicate dimensions. Emit the session snapshot through a callback without exposing credentials.

- [ ] **Step 4: Run focused tests and E2E**

Run: `npm test -- tests/unit/web/terminal-session.test.ts` and `npm run test:e2e -- --project=chromium`

Expected: PASS; E2E uses ordinary (non-force) clicks for host-key decisions and both same-host terminals remain usable.

- [ ] **Step 5: Commit**

```bash
git add src/web/hooks/use-terminal-session.ts src/web/components/TerminalPanel.tsx src/web/styles.css tests/unit/web/terminal-session.test.ts tests/e2e/host-to-terminal.spec.ts
git commit -m "fix: stabilize terminal workspace sizing"
```

### Task 4: Recoverable boot, Vault and connection errors

**Files:**
- Modify: `src/web/App.tsx`, `src/web/components/SetupGate.tsx`, `src/web/components/UnlockView.tsx`, `src/web/api.ts`
- Test: `tests/unit/web/*.test.tsx`, `tests/integration/server/auth-routes.test.ts`

**Interfaces:**
- Produces visible error/retry actions for loading, setup and unlock without changing server error codes.

- [ ] **Step 1: Write failing DOM tests**

Render `SetupGate` and `UnlockView` with an `errorMessage`, assert it is visible; submit an empty/short unlock form and assert the input remains mounted and the error is actionable. Add an App-level boot failure test using a rejected `getSetupStatus` mock and assert “重试”.

- [ ] **Step 2: Run the focused tests**

Run: `npm test -- tests/unit/web`

Expected: FAIL because App does not pass setup/unlock errors and the loading path has no retry view.

- [ ] **Step 3: Implement bounded retries**

Pass `errorMessage` to setup/unlock components, preserve password input on failure, add an explicit retry action for boot status and a request timeout using `AbortController` in `api.ts`. Do not retry a deliberate user rejection automatically.

- [ ] **Step 4: Run focused tests**

Run: `npm test -- tests/unit/web tests/integration/server/auth-routes.test.ts`

Expected: PASS with existing auth/security assertions unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/web/App.tsx src/web/components/SetupGate.tsx src/web/components/UnlockView.tsx src/web/api.ts tests/unit/web tests/integration/server/auth-routes.test.ts
git commit -m "feat: add recoverable authentication errors"
```

### Task 5: Server recency and management actions

**Files:**
- Modify: `src/server/ws/terminal-gateway.ts`, `src/web/components/HostCard.tsx`, `src/web/components/HostForm.tsx`, `src/web/components/HostWorkspace.tsx`, `src/web/App.tsx`
- Test: `tests/integration/server/host-routes.test.ts`, `tests/unit/web/host-form.dom.test.tsx`, `tests/unit/web/host-workspace.dom.test.tsx`

**Interfaces:**
- Reuses `updateHost`, `deleteHost`, `testConnection` and `lastConnectedAt` already present in the repository/API.

- [ ] **Step 1: Write failing tests**

Assert a successful SSH open updates `lastConnectedAt`; render HostCard actions for edit/delete/test; submit HostForm in edit mode with existing values; assert HostWorkspace sorts two hosts by recent connection after favorites tie.

- [ ] **Step 2: Run focused tests**

Run: `npm test -- tests/integration/server/host-routes.test.ts tests/unit/web/host-form.dom.test.tsx tests/unit/web/host-workspace.dom.test.tsx`

Expected: FAIL because the gateway does not mark successful connections and cards only expose favorite/connect.

- [ ] **Step 3: Implement management flow**

Call `markConnected(hostId, now)` after `open` attaches successfully; add a shared create/edit form mode with group selection; add a confirmation dialog before delete and close matching tabs; add a test-connection action that reports host-key/SSH errors without saving credentials.

- [ ] **Step 4: Run focused tests**

Run: `npm test -- tests/integration/server/host-routes.test.ts tests/unit/web/host-form.dom.test.tsx tests/unit/web/host-workspace.dom.test.tsx`

Expected: PASS and no credential values in rendered metadata or errors.

- [ ] **Step 5: Commit**

```bash
git add src/server/ws/terminal-gateway.ts src/web/components/HostCard.tsx src/web/components/HostForm.tsx src/web/components/HostWorkspace.tsx src/web/App.tsx tests/integration/server/host-routes.test.ts tests/unit/web/host-form.dom.test.tsx tests/unit/web/host-workspace.dom.test.tsx
git commit -m "feat: add server recency and management actions"
```

### Task 6: Theme, terminal typography and accessibility

**Files:**
- Create: `src/web/theme.ts`
- Modify: `src/web/App.tsx`, `src/web/components/TerminalPanel.tsx`, `src/web/components/HostKeyDialog.tsx`, `src/web/styles.css`
- Test: `tests/unit/web/theme.test.ts`, `tests/unit/web/terminal-workspace.dom.test.tsx`, `tests/e2e/host-to-terminal.spec.ts`

**Interfaces:**
- Produces `ThemeName`, `TerminalFontSize`, `loadPreferences()`, `savePreferences()` and theme palette data.

- [ ] **Step 1: Write failing tests**

Assert `loadPreferences()` falls back to `midnight` and 14px for invalid storage values, round-trips valid theme/size preferences, and that the settings control changes the root `data-theme` and terminal font-size label. Assert host-key dialog focuses “拒绝连接” on open and Escape rejects the pending decision.

- [ ] **Step 2: Run focused tests**

Run: `npm test -- tests/unit/web/theme.test.ts tests/unit/web/terminal-workspace.dom.test.tsx`

Expected: FAIL because theme module/settings and dialog focus behavior do not exist.

- [ ] **Step 3: Implement preferences and focus behavior**

Define three palettes in `theme.ts`, apply CSS variables through `data-theme`, update xterm `options.theme` and `options.fontSize` on preference changes, store only non-sensitive preferences, and implement a small focus trap/Escape handler for host-key dialog with explicit buttons.

- [ ] **Step 4: Run focused tests and E2E**

Run: `npm test -- tests/unit/web/theme.test.ts tests/unit/web/terminal-workspace.dom.test.tsx` and `npm run test:e2e -- --project=chromium`

Expected: PASS with theme persistence, readable controls and no terminal regressions.

- [ ] **Step 5: Commit**

```bash
git add src/web/theme.ts src/web/App.tsx src/web/components/TerminalPanel.tsx src/web/components/HostKeyDialog.tsx src/web/styles.css tests/unit/web/theme.test.ts tests/unit/web/terminal-workspace.dom.test.tsx tests/e2e/host-to-terminal.spec.ts
git commit -m "feat: add workspace themes and terminal preferences"
```

### Task 7: Refresh recovery, keyboard shortcuts and final verification

**Files:**
- Modify: `src/web/App.tsx`, `src/web/state/app-state.ts`, `src/web/components/TerminalWorkspace.tsx`, `README.md`
- Test: `tests/unit/web/app-state.test.ts`, `tests/unit/web/terminal-workspace.dom.test.tsx`, `tests/e2e/host-to-terminal.spec.ts`

- [ ] **Step 1: Write failing tests**

Assert non-sensitive open-tab descriptors are serialized to `sessionStorage`, restored after boot within the server detach window, and discarded after explicit close/lock; assert `Ctrl/Cmd+K` focuses host search and `Ctrl/Cmd+W` closes the active tab.

- [ ] **Step 2: Run focused tests**

Run: `npm test -- tests/unit/web/app-state.test.ts tests/unit/web/terminal-workspace.dom.test.tsx`

Expected: FAIL because no terminal descriptors or keyboard shortcuts are currently persisted.

- [ ] **Step 3: Implement bounded refresh recovery**

Persist only `{ terminalId, hostId }`, restore only hosts still present after Vault unlock, reattach with the same request ID, show “恢复失败，创建新连接” when the server retention window has expired, and clear descriptors on explicit close or lock. Add keyboard handlers that ignore focused text inputs.

- [ ] **Step 4: Update documentation and run all checks**

Document multi-console behavior, theme preferences, public deployment Origin requirements and the refresh retention window in `README.md`. Run:

```bash
npm test
npm run lint
npm run typecheck
npm run build
npm run test:e2e -- --project=chromium
```

Expected: all commands exit 0; the E2E flow covers same-host multiple consoles, host-key confirmation, resize stability, close/reconnect and lock.

- [ ] **Step 5: Commit**

```bash
git add src/web/App.tsx src/web/state/app-state.ts src/web/components/TerminalWorkspace.tsx README.md tests/unit/web/app-state.test.ts tests/unit/web/terminal-workspace.dom.test.tsx tests/e2e/host-to-terminal.spec.ts
git commit -m "feat: finish persistent terminal workspace UX"
```
