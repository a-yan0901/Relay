# Web SSH Workspace

一个自托管、单实例的 Web SSH 工作台：把多台 Server 的连接信息保存在本地加密 Vault 中，并在浏览器里完成交互式终端、SFTP 文件操作和安全的批量命令执行。

## 快速启动

生产环境应当把应用放在 HTTPS 反向代理之后，并将浏览器访问地址写入 `TRUSTED_ORIGINS`：

```bash
export TRUSTED_ORIGINS=https://ssh.example.com
docker compose up -d --build
```

然后访问 `https://ssh.example.com`，首次使用时创建主密码。主密码遗失后无法恢复已保存的 Server 凭据。

解锁会话默认在 24 小时无操作后自动过期；可通过 `SESSION_IDLE_TIMEOUT`（毫秒）调整，支持 1 分钟至 24 小时，例如 `SESSION_IDLE_TIMEOUT=3600000` 表示 1 小时。

应用只需要一个持久化数据卷 `/data`。备份整个 Docker volume 或宿主机绑定目录，并将备份视为敏感数据：数据库中的 Server 密码、私钥、passphrase、Snippet 和可保存的批量输出是密文，但解锁后的运行中实例能够暂时使用这些凭据建立 SSH 连接。

服务端默认按来源限制每分钟 120 个请求；只有在明确评估部署流量后才调整 `RATE_LIMIT_MAX`，不要用它替代反向代理和身份认证层的限流。

## 工作区使用

- 同一台 Server 可以打开多个独立 Console；顶部 tab 会显示 `Server · 1`、`Server · 2`，每个窗口拥有自己的输入、尺寸、Host Key 确认和重连状态。
- 终端工作区优先占用屏幕空间，左侧 rail 可搜索 Server 并使用 `＋` 快速新建 Console；`Ctrl/Cmd+K` 聚焦当前 Server 搜索，`Ctrl/Cmd+W` 关闭当前 Console。
- 工作区会在服务端持久化打开哪些主机、活动 tab、分屏比例和筛选状态；浏览器刷新会在约 30 秒的会话保留窗口内尝试恢复 live Console。恢复描述只在当前标签页的 `sessionStorage` 保存 `terminalId`、`hostId` 和非敏感的工作区 tab 绑定，不进入持久化工作区；锁定 Vault 或显式关闭 Console 后会清除描述。应用进程重启后只恢复 tab 意图并创建新 shell，不宣称远端 shell 仍然存在。
- “偏好”中可切换深夜蓝、浅色、高对比主题和终端字号。偏好只保存在当前浏览器，不包含任何密码、私钥或会话 token。
- “工作区与加密数据”支持加密 Vault bundle 的导出、导入预览和冲突确认；导出密码不会写入 bundle、数据库或日志。
- “身份”支持创建可复用的密码/私钥身份；多个 Server 可以共享同一身份。Group 支持嵌套、默认身份和连接参数继承，Server 可选择跟随分组身份；导入/导出会保留这些关系。
- “工作区”支持保存、打开和删除命名模板；终端支持左右/上下分屏及最多四格布局，模板只保存非敏感的 tab 意图。
- Server 卡片支持最近连接排序、编辑、测试连接和删除；编辑时凭据留空表示保留原凭据，测试连接不会保存新的认证材料。连接可配置 Keepalive、自动重连和最多四级 ProxyJump，每一跳都执行 host key 校验。
- 终端连接状态会显示当前阶段（解析、TCP、跳板、Host Key、认证或终端通道）及下一步；短暂断线会在倒计时后自动重连，认证/Host Key 等不可盲重试的错误会要求编辑或确认。服务实例变化后，旧 Console 会显示“需要重新打开”，不会把新服务误报成旧 Shell 仍然存活。

## 文件、命令与活动

- 终端工具栏中的“远程文件”复用当前 Server 的认证、host key 和跳板路径，可浏览目录、上传、下载、新建目录、重命名和删除文件。
- 上传先写入远程临时文件，完成后原子重命名；大文件使用限内存分块/流式处理，断线重试会校验 checkpoint 和 SHA-256 后从安全位置继续。队列显示进度、速度/预计剩余时间、恢复位置、原因和下一步，支持取消和失败重试。服务重启中的传输会标记为“已中断”，只能由用户显式重试；SFTP 路径会拒绝 NUL、控制字符、反斜杠和规范化后的目录越界。
- “批量执行”支持 `{{variable}}` 参数、目标预览、并发（默认 4、最大 16）、超时、输出大小上限和逐主机结果。多主机或高风险命令必须显式确认，服务端会重新校验主机归属；服务重启不会继续执行排队/运行中的任务，而是保留为可解释的中断结果。
- “片段”支持加密保存命令、变量和标签；终端中可用 `Ctrl/Cmd+Shift+P` 搜索并带入批量执行预览，不绕过确认步骤。
- “活动”只显示结构化脱敏摘要，不录制交互式终端原始输入输出；选择保存的批量输出按主机隔离并在 TTL 后过期。

## 跨端扩展边界

`src/shared/core` 提供平台无关的模型、校验、错误码、状态机、目标/连接解析、`CoreRuntime` 和 ports；当前 Web 通过 `src/web/platform/web-adapters.ts` 接入 HTTP/WSS 和浏览器文件能力。桌面与 Android 后续可以替换 transport、文件选择器和 OS keychain/Keystore，不需要复制 Host、Group、Identity、Workspace、Snippet、SFTP 或任务终态规则。当前已用同一套 CoreRuntime contract 验证 Web adapter 与 desktop/Android native-like runtime；这证明了跨端扩展边界，但不代表原生 UI、系统密钥链或本地 SSH 已交付。云同步、团队协作和更多协议暂不属于当前核心的隐式依赖。

## 反向代理要求

- 代理必须终止 TLS，并将 HTTP Upgrade 请求转发到 `/ws/terminal`。
- 浏览器端终端在生产环境使用 WSS；不要把应用端口直接暴露到不可信网络。
- `TRUSTED_ORIGINS` 只接受完整的 `http://` 或 `https://` origin，不接受路径、query、通配符或凭据。
- `TRUSTED_ORIGINS` 必须与浏览器地址栏中的 origin 完全一致。
- 应用通过 HttpOnly、SameSite Strict、生产 Secure cookie 保存会话标识；不要通过 URL 或 localStorage 传递会话 token。

反向代理还应设置合理的 WebSocket 空闲超时，并限制管理入口的访问来源。应用自身会检查 WebSocket Origin、解锁会话、消息大小和活动终端数，但它不是身份提供商或完整的公网边界防火墙。

## 数据与网络

容器需要：

- 对 `/data` 的读写权限；容器以非 root 用户 `webssh` 运行。
- 到目标 SSH Server 的出站 TCP 连接，通常是端口 22 或你配置的端口。
- 到浏览器反向代理的入站 HTTP/HTTPS 连接。

远程 SSH Server 不需要映射到容器或宿主机。不要在日志、Issue、备份外链或截图中暴露密码、私钥、passphrase、session cookie 或终端内容。

## Vault 与 host key

初始化时应用生成随机 Vault key，使用 Argon2id 从主密码派生的密钥加密保存；每台 Server 的认证材料再用 AES-256-GCM 独立加密。主密码不会落库。

首次连接出现 host key 时，必须核对页面显示的算法、地址和 SHA-256 指纹后明确选择“信任并连接”。已保存指纹变化会硬失败，不提供跳过校验按钮。若确实更换了远程 Server 的 host key，应先在安全管理流程中清理旧信任记录，再重新确认新指纹。

## 本地开发

```bash
npm install
npm run dev
```

开发服务器使用 Vite `5173` 和 Fastify `3000`，Vite 会代理 `/api` 与 `/ws`。生产构建和启动：

```bash
npm run build
DATA_DIR=.local-data NODE_ENV=test TRUSTED_ORIGINS=http://127.0.0.1:4173 PORT=4173 npm start
```

开发模式未显式设置 `TRUSTED_ORIGINS` 时，会自动信任 localhost、回环地址、`0.0.0.0` 和本机网卡地址对应的 Vite 端口；生产模式仍必须显式配置完整浏览器 origin。

如果从公网 IP 访问开发服务器，必须把浏览器地址栏中的完整 origin 加入配置，例如 `TRUSTED_ORIGINS=http://106.14.61.92:5173`。生产部署仍建议使用 HTTPS 反向代理；Origin 校验用于防止其他网站借助浏览器会话发起 WebSocket 操作，不是登录认证的替代品。

验证命令：

```bash
npm run lint
npm run typecheck
npm test
npm run test:e2e
npm run build
```

## 威胁模型边界

此版本是单 Vault、单用户实例，已包含 SFTP、ProxyJump、工作区恢复、批量命令和脱敏活动摘要；仍不包含云同步、账号注册、团队 RBAC、SSO、端口转发、RDP/VNC/X11、Telnet、串口或其他远程协议。数据库和备份只得到静态加密保护；能够控制一个已解锁容器、Node 进程或其运行用户的攻击者，可能读取活动会话正在使用的凭据。因此应保护宿主机、Docker socket、`/data` 备份和反向代理管理面，并在离开设备时锁定 Vault。

应用日志和活动页只记录脱敏的请求、连接状态、SFTP 生命周期和批量任务摘要，不记录终端输入输出、完整 WebSocket 消息、展开后的变量值或认证材料。批量输出按主机隔离并在 TTL 后清理；短暂浏览器断线可在会话保留窗口内重连；应用进程重启不承诺远程 shell 或内存任务继续存在。当前交付为 Web-first，桌面版以及 Windows、Linux、Android 客户端通过 shared core 和 adapter contract 预留，尚未交付原生 UI。
