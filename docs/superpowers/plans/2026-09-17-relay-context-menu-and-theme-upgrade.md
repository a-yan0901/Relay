# Relay Context Menu and Theme Upgrade Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 Relay 建立统一的右键效率交互，覆盖终端、Server 卡片、Server 标签和后续 SFTP/终端标签，并将三套简单主题升级为语义化 UI Token 与多套现代主题预设。

**Architecture:** 新增平台无关的 Web Context Menu 交互层，由 `ContextMenu`、`useContextMenu` 和上下文目标类型负责定位、键盘可访问性与生命周期；业务组件只提供当前对象的动作列表，不复制菜单行为。主题继续留在 Web 层，以 `ThemeDefinition` 同时驱动 CSS 自定义属性和 xterm `TerminalTheme`，保留现有 `data-relay-theme` 隔离边界和 LocalStorage 兼容策略。

**Tech Stack:** TypeScript, React, CSS custom properties, xterm.js, Vitest, React Testing Library, Playwright, Vite.

**Spec:** `docs/superpowers/specs/2026-09-17-relay-context-menu-and-theme-upgrade-design.md`

## Global Constraints

- 工作区非编辑区域使用 Relay 自定义右键菜单；`input`、`textarea`、`select`、`contenteditable`、链接和显式原生菜单控件保留浏览器菜单。
- `ContextMenu` 必须支持鼠标、键盘、Escape、外部点击、滚动关闭和视口边缘定位；菜单项使用可访问的 `role="menu"`/`role="menuitem"` 语义。
- 终端有选区时 `Ctrl/Cmd+C` 复制选区；无选区时不拦截远端中断信号。粘贴必须经过现有 ClipboardPort 和多行/长文本确认流程。
- 右键菜单不得暴露密码、私钥、passphrase、主密码、token、恢复密钥或完整终端内容。
- 删除 Server、清除 Host Key 信任、删除远程文件继续使用现有二次确认和 Host Key/SFTP 安全边界。
- 主题继续使用 `data-relay-theme`，不得写回通用 `data-theme`；未知或损坏的本地主题值必须回退到 `DEFAULT_PREFERENCES`。
- 主题预设同时定义 Relay UI Token 和 xterm ANSI 调色板；颜色不能成为连接状态、错误或安全提示的唯一表达。
- `src/shared/core` 不新增 DOM、React、浏览器存储或 CSS 依赖；本计划的 Context Menu 和主题实现均限定在 `src/web`。
- 验证按风险分级：组件改动运行相关 Vitest/DOM 测试，跨 App/TerminalWorkspace 的行为运行 targeted Playwright；只有修改 shared contract、数据迁移、安全边界或构建链时才升级为全量验证。
- 每个任务只提交该任务涉及的文件；提交前运行 `git status --short`、`git diff --check`，不使用 `git reset`、`git checkout` 覆盖既有改动。

## 文件与模块地图

### 新增

- `src/web/components/ContextMenu.tsx`：可访问的通用菜单渲染和键盘交互。
- `src/web/hooks/use-context-menu.ts`：右键目标与坐标状态、打开/关闭生命周期。
- `src/web/context-menu.ts`：菜单项、位置、目标和原生菜单豁免类型/纯函数。
- `src/web/components/ServerContextMenu.tsx`：Server 卡片和标签的动作列表。
- `tests/unit/web/context-menu.dom.test.tsx`：通用菜单的焦点、键盘、定位和关闭测试。
- `tests/unit/web/server-context-menu.dom.test.tsx`：Server/标签动作和危险动作测试。

### 修改

- `src/web/App.tsx`：工作区右键边界、Server/SFTP/主题回调和直接打开 SFTP 的请求桥接。
- `src/web/components/TerminalPanel.tsx`：终端右键菜单、选区监听和复制/粘贴快捷键。
- `src/web/components/TerminalWorkspace.tsx`：将 SFTP/新建 Console 请求传入终端面板，并在 Server 右键打开 SFTP 时激活目标会话。
- `src/web/components/HostWorkspace.tsx`、`HostList.tsx`、`HostCard.tsx`：Server 卡片和标签右键目标传递。
- `src/web/components/GroupSidebar.tsx`：左侧标签筛选项右键目标。
- `src/web/components/SftpPanel.tsx`、`SftpWorkspace.tsx`：第二阶段文件条目上下文菜单。
- `src/web/theme.ts`：主题 Token、预设、校验、持久化和 xterm 主题映射。
- `src/web/styles.css`：菜单样式、主题 Token 消费和移除跨主题硬编码颜色。
- `tests/unit/web/terminal-panel.dom.test.tsx`、`terminal-workspace.dom.test.tsx`：终端菜单、快捷键和 SFTP 请求。
- `tests/unit/web/host-card.dom.test.tsx`、`host-workspace.dom.test.tsx`：Server 卡片/标签菜单。
- `tests/unit/web/sftp-panel.dom.test.tsx`：文件菜单和过滤/选择交互回归。
- `tests/unit/web/theme.test.ts`、`tests/unit/web/app.dom.test.tsx`：主题预设和设置面板回归。
- `tests/e2e/host-to-terminal.spec.ts`：浏览器右键、终端复制粘贴、Server 标签菜单和主题刷新。
- `docs/superpowers/specs/2026-09-17-relay-context-menu-and-theme-upgrade-design.md`：本计划的体验和安全契约。

## Task 1: 建立 Context Menu 基础设施和浏览器右键边界

**Status:** Done（2026-09-17）
**Evidence:** `npm test -- --run tests/unit/web/context-menu.dom.test.tsx`、`npm run typecheck`、`npm run lint` 均通过。

**Files:**

- Create: `src/web/context-menu.ts`
- Create: `src/web/hooks/use-context-menu.ts`
- Create: `src/web/components/ContextMenu.tsx`
- Modify: `src/web/App.tsx:1201-1380`
- Modify: `src/web/styles.css`
- Test: `tests/unit/web/context-menu.dom.test.tsx`

**Interfaces:**

- Consumes: React mouse/keyboard events和现有 `app-shell` DOM边界。
- Produces: `ContextMenuItem`、`ContextMenuState<T>`、`useContextMenu<T>()` 和 `ContextMenu`，供 Terminal、Server、SFTP 复用。

```ts
export type ContextMenuTone = 'default' | 'danger';

export interface ContextMenuPosition {
  x: number;
  y: number;
}

export interface ContextMenuItem {
  id: string;
  label: string;
  shortcut?: string;
  disabled?: boolean;
  tone?: ContextMenuTone;
  separatorBefore?: boolean;
  onSelect: () => void | Promise<void>;
}

export interface ContextMenuState<T> {
  target: T;
  position: ContextMenuPosition;
}

export interface ContextMenuController<T> {
  state: ContextMenuState<T> | null;
  open: (event: React.MouseEvent, target: T) => void;
  close: () => void;
}

export const useContextMenu = <T>(): ContextMenuController<T>;
export const isNativeContextMenuTarget = (target: EventTarget | null): boolean => boolean;
```

- [x] **Step 1: 写失败的菜单行为测试**

在 `context-menu.dom.test.tsx` 覆盖：打开后第一个可用项获得焦点；ArrowDown 跳过 disabled 项；Enter 执行动作并关闭；Escape 关闭；菜单靠近右下角时不超出 viewport；点击 `input`、`textarea`、`select`、链接和 `[data-native-context-menu="true"]` 时 `isNativeContextMenuTarget()` 返回 `true`。

```tsx
fireEvent.contextMenu(screen.getByTestId('custom-surface'), { clientX: 780, clientY: 580 });
expect(screen.getByRole('menu')).toBeInTheDocument();
expect(screen.getByRole('menuitem', { name: '复制' })).toHaveFocus();
await user.keyboard('{Enter}');
expect(onCopy).toHaveBeenCalledOnce();
expect(screen.queryByRole('menu')).not.toBeInTheDocument();
fireEvent.contextMenu(screen.getByTestId('custom-surface'), { clientX: 780, clientY: 580 });
await user.keyboard('{ArrowDown}');
expect(screen.getByRole('menuitem', { name: '清除' })).toHaveFocus();
```

- [x] **Step 2: 运行聚焦测试确认缺口**

Run:

```bash
npm test -- --run tests/unit/web/context-menu.dom.test.tsx
```

Expected: 测试因缺少 `ContextMenu`、hook 或原生菜单判断而失败。

- [x] **Step 3: 实现最小通用菜单**

在 `src/web/context-menu.ts` 实现目标类型和 `isNativeContextMenuTarget()`；在 `use-context-menu.ts` 实现 `open(event, target)`、`close()` 和 document click/scroll/blur 清理；在 `ContextMenu.tsx` 实现 `role="menu"`、`role="menuitem"`、禁用项跳过、Escape 和定位边界。

在 App 的 `<main className="app-shell">` 增加工作区边界处理：非原生目标 `preventDefault()`，但不在这里决定业务菜单项。菜单组件通过业务组件在触发点渲染，避免 App 持有所有对象类型。

- [x] **Step 4: 增加菜单视觉 Token**

在 `styles.css` 增加 `.context-menu`、`.context-menu-item`、`.context-menu-separator`、`.context-menu-shortcut` 和危险状态样式，颜色全部使用已有语义变量，不直接写午夜蓝或白色常量。

- [x] **Step 5: 运行通过验证**

Run:

```bash
npm test -- --run tests/unit/web/context-menu.dom.test.tsx
npm run typecheck
npm run lint
```

Expected: 菜单单元/DOM 测试通过；TypeScript 和 ESLint 无新增错误。

- [x] **Step 6: Commit**

```bash
git add src/web/context-menu.ts src/web/hooks/use-context-menu.ts src/web/components/ContextMenu.tsx src/web/App.tsx src/web/styles.css tests/unit/web/context-menu.dom.test.tsx
git commit -m "feat: add accessible relay context menu"
```

## Task 2: 接入终端右键菜单和复制粘贴快捷键

**Status:** Done（2026-09-17）
**Evidence:** `npm test -- --run tests/unit/web/terminal-panel.dom.test.tsx tests/unit/web/terminal-workspace.dom.test.tsx`、`npm run typecheck`、`npm run lint` 均通过。

**Files:**

- Modify: `src/web/components/TerminalPanel.tsx`
- Modify: `src/web/components/TerminalWorkspace.tsx`
- Modify: `tests/unit/web/terminal-panel.dom.test.tsx`
- Modify: `tests/unit/web/terminal-workspace.dom.test.tsx`

**Interfaces:**

- Consumes: Task 1 的 `ContextMenu`/`useContextMenu`、现有 `ClipboardPort`、`SearchAddon`、`TerminalPanel` 的 `copySelection`/`pasteClipboard`/`clear`。
- Produces: `TerminalPanelProps.onOpenSftp?: () => void`、`TerminalPanelProps.onNewTerminal?: () => void`；终端选区右键和键盘行为。

- [x] **Step 1: 扩展 FakeTerminal 和写失败测试**

在测试 fake 中增加 `hasSelection()`、`selectAll()`、`onSelectionChange()` 和 `attachCustomKeyEventHandler()`，然后覆盖：右键展示菜单；无选区时复制 disabled；全选调用 xterm；选区存在时 Ctrl+C 不调用 `sendInput` 而调用 clipboard；无选区 Ctrl+C 返回给 xterm；Ctrl/Cmd+V 走现有确认流程；菜单中的“打开远程文件”和“新建 Console”调用对应 props。

```ts
fireEvent.contextMenu(document.querySelector('.terminal-canvas')!, { clientX: 160, clientY: 120 });
expect(screen.getByRole('menuitem', { name: '复制' })).toHaveAttribute('aria-disabled', 'true');
await user.click(screen.getByRole('menuitem', { name: '全选' }));
expect(fakeTerminal.selectAll).toHaveBeenCalledOnce();
```

- [x] **Step 2: 运行终端聚焦测试确认缺口**

Run:

```bash
npm test -- --run tests/unit/web/terminal-panel.dom.test.tsx tests/unit/web/terminal-workspace.dom.test.tsx
```

Expected: 新增右键菜单和按键断言在实现前失败，现有终端复制/粘贴测试仍可定位。

- [x] **Step 3: 连接终端选区和菜单状态**

在 TerminalPanel 中监听 `terminal.onSelectionChange`，用 state 维护 `hasSelection`；右键 `.terminal-canvas` 时通过 `useContextMenu` 打开终端目标。菜单项固定为：复制、粘贴、全选、清除选区、搜索、清屏，并按 `clipboard`、`hasSelection` 和可选回调设置 disabled。

- [x] **Step 4: 接入 xterm 自定义键盘处理**

使用 `terminal.attachCustomKeyEventHandler`：

```ts
if (event.type === 'keydown' && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'c') {
  if (!terminal.hasSelection()) return true;
  void copySelectionRef.current();
  return false;
}
if (event.type === 'keydown' && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'v') {
  if (!clipboard) return true;
  void pasteClipboardRef.current();
  return false;
}
return true;
```

通过 ref 保存最新 callback，避免 xterm 初始化 effect 因 callback 变化反复销毁会话。无选区 Ctrl+C 必须返回 `true`，保持远端 SIGINT 行为。

- [x] **Step 5: 把 SFTP/新建 Console 请求接入 Workspace**

TerminalWorkspace 传入：`onOpenSftp={() => setFilePanelOpen(true)}` 和 `onNewTerminal={() => setHostPickerOpen(true)}`；它们只改变当前 Web Workspace 视图，不新增 shared session 状态。

- [x] **Step 6: 运行终端验证**

Run:

```bash
npm test -- --run tests/unit/web/terminal-panel.dom.test.tsx tests/unit/web/terminal-workspace.dom.test.tsx
npm run typecheck
npm run lint
```

Expected: 终端右键、选区快捷键、SFTP 请求和既有复制粘贴测试通过。

- [x] **Step 7: Commit**

```bash
git add src/web/components/TerminalPanel.tsx src/web/components/TerminalWorkspace.tsx tests/unit/web/terminal-panel.dom.test.tsx tests/unit/web/terminal-workspace.dom.test.tsx
git commit -m "feat: add terminal context actions"
```

## Task 3: 接入 Server 卡片、卡片标签和左侧标签的右键功能

**Files:**

- Create: `src/web/components/ServerContextMenu.tsx`
- Modify: `src/web/components/HostCard.tsx`
- Modify: `src/web/components/HostList.tsx`
- Modify: `src/web/components/HostWorkspace.tsx`
- Modify: `src/web/components/GroupSidebar.tsx`
- Modify: `src/web/App.tsx`
- Modify: `src/web/styles.css`
- Test: `tests/unit/web/server-context-menu.dom.test.tsx`
- Modify: `tests/unit/web/host-card.dom.test.tsx`
- Modify: `tests/unit/web/host-workspace.dom.test.tsx`

**Interfaces:**

- Consumes: Task 1 的菜单基础设施、现有 Host actions、`ClipboardPort`、`HostMetadataState` 和标签筛选回调。
- Produces: `ServerContextTarget`、`ServerContextMenu`，以及 HostCard/GroupSidebar 的右键目标回调。

```ts
export type ServerContextTarget =
  | { kind: 'host'; host: HostMetadataState }
  | { kind: 'tag'; tag: string; hostId?: string };

export interface ServerContextActions {
  onConnect: (host: HostMetadataState) => void;
  onOpenSftp?: (host: HostMetadataState) => void;
  onCopyText: (value: string) => Promise<void> | void;
  onFavoriteToggle: (host: HostMetadataState) => void;
  onTagSelected: (tag: string) => void;
  onTestConnection?: (host: HostMetadataState) => void;
  onEdit?: (host: HostMetadataState) => void;
  onClearHostKey?: (host: HostMetadataState) => void;
  onDelete?: (host: HostMetadataState) => void;
}

export interface SftpOpenRequest {
  requestId: string;
  hostId: string;
}
```

- [ ] **Step 1: 写 Server/标签菜单失败测试**

测试 Host 卡片右键显示“进入 Console、复制地址、复制 SSH 命令、收藏、编辑、删除”；有 Host Key 时显示“清除 Host Key 信任”；删除和清除信任动作调用父级 callback，但菜单本身不绕过父级确认。

测试卡片标签和左侧标签均显示“按此标签筛选、复制标签”；标签右键不触发 Host 卡片菜单；当前标签已选中时显示“清除当前筛选”。

```tsx
fireEvent.contextMenu(screen.getByRole('button', { name: '筛选标签 prod' }), { clientX: 120, clientY: 80 });
expect(screen.getByRole('menuitem', { name: '复制标签' })).toBeInTheDocument();
await user.click(screen.getByRole('menuitem', { name: '按此标签筛选' }));
expect(onTagSelected).toHaveBeenCalledWith('prod');
```

- [ ] **Step 2: 运行 Host 聚焦测试确认缺口**

Run:

```bash
npm test -- --run tests/unit/web/server-context-menu.dom.test.tsx tests/unit/web/host-card.dom.test.tsx tests/unit/web/host-workspace.dom.test.tsx
```

Expected: 新增菜单断言失败，既有卡片按钮和标签左键筛选测试保持可执行。

- [ ] **Step 3: 增加 Host 和标签目标传递**

给 HostCard 增加 `onContextMenu` 和 `onTagContextMenu`；在标签 button 上调用 `stopPropagation()` 后交给标签目标；HostList/HostWorkspace 原样传递；GroupSidebar 的标签 button 也增加标签目标回调。

- [ ] **Step 4: 实现连接信息格式化和动作列表**

在 `ServerContextMenu.tsx` 内使用纯函数生成不含 secret 的文本；复制地址保持可读格式，复制 SSH 命令对用户输入做 shell quoting：

```ts
export const hostAddressText = (host: HostMetadataState): string => `${host.username}@${host.address}:${host.port}`;
const shellQuote = (value: string): string => "'" + value.replaceAll("'", "'\\\"'\\\"'") + "'";
export const sshCommandText = (host: HostMetadataState): string => `ssh -p ${host.port} ${shellQuote(`${host.username}@${host.address}`)}`;
```

Host 菜单按普通动作、连接管理、危险动作顺序生成；标签菜单只生成标签筛选、复制和清除筛选动作。复制动作统一调用 `onCopyText`，由 App 使用现有 ClipboardPort 处理权限和反馈。

- [ ] **Step 5: 支持从 Server 菜单直接打开 SFTP**

App 增加 `sftpOpenRequest: SftpOpenRequest | null` 状态和 `handleOpenSftp(host)`：先复用 `handleOpenTerminal(host)`，再把 `{ requestId, hostId }` 传给 TerminalWorkspace。TerminalWorkspaceProps 使用 `openSftpRequest?: SftpOpenRequest` 和 `onSftpRequestConsumed?: (requestId: string) => void`；目标 terminal 出现后激活它、打开全屏 SFTP，并回调清理请求，避免刷新或重复 render 再次打开。

- [ ] **Step 6: 保留现有安全确认**

ServerContextMenu 不直接调用 runtime delete 或 Host Key API，只调用现有 `onDelete` 和 `onClearHostKey`；App 中的 `handleDeleteHost`、`handleClearHostKey` 继续负责 `window.confirm` 和错误反馈。

- [ ] **Step 7: 运行 Server 验证**

Run:

```bash
npm test -- --run tests/unit/web/server-context-menu.dom.test.tsx tests/unit/web/host-card.dom.test.tsx tests/unit/web/host-workspace.dom.test.tsx
npm run typecheck
npm run lint
```

Expected: Server 卡片、卡片标签、左侧标签和直接打开 SFTP 的行为通过；现有 Host CRUD 测试无回归。

- [ ] **Step 8: Commit**

```bash
git add src/web/components/ServerContextMenu.tsx src/web/components/HostCard.tsx src/web/components/HostList.tsx src/web/components/HostWorkspace.tsx src/web/components/GroupSidebar.tsx src/web/App.tsx src/web/styles.css tests/unit/web/server-context-menu.dom.test.tsx tests/unit/web/host-card.dom.test.tsx tests/unit/web/host-workspace.dom.test.tsx
git commit -m "feat: add server and tag context actions"
```

## Task 4: 扩展终端标签和 SFTP 文件上下文操作

**Files:**

- Modify: `src/web/components/TerminalWorkspace.tsx`
- Modify: `src/web/components/SftpPanel.tsx`
- Modify: `src/web/components/SftpWorkspace.tsx`
- Modify: `src/web/styles.css`
- Test: `tests/unit/web/terminal-workspace.dom.test.tsx`
- Modify: `tests/unit/web/sftp-panel.dom.test.tsx`

**Interfaces:**

- Consumes: Task 1 的 `ContextMenu`、现有 `onClose`、SFTP mutation/transfer callbacks、`SftpEntry` 和当前目录过滤/选择状态。
- Produces: 标签页和 SFTP 文件条目的上下文动作，不新增服务端 API。

- [ ] **Step 1: 写终端标签菜单失败测试**

右键 terminal tab 后断言可以激活标签、关闭当前标签、关闭其他标签和打开该标签 SFTP；关闭其他标签不能关闭当前目标以外的 tab，最后一个 tab 的行为沿用现有 `onClose` 约束。

- [ ] **Step 2: 实现终端标签菜单**

在 tab 容器上绑定 `useContextMenu`，目标为 `terminalId`；动作调用 `activateTerminal`、已有 `onClose` 和 SFTP 请求桥接，不把标签关闭直接写入 DOM。

- [ ] **Step 3: 写 SFTP 文件菜单失败测试**

覆盖文件右键显示下载、复制远程路径、重命名、删除；目录右键显示进入目录；没有对应 callback 时菜单项 disabled；删除仍然打开现有 Dialog；当前 filter 下只对可见条目响应右键。

```tsx
fireEvent.contextMenu(screen.getByRole('button', { name: '配置文件' }), { clientX: 240, clientY: 160 });
expect(screen.getByRole('menuitem', { name: '复制远程路径' })).toBeInTheDocument();
await user.click(screen.getByRole('menuitem', { name: '下载' }));
expect(onDownload).toHaveBeenCalledWith('/etc/config.yml', 'config.yml');
```

- [ ] **Step 4: 实现 SFTP 条目菜单**

复用当前 `selectedPaths`、`dialog` 和 `onNavigate`；复制路径只传给 `onCopyText`，下载/重命名/删除调用既有 callback。不得绕过 SFTP 路径规范化和 mutation capability。

- [ ] **Step 5: 运行 SFTP/Workspace 验证**

Run:

```bash
npm test -- --run tests/unit/web/terminal-workspace.dom.test.tsx tests/unit/web/sftp-panel.dom.test.tsx
npm run typecheck
npm run lint
```

- [ ] **Step 6: Commit**

```bash
git add src/web/components/TerminalWorkspace.tsx src/web/components/SftpPanel.tsx src/web/components/SftpWorkspace.tsx src/web/styles.css tests/unit/web/terminal-workspace.dom.test.tsx tests/unit/web/sftp-panel.dom.test.tsx
git commit -m "feat: add terminal tab and sftp context actions"
```

## Task 5: 将主题改为语义化 Token 和现代预设

**Files:**

- Modify: `src/web/theme.ts`
- Modify: `src/web/styles.css`
- Modify: `src/web/components/TerminalPanel.tsx`
- Modify: `tests/unit/web/theme.test.ts`

**Interfaces:**

- Consumes: 现有 `UiPreferences`、`TerminalTheme`、`data-relay-theme`、`getTerminalTheme()` 和 CSS 变量。
- Produces: 扩展后的 `ThemeName`、`ThemeDefinition`、`ThemeTokens`、`themeOptions` 和 `getThemeDefinition()`。

```ts
export type ThemeName = 'midnight' | 'light' | 'contrast' | 'nord' | 'dracula' | 'solarized-dark' | 'oled';

export interface ThemeTokens {
  bg: string;
  bgRaised: string;
  panel: string;
  panelSoft: string;
  panelHover: string;
  panelActive: string;
  border: string;
  borderStrong: string;
  text: string;
  muted: string;
  faint: string;
  blue: string;
  blueStrong: string;
  primaryText: string;
  focusRing: string;
  green: string;
  yellow: string;
  red: string;
  terminalBg: string;
  shadow: string;
}

export interface ThemeDefinition {
  id: ThemeName;
  label: string;
  colorScheme: 'light' | 'dark';
  tokens: ThemeTokens;
  terminal: TerminalTheme;
  themeColor: string;
  swatches: readonly string[];
}
```

- [ ] **Step 1: 写主题预设和兼容性失败测试**

测试七个预设都能被 `loadPreferences` 接受；旧的 `midnight`、`light`、`contrast` JSON 不变；未知主题回退默认；`applyPreferences` 设置 `data-relay-theme`、CSS Token、color-scheme、字号和 meta theme-color；设置 `data-theme="light"` 不影响 Relay 属性。

```ts
applyPreferences({ theme: 'nord', fontSize: 14 });
expect(document.documentElement.dataset.relayTheme).toBe('nord');
expect(document.documentElement.style.getPropertyValue('--panel')).not.toBe('');
expect(document.documentElement.style.getPropertyValue('color-scheme')).toBe('dark');
```

- [ ] **Step 2: 运行主题聚焦测试确认缺口**

Run:

```bash
npm test -- --run tests/unit/web/theme.test.ts
```

Expected: 新主题校验和 CSS Token 断言在实现前失败。

- [ ] **Step 3: 建立 ThemeDefinition 注册表**

将现有三套 `terminalThemes` 和 `themeColors` 合并到 `themeDefinitions`；为 Nord、Dracula、Solarized Dark、OLED 增加完整 UI Token 和 ANSI 16 色；`getTerminalTheme(theme)` 从注册表返回终端调色板，保留现有调用签名。

- [ ] **Step 4: 让 applyPreferences 写入语义变量**

`applyPreferences()` 继续写 `document.documentElement.dataset.relayTheme`，并逐项写入 `ThemeTokens` 对应的 CSS 自定义属性；同时设置 `color-scheme`、`--terminal-font-size` 和 meta theme-color。禁止修改 `data-theme`。

- [ ] **Step 5: 迁移 CSS 的跨主题硬编码颜色**

将菜单、终端 tab、toolbar、host card、dialog、SFTP toolbar 和状态提示中影响主题的背景、边框、文本颜色迁移到语义变量；保留只表达 ANSI/状态的颜色，但确保浅色、高对比和 OLED 下文本对比度可读。

- [ ] **Step 6: 运行主题验证**

Run:

```bash
npm test -- --run tests/unit/web/theme.test.ts tests/unit/web/terminal-panel.dom.test.tsx
npm run typecheck
npm run lint
npm run build:web
```

Expected: 预设、xterm 颜色、CSS Token、第三方 `data-theme` 隔离和 Web 构建全部通过。

- [ ] **Step 7: Commit**

```bash
git add src/web/theme.ts src/web/styles.css src/web/components/TerminalPanel.tsx tests/unit/web/theme.test.ts tests/unit/web/terminal-panel.dom.test.tsx
git commit -m "feat: add semantic relay theme presets"
```

## Task 6: 升级偏好设置中的主题选择和预览

**Files:**

- Modify: `src/web/App.tsx`
- Modify: `src/web/theme.ts`
- Modify: `src/web/styles.css`
- Modify: `tests/unit/web/app.dom.test.tsx`
- Modify: `tests/e2e/host-to-terminal.spec.ts`

**Interfaces:**

- Consumes: Task 5 的 `themeOptions`、`ThemeDefinition.swatches` 和现有 `PreferencesPanel`。
- Produces: 带主题色板预览的偏好设置选择，仍使用 `UiPreferences` 和现有本地持久化。

- [ ] **Step 1: 写主题设置失败测试**

打开偏好设置后断言七个主题选项存在、每个主题有可访问的色板/预览标识；切换到 Nord 后立即更新 `data-relay-theme` 和一个 Token；刷新/重新 bootstrap 后仍是 Nord；未写入设置时使用 Midnight。

- [ ] **Step 2: 实现主题选择器预览**

在现有 `select` 旁增加 `theme-preview-list`，每个预设显示名称和 3–5 个 swatch；点击或选择只更新 `UiPreferences`，不创建新的设置存储 key。预览元素使用 `aria-label="预览主题：${label}"`，不把颜色作为唯一信息。

- [ ] **Step 3: 增加设置面板窄屏样式**

预览列表在 320px 宽度下改为两列或横向滚动；确保菜单、设置面板和 Server 标签菜单不造成水平滚动。

- [ ] **Step 4: 运行 Web/浏览器验证**

Run:

```bash
npm test -- --run tests/unit/web/app.dom.test.tsx tests/unit/web/theme.test.ts
npm run typecheck
npm run lint
npm run build:web
npm run test:e2e -- tests/e2e/host-to-terminal.spec.ts --grep "theme|context|clipboard|标签"
```

Expected: 偏好设置、刷新持久化、右键边界、主题预览和窄屏关键路径通过。

- [ ] **Step 5: Commit**

```bash
git add src/web/App.tsx src/web/theme.ts src/web/styles.css tests/unit/web/app.dom.test.tsx tests/e2e/host-to-terminal.spec.ts
git commit -m "feat: add theme previews and browser interaction coverage"
```

## Task 7: 完成回归矩阵、人工走查和交付记录

**Files:**

- Modify: `tests/e2e/host-to-terminal.spec.ts`
- Modify: `tests/unit/web/context-menu.dom.test.tsx`
- Modify: `tests/unit/web/server-context-menu.dom.test.tsx`
- Modify: `docs/superpowers/specs/2026-09-17-relay-context-menu-and-theme-upgrade-design.md`
- Modify: `docs/superpowers/plans/2026-09-17-relay-context-menu-and-theme-upgrade.md`

**Interfaces:**

- Consumes: Tasks 1–6 的稳定 UI 行为和主题预设。
- Produces: 可重复的 focused 验证证据、人工走查清单和任务状态记录。

- [ ] **Step 1: 增加浏览器关键路径**

Playwright 覆盖：

1. Server 卡片右键打开菜单并复制地址；
2. 卡片标签和左侧标签右键筛选；
3. 输入框右键仍显示浏览器原生菜单，不出现 Relay menu；
4. 终端输出选中后右键复制，粘贴出现确认；
5. 切换 Nord/OLED/High Contrast 后刷新，Relay 主题保持，第三方 `data-theme="light"` 不影响 `data-relay-theme`；
6. 320px 宽度下菜单和偏好设置不产生横向溢出。

- [ ] **Step 2: 执行适当验证**

Run:

```bash
npm test -- --run tests/unit/web/context-menu.dom.test.tsx tests/unit/web/server-context-menu.dom.test.tsx tests/unit/web/terminal-panel.dom.test.tsx tests/unit/web/terminal-workspace.dom.test.tsx tests/unit/web/sftp-panel.dom.test.tsx tests/unit/web/theme.test.ts tests/unit/web/app.dom.test.tsx
npm run typecheck
npm run lint
npm run build:web
npm run test:e2e -- tests/e2e/host-to-terminal.spec.ts --grep "theme|context|clipboard|标签"
```

只有在这次改动扩展到 shared core、服务端 API、数据库迁移、权限边界或完整构建链时，才追加：

```bash
npm test
npm run build
npm run test:e2e
```

- [ ] **Step 3: 更新计划状态和验证证据**

在本计划每个任务下记录完成日期、commit、聚焦命令和结果；在 spec 中把“提案”更新为“已实现”，并记录仍然延期的自定义主题编辑器、团队共享和跨平台同步项。

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/host-to-terminal.spec.ts tests/unit/web/context-menu.dom.test.tsx tests/unit/web/server-context-menu.dom.test.tsx docs/superpowers/specs/2026-09-17-relay-context-menu-and-theme-upgrade-design.md docs/superpowers/plans/2026-09-17-relay-context-menu-and-theme-upgrade.md
git commit -m "docs: record relay interaction and theme verification"
```

## 交付顺序和依赖

1. Task 1：所有右键能力的基础设施，必须先完成。
2. Task 2：终端高频操作；依赖 Task 1。
3. Task 3：Server 卡片、卡片标签和左侧标签；依赖 Task 1，可与 Task 2 独立开发。
4. Task 4：终端标签和 SFTP 文件菜单；依赖 Task 1，可在 Task 2/3 后执行。
5. Task 5：主题 Token 和预设；可与 Task 2/3 并行，但最终 CSS 验证依赖菜单样式完成。
6. Task 6：设置面板预览；依赖 Task 5。
7. Task 7：统一回归和交付记录；依赖所有进入当前迭代的任务。

## 当前计划状态

| Task | 状态 | 说明 |
| --- | --- | --- |
| Task 1 | Ready | 等待用户确认计划后实现 |
| Task 2 | Done | 终端右键菜单、选区复制快捷键和 SFTP/新建 Console 入口已完成；验证通过 |
| Task 3 | Ready | 依赖 Task 1；包含 Server 标签右键 |
| Task 4 | Deferred | 第二阶段，复用 Task 1 |
| Task 5 | Ready | 主题 Token 与预设 |
| Task 6 | Ready | 主题预览与刷新持久化 |
| Task 7 | Ready | 实现完成后执行 |
