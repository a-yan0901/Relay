# Web SSH Termius 式用户体验专项设计

## 目标

把当前“Server 列表页 + 独立终端页”升级为持续工作的 Web SSH 工作区：终端是主角，同一台 Server 可以打开多个互相独立的 Console，连接状态和错误可见且可恢复，并提供一致的主题与终端显示偏好。

## 评审依据

UX/Product Reviewer 对当前 worktree 的只读评审确认了以下缺口：

- `App.tsx` 按 `hostId` 去重，无法打开同一 Server 的多个终端。
- 终端 rail 和 tab 固定显示绿色状态，无法表达连接中、失败和重连中。
- 终端布局曾受 720px 上限和 flex/grid intrinsic size 影响，造成 console 偏小或布局抖动。
- Server 卡片没有编辑、删除、测试连接入口，已有 API 能力没有转化为 UI。
- 主题和终端字号硬编码，host key、启动失败和解锁失败的恢复路径不完整。

## 设计原则

1. 终端优先：进入终端模式后，终端 canvas 占据可用空间的主体；列表和工具栏保持紧凑。
2. 一次操作一个结果：点击连接总是产生一个新 Console；点击标签主体只切换，点击关闭按钮只关闭目标 Console。
3. 状态可信：任何连接状态都同时通过文字和状态点表达，不能用固定绿色代替真实状态。
4. 可恢复：网络、SSH、Vault 和 host key 错误必须给出下一步动作；用户不需要刷新页面猜测状态。
5. 本地优先：主题、字号和未包含敏感信息的终端描述只存浏览器本地，不新增凭据传输路径。
6. 保留安全边界：Vault、HttpOnly 会话、Origin 校验和 host key TOFU/mismatch 策略不因 UX 改造而放宽。

## 用户流程

### 打开 Console

用户在 Server 卡片点击“连接”，工作区进入终端模式并创建唯一 `terminalId`。同一 Server 再次点击“连接”时创建第二个 `terminalId`，两个 tab 各自拥有一个 WebSocket/SSH 生命周期。侧栏按 Server 聚合显示已打开数量，tab 使用“名称 · 序号”区分重复会话。

### 切换与关闭

tab 主体和侧栏条目只负责激活目标 Console；每个 tab 有独立的关闭按钮。关闭活动 tab 后优先激活其相邻 tab，关闭动作会停止自动重连并销毁对应终端控制器。

### 连接中与恢复

状态从 session controller 上提到工作区状态层，统一显示在 tab、侧栏和当前终端标题。`reconnecting` 显示下一次重试倒计时，并提供立即重连；`failed` 显示错误和重连入口；等待 host key 时弹窗固定在视口且可键盘操作。

### 主题与显示

工作区设置入口提供 `Midnight`、`Light`、`High Contrast` 三套主题，以及 12/14/16px 终端字号。选择立即应用到 UI 和 xterm，并以 `localStorage` 持久化；不修改服务端数据。

## 架构

### 工作区状态

扩展 `TerminalTabState`：

```ts
interface TerminalTabState {
  terminalId: string;
  hostId: string;
  state: TerminalStatus;
  reconnectDelayMs: number;
  errorMessage: string | null;
}
```

`App` reducer 负责创建、激活、关闭和更新 tab 元数据；`TerminalPanel` 仍负责 xterm 与 session controller 的实际生命周期，通过 `onStatusChange` 把快照同步给父层。服务端协议不需要为多 Console 增加字段，因为现有 `requestId`/`terminalId` 已能区分会话。

### 主题状态

新增 `src/web/theme.ts`，定义主题名、终端 palette、localStorage key 和安全的解析/默认逻辑。`App` 在启动时读取偏好并把 `data-theme` 设置到根节点；`TerminalPanel` 根据主题和字号构造 xterm，并在偏好变化时更新现有终端选项。

### 布局

- 终端工作区使用 `height: calc(100dvh - header/padding)`，不再用 720px 封顶。
- desktop rail 约 184px，独立滚动；tabs、panel heading 和外层 padding 使用 compact 尺寸。
- `.terminal-main`、`.terminal-panels`、`.terminal-panel` 均显式允许 shrink，避免 xterm intrinsic height 反向撑大父容器。
- host key overlay 使用 fixed viewport layer，短视口下 dialog 自身可滚动。
- mobile 保持文档流布局，提供可见的 Server picker，不通过 `display:none` 丢失连接入口。

### Server 管理与最近连接

现有后端 `lastConnectedAt` 和前端 `updateHost/deleteHost/testConnection` API 继续复用。SSH channel 建立成功后调用 repository 的 `markConnected`；Server 列表默认按收藏、最近连接、名称排序。新增/编辑使用同一个表单，删除前确认并关闭对应活动 tab。

## 分阶段范围

### Phase 1：核心持续工作区

同一 Server 多 Console、真实状态上提、独立 tab 关闭、终端占屏布局、host key 可操作性和布局稳定性。

### Phase 2：可恢复与管理

启动/解锁/初始化错误重试、重连倒计时、短期刷新恢复、最近连接、Server 编辑/删除/测试连接、host key 变更的清理入口。

### Phase 3：个性化与无障碍

三套主题、字号、主题持久化、移动端 picker、focus trap、tab/tabpanel 语义、键盘快捷键和诊断信息复制。

## 验收标准

- 同一 Server 连续打开两次会出现两个独立 tab；输入、输出、resize、重连和关闭互不影响。
- 终端模式在 1440×900、1366×768、1024×768 下使用主要视口空间，打开 10 个 tab 时切换和新建入口仍可见。
- tab、侧栏和终端标题的状态一致，失败/重连不会显示绿色已连接。
- host key 窗口在布局变化、短视口和终端输出期间仍完全可操作。
- 服务不可达、解锁失败、连接失败和重连状态都有明确反馈与下一步动作。
- 主题/字号即时生效，刷新后保留；普通文本达到可读对比度，终端 palette 与主题一致。
- 服务器连接成功后最近连接信息更新，刷新列表顺序保持；编辑、删除、测试连接可完成闭环。
- 现有 Vault 加密、会话 cookie、Origin、host key 和 SSH 安全测试全部保持通过。
