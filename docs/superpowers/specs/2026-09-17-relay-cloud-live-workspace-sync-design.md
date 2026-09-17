# Relay 云端同步与跨端实时工作区设计

**日期：** 2026-09-17

**范围：** 独立 Web、Windows、Android 客户端；账号与 MySQL 云服务；数据同步；跨设备打开远端实时工作区；三端一致的入口和交互。

## 1. 产品语义

每个安装实例有自己的本地工作区和本地 SSH 执行端。登录同一账号后，首页显示“当前端”以及该账号下其他端的工作区，例如“Web”“Android 小明”“Windows 办公室”。点“Windows 办公室”进入它**当前正在运行的工作区**：若该端已连接两个终端，当前端显示这两个终端的实际画面，输入转发给 Windows 端已有的 SSH 连接，输出同步回所有观看端。远端 Host、SFTP、命令与工作区操作由远端执行端处理；当前端不复制远端 Shell，也不在自己设备上重新连接目标 SSH 主机。

同一终端允许多个已授权设备同时输入。持有 SSH 连接的端是唯一执行者，按到达顺序为输入分配单调序号并写入通道；所有参与端看到同一输出与参与者列表。界面标明“多人正在操作”，粘贴较长内容仍要求本地确认。PTY 尺寸由执行端持有，观看端适配显示尺寸，避免各设备互相触发 resize。

云服务还保存每个工作区的**端到端加密持久数据快照**，用于配置同步、恢复和远端离线时查看最近状态。快照和实时会话是两条通道：快照不包含 live Shell、终端原始内容或 SFTP 文件；实时流不作为云端历史记录。远端执行端离线或 Vault 锁定时，不能伪装终端可操作：显示离线/锁定原因、最后同步时间，可查看已授权的最近加密快照，所有远程操作禁用。客户端的“当前端”始终可独立工作。

“远端 A/B”在本设计中是设备或 Web 执行实例拥有的工作区，而非云端运行的 SSH 会话。首次打开其他端先验证账号、设备信任和解密能力；之后直接进入该端实时工作区。支持从远端显式“复制配置到当前端”，经过冲突预览，不在切换卡片时静默合并本地 Vault。

## 2. 现状与必须改造的边界

现有 `src/shared/core` 已提供 `CoreRuntime`、Host/Session/File/Command 等 ports；Web 的 SSH 由 `src/server/ssh/session-manager.ts` 持有，具备短时 detach/reconnect 与 256 KiB 输出缓冲。现有账号与同步在同一 SQLite 服务中，`BlindSyncStore` 按 **accountId 单一 vault/head** 保存加密快照，`SyncSnapshotService` 的 v1 快照包含 Host/Identity/Group/Snippet/Workspace/终端 profile。Web 账号状态和云同步 UI 已有切片，但不能直接表示多个独立工作区，更不能转发远端实时终端。Windows/Android 独立客户端仍按 [本地端设计](./2026-09-17-relay-windows-android-unified-experience-design.md) 实施。

本设计引入 v2 云协议与独立部署；不把现有 SQLite 表替换成 MySQL 连接串，也不直接暴露旧的 `/api/sync/v1/envelope` 为多工作区 API。旧 Web v1 数据需按迁移流程转成该 Web 实例的一个工作区，保留可回滚副本。Web 当前 `ownerId='default'`/单 Vault 假设需要隔离成每账号独立本地数据域；在完成隔离前不得让多个账号共用同一 Web 执行实例的数据与 live Shell。

## 3. 系统拓扑和部署

```text
Web 浏览器 → Web 执行实例（本地 Vault/SSH/SQLite） ─┐
Windows app（本地 Vault/SSH/SQLite） ───────────────┼─ 出站 HTTPS/WSS ─→ 云 API/中继 ─→ MySQL
Android app（本地 Vault/SSH/私有库） ────────────────┘
       ↑ 当前端 UI 选择本端或其他端；远端实时操作沿中继回到拥有者
```

云 API 可部署在当前 `106.14.61.92`，使用已有 `api.ayan.org.cn` 作为唯一公开 HTTPS/WSS 入口。nginx 在 443 终止 TLS 并反向代理到仅监听 `127.0.0.1` 的独立云服务；MySQL 当前监听 `127.0.0.1:3306`，云服务使用专用 schema、最小权限数据库用户和独立迁移，不读写 Web SSH 的 SQLite。云服务不开放 SSH 目标连接能力，不接收远端主机密码/私钥明文。正式上线前验证域名证书、代理 WebSocket upgrade、请求体大小、超时、备份恢复及断线重连。当前域名 `/` 返回 404 只能证明 HTTPS 到达 nginx，不能证明云 API 已部署；设计阶段不修改 nginx/MySQL。

Web 的执行实例和云服务即便同机部署也是不同信任与存储域。Web 浏览器沿用自身同源会话访问 Web 执行实例，由该实例以受限设备凭据连接云 API；Windows/Android 通过系统安全存储持有设备会话凭据并直接连接云 API。云服务验证账号、设备、工作区归属与撤销状态；Web 执行实例若服务多个账号，必须按账号隔离本地 Vault、SSH session、workspace 与云设备凭据。云服务的浏览器来源白名单只列受支持的正式 Web origin，不开放 `*`。

## 4. 云数据模型与 API

MySQL InnoDB 使用独立 schema，核心表如下；所有关联均以 `account_id` 限定，所有写入有幂等键和审计摘要。

| 表 | 主键/关键索引 | 内容与约束 |
| --- | --- | --- |
| `accounts` | `account_id`；唯一归一化邮箱 | 账号身份、密码验证材料、状态；无 Vault 明文 |
| `devices` | `device_id`；`account_id, revoked_at` | 平台、用户可见名称、设备公钥、最近心跳；标签是可见元数据 |
| `device_sessions` | token hash；`device_id, expires_at` | 会话/撤销/轮换，原 token 不落库 |
| `workspaces` | `workspace_id`；唯一 `owner_device_id` | 归属设备、加密标题、版本、最后发布时刻、删除状态；一端默认一个主工作区 |
| `workspace_keys` | `workspace_id, key_version, device_id` | 向已授权设备封装的工作区密钥；云端不持有解密 key |
| `workspace_heads` | `workspace_id` | 当前 `revision/hash/key_version`；CAS 写入 |
| `workspace_revisions` | `workspace_id, revision`；唯一幂等键 | 不可变加密快照、AAD、hash、大小、作者设备与时间 |
| `workspace_memberships` | `workspace_id, device_id` | 同账号设备的访问范围和撤销记录；默认同账号受信设备可申请加入，需具备工作区 key |
| `relay_presence` | 内存/短 TTL | 执行端连接、当前 live session 数与路由；不作为运行状态的永久真相 |
| `audit_events` | 时间/账号索引 | 登录、设备撤销、工作区加入、订阅、输入、删除的脱敏摘要 |

MySQL 持久化账号、设备、加密快照与审计；live 输出只在在线内存中转发，禁止写 MySQL、普通日志或备份。发布快照时以 InnoDB 事务锁定该工作区 head、校验 `parentRevision`，再写新 revision/head；版本不匹配返回冲突，不做最后写入覆盖。事务与行锁行为按 [MySQL InnoDB 文档](https://dev.mysql.com/doc/refman/8.4/en/innodb-transaction-model.html) 验证。v1 先用快照 CAS 和人工冲突处理；对象级自动合并留后续。

云 API v2：`/v2/auth/*` 登录、刷新、登出；`/v2/devices` 列表/重命名/撤销；`/v2/workspaces` 列表与权限；`/v2/workspaces/{id}/descriptor|head|revisions|snapshot` 获取加密数据；`PUT /v2/workspaces/{id}/snapshot` 带 `parentRevision` 和幂等键发布；`/v2/relay/owner` 与 `/v2/relay/viewer` 为已认证 WSS。所有路由从会话解析 account/device，不接受客户端自报的任意账号 ID；IDOR、超额载荷和已撤销设备应返回稳定错误码。服务端列表只返回最小元数据，不暴露 Host 地址、命令、私钥或终端输出。

## 5. 密钥、登录与恢复

各端本地 Vault 独立。首次开通云同步时客户端生成账号同步根密钥 `K_account`，每个工作区生成 `K_workspace`；工作区快照由 `K_workspace` AEAD 加密，`K_workspace` 由 `K_account` 包装并按授权设备再封装。AAD 绑定协议版本、accountId、workspaceId、revision、parentRevision、keyVersion、writerDeviceId。云端存密文、包装密钥和最小路由元数据，不能解密快照。旧 v1 `K_sync`/Vault 包装不可无条件沿用为多工作区密钥；客户端在用户确认迁移时完成 v2 重新加密并保留 v1 回滚副本。

账号登录只证明身份；新设备仍需离线恢复密钥或已信任设备批准以取得 `K_account`，且本地 Vault 解锁后才能查看/应用敏感配置。Windows/Android 的设备私钥与会话凭据进 OS keychain/Android Keystore；Web 执行实例安全保存设备凭据，浏览器只持有 HttpOnly 会话。设备撤销立即停止新的快照读取/写入与 live relay，强制关闭现有订阅，随后轮换受影响工作区 key 并为剩余设备重封装。丢失全部恢复材料时账号密码重置不恢复加密工作区。

实时 Console 流也视为敏感数据：所有参与端先完成设备互信，再协商每次连接的临时加密会话密钥；云服务只转发密文帧及必要路由元数据，不记录终端字节或输入。实现前用 Web 执行端、Electron 和 Android 真机验证同一加密帧格式、密钥轮换与断线重协商；无法通过时不得以明文中继冒充端到端加密。云端仍能看到在线状态、设备/工作区 ID、流量时间和大小，这些属于明示的元数据。

## 6. 实时工作区协议

1. 执行端登录后维持出站 WSS 心跳，发布 `workspaceId`、活跃终端的**不含秘密**清单、layout revision 与可用性；Web 执行端的连接由后端持有，浏览器刷新不改变其路由身份。
2. 观看端点击远端卡片，加载加密快照与在线描述，取得工作区 key，向云 relay 订阅该工作区。云端检查同账号成员权限并将请求转给拥有者；拥有者检查 Vault 解锁、实际 session、设备授权，再回传工作区 layout、两个终端的 `sessionId`/状态和各终端画面快照，随后发送连续输出事件。不能用历史末尾 256 KiB 字节流推断完整当前屏幕；拥有者需维护可重建当前屏幕的终端状态快照和有界 scrollback。
3. 每个事件含 `workspaceId/sessionId/ownerEpoch/sequence/type`。观看端先应用快照，再按序消费输出；丢帧请求从拥有者的有界缓冲补发，超窗则重新获取屏幕快照。owner 重启导致 `ownerEpoch` 变化时旧帧全部丢弃，Shell 显示 `needs-reopen`，不虚构原连接继续存在。
4. 多端输入帧含 `participantDeviceId/inputId/sessionId/payload`，仅拥有者能写 SSH 通道。拥有者校验授权、长度、控制字符策略与 Vault/session 状态，为每帧分配 `inputSequence`，去重后按序写入并确认；所有参与端显示操作人。粘贴按一帧处理并限制大小；断线后未确认输入不自动重放，避免命令重复执行。云服务不修改或执行输入。
5. 终端尺寸由拥有者决定；观看端按容器缩放/留白，不直接触发远端 PTY resize。多人同时输入不锁定键盘，但 UI 提示并显示参与者；任何端可停止自己的订阅，只有拥有者或显式授权的动作可关闭实际 SSH session。
6. 远端 Host/SFTP/批量命令与 workspace 导航通过同一 relay RPC 发给拥有者执行，结果经加密通道返回；SFTP 文件本期只在有明确选择/保存动作时按有界流传输，不进入云数据库。超时、取消、权限拒绝与断线有稳定状态，观众端不自行改写远端数据。

Android 作为拥有者进入后台时，只有用户明确开启的前台服务可继续维持 SSH 与 relay，并有持续通知和停止入口；没有前台服务或系统回收时更新离线状态。Windows 关闭窗口的行为须在设置中明确是继续后台执行还是终止；Web 后端重启会失去原 SSH session。云端在线状态以心跳 TTL 和拥有者确认共同判断，不能只凭最近同步时间标“在线”。

## 7. 持久数据同步与冲突

拥有者本地修改 Host/Identity/Group/Snippet/Workspace/主题后先提交本地事务，再生成加密快照，按 `parentRevision` 上传到自己的工作区；云不可用时本地继续工作，待上传密文和幂等键留在本地加密队列。其他端已进入该远端工作区时，操作直接 RPC 到拥有者并由其发布新快照，不在观看端各建一份独立可写 Vault。观看端要把远端配置复制到“当前端”时，必须预览对象数、同名/同 ID 冲突和 Host Key 信任；接收端本地事务应用后再发布自己工作区的新 revision。

如果拥有者与云 head 分叉，停止自动覆盖，保留两份加密快照并在拥有者 UI 提供“保留本端、采用云端、加密导出两份”；Host Key、凭据、ProxyJump 和命令片段不能静默按时间合并。删除工作区使用软删除、保留期和设备撤销检查；恢复不自动重建已失效的 live session。Web 旧 v1 迁移须记录旧 head/hash 到新 workspace revision 映射、加密备份、幂等迁移标记和回滚窗口；不能把 SQLite 中的现有账号/同步表当成云 MySQL 的生产多用户数据。

## 8. 三端首页与远端工作区交互

```text
Relay 首页  [搜索]                         [账号/同步状态]
┌───────────────────┐  ┌───────────────────┐  ┌───────────────────┐
│ 当前端 · 本地      │  │ Windows 办公室     │  │ Android 小明       │
│ 2 个终端 · 可用    │  │ 在线 · 2 个终端    │  │ 离线 · 最后同步…   │
│ [进入]            │  │ [打开实时工作区]   │  │ [查看最近快照]    │
└───────────────────┘  └───────────────────┘  └───────────────────┘
```

三端共用卡片信息、状态文字、图标语义、主题 token 与进入流程；Windows/Web 可多栏，Android 单列/横向切换，不缩小终端到不可操作。远端工作区顶部固定显示“正在查看 Windows 办公室 · 由该端执行 SSH · 在线参与者 3”，并有显著“返回当前端”。远端两个终端按拥有者布局显示；窄屏以两个标签切换而非同时挤在屏上，但两条真实 session 均继续在线。输入框可用时显示多人同时操作提示和操作者；只读/离线/锁定时明确原因。

首页卡片状态至少有：`当前端`、`在线可进入`、`连接中`、`远端已锁定`、`离线仅快照`、`需要恢复密钥`、`设备已撤销`、`同步冲突`。进入远端与本端使用相同 Host、Terminal、SFTP、Activity 页面和主题；不同的是 `CoreRuntime` 由远端代理 adapter 注入，文件和剪贴板使用观看端的系统能力。标签/终端的远端归属永远可见，危险操作显示执行端名称和目标。断线后保留画面但覆盖“已断开”状态，禁止把旧画面当作实时 Shell；可重新连接或返回本端。

## 9. 验收、发布和限制

- 单用户三实例（Web、Windows、Android）可分别 Local 使用，登录后首页显示三张独立入口；Web 归属数据与其他账号严格隔离。
- Windows 拥有者打开两个真实 SSH Shell；Web 和 Android 同时进入 Windows 工作区，均看到两个终端的当前画面和后续输出，三端交替输入按拥有者序号写入同一 Shell。观看端退出不关闭 SSH。
- 远端执行端离线、Vault 锁定、进程重启或 Android 后台回收时，所有观看端迅速得到真实状态，不会在云端创建替代 SSH 连接；重连后按新 epoch 恢复或显示需重新打开。
- Host/SFTP/批量操作从观看端发起时在拥有者执行；文件不落云 MySQL；快照只含允许的加密配置与工作区意图。云数据库、日志和普通备份均无 Host/命令/终端明文。
- 设备撤销立即断开 live 订阅，拒绝后续快照请求；两设备修改造成的 revision 冲突可导出两份并安全恢复。云服务不可用时当前端仍可工作，远端入口明确不可实时进入。
- `https://api.ayan.org.cn` 的 API/WSS、独立 MySQL schema、迁移/回滚、备份恢复、TLS、限流与三端真机/浏览器任务链均有发布证据。该域名及本机 MySQL 当前可作为部署目标，但本设计未部署服务或变更数据库。

本期不提供云端 SSH 执行、云端终端录制、远端设备离线控制、多人输入的事务级命令隔离，也不承诺 Android 在后台无前台服务时保持可用。此设计覆盖后续云端服务和三端实现阶段，不能用现有 v1 同实例测试宣称已交付。
