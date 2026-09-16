# Relay 账号重新认证与删除恢复设计

日期：2026-09-17
状态：Approved for implementation
适用范围：路线图 X-04D；个人账号、云端同步数据删除、30 天恢复窗口、设备撤销和本地副本保留。

## 1. 决策摘要

当前 `reauthenticated: true` 是客户端可伪造的布尔值，不能作为高风险操作的授权。X-04D 引入服务端 session-bound re-auth：当前账号 session 提交账号密码后，服务端只在内存中记录 10 分钟有效的重新认证状态；密码不进入响应、数据库、审计 metadata、URL 或普通日志。

删除分为两个明确层级：

- 云端同步数据删除：保留账号和设备，停止该账号的同步，进入 30 天可恢复窗口；恢复需要有效账号 session 和再次 re-auth。
- 账号删除：撤销所有现有设备和账号 session，停止同步，进入 30 天可恢复窗口；窗口内可用原账号密码重新登录，完成 re-auth 后恢复账号。窗口到期后事务删除账号、设备和所有云端同步数据。

两种删除都不触碰当前 Relay 实例的本地 Vault、Host、Identity、Group、Snippet、Workspace、SSH session 或本地审计数据。账号删除后的新登录只用于恢复或查看删除状态；恢复前不得读取、上传或修改云端同步载荷。

## 2. 范围与非目标

### 2.1 本次交付

1. `AccountSessionStore` 增加短时、绑定 session 的 re-auth 状态和按账号撤销能力。
2. Account service 增加 re-auth、账号删除请求、删除状态、恢复和过期清理。
3. 新增 `account_delete_requests` 数据表，schema version 从 13 升到 14。
4. 新增账号删除 API，并将现有同步 Vault 删除/恢复 API 改为服务端 re-auth。
5. 删除请求期间阻止新的同步读写和队列上传；状态接口仍返回脱敏倒计时。
6. AccountMenu 提供账号删除、重新认证、恢复和本地数据保留说明；同步中心入口提供云端同步数据删除状态和恢复动作。
7. Web、native-like fake、server integration、DOM 和账号 E2E 覆盖成功、失败、过期、撤销、恢复和本地保留边界。

### 2.2 非目标

- 本次不实现“退出账号并删除本地 Vault”的操作；该动作必须作为独立的更高风险功能设计。
- 不实现账号密码重置、邮件恢复链接或第三方身份提供商。
- 不删除当前 Relay 的本地审计历史；审计事件只包含事件类型、request id、opaque account/device id 和结果。
- 不把删除状态或 re-auth 状态写入 shared 的长期持久化状态、localStorage、sessionStorage 或同步快照。

## 3. 状态机与生命周期

### 3.1 Re-auth

`AccountSessionStore` 的每个内存 session 保存 `reauthenticatedUntil: number | null`，创建、登出、过期和撤销时均清除。`reauthenticate(sessionToken, password)` 先通过 `AccountService` 查询当前账号并调用现有 Argon2id password verifier，成功后设置 `now + 10 minutes`；`requireReauthenticated(sessionToken)` 同时检查 session 有效性和时间窗口。服务重启会丢失 re-auth 状态，必须重新认证。

账号密码错误统一返回 `ACCOUNT_REAUTH_FAILED`，不区分账号不存在、密码错误或 session 失效；缺少或过期 re-auth 返回 `ACCOUNT_REAUTH_REQUIRED`。成功 re-auth 使用 `204 No Content` 和 `Cache-Control: no-store`，不返回 token。

### 3.2 云端同步数据删除

现有 `sync_delete_requests` 表继续承载云端同步数据删除：

```text
none --reauth + exact confirmation--> pending(deleteAfter = now + 30 days)
pending --reauth + restore--> none
pending --clock >= deleteAfter--> purged
```

pending 期间：

- `GET /api/sync/v1/state` 返回 `sync: local-only`、无 head/pending envelope 和删除倒计时。
- descriptor、envelope、push、preview、resolve、retry 和 coordinator 上传均拒绝并返回 `SYNC_DELETE_PENDING`。
- 本地 Vault、Host、Workspace 和 SSH/SFTP/批量命令不受影响。
- 恢复只取消删除请求，不恢复已被撤销或清理的本地数据。

### 3.3 账号删除

新增 `account_delete_requests`：

```sql
account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
delete_after TEXT NOT NULL,
requested_at TEXT NOT NULL,
restored_at TEXT
```

请求账号删除时，数据库事务写入 pending request 并将所有 `account_devices.revoked_at` 设置为当前时间；事务成功后由内存 `AccountSessionStore.revokeAccount(accountId)` 撤销所有 session，并清理当前账号 cookie。原设备不会在恢复时自动取消撤销。

pending 账号允许使用原账号密码登录，以便用户恢复；登录创建的新设备只可调用 deletion status、re-auth 和 restore，不能访问同步 API。恢复后该新设备保持有效，历史已撤销设备仍需重新登录创建新设备。

过期清理在服务启动和账号相关请求前执行，使用单个数据库事务删除：

- `sync_client_state`、`sync_conflicts`、`sync_envelopes`、`sync_vaults`、`sync_delete_requests`；
- `account_delete_requests`、`account_devices`、`account_sessions`、`accounts`。

由于本地业务表使用 owner `default`，清理不删除 `app_config`、hosts、identities、groups、snippets、workspace、command 或 transfer 数据，也不撤销 `SessionStore` 的本地 Vault session。

## 4. API 与 shared contract

### 4.1 Account API

```text
POST /api/account/session/reauth
  body: { password: string }                         -> 204, no-store

GET  /api/account/deletion
  response: { deletion: AccountDeletionState | null } -> 200, no-store

POST /api/account/deletion
  body: { confirmDelete: "DELETE MY ACCOUNT" }      -> 202, { deletion }, no-store

POST /api/account/deletion/restore
  body: {}                                           -> 204, no-store
```

所有 request body 严格拒绝未知字段；密码长度使用账号密码现有 1–4096 request bound，实际验证复用 Argon2id verifier。账号删除请求和恢复均要求当前账号 session 与服务端 re-auth；删除请求成功后清除当前账号 cookie，恢复不会自动解锁或改变本地 Vault。

新增 shared model：

```ts
export interface AccountDeletionState {
  deleteAfter: string;
  requestedAt: string;
  remainingMs: number;
}
```

`AccountSessionPort` 增加：

```ts
reauthenticate(password: string): Promise<void>;
getDeletion(): Promise<AccountDeletionState | null>;
requestDeletion(confirmDelete: string): Promise<AccountDeletionState>;
restoreDeletion(): Promise<void>;
```

### 4.2 Existing sync delete API

保留现有路径以兼容已存在的 sync contract，但 body 改为严格的 `{ confirmDelete: "DELETE MY CLOUD VAULT" }`，不再接受 `reauthenticated` 字段；请求和恢复都调用 `AccountService.requireReauthenticated`。新增 `SYNC_DELETE_PENDING` 用于 pending 期间的 sync 读写拒绝。

`SyncPort` 增加：

```ts
requestCloudDeletion(confirmDelete: string): Promise<NonNullable<SyncState['deletion']>>;
restoreCloudDeletion(): Promise<void>;
```

云端删除仍不会撤销账号设备；账号删除才撤销全部设备和 session。

## 5. 安全边界

- re-auth 密码只存在 HTTP request 和短暂调用栈；服务端不把原始字符串放进 session、数据库、error message、audit 或 logger。
- re-auth 标志只存 session 内存，按 session 绑定，不能由 body、cookie 外字段或 account id 伪造；session revoke、account revoke、服务重启和 TTL 到期均失效。
- delete/restore 的 confirmation phrase 在服务端使用 `z.literal` 严格校验；UI 文案和 server constant 不接受模糊匹配。
- 账号删除先事务更新设备 revoke 与 deletion request，再撤销内存 session；数据库失败时不得撤销 session 或清除 cookie。
- purge 只按 account id 删除同步和账号表；任何 local owner 数据、Vault key、活跃 SSH session 和本地副本均不删除。
- 删除 pending 时 coordinator 在排队、执行和 retry 三个入口都检查状态，防止删除请求与异步 snapshot 上传竞态。
- 审计只写 `accountId`、`deviceId`、`status`、`reason`、`action` 等已有白名单字段。敏感扫描覆盖 password、Host address/name、credential marker、snapshot marker、sync ciphertext 之外的明文字段。

## 6. Web 交互

AccountMenu 登录状态下增加“账号安全”区域：

- 正常状态显示“删除账号”入口；表单要求账号密码和精确确认文本 `DELETE MY ACCOUNT`，提交时显示 busy，成功后清理输入并提示“账号删除已计划，本地 Vault 保留”。
- pending 状态显示明确的 `deleteAfter` 与倒计时、同步已停止、本地数据保留说明，以及“重新认证并恢复账号”入口。
- 恢复必须重新输入账号密码；成功后刷新 account/deletion/sync 状态，历史撤销设备仍显示为已撤销。
- re-auth 失败只显示可重试原因，不回显密码；取消、错误、成功、卸载组件均清除密码字段。

SyncCenter/AccountMenu 对云端同步数据删除显示单独的倒计时和恢复动作；缺少新 endpoint 的旧服务器映射为 `CAPABILITY_UNAVAILABLE`，不影响 Local-only、终端、SFTP 和批量命令。

## 7. 验证要求

### Server

- AccountSessionStore：TTL、session 绑定、撤销、账号批量撤销、错误密码和重启失效。
- AccountRepository/迁移：schema version 14、pending/upsert/restore、过期事务清理、account/device/sync cascade 和本地表保留。
- Account routes：未登录、错误密码、缺少/过期 re-auth、严格 body、请求清除 cookie、pending 登录恢复、过期后认证失败。
- Sync routes：旧布尔字段拒绝、服务端 re-auth、cloud deletion pending 阻止读写、恢复和 30 天 countdown。
- Audit/log scan：不出现密码、Host 明文、snapshot marker 或私钥。

### Web/native-like

- API 严格解析 deletion/re-auth 响应；旧服务器缺 endpoint 时返回 capability error。
- AccountMenu/SyncCenter 覆盖删除确认、busy、错误重试、倒计时、恢复、本地数据保留和输入清理。
- Local-only fake 不要求新增账号方法；desktop-like/Android-like fake 使用相同状态和错误 contract。

### Release gate

该变更涉及账号权限、数据库迁移、删除生命周期、同步队列和 shared ports，完成 focused 测试后必须运行 `npm test`、`npm run typecheck`、`npm run lint`、`npm run build`、默认 E2E、account-enabled E2E 及敏感数据扫描。只有所有结果通过后才将路线图 X-04D 标记完成。
