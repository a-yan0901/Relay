# Relay Windows 与 Android 统一体验设计

**日期：** 2026-09-17

**状态：** 实施设计；本文件不表示客户端已交付。
**范围：** Windows 桌面版、Android app、Web 界面和共享核心的关系。

## 依据与现状

以 [跨平台架构](../../architecture/cross-platform.md)、[平台 shell 草案](./2026-09-16-relay-platform-shell-design.md)、[账号与加密同步设计](./2026-09-16-relay-account-and-encrypted-sync-design.md) 和 [长期路线图](../plans/2026-09-16-relay-long-term-roadmap.md) 为基线。当前代码已有 `src/shared/core` 的模型、ports、状态和 capability，`src/web/platform/web-adapters.ts` 实现 Web runtime，`src/web/main.tsx` 注入 React `App`。Web 的 PWA 和账号同步切片已存在；仓库没有 Windows 或 Android 工程。`App.tsx` 仍直接使用 `window`、`document`、浏览器文件和 Web 下载逻辑，因此共享 `CoreRuntime` 不等于当前 UI 可以原样放入手机。

## 决策和备选

**选用：同一 React 产品界面 + 平台 shell + 可替换 runtime。** Windows 用 Electron 装载本地打包的界面，并以独立本地进程运行现有 Node/Fastify/SQLite/SSH 执行端；Android 用 Capacitor 装载同一前端构建，通过安全连接访问用户指定的 Relay 执行端。平台差异由窄接口、布局断点和交互策略承载；Host、工作区、主题、终端、SFTP、账号和同步使用相同页面/组件及 shared core 语义。Electron 的 main/renderer 分离及 Capacitor 的 Web UI/Android 插件模型允许这种装载方式；具体依赖版本须在实施时锁定。参见 [Electron 进程模型](https://www.electronjs.org/docs/latest/tutorial/process-model) 和 [Capacitor 文档](https://capacitorjs.com/docs)。

备选 A：三个平台分别开发 UI。原生细节更自由，但产品行为、主题和可访问性容易分叉，维护三套页面。备选 B：两端只封装远程 Web URL。初期快，但 Windows 无法开箱即用，本地文件/系统集成及网络错误体验受限。本设计选择可复用界面，同时保留各平台需要的导航和系统交互。

## 边界与数据流

```text
Web 浏览器 ───┐
Windows Electron renderer ── 共享 React UI / 设计 token / shared core
Android Capacitor WebView ──┘             │
                               平台 runtime + 系统服务 adapter
                                         │
                         HTTPS/WSS + 版本化 API/capability
                                         │
                        Relay 执行端：Vault、SSH、SFTP、SQLite
```

Windows 默认启动仅监听 loopback 的本地执行端，数据目录使用当前用户的 app data，不复用开发服务器数据库或可预测端口；窗口只打开随安装包发布的资源。main 进程负责执行端启动、健康检查、优雅停止、单实例与窗口生命周期；renderer 无 Node 权限，原生能力由 allowlist preload/IPC 暴露。执行端崩溃时 UI 保留工作区意图并显示重新启动动作；不能把未确认的会话标为在线。Windows 首版不引入本机直连 SSH 第二套执行栈。

Android 首版不嵌入 Node/SQLite/ssh2，也不宣称设备离线可以发起 SSH。用户先配置受信 Relay 服务地址，完成 TLS/会话校验后进入现有 Vault 工作流；可以不登录账号使用该实例。这里“Local-only”指不启用账号云同步，数据位于所连接的 Relay 实例，并非 Android 设备完全离线可用。Android UI 与 Relay 服务的跨源 cookie、Origin、WebSocket 和证书策略必须在实现前通过真实设备验证；不能通过关闭 TLS 校验或放宽任意 Origin 解决。服务不可达时只显示缓存的非敏感导航意图与明确的离线状态。服务地址切换隔离会话、工作区缓存与文件授权，避免跨实例串数据。

账号登录是开启同步的用户动作，但同步还要求 Vault 解锁或恢复密钥。云端同步对象沿用现有加密快照范围：Host、Identity、Group、Snippet、工作区模板/非敏感偏好和需重新确认的 Host Key 信任；不包含活跃 Shell、终端输出、SFTP 文件内容或进行中的任务。登出与设备撤销停止同步但不删除本地实例数据。跨 Windows 本地执行端、Android 所连执行端及 Web 部署真正恢复同一 Vault，需要验证独立数据卷、账号/盲同步服务分离及新设备恢复；当前同实例模拟测试不足以证明跨端可用。

## 一致的 UI 与交互

共用颜色、字体、间距、密度、图标和终端主题 token，以及 Host 卡片/列表、连接状态、Host Key 确认、SFTP、传输中心、账号同步中心和错误文案。用户主题选择跨重载生效；平台系统主题仅作为未显式选择时的默认值。各平台只更换布局与输入方式：

| 场景 | Web / Windows 大屏 | Android 窄屏 | 相同语义 |
| --- | --- | --- | --- |
| 找主机 | 左侧分组、搜索、grid/list 与快捷切换 | 搜索优先、最近主机、列表 | 相同筛选、收藏、连接状态 |
| 终端 | 多标签、分屏、键盘快捷键、右键菜单 | 单终端优先、软键盘工具条、长按菜单 | 相同会话状态、复制粘贴与重连规则 |
| SFTP | 全屏工作区、目录过滤、拖放/文件选择 | 全屏列表、路径面包屑、系统选择器/分享 | 相同目录操作、传输进度与失败诊断 |
| 批量命令 | 预览目标与并发参数 | 分步预览与确认 | 同一目标快照、取消和结果隔离 |
| 同步 | 账号入口和冲突中心 | 同一状态与动作，移动布局 | Local、待同步、冲突、需要解锁一致 |

交互尺寸适应鼠标、键盘与触控；Android 支持系统返回、字体缩放、横竖屏和软键盘遮挡处理。平台菜单只代理相同的应用命令，不复制业务判断。危险操作和 Host Key 变更必须确认。色彩不能是唯一状态提示。终端最后一行、SFTP 双滚动区域和弹窗焦点要纳入跨端走查。

## 平台适配与失败处理

- 将 `App.tsx` 中直接调用的浏览器下载、文件选择、确认框、网络监听和快捷键逐步移到 `PlatformServices` 或 UI shell hooks；shared core 不引入 DOM、Electron 或 Android 类型。
- 复用 `CoreRuntime`、`SessionTransport`、`FileTransport`、`ImportExportPort` 和 capability 协商；Electron/Capacitor 只提供系统剪贴板、文件选择/保存、通知、链接打开和生命周期事件。权限被拒绝时保留可操作的应用内反馈。
- Android 文件使用系统授权 URI，上传/下载按流处理并释放授权；Windows 使用系统选择器，renderer 不获得任意文件系统访问权。
- 会话重连必须先询问执行端真实状态；网络切换、休眠、进程回收后显示 `reconnecting`、`interrupted` 或 `needs-reopen`，不能凭缓存显示 `connected`。批量任务与传输按任务 id 查询，失败包含阶段、脱敏原因和下一步动作。
- Windows loopback 服务和 IPC 均需限定调用者；Android 的 token/设备凭据使用系统安全存储，不能写普通 Web storage。具体凭据持有边界遵循现有 server-mediated Vault 设计。Host Key、ProxyJump、路径校验、审计脱敏和同步冲突规则保持服务端/core 的单一实现。

## 验收与非目标

同一个测试账号或 Local 模式下，三端能完成“搜索 Host → 校验 Host Key → 连接 → 复制粘贴/重连 → SFTP 上传下载 → 锁定/恢复”；相同任务状态和文案，不要求像素完全相同。Windows 离线于账号服务时仍能通过本机执行端连接 SSH；Android 离线于 Relay 服务时不得声称本地 SSH 可用。登录后在两个独立执行端的数据卷间可恢复配置，须以真实跨实例演练证明。用户选择主题、全屏 SFTP 和窄屏终端可操作性须经 Windows 与 Android 实机检查。

本期不实现 Android 设备直连 SSH、Windows 第二套本地 SSH adapter、后台常驻移动 SSH、多窗口协作、团队 Vault 或跨设备迁移 live session。发布包签名、自动更新和应用商店上架单列发布任务，不作为首个技术预览的前置条件。
