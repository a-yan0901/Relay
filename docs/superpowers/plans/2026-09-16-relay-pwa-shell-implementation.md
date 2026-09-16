# Relay PWA Shell Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将当前 Web-first Relay 变成可安装、可安全离线启动、具备明确网络反馈以及用户主动剪贴板/通知能力的 PWA shell，同时保持 server-mediated SSH 和 shared core 安全边界不变。

**Architecture:** 使用 Vite `public/` 目录提供 manifest、service worker 和品牌图标；service worker 只缓存同源 app shell/静态 GET，不缓存 `/api/`、`/ws/` 或任何运行时数据。shared core 只增加平台中立的可选 `ClipboardPort`/`NotificationPort`，Web adapter 负责浏览器 API、权限和稳定错误映射，React 只消费可选服务与已有网络状态。

**Tech Stack:** TypeScript 6、React 19、Vite、Web App Manifest、Service Worker Cache API、Clipboard API、Notifications API、Vitest/jsdom、Playwright Chromium。

**Spec:** `docs/superpowers/specs/2026-09-16-relay-platform-shell-design.md`

## Global Constraints

- Web/PWA 继续使用 server-mediated SSH；本计划不实现 local SSH、账号同步、后台常驻 SSH 或离线命令队列。
- service worker 只能缓存同源、非 `/api/`、非 `/ws/` 的 GET 响应；不得缓存凭据、主密码、token、完整终端输出、SFTP 内容或活动明细。
- `ClipboardPort.readText()` 只能由用户明确点击触发；连接、加载、service worker 事件和页面恢复不得自动读取剪贴板。
- 通知标题/正文只包含脱敏任务摘要，不包含密码、私钥、token、完整命令、终端输出、完整 Host 地址、用户名或敏感路径。
- 浏览器 `File`、`Blob`、`Notification`、`Clipboard`、`ServiceWorkerRegistration` 只能出现在 Web adapter/UI 边界；`src/shared` 不导入浏览器对象。
- 不支持浏览器能力时隐藏或降级操作，并保留文字状态和应用内反馈；通知/剪贴板失败不能改变 SSH、传输或命令任务终态。
- 最低支持视口为 320px；新增按钮必须有可见焦点、中文 accessible name 和不依赖颜色的状态表达。
- 这是 PWA 独立子项目；Desktop/Android 原生工程、系统 keychain/Keystore 和平台本地 transport 另立计划。

## File Map

- Create: `public/manifest.webmanifest` — PWA 名称、图标、启动范围、显示模式和主题色。
- Create: `public/sw.js` — 版本化 app-shell cache、激活清理、静态资源 runtime cache 和 offline navigation fallback。
- Create: `public/icons/relay-192.svg`, `public/icons/relay-512.svg` — 不含外部资源的品牌图标。
- Create: `src/web/platform/browser-system-services.ts` — Clipboard/Notification adapter、浏览器能力检测和 permission 映射。
- Create: `src/web/platform/pwa-registration.ts` — service worker 注册和 standalone 检测，集中隔离 `navigator.serviceWorker`。
- Create: `tests/unit/shared/platform-services-contract.test.ts` — shared 可选系统能力端口的类型/行为 contract fake。
- Create: `tests/unit/web/browser-system-services.test.ts` — 浏览器 adapter 的支持、权限、用户动作失败和稳定错误测试。
- Create: `tests/unit/web/pwa-registration.test.ts` — service worker 注册成功/不支持/失败降级测试。
- Modify: `src/shared/core/ports.ts` — 增加平台中立的 `ClipboardPort`、`NotificationPort`、`PlatformServices`。
- Modify: `src/shared/core/runtime.ts` — 给 `CoreRuntime` 增加可选 `platformServices`，不使 Local-only runtime 产生新必选依赖。
- Modify: `src/web/platform/web-adapters.ts` — 默认注入 browser system services，并允许测试/宿主注入替代服务。
- Modify: `src/web/main.tsx`, `index.html` — 注册 PWA shell、声明 manifest 和移动 Web 元数据。
- Modify: `src/web/App.tsx`, `src/web/styles.css` — 网络/安装状态、通知权限入口、任务终态脱敏通知和系统服务向终端 workspace 的传递。
- Modify: `src/web/components/TerminalWorkspace.tsx`, `src/web/components/TerminalPanel.tsx`, `src/web/components/TerminalToolbar.tsx` — 用户主动复制/粘贴入口和失败反馈。
- Modify: `tests/unit/web/app.dom.test.tsx`, `tests/unit/web/terminal-panel.dom.test.tsx`, `tests/e2e/ssh-productivity.spec.ts` — PWA/权限/剪贴板/通知/响应式行为断言。
- Modify: `docs/architecture/cross-platform.md`, `docs/superpowers/plans/2026-09-16-relay-long-term-roadmap.md` — 记录 PWA 交付边界和证据。

## Implementation Tasks

### Task 1: 固化平台系统能力的 shared contract

**Files:**

- Modify: `src/shared/core/ports.ts`
- Modify: `src/shared/core/runtime.ts`
- Test: `tests/unit/shared/platform-services-contract.test.ts`

**Interfaces:**

新增以下平台中立类型，并将 `platformServices?: PlatformServices` 加入 `CoreRuntime`：

```ts
export type NotificationPermission = 'default' | 'granted' | 'denied';

export interface NotificationRequest {
  title: string;
  body: string;
  tag?: string;
}

export interface NotificationPort {
  permission(): Promise<NotificationPermission>;
  requestPermission(): Promise<NotificationPermission>;
  notify(request: NotificationRequest): Promise<void>;
}

export interface ClipboardPort {
  readText(): Promise<string>;
  writeText(text: string): Promise<void>;
}

export interface PlatformServices {
  clipboard?: ClipboardPort;
  notifications?: NotificationPort;
}
```

- [x] **Step 1: Write the failing contract fake.**

  在 `platform-services-contract.test.ts` 中创建只使用字符串和 `Promise` 的 fake：记录 `readText`/`writeText` 参数，记录 notification request，并断言 `PlatformServices` 可以作为 `CoreRuntime.platformServices` 的可选字段使用。测试不得引用 `window`、`navigator`、`Notification` 或 `Clipboard`。

- [x] **Step 2: Run the focused typecheck to verify the contract is absent.**

  Run: `npx tsc --ignoreConfig --noEmit --target ES2022 --module NodeNext --moduleResolution NodeNext --strict --skipLibCheck --esModuleInterop tests/unit/shared/platform-services-contract.test.ts`
  Expected: FAIL，因为新增类型和 `CoreRuntime.platformServices` 尚不存在；Vitest 本身只转译此 type-only contract，不承担 export 检查。

- [x] **Step 3: Add the platform-neutral types and optional runtime field.**

  把类型放在 `src/shared/core/ports.ts`，从 `runtime.ts` 导入 `PlatformServices`，将 `platformServices?: PlatformServices` 放在 `CoreRuntime` 的 transport/store 字段附近。不要把它设为 required，也不要把浏览器检测逻辑放进 shared。

- [x] **Step 4: Run the focused contract and boundary tests.**

  Run: `npx tsc --ignoreConfig --noEmit --target ES2022 --module NodeNext --moduleResolution NodeNext --strict --skipLibCheck --esModuleInterop tests/unit/shared/platform-services-contract.test.ts && npx vitest run tests/unit/shared/platform-services-contract.test.ts tests/unit/shared/core-boundary.test.ts`
  Expected: PASS；shared boundary 不出现 DOM、浏览器存储或平台 API。

- [x] **Step 5: Commit the shared contract.**

  ```bash
  git add src/shared/core/ports.ts src/shared/core/runtime.ts tests/unit/shared/platform-services-contract.test.ts
  git diff --cached --check
  git commit -m "feat: add optional platform system ports"
  ```

### Task 2: 实现 Web Clipboard/Notification adapter 和能力检测

**Files:**

- Create: `src/web/platform/browser-system-services.ts`
- Modify: `src/web/platform/web-adapters.ts`
- Test: `tests/unit/web/browser-system-services.test.ts`

**Interfaces:**

`browser-system-services.ts` 导出：

```ts
export interface BrowserSystemCapabilities {
  clipboardRead: boolean;
  clipboardWrite: boolean;
  notifications: boolean;
}

export interface BrowserSystemServices extends PlatformServices {
  capabilities: BrowserSystemCapabilities;
}

export const detectBrowserSystemCapabilities: () => BrowserSystemCapabilities;
export const createBrowserSystemServices: () => BrowserSystemServices;
```

实现细节必须固定：

- Clipboard 仅在 `isSecureContext !== false` 且 API 方法存在时报告对应能力；缺失或拒绝统一抛 `new AppError('CAPABILITY_UNAVAILABLE')`。
- Notification 未定义时 `permission()` 返回 `'denied'`；存在时只读取浏览器 permission。`requestPermission()` 只由 UI 调用；`notify()` 仅在 permission 为 `'granted'` 时创建通知，否则抛 `CAPABILITY_UNAVAILABLE`。
- `notify()` 只接收已经由调用方脱敏的 `NotificationRequest`，不把异常原文写入日志；构造器异常也映射为 `CAPABILITY_UNAVAILABLE`。
- 为测试提供不依赖全局对象的内部 host 参数或小型 host factory；生产导出仍使用 `globalThis`，不在 App 中直接访问 `navigator.clipboard`/`Notification`。

- [x] **Step 1: Write failing adapter tests.**

  覆盖以下断言：安全上下文和方法存在时 read/write 可调用；非安全上下文或方法缺失时能力为 false 且操作抛 `CAPABILITY_UNAVAILABLE`；notification permission 为 `default` 时不会创建通知；显式 request 后变成 `granted` 才允许 notify；底层 API reject 映射为稳定 AppError；request body 原样只传给 host，不由 adapter 拼接 Host/命令信息。

- [x] **Step 2: Run the focused adapter tests and observe failure.**

  Run: `npx vitest run tests/unit/web/browser-system-services.test.ts`
  Expected: FAIL，因为 adapter 尚不存在。

- [x] **Step 3: Implement the browser adapters.**

  使用 `ClipboardPort`/`NotificationPort` 实现依赖注入；`createBrowserSystemServices()` 返回 ports 和检测结果。所有 capability 判断只影响 UI 可用性，不修改 server capability intersection。

- [x] **Step 4: Inject services from Web adapters.**

  在 `createWebAdapters(options)` 中增加 `platformServices?: PlatformServices` 可选参数；调用方提供时原样使用，未提供时调用 `createBrowserSystemServices()`。返回对象的 `platformServices` 仍是可选 shared 字段，现有 fake runtime 无需实现。

- [x] **Step 5: Run adapter, Web adapter and core type checks.**

  Run: `npx vitest run tests/unit/web/browser-system-services.test.ts tests/unit/web/web-adapters.test.ts tests/unit/shared/core-models.test.ts && npm run typecheck`
  Expected: PASS。

- [x] **Step 6: Commit the adapter boundary.**

  ```bash
  git add src/web/platform/browser-system-services.ts src/web/platform/web-adapters.ts tests/unit/web/browser-system-services.test.ts
  git diff --cached --check
  git commit -m "feat: add browser system capability adapters"
  ```

### Task 3: 增加可安装 PWA shell 和安全 service worker

**Files:**

- Create: `public/manifest.webmanifest`
- Create: `public/sw.js`
- Create: `public/icons/relay-192.svg`
- Create: `public/icons/relay-512.svg`
- Create: `src/web/platform/pwa-registration.ts`
- Modify: `index.html`
- Modify: `src/web/main.tsx`
- Test: `tests/unit/web/pwa-registration.test.ts`

**Interfaces and invariants:**

```ts
export interface PwaRegistrationResult {
  supported: boolean;
  registered: boolean;
}

export const registerPwaServiceWorker: (environment?: PwaRegistrationEnvironment) => Promise<PwaRegistrationResult>;
export const isStandaloneDisplayMode: (environment?: PwaRegistrationEnvironment) => boolean;
```

- manifest 使用 `name: "Relay SSH Workspace"`、`short_name: "Relay"`、`start_url: "/"`、`scope: "/"`、`display: "standalone"`、`theme_color: "#07111f"` 和 `background_color: "#07111f"`；图标使用本地 SVG，不能请求外部资源。
- service worker 使用版本常量，例如 `relay-shell-v1`；install 预缓存 `/` 和 `/manifest.webmanifest`，activate 删除旧的 `relay-shell-` cache 并 `clients.claim()`。
- fetch 只处理 same-origin GET；`/api/`、`/ws/`、非 GET 和跨 origin 直接交给浏览器。导航请求网络失败时回退到缓存的 `/`；静态 GET 网络成功且 response `ok` 时才写入 cache。
- 注册失败只返回 `{ supported: true, registered: false }`，不阻断 React 启动；development/test 不主动清理用户已有 registration。

- [x] **Step 1: Write failing registration tests.**

  注入 fake `serviceWorker.register`，覆盖支持且注册成功、`serviceWorker` 不存在、register reject 三种结果；验证 `isStandaloneDisplayMode()` 在 `matchMedia('(display-mode: standalone)')` true 或 iOS standalone true 时返回 true，普通浏览器返回 false。

- [x] **Step 2: Run focused registration tests and observe failure.**

  Run: `npx vitest run tests/unit/web/pwa-registration.test.ts`
  Expected: FAIL，因为 registration module 尚不存在。

- [x] **Step 3: Add manifest, icons and service worker.**

  所有静态内容使用绝对根路径；service worker 中明确排除 API/WSS，不能使用 network-first 缓存 API 响应。

- [x] **Step 4: Add the registration boundary and bootstrap it.**

  `main.tsx` 在 `createRoot(...).render(...)` 前调用 `void registerPwaServiceWorker()`；不得 await 它或把失败渲染成 boot error。`index.html` 增加 manifest、description、apple mobile web app 元数据。

- [x] **Step 5: Run static/PWA verification.**

  Run: `npx vitest run tests/unit/web/pwa-registration.test.ts && npm run build:web && test -f dist/web/manifest.webmanifest && test -f dist/web/sw.js && git diff --check`
  Expected: PASS；构建产物包含 manifest、service worker 和两个图标，Web bundle 不请求 `/api/` 作为 shell cache。

- [x] **Step 6: Commit the PWA shell.**

  ```bash
  git add index.html public src/web/main.tsx src/web/platform/pwa-registration.ts tests/unit/web/pwa-registration.test.ts
  git diff --cached --check
  git commit -m "feat: add installable relay pwa shell"
  ```

### Task 4: 接入网络/权限反馈和终端剪贴板动作

**Files:**

- Modify: `src/web/App.tsx`
- Modify: `src/web/components/TerminalWorkspace.tsx`
- Modify: `src/web/components/TerminalPanel.tsx`
- Modify: `src/web/components/TerminalToolbar.tsx`
- Modify: `src/web/styles.css`
- Test: `tests/unit/web/app.dom.test.tsx`, `tests/unit/web/terminal-panel.dom.test.tsx`

**Interfaces:**

- `TerminalWorkspace`/`TerminalPanel` 接收 `clipboard?: ClipboardPort`；无 port 时不渲染系统复制/粘贴按钮。
- `TerminalPanelToolbarState` 扩展 `onCopy?: () => Promise<void>` 和 `onPaste?: () => Promise<void>`；`TerminalToolbar` 只在回调存在时显示“复制选择”“粘贴”按钮。
- App 从 `runtime.platformServices?.clipboard` 传递 clipboard；App 不直接访问浏览器 clipboard。
- `PreferencesPanel` 接收可选 `notifications?: NotificationPort`、当前 `NotificationPermission` 和 `onRequestNotifications`，只在用户点击“启用桌面通知”时调用 request。

交互规则：

- “复制选择”只复制 xterm 当前 selection；无 selection 显示应用内状态，不读取或猜测终端内容。
- “粘贴”点击后先读取剪贴板，再弹出只包含字符数的确认；确认后才 `session.sendInput(text)`，不显示/记录文本内容。空文本不发送。
- 剪贴板失败显示脱敏的 `role=status`，不抛到全局错误，不改变连接状态。
- 网络离线 banner 继续保留 workspace，增加明确的 offline 说明；重新 online 时显示短暂“网络已恢复，正在检查会话状态”反馈后自动消失，不能声称所有 session 已恢复。
- 偏好设置显示通知状态：不支持/已拒绝/待授权/已启用；权限拒绝时仍说明应用内 Activity 可用。

- [ ] **Step 1: Write failing DOM tests.**

  在 App DOM test 中注入 fake `platformServices`，断言通知按钮只在点击时调用 `requestPermission`，拒绝后显示降级文案；在 TerminalPanel DOM test 中注入 clipboard fake，断言复制传入 selection、粘贴需要确认后才发送，拒绝确认或 adapter reject 均不发送文本。

- [ ] **Step 2: Run focused DOM tests and observe failure.**

  Run: `npx vitest run tests/unit/web/app.dom.test.tsx tests/unit/web/terminal-panel.dom.test.tsx`
  Expected: FAIL，因为 UI 尚未接收 platform services 和剪贴板回调。

- [ ] **Step 3: Thread optional services through the terminal workspace.**

  逐层传递 `ClipboardPort` 和异步回调；在 TerminalPanel 内保留 xterm `Terminal` ref，使用 `terminal.getSelection()`，粘贴前只生成 `将粘贴 ${text.length} 个字符到终端，是否继续？` 的确认文案。

- [ ] **Step 4: Add notification permission and lifecycle feedback.**

  App mount 时只读取 `permission()`，不请求权限；按钮点击调用 `requestPermission()` 并更新状态。command run 从 `queued/running` 进入 `completed/failed/cancelled` 时，如 permission 已是 `granted`，发送不含 Host/命令/输出的摘要通知；通知失败只留应用内状态。

- [ ] **Step 5: Add responsive/accessibility styles and run focused tests.**

  为 system action、permission row 和 network feedback 增加现有 token 的样式；在 320px 下操作栏允许换行或折叠，不能横向溢出。Run: `npx vitest run tests/unit/web/app.dom.test.tsx tests/unit/web/terminal-panel.dom.test.tsx tests/unit/web/terminal-workspace.dom.test.tsx && npm run lint && npm run typecheck`
  Expected: PASS。

- [ ] **Step 6: Commit the user-facing PWA interactions.**

  ```bash
  git add src/web/App.tsx src/web/components/TerminalWorkspace.tsx src/web/components/TerminalPanel.tsx src/web/components/TerminalToolbar.tsx src/web/styles.css tests/unit/web/app.dom.test.tsx tests/unit/web/terminal-panel.dom.test.tsx
  git diff --cached --check
  git commit -m "feat: add pwa network and system interactions"
  ```

### Task 5: 增加 PWA e2e 与文档证据

**Files:**

- Modify: `tests/e2e/ssh-productivity.spec.ts`
- Modify: `docs/architecture/cross-platform.md`
- Modify: `docs/superpowers/plans/2026-09-16-relay-long-term-roadmap.md`

- [ ] **Step 1: Write the failing browser checks.**

  添加 Chromium 检查：`/manifest.webmanifest` 返回 JSON 且包含 `name/start_url/display/icons`；service worker 脚本可访问；离线事件显示网络提示且工作区仍在；在 320px viewport 下 `document.documentElement.scrollWidth <= window.innerWidth`。浏览器权限 API 不可用时测试只断言应用内降级，不强行授予权限。

- [ ] **Step 2: Run the focused e2e checks and observe failure.**

  Run: `npx playwright test tests/e2e/ssh-productivity.spec.ts --project=chromium`
  Expected: 新增 PWA 断言在静态资产或 UI 尚未完成时失败，既有 SSH productivity 场景保持可定位。

- [ ] **Step 3: Implement the browser checks and fix only affected behavior.**

  使用现有 `webServer` 构建路径；不把 service worker 注册状态当作 SSH 连接成功条件，不在 e2e 中依赖持久化浏览器权限。

- [ ] **Step 4: Record architecture and roadmap evidence.**

  在 `cross-platform.md` 增加当前 PWA 已交付项和明确未交付项；路线图 X-02 记录 PWA 子计划/验证证据，Desktop/Android 仍保持独立计划状态。

- [ ] **Step 5: Run the affected release checks.**

  Run: `npx vitest run tests/unit/shared/platform-services-contract.test.ts tests/unit/web/browser-system-services.test.ts tests/unit/web/pwa-registration.test.ts tests/unit/web/app.dom.test.tsx tests/unit/web/terminal-panel.dom.test.tsx tests/unit/web/web-adapters.test.ts && npm run lint && npm run typecheck && npm run build && npx playwright test tests/e2e/ssh-productivity.spec.ts --project=chromium`
  Expected: 全部 PASS；build 仅允许已有 bundle size warning，不得出现类型、lint、manifest、service worker 或 PWA e2e 错误。

- [ ] **Step 6: Commit the PWA verification evidence.**

  ```bash
  git add tests/e2e/ssh-productivity.spec.ts docs/architecture/cross-platform.md docs/superpowers/plans/2026-09-16-relay-long-term-roadmap.md
  git diff --cached --check
  git commit -m "test: verify relay pwa shell"
  ```

## Verification and Handoff

完成 Task 1-5 后，检查：

- `git status --short` 为空，`git log` 中每个 commit 只包含对应任务文件。
- `rg -n "localStorage|sessionStorage|password|privateKey|token|terminal output" public/sw.js src/web/platform/browser-system-services.ts` 不出现 service worker 对敏感运行时数据的缓存或持久化逻辑；允许类型/错误文案中的安全词汇，但需人工确认上下文。
- 通过 `git diff --check`、focused Vitest、lint、typecheck、Web build 和受影响 Chromium e2e；本子项目涉及 shared optional contract、静态构建资产和浏览器交互，但不修改 server、数据库、加密、认证、SSH 协议或迁移，因此不重复执行全量 `npm test`，除非实现过程中扩大到上述高风险范围。
- PWA shell 交付不代表 Desktop/Android、账号同步或 local SSH 已交付；下一阶段应分别创建平台 implementation plan。
