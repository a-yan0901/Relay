# 轻量 Web SSH 工作台架构设计

日期：2026-09-14
状态：设计已获批准，等待规格文件审核

## 1. 设计范围

本设计覆盖首版自托管 Web SSH 工作台的产品边界、系统架构、数据模型、HTTP/WebSocket 接口、安全模型、部署和测试策略。目标是先交付一个可运行、可验证的多 Server SSH 工具，不引入云端同步和团队协作依赖。

首版假设：一个 Docker 实例对应一个 Vault 和一个使用者；数据模型保留 `owner_id` 等扩展位置，但不实现账号注册、邀请和 RBAC。

## 2. 设计原则

1. **主机优先**：用户以保存的 Server 配置为入口，不要求重复输入 SSH 命令。
2. **服务端桥接**：浏览器只处理终端 UI，服务端负责 SSH TCP 连接和 PTY。
3. **安全默认**：主机指纹异常硬失败；敏感信息默认密文；不把控制权塞进 URL。
4. **单体优先**：一个应用容器即可运行；模块边界清晰，未来可拆分 SSH worker。
5. **可恢复连接**：短暂 WebSocket 断线有重连窗口；服务重启不承诺远程进程持久化。
6. **可测试交付**：所有核心边界通过测试证明，而不是只依赖手工打开页面。

## 3. 方案比较与决定

### 方案 A：Node.js 单体服务（采用）

前端 React/Vite 与后端 Fastify/Node.js 同仓库构建为一个静态资源和 API 服务，使用 `ssh2` 建立远程 SSH，使用 WebSocket 桥接终端，SQLite 保存数据。

优点：部署最简单；TypeScript 可共享验证类型；`ssh2` 直接提供密码、私钥、shell、PTY 等能力；适合一个自托管实例。

代价：所有 SSH 会话共享一个进程；高并发或隔离不如 worker 架构；需要限制连接数、消息大小和资源使用。

### 方案 B：React + 独立 SSH Worker 集群

API、前端、会话编排和 SSH worker 分成多个服务，以 Redis 或消息总线传递会话。

优点：可独立扩展和隔离连接；适合多租户 SaaS。

代价：部署、认证、会话路由和持久化复杂度明显增加，不符合首版轻量自托管。

### 方案 C：React + Go SSH 网关

浏览器仍使用 React/xterm.js，后端使用 Go 的 SSH 库和 WebSocket。

优点：长连接资源模型和静态部署较强。

代价：需要维护两种语言边界；首版产品迭代和共享类型成本更高；无法直接复用 Node 生态的表单、测试和加密工具。

### 决策

采用方案 A。未来只有在连接规模、租户隔离或资源稳定性证明单体不足时，才把 `SshSessionManager` 抽为 worker；前端和 API 契约保持不变。

## 4. 系统上下文

```text
┌──────────────────┐       HTTPS / WSS        ┌──────────────────────────┐
│ Browser          │ ◄──────────────────────► │ Web SSH App              │
│ React            │                           │ Fastify + WebSocket      │
│ xterm.js         │                           │ Auth + Vault + SSH       │
└──────────────────┘                           └─────────────┬────────────┘
                                                             │ SSH TCP
                                                             ▼
                                                   ┌──────────────────┐
                                                   │ Remote SSH Server│
                                                   └──────────────────┘

                                                   ┌──────────────────┐
                                                   │ SQLite /data      │
                                                   │ encrypted records │
                                                   └──────────────────┘
```

Docker 容器需要访问远程 Server 的网络地址。默认只暴露 Web 端口；SSH 目标是出站连接，不需要把远程 Server 的 22 端口映射到容器宿主机。

## 5. 组件边界

### 5.1 Web UI

职责：

- 展示主机列表、分组、筛选、表单和状态。
- 在内存中管理当前解锁状态和终端标签。
- 创建 xterm.js 实例，处理输入、输出、resize、复制粘贴和搜索。
- 实现连接状态机和用户可见错误。

不负责：

- 直接连接 SSH TCP。
- 判断 SSH host key 是否可信。
- 记录或打印凭据。

### 5.2 HTTP API

职责：

- 初始化和解锁 Vault。
- 校验请求数据和会话。
- 管理主机元数据、加密凭据和指纹。
- 返回脱敏主机视图。

不负责：

- 在 API 响应中返回明文凭据。
- 通过 URL 或 query 参数接收密码、私钥和远程命令。

### 5.3 WebSocket Session Gateway

职责：

- 校验握手的 Origin、会话和消息协议。
- 每个终端标签创建一个 `SshSession`。
- 在 SSH channel 和浏览器之间转发输入输出。
- 转发 resize、状态、host key 提示和错误。
- 管理短暂断线的会话保留和重新绑定。

### 5.4 Vault Service

职责：

- 初始化随机 Vault key。
- 从主密码派生 KEK 并包裹/解包 Vault key。
- 加密、解密主机认证材料。
- 在 lock、session expiry、连接结束等边界清理敏感 Buffer。

### 5.5 SSH Adapter

职责：

- 将 Host 配置转换为 `ssh2` 连接参数。
- 支持 password/privateKey/passphrase。
- 请求交互式 shell 和 PTY。
- 处理 hostVerifier、连接超时、认证失败、channel exit 和 close。
- 暴露独立于 `ssh2` 的事件接口，便于单元测试和未来替换实现。

### 5.6 Repository

职责：

- 持久化主机元数据、密文、指纹和审计事件。
- 所有查询按实体 ID 和未来的 owner 边界执行。
- 不允许普通查询返回 credential plaintext。

## 6. 数据模型

SQLite 表以逻辑字段描述如下：

### `app_config`

- `id`：固定单行主键。
- `schema_version`：数据格式版本。
- `kdf_algorithm`：固定为 Argon2id。
- `kdf_params_json`：内存、迭代和并行度参数。
- `kdf_salt`：随机 salt。
- `wrapped_vault_key`：由 KEK 包裹的随机 Vault key。
- `wrapped_vault_key_nonce`：AES-GCM nonce。
- `created_at`、`updated_at`。

主密码不存储。主密码正确与否通过尝试解包 Vault key 判断。

### `hosts`

- `id`：随机 UUID。
- `owner_id`：单用户首版固定为 `default`，所有 repository 查询都必须显式带上；未来映射到用户/租户。
- `name`：用户可见名称。
- `address`：IP 或域名。
- `port`：1–65535，默认 22。
- `username`：SSH 用户名。
- `auth_type`：`password` 或 `private_key`。
- `credential_ciphertext`：加密 JSON，包含 password 或 private key/passphrase。
- `credential_nonce`：每次写入随机生成。
- `credential_version`：便于未来迁移。
- `host_key_algorithm`、`host_key_fingerprint`：首次信任后的主机身份。
- `group_id`：可空分组引用。
- `tags_json`：规范化标签数组。
- `is_favorite`：布尔值。
- `last_connected_at`：最近成功建立 shell 的时间。
- `created_at`、`updated_at`。

地址、用户名和标签用于列表搜索；凭据密文永不进入列表 DTO。

单用户组合根为所有 repository 调用注入 `owner_id = default`。未来多用户版本必须将 owner/tenant 从已认证会话解析，而不能接受浏览器直接提交的 owner id。

### `groups`

- `id`
- `owner_id`：单用户首版固定为 `default`，用于未来租户隔离。
- `name`
- `sort_order`
- `created_at`、`updated_at`

### `audit_events`

- `id`
- `owner_id`：单用户首版固定为 `default`，用于未来审计范围隔离。
- `event_type`：如 `vault_unlocked`、`host_created`、`ssh_connect_failed`、`host_key_rejected`。
- `host_id`：可空。
- `request_id`
- `remote_address`：按部署隐私策略脱敏或可选。
- `created_at`

不保存终端内容、输入输出、认证材料和完整 WebSocket 消息。

## 7. Vault 与凭据加密

### 7.1 初始化

1. 服务发现 `app_config` 不存在。
2. 用户通过 HTTPS 提交主密码。
3. 应用生成 32 字节随机 Vault key 和随机 KDF salt。
4. 使用 Argon2id 派生 KEK。
5. 使用 AES-256-GCM 加密 Vault key，保存密文、nonce、KDF 参数和 schema version。
6. 创建空的主机和分组表。

### 7.2 解锁

1. 用户提交主密码。
2. 服务根据保存的 salt 和参数派生 KEK。
3. 尝试解密 `wrapped_vault_key`。
4. 成功后把 Vault key 放入进程内存中的短生命周期 session。
5. 使用 HttpOnly、Secure、SameSite cookie 绑定 opaque session id；生产环境不使用 localStorage 保存会话 token。
6. 失败只返回统一错误，避免泄露校验细节，并对尝试频率限流。

### 7.3 主机凭据

主机认证 JSON 使用 Vault key 加密。每条记录有独立 nonce，AAD 包含 `host_id`、字段用途和版本，避免密文被跨记录复制。读取只发生在创建 SSH 连接的短暂作用域；连接关闭后释放引用并覆盖可清理的 Buffer。

该方案保护静态数据库和备份，但因为 SSH 连接由服务端发起，解锁后的服务进程仍会短暂接触远程认证材料。部署者必须把运行中的容器视为可信边界，并在部署文档中说明这一点。

## 8. HTTP API 设计

API 前缀：`/api`。所有错误使用统一结构：

```json
{
  "error": {
    "code": "HOST_VALIDATION_FAILED",
    "message": "请检查服务器地址和端口",
    "requestId": "req_..."
  }
}
```

### Setup/Auth

- `GET /api/setup/status`：返回是否已初始化、是否已锁定；不返回任何 KDF 秘密。
- `POST /api/setup`：创建主密码和 Vault；只允许在未初始化时调用。
- `POST /api/session/unlock`：解锁 Vault，设置 HttpOnly session cookie。
- `POST /api/session/lock`：撤销当前会话、清理内存 key，并按设置断开活动 SSH 会话。
- `GET /api/session`：返回当前会话的锁定状态和非敏感过期信息。

### Hosts/Groups

- `GET /api/hosts?query=&groupId=&favorite=`：返回脱敏主机列表。
- `POST /api/hosts`：校验并加密认证材料后创建主机。
- `GET /api/hosts/:id`：返回主机元数据、认证类型和指纹摘要，不返回秘密。
- `PATCH /api/hosts/:id`：部分更新；认证字段替换时重新加密。
- `DELETE /api/hosts/:id`：删除主机及关联的密文和指纹。
- `POST /api/hosts/:id/test-connection`：建立短暂连接并返回结果，不创建终端会话。
- `GET/POST/PATCH/DELETE /api/groups...`：管理分组。

### 防误用约束

- 连接信息不允许出现在 URL、日志和错误堆栈。
- 主机地址必须是普通 hostname/IP 格式；首版拒绝 URL、shell 片段和命令字段。
- 端口、标签、名称和用户名做长度上限与字符校验。
- 所有写接口需要已解锁会话和 CSRF 防护策略；同源 cookie 配合 Origin/Referer 校验。

## 9. WebSocket 终端协议

端点：`GET /ws/terminal`。握手必须通过 HTTPS/WSS、Origin 白名单、HttpOnly session 和连接速率限制。

### 9.1 控制消息

浏览器到服务端使用 JSON 控制消息，终端输入可使用二进制帧或带长度限制的 UTF-8 数据帧：

```json
{
  "type": "open",
  "hostId": "host_123",
  "cols": 120,
  "rows": 36,
  "requestId": "open_123"
}
```

```json
{
  "type": "resize",
  "cols": 140,
  "rows": 42
}
```

```json
{
  "type": "host-key-decision",
  "decision": "trust",
  "fingerprint": "SHA256:..."
}
```

```json
{
  "type": "close"
}
```

### 9.2 服务端事件

```json
{
  "type": "status",
  "state": "connecting"
}
```

```json
{
  "type": "host-key",
  "algorithm": "ssh-ed25519",
  "fingerprint": "SHA256:...",
  "address": "10.0.0.8",
  "port": 22
}
```

```json
{
  "type": "error",
  "code": "HOST_KEY_MISMATCH",
  "message": "远程主机指纹与已保存指纹不一致"
}
```

终端输出使用二进制数据帧直接写入 xterm.js，避免把 ANSI 数据当作 HTML 处理。服务端控制消息只能驱动当前会话绑定的 SSH channel，不能携带远程命令、文件路径或任意代理目标。

### 9.3 Session 生命周期

状态：`idle → connecting → awaiting-host-key → connected → reconnecting → closed/failed`。

- `connecting`：创建 SSH client、校验地址和读取密文。
- `awaiting-host-key`：仅首次未知指纹时暂停握手等待用户决定。
- `connected`：请求 PTY 和 shell，转发 I/O。
- `reconnecting`：WebSocket 短暂断开时保留服务端 session 一小段时间，并允许同一已认证会话重新绑定。
- `closed`：用户关闭、远程退出、超时或 session 过期后释放 SSH client 和凭据引用。

首版不承诺应用进程重启后保留远程 shell；如果服务重启，界面创建新的 SSH session。

## 10. 安全控制

### 必须实现

- HTTPS/WSS 部署要求和安全 cookie。
- WebSocket Origin 显式 allowlist，拒绝未配置或不匹配来源。
- WebSocket 每条消息做 JSON schema、状态、长度、频率和权限校验。
- 连接数、单消息大小、空闲时间和认证失败限流。
- SSH host key 首次确认、后续 mismatch 硬失败。
- 输入/输出和终端标题视为不可信数据；不使用 `innerHTML` 渲染终端内容。
- 应用日志脱敏；日志中不出现完整消息、cookie、token、密码、私钥和终端输出。
- Docker 进程使用非 root 用户，数据目录权限最小化。
- 健康检查和错误响应不泄露数据库路径、堆栈或凭据。

### 明确的威胁模型

本版本防御：数据库/备份泄露、跨站 WebSocket 劫持、未知或被替换的 SSH Server、普通 API 越权、错误日志泄露和恶意终端数据导致的 DOM 注入。

本版本不防御：攻击者已经取得 Docker 容器 root 权限、控制宿主机内存、控制用户浏览器扩展或用户主动泄露主密码。自托管部署文档必须把这些限制写清楚。

## 11. 部署设计

### 11.1 容器

- 多阶段构建前端静态资源和后端生产包。
- 运行镜像只保留生产依赖。
- 使用非 root 用户启动 Node 服务。
- 默认监听 `3000`，通过反向代理提供 HTTPS/WSS。
- `/data` 作为唯一持久化数据卷。
- 提供 `/healthz`，只返回服务和数据库是否可用，不返回敏感配置。

### 11.2 配置

- `PORT`：监听端口，默认 3000。
- `DATA_DIR`：数据库和迁移文件目录，默认 `/data`。
- `TRUSTED_ORIGINS`：逗号分隔的完整来源 allowlist。
- `SESSION_IDLE_TIMEOUT`：解锁会话空闲超时。
- `MAX_SESSIONS`：实例最大并发终端数。
- `LOG_LEVEL`：日志级别。

不通过 Dockerfile `ENV`、构建参数或普通 compose 明文变量注入 SSH 凭据和主密码。备份只包含加密数据，恢复后仍需要主密码解锁。

### 11.3 备份

提供停机或一致性快照建议，备份 `/data` 中的 SQLite 数据和迁移元数据。备份文件本身仍是秘密材料，部署文档要求加密保存并测试恢复。首版不提供明文导出。

## 12. 错误处理与观测

错误分为四类：输入校验、Vault/会话、SSH/网络、系统内部错误。对用户显示稳定的错误 code 和可行动建议；对日志记录 request id、主机 id、状态和耗时，但不记录地址之外的完整敏感配置。

连接事件包括：开始、成功、认证失败、host key 首次看到、host key 拒绝、host key mismatch、远程退出、WebSocket 断开和重连结果。审计事件只描述动作，不保存终端内容。

## 13. 测试策略

### 单元测试

- 主机和标签输入校验。
- Argon2id 参数序列化、Vault key 包裹/解包、AES-GCM 篡改检测。
- 凭据 JSON 的不同认证类型和版本迁移。
- host key 指纹规范化、首次信任、匹配、mismatch。
- WebSocket 控制消息 schema、状态转移和大小限制。
- SSH adapter 错误映射和资源释放。

### API 集成测试

- 初始化、重复初始化、正确/错误解锁、锁定和会话过期。
- 主机 CRUD 与脱敏 DTO。
- 数据库中不存在明文凭据。
- 删除或替换凭据后旧密文不再被连接使用。
- 未解锁会话、跨主机 ID 和恶意字段被拒绝。

### 真实 SSH 集成测试

使用可重复构建的 OpenSSH 测试容器，覆盖：

- 密码登录和私钥登录。
- 错误凭据、连接拒绝和超时。
- 交互式 shell 输入输出。
- PTY rows/cols 更新。
- 未知指纹确认、拒绝和 mismatch 硬失败。
- WebSocket 断线重连和 session 释放。

### 浏览器 E2E

使用 Playwright 验证初始化、添加主机、主机列表检索、连接、终端输入、标签切换、resize、锁定和错误提示。E2E 的 SSH 目标固定为测试容器，不使用真实生产凭据。

### 安全验证

- 不可信 Origin 的 WebSocket 握手被拒绝。
- 无 session、过期 session 和错误 hostId 无法打开终端。
- 超大消息、非法 JSON、未知控制类型和消息洪泛被拒绝或限流。
- 终端输出含 HTML/OSC/链接控制序列时不会执行 DOM 脚本。
- 日志和构建产物扫描不到测试凭据、私钥和主密码。

### 发布门槛

实现阶段必须通过 lint、类型检查、全部单元/API/集成/E2E 测试、Docker build 和启动 smoke test，才能声称首版交付。

## 14. 后续演进边界

当单用户首版稳定后，可按以下顺序演进：

1. SFTP 文件面板，复用现有 SSH session/credential 边界。
2. SSH config 导入和 ProxyJump，新增严格的目标授权模型。
3. 多用户与 RBAC，把 Vault、Host、Session 加入 owner/tenant 维度。
4. 客户端加密和跨设备同步，重新设计密钥交换与恢复流程。
5. 独立 SSH worker，解决更高并发和资源隔离。

这些能力不能通过放宽首版的 host key 校验、URL 目标注入或明文凭据存储来提前实现。
