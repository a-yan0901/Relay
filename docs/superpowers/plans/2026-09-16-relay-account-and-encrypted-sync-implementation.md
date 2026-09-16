# Relay 个人账号与加密同步 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不改变 Local-only 使用路径的前提下，为 Relay 增加可选账号、设备信任和加密 Vault 同步，让登录且解锁 Vault 的用户可以在受信设备间恢复持久化配置。

**Architecture:** shared core 只保存平台无关的账号/设备/同步状态和可选 ports；Web adapter 负责 HttpOnly account session 与 HTTP 映射，桌面/Android adapter 后续复用相同 contract。当前服务端实现一个可替换的 self-hosted account provider 和 blind sync store，账号/设备/同步数据使用独立表和独立 cookie；同步 snapshot 在受信执行端用 `K_sync` 加密后才进入 blind store，云端接口不解析明文。Local-only 不创建账号请求、不需要新 ports，现有 SSH/SFTP/command/Vault 路径继续使用 `ownerId = default`。

**Tech Stack:** Node.js 22+, TypeScript, React 19, Fastify, SQLite/better-sqlite3, Argon2id, AES-256-GCM, Vitest, React Testing Library, Playwright, existing VaultBundle/transaction services.

**Spec:** `docs/superpowers/specs/2026-09-16-relay-account-and-encrypted-sync-design.md`

## Global Constraints

- 未登录账号时不发起 account/sync 请求；Host、Identity、Group、Snippet、Workspace 和加密凭据继续完整支持 Local-only。
- 账号密码不等于 Vault 主密码；账号重置不能恢复 Vault。主密码、私钥、passphrase、recovery key、Vault key、Sync key、session cookie 和 token 不进入 shared DTO、云端明文、浏览器持久化或普通日志。
- `account.auth`、`device.trust`、`sync.encrypted` 是可选 capability；client/server intersection 之外的操作必须返回 `CAPABILITY_UNAVAILABLE`。
- Sync API 只接受和返回 `SyncEnvelope`/`SyncDescriptor` 及最小 opaque metadata，不接受 master password、Vault plaintext、Host plaintext、Snippet command 或终端内容。
- `K_sync` 由 `K_vault` 包装；envelope 的 AAD 至少绑定 `vaultId`、`schemaVersion`、`revision`、`keyVersion` 和 `deviceId`；hash 校验与 AEAD auth tag 都必须通过。
- 首版同步对象只包括 Host/Group/Identity/Snippet/Workspace 和 Host Key trust；不包括 live Shell、terminal/session id、TransferJob、CommandRun、终端原始内容、SFTP 文件内容或普通 Activity 输出。
- 同步采用 encrypted snapshot + revision conflict；revision 不匹配拒绝覆盖，Host、Identity、Host Key trust、ProxyJump 和 Snippet command 不允许静默最后写入。
- 本地变更先事务提交，再进入加密 pending 队列；同步失败、离线或账号过期不阻塞 SSH/SFTP/批量命令。
- 登出停止同步但保留本地数据；设备撤销停止云端读写但不删除本地 Vault；删除账号使用 30 天可恢复窗口且不隐式删除本地副本。
- Server routes 从认证 session 派生 owner/account/device；请求 body 不能覆盖授权范围。跨 owner/account 的资源使用同样的 not-found 语义。
- 新行为遵循 `shared contract → failing test → minimal implementation → focused verification → browser/E2E verification → documentation`。
- 本任务影响核心数据模型、加密、认证、数据库迁移、跨模块路由和 UI；最终按 Q-01 运行完整验证，纯文档/单模块中间步骤使用聚焦验证。

---

## 1. 文件与模块边界

### Shared

- `src/shared/core/models.ts`：新增 `AccountState`、`SyncStatus`、设备、descriptor、envelope、冲突和 UI-safe 状态 DTO；不放 token/key/plaintext。
- `src/shared/core/ports.ts`：新增可选 `AccountSessionPort`、`DeviceTrustPort`、`SyncPort`；ports 只传输上述 DTO 和错误，不暴露 `Buffer`、浏览器对象或 HTTP response。
- `src/shared/core/runtime.ts`：给 `CoreRuntime` 增加可选 `account`、`devices`、`sync`，保证已有 Local fake 不需要实现它们。
- `src/shared/core/capabilities.ts`：拆分 Web client candidate 与 server-enabled account capability，默认服务端关闭时不广告。
- `src/shared/core/account-sync.ts`：平台无关状态降级、状态标签、冲突动作和 DTO 安全判定；不实现加密和网络。
- `src/shared/errors.ts`：加入账号/设备/同步稳定错误码、默认文案和 HTTP 状态。

### Server

- `src/server/db/migrations.ts`、`src/server/db/types.ts`、`src/server/db/repositories.ts`：账号、设备、blind envelope、冲突/删除窗口和本地 pending 元数据；所有 SQL 带 account/owner 条件。
- `src/server/account/account-crypto.ts`：账号密码 Argon2id hash/verify；不复用 Vault key，不记录明文。
- `src/server/account/account-session-store.ts`、`src/server/account/account-service.ts`：短期 account session、注册/登录/登出、设备注册/撤销；cookie 只存不可逆 session token。
- `src/server/account/account-routes.ts`：账号和设备控制面；不返回 token/hash。
- `src/server/sync/sync-crypto.ts`：K_sync 生成、wrapped key、AEAD envelope、AAD/hash/schema/大小验证；不解析业务 snapshot。
- `src/server/sync/sync-snapshot.ts`：从现有 owner-scoped repositories 生成/验证/事务应用 snapshot；复用 VaultBundle 的 Host/Identity/Group 校验，不同步运行态。
- `src/server/sync/sync-repository.ts`、`src/server/sync/sync-service.ts`、`src/server/sync/sync-routes.ts`：blind store、revision/idempotency、pending/retry、pull/preview/apply/delete；blind repository 不调用 Vault 解密。
- `src/server/auth/account-cookie.ts`：与 `webssh_session` 分离的 HttpOnly/SameSite account cookie。
- `src/server/config.ts`、`src/server/app.ts`、`src/server/api/setup-routes.ts`：`ACCOUNT_SYNC_ENABLED` 开关、可选依赖注入、capability 广告和新设备安全恢复入口。

### Web / tests / docs

- `src/web/api.ts`、`src/web/platform/web-adapters.ts`：account/device/sync API 和 ports adapter；不把 cookie/token 暴露到 React state。
- `src/web/components/AccountMenu.tsx`、`src/web/components/SyncCenter.tsx`、`src/web/App.tsx`、`src/web/styles.css`：Local-only/account/sync 状态、登录、设备、冲突和恢复交互；不展示秘密。
- `tests/unit/shared/account-sync-contract.test.ts`、`tests/unit/server/account-service.test.ts`、`tests/unit/server/sync-crypto.test.ts`、`tests/integration/server/sync-routes.test.ts`：contract、加密、权限、revision 和 blind store 验证。
- `tests/unit/web/account-menu.dom.test.tsx`、`tests/unit/web/sync-center.dom.test.tsx`、`tests/e2e/account-sync.spec.ts`：UI、Local fallback、锁定/解锁、冲突和浏览器安全路径。
- `tests/fixtures/core-runtime-contract.ts`、`tests/fixtures/native-runtime.ts`、`tests/unit/shared/core-adapter-contract.test.ts`、`tests/unit/shared/native-adapter-contract.test.ts`：Web/desktop-like/Android-like 可选 ports contract。
- `docs/architecture/cross-platform.md`、`docs/superpowers/plans/2026-09-16-relay-long-term-roadmap.md`、`README.md`：记录真实交付范围和 Local-only fallback。

---

## Task 1: 固化 shared account/sync contract 与 Local fallback

**Files:**

- Modify: `src/shared/core/models.ts`
- Modify: `src/shared/core/ports.ts`
- Modify: `src/shared/core/runtime.ts`
- Modify: `src/shared/core/capabilities.ts`
- Modify: `src/shared/errors.ts`
- Create: `src/shared/core/account-sync.ts`
- Test: `tests/unit/shared/account-sync-contract.test.ts`
- Modify: `tests/fixtures/core-runtime-contract.ts`
- Modify: `tests/fixtures/native-runtime.ts`
- Modify: `tests/unit/shared/core-adapter-contract.test.ts`
- Modify: `tests/unit/shared/native-adapter-contract.test.ts`

**Interfaces:**

```ts
export type AccountState = 'signed-out' | 'authenticating' | 'signed-in' | 'revoked';

export type SyncStatus =
  | 'local-only'
  | 'needs-unlock'
  | 'syncing'
  | 'synced'
  | 'pending'
  | 'offline'
  | 'conflict'
  | 'device-revoked';

export interface AccountSession {
  accountId: string;
  deviceId: string;
  state: Exclude<AccountState, 'signed-out' | 'authenticating'>;
  expiresAt: string;
}

export interface DeviceDescriptor {
  id: string;
  label: string;
  platform: ClientPlatform;
  lastSeenAt: string | null;
  current: boolean;
  revokedAt: string | null;
}

export interface SyncHead {
  vaultId: string;
  revision: number;
  keyVersion: number;
  payloadHash: string;
  updatedAt: string;
}

export interface WrappedKeyEnvelope {
  version: number;
  nonce: string;
  ciphertext: string;
  authTag: string;
  aad: string;
}

export interface VaultUnlockEnvelope {
  version: number;
  kdf: { algorithm: string; salt: string; memoryCost: number; timeCost: number; parallelism: number; hashLength: number };
  wrappedVaultKey: WrappedKeyEnvelope;
}

export interface SyncDescriptor {
  vaultId: string;
  keyVersion: number;
  vaultUnlockEnvelope: VaultUnlockEnvelope;
  wrappedSyncKey: WrappedKeyEnvelope;
}

export interface SyncEnvelope {
  schemaVersion: number;
  vaultId: string;
  revision: number;
  parentRevision: number | null;
  deviceId: string;
  keyVersion: number;
  nonce: string;
  ciphertext: string;
  authTag: string;
  aad: string;
  payloadHash: string;
  byteLength: number;
}

export interface SyncPreview {
  conflictId: string;
  localRevision: number;
  remoteRevision: number;
  conflictTypes: readonly ('host' | 'group' | 'identity' | 'snippet' | 'workspace' | 'host-key')[];
  localBackupRevision: number;
}

export type SyncResolution = 'keep-local' | 'use-remote' | 'export-both';

export interface SyncState {
  sync: SyncStatus;
  head: SyncHead | null;
  pendingCount: number;
  lastErrorCode?: string;
  lastSyncedAt?: string;
}

export interface AccountSessionPort {
  status(): Promise<AccountSession | null>;
  register(email: string, password: string, label?: string): Promise<AccountSession>;
  signIn(email: string, password: string, label?: string): Promise<AccountSession>;
  signOut(): Promise<void>;
}

export interface DeviceTrustPort {
  listDevices(): Promise<readonly DeviceDescriptor[]>;
  revokeDevice(deviceId: string): Promise<void>;
}

export interface SyncPort {
  status(): Promise<{ sync: SyncStatus; head: SyncHead | null }>;
  descriptor(): Promise<SyncDescriptor | null>;
  pull(): Promise<SyncEnvelope | null>;
  push(envelope: SyncEnvelope, idempotencyKey: string): Promise<SyncHead>;
  previewPull(): Promise<{ conflictId: string; localRevision: number; remoteRevision: number; conflictTypes: readonly string[] }>;
  resolveConflict(conflictId: string, resolution: 'keep-local' | 'use-remote' | 'export-both'): Promise<void>;
}
```

- [x] **Step 1: Write the failing contract tests.**

  在 `account-sync-contract.test.ts` 断言 `local-only`、`needs-unlock`、`device-revoked` 的状态文案/下一步，account DTO 不允许出现 token/master password/private key 字段，`SyncEnvelope` 必须包含 revision/hash/AAD 元数据。增加一个不实现可选 ports 的旧 `CoreRuntime` fake，证明 Local-only 类型兼容。

- [x] **Step 2: Run tests to verify they fail.**

  Run:

  ```bash
  export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
  npm test -- --run tests/unit/shared/account-sync-contract.test.ts tests/unit/shared/core-adapter-contract.test.ts tests/unit/shared/native-adapter-contract.test.ts
  ```

  Expected: FAIL because account/sync types, optional runtime ports and state helpers do not exist.

- [x] **Step 3: Implement the platform-neutral contract.**

  把类型放入 shared，给 `CoreRuntime` 增加 `account?: AccountSessionPort`、`devices?: DeviceTrustPort`、`sync?: SyncPort`；新增 `accountSyncCapabilities` helper。将 `WEB_CLIENT_CAPABILITIES` 定义为现有 Web client candidates 加 `account.auth`、`device.trust`、`sync.encrypted`，`createWebCapabilitySet({ accountSyncEnabled = false })` 只有在 server 配置开启时才把三个名称放入实际 server set；Web adapter 直接使用 `WEB_CLIENT_CAPABILITIES` 计算交集，未启用时保留现有列表。新增以下稳定错误码并绑定 HTTP 状态：`ACCOUNT_EMAIL_INVALID`(400)、`ACCOUNT_PASSWORD_INVALID`(400)、`ACCOUNT_EXISTS`(409)、`ACCOUNT_AUTH_FAILED`(401)、`ACCOUNT_SESSION_INVALID`(401)、`ACCOUNT_DEVICE_REVOKED`(403)、`SYNC_NOT_ENABLED`(409)、`SYNC_NOT_FOUND`(404)、`SYNC_CONFLICT`(409)、`SYNC_PAYLOAD_INVALID`(422)、`SYNC_KEY_VERSION_UNSUPPORTED`(422)、`SYNC_DELETE_CONFIRMATION_REQUIRED`(400)。

- [x] **Step 4: Run the focused contract tests.**

  Run:

  ```bash
  export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
  npm test -- --run tests/unit/shared/account-sync-contract.test.ts tests/unit/shared/core-adapter-contract.test.ts tests/unit/shared/native-adapter-contract.test.ts
  ```

  Expected: PASS; existing fake runtime and existing Web/native-like contract remain green.

- [x] **Step 5: Commit the shared contract.**

  ```bash
  export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
  git add src/shared/core/models.ts src/shared/core/ports.ts src/shared/core/runtime.ts src/shared/core/capabilities.ts src/shared/core/account-sync.ts src/shared/errors.ts tests/unit/shared/account-sync-contract.test.ts tests/fixtures/core-runtime-contract.ts tests/fixtures/native-runtime.ts tests/unit/shared/core-adapter-contract.test.ts tests/unit/shared/native-adapter-contract.test.ts
  git diff --cached --check
  git commit -m "feat: add account sync shared contracts"
  ```

## Task 2: Implement Sync key wrapping and encrypted envelope

**Files:**

- Create: `src/server/sync/sync-crypto.ts`
- Modify: `src/server/vault/types.ts` only if a shared `WrappedKeyEnvelope` conversion is required
- Test: `tests/unit/server/sync-crypto.test.ts`

**Interfaces:**

```ts
export const SYNC_SCHEMA_VERSION = 1 as const;
export const SYNC_KEY_VERSION = 1 as const;
export const SYNC_MAX_PAYLOAD_BYTES = 32 * 1024 * 1024;

export const createSyncKey = (): Buffer;
export const wrapSyncKey = (vaultKey: Buffer, vaultId: string, keyVersion: number, syncKey: Buffer): WrappedKeyEnvelope;
export const unwrapSyncKey = (vaultKey: Buffer, vaultId: string, keyVersion: number, wrapped: WrappedKeyEnvelope): Buffer;
export const encryptSyncPayload = (input: {
  syncKey: Buffer;
  vaultId: string;
  revision: number;
  parentRevision: number | null;
  deviceId: string;
  keyVersion: number;
  plaintext: Buffer;
}): SyncEnvelope;
export const decryptSyncPayload = (syncKey: Buffer, envelope: SyncEnvelope): Buffer;
export const validateSyncEnvelope = (value: unknown): SyncEnvelope;
```

- [x] **Step 1: Write failing crypto tests.**

  覆盖随机 32-byte `K_sync`、wrap/unwrap round trip、envelope round trip、AAD 修改、ciphertext/authTag/hash 修改、vaultId/revision/deviceId/keyVersion 不一致、超过 32 MiB、错误 base64、未知 schema/key version、不同 revision 产生不同 AAD。断言序列化 envelope 不包含 snapshot 中的 `password`、`privateKey`、`passphrase`、`command` 明文。

- [x] **Step 2: Run the crypto tests and observe failure.**

  ```bash
  export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
  npm test -- --run tests/unit/server/sync-crypto.test.ts
  ```

  Expected: FAIL because `src/server/sync/sync-crypto.ts` is absent.

- [x] **Step 3: Implement versioned AEAD and validation.**

  使用现有 `encryptBytes`/`decryptBytes` 的 AES-256-GCM 约束和 `VAULT_KEY_LENGTH`，为 sync 定义 `relay-sync:key:v1:<vaultId>:<keyVersion>` 与 `relay-sync:payload:v1:<vaultId>:<revision>:<parentRevision|root>:<keyVersion>:<deviceId>` AAD。对所有字段做长度、整数、base64、hash 和最大 payload 校验；错误分别映射到 `SYNC_PAYLOAD_INVALID`、`SYNC_KEY_VERSION_UNSUPPORTED` 或 `VAULT_CRYPTO_FAILED`。解密失败时释放临时 Buffer，不把 plaintext 放入异常文本。

- [x] **Step 4: Run the crypto tests.**

  ```bash
  export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
  npm test -- --run tests/unit/server/sync-crypto.test.ts
  ```

  Expected: PASS with tamper and size-limit assertions.

- [x] **Step 5: Commit the crypto slice.**

  ```bash
  export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
  git add src/server/sync/sync-crypto.ts tests/unit/server/sync-crypto.test.ts src/server/vault/types.ts
  git diff --cached --check
  git commit -m "feat: add encrypted sync envelope"
  ```

## Task 3: Add account/device schema, repositories and secure account sessions

**Files:**

- Modify: `src/server/db/migrations.ts`
- Modify: `src/server/db/types.ts`
- Modify: `src/server/db/repositories.ts`
- Create: `src/server/account/account-crypto.ts`
- Create: `src/server/account/account-session-store.ts`
- Create: `src/server/auth/account-cookie.ts`
- Create: `src/server/account/account-service.ts`
- Test: `tests/unit/server/account-service.test.ts`
- Modify: `tests/unit/server/migrations.test.ts`
- Modify: `tests/unit/server/repositories.test.ts`

**Interfaces:**

```ts
export interface AccountRow {
  id: string;
  email: string;
  passwordHash: string;
  createdAt: string;
  updatedAt: string;
}

export interface AccountDeviceRow {
  id: string;
  accountId: string;
  label: string;
  platform: ClientPlatform;
  createdAt: string;
  lastSeenAt: string | null;
  revokedAt: string | null;
}

export interface AccountSessionRecord {
  id: string;
  accountId: string;
  deviceId: string;
  expiresAt: number;
  lastUsedAt: number;
}

export interface AccountService {
  register(email: string, password: string, device: { label?: string; platform: ClientPlatform }): Promise<AccountSession>;
  signIn(email: string, password: string, device: { label?: string; platform: ClientPlatform }): Promise<AccountSession>;
  status(sessionId: string): AccountSession | null;
  signOut(sessionId: string): Promise<void>;
  listDevices(sessionId: string): Promise<readonly DeviceDescriptor[]>;
  revokeDevice(sessionId: string, deviceId: string): Promise<void>;
}
```

- [x] **Step 1: Write failing account/session tests.**

  覆盖 email 规范化/重复注册、弱密码、错误密码不泄露账户存在性、argon2 hash 不等于明文、session token 只在 cookie 层出现、过期 session、登出、设备列表 current 标记、撤销设备后 session 无法继续使用、当前 account 不能绕过 owner/account 检查。测试还要确认 migration 从旧 schema 升级后现有 Host/Vault 数据不变。

- [x] **Step 2: Run tests to verify failure.**

  ```bash
  export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
  npm test -- --run tests/unit/server/account-service.test.ts tests/unit/server/migrations.test.ts tests/unit/server/repositories.test.ts
  ```

  Expected: FAIL because account tables, repositories and service do not exist.

- [x] **Step 3: Add schema and owner-safe repositories.**

  将 `SCHEMA_VERSION` 从 11 升到 12，新增 `accounts`、`account_devices`、`account_sessions` metadata table，并为 account/email/device/revokedAt 建索引；migration 使用 `CREATE TABLE IF NOT EXISTS` 和事务，旧表不重建。repository 的 `getAccountByEmail`、`createAccount`、`createDevice`、`listDevices`、`revokeDevice` 全部使用参数化 SQL；不要将 account password/session token 写入 repository 返回 DTO。

- [x] **Step 4: Implement password hash and in-memory session store.**

  `account-crypto.ts` 使用 Argon2id encoded hash（不使用 Vault `K_vault`）；password 只存在调用栈。`AccountSessionStore` 生成至少 32-byte random token，内部只保存 token hash、accountId/deviceId/expiry，idle/absolute expiry 后立即删除；`account-cookie.ts` 使用 `relay_account_session`、HttpOnly、SameSite=Strict、production Secure，与 `webssh_session` 完全分离。撤销 device 时同步删除它的内存 sessions。

- [x] **Step 5: Run account focused tests.**

  ```bash
  export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
  npm test -- --run tests/unit/server/account-service.test.ts tests/unit/server/migrations.test.ts tests/unit/server/repositories.test.ts
  ```

  Expected: PASS; no account secret appears in test response/log assertions.

- [x] **Step 6: Commit account storage slice.**

  ```bash
  export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
  git add src/server/db/migrations.ts src/server/db/types.ts src/server/db/repositories.ts src/server/account/account-crypto.ts src/server/account/account-session-store.ts src/server/auth/account-cookie.ts src/server/account/account-service.ts tests/unit/server/account-service.test.ts tests/unit/server/migrations.test.ts tests/unit/server/repositories.test.ts
  git diff --cached --check
  git commit -m "feat: add account and device trust storage"
  ```

## Task 4: Add account/device routes and capability-gated app wiring

**Files:**

- Create: `src/server/account/account-routes.ts`
- Modify: `src/server/config.ts`
- Modify: `src/server/app.ts`
- Modify: `src/shared/core/capabilities.ts`
- Modify: `src/server/api/setup-routes.ts`
- Test: `tests/integration/server/auth-routes.test.ts`
- Create: `tests/integration/server/account-routes.test.ts`
- Modify: `tests/unit/server/config.test.ts`

**Interfaces:**

```ts
POST /api/account/register
  { email: string; password: string; deviceLabel?: string; platform?: ClientPlatform }
  → { account: AccountSession }

POST /api/account/session
  { email: string; password: string; deviceLabel?: string; platform?: ClientPlatform }
  → { account: AccountSession }

GET /api/account/session
  → { account: AccountSession | null }

DELETE /api/account/session
  → 204; local Vault remains usable

GET /api/account/devices
  → DeviceDescriptor[]

DELETE /api/account/devices/:deviceId
  → 204; current device deletion also invalidates its account sessions
```

- [x] **Step 1: Write failing route/config tests.**

  断言 `ACCOUNT_SYNC_ENABLED` 只接受 `true/false/1/0`，默认关闭；关闭时 account routes 和 capability 返回 `CAPABILITY_UNAVAILABLE`，且不触发 account DB 写入。开启时测试注册、登录、session cookie 属性、状态查询、登出保留 Vault session、设备列表/撤销、未登录 401、错误 Origin 403 和敏感字段不出响应。

- [x] **Step 2: Run integration tests to verify failure.**

  ```bash
  export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
  npm test -- --run tests/integration/server/account-routes.test.ts tests/integration/server/auth-routes.test.ts tests/unit/server/config.test.ts
  ```

  Expected: FAIL because config and account routes are not wired.

- [x] **Step 3: Add feature flag and capability advertisement.**

  `AppRuntimeConfig` 增加 `accountSyncEnabled`，`loadConfig` 默认 `false`；`GET /api/capabilities` 使用 `createWebCapabilitySet({ maxWorkspacePanes, accountSyncEnabled })`，关闭时不广告 account/device/sync。所有 account route 先检查 enabled，再验证 trusted Origin 和严格 Zod body。

- [x] **Step 4: Wire account service and routes.**

  `buildApp` 创建可注入的 `AccountService`/`AccountSessionStore`，注册 routes；路由从 cookie 读取 session，owner 不从 body 派生。register/sign-in 成功才 set account cookie；delete session 只 revoke account session，不调用 `SessionStore.revoke`，从而保持 Local-only Vault/SSH 可用。设备 revoke 统一清理被撤销设备 sessions，并在审计中只记录 account/device opaque id、动作和 request id。

- [x] **Step 5: Run route focused tests.**

  ```bash
  export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
  npm test -- --run tests/integration/server/account-routes.test.ts tests/integration/server/auth-routes.test.ts tests/unit/server/config.test.ts
  ```

  Expected: PASS; existing setup/unlock/lock behavior remains unchanged.

- [x] **Step 6: Commit account route slice.**

  ```bash
  export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
  git add src/server/account/account-routes.ts src/server/config.ts src/server/app.ts src/shared/core/capabilities.ts src/server/api/setup-routes.ts tests/integration/server/account-routes.test.ts tests/integration/server/auth-routes.test.ts tests/unit/server/config.test.ts
  git diff --cached --check
  git commit -m "feat: add optional account session routes"
  ```

## Task 5: Build blind sync repository, snapshot bridge and revision conflict service

**Files:**

- Modify: `src/server/db/migrations.ts`
- Modify: `src/server/db/types.ts`
- Modify: `src/server/db/repositories.ts`
- Create: `src/server/sync/sync-repository.ts`
- Create: `src/server/sync/sync-snapshot.ts`
- Create: `src/server/sync/sync-service.ts`
- Modify: `src/server/workspace/vault-bundle-service.ts`
- Modify: `src/server/api/setup-routes.ts`
- Test: `tests/integration/server/sync-routes.test.ts`
- Test: `tests/unit/server/sync-crypto.test.ts`

**Interfaces:**

```ts
export interface BlindSyncStore {
  getHead(accountId: string): SyncHead | null;
  getEnvelope(accountId: string, revision?: number): SyncEnvelope | null;
  putEnvelope(accountId: string, envelope: SyncEnvelope, idempotencyKey: string): SyncHead;
  getDescriptor(accountId: string): SyncDescriptor | null;
  saveDescriptor(accountId: string, descriptor: SyncDescriptor): void;
  saveConflict(accountId: string, local: SyncEnvelope, remote: SyncEnvelope): string;
  getConflict(accountId: string, conflictId: string): { local: SyncEnvelope; remote: SyncEnvelope } | null;
  deleteAccountVault(accountId: string, deleteAfter: string): void;
}

export interface SyncSnapshotService {
  create(ownerId: string, vaultKey: Buffer): Promise<Buffer>;
  validate(plaintext: Buffer): SyncSnapshot;
  previewApply(ownerId: string, vaultKey: Buffer, plaintext: Buffer): Promise<SyncPreview>;
  apply(ownerId: string, vaultKey: Buffer, plaintext: Buffer, resolution: SyncResolution): Promise<void>;
}

export interface SyncService {
  status(accountId: string): SyncState;
  enable(accountId: string, ownerId: string, deviceId: string, vaultKey: Buffer, vaultConfig: VaultConfig): Promise<SyncHead>;
  pull(accountId: string): SyncEnvelope | null;
  push(accountId: string, envelope: SyncEnvelope, idempotencyKey: string): SyncHead;
  previewPull(accountId: string, ownerId: string, vaultKey: Buffer): Promise<SyncPreview>;
  resolveConflict(accountId: string, ownerId: string, vaultKey: Buffer, conflictId: string, resolution: SyncResolution): Promise<void>;
}
```

- [x] **Step 1: Write failing blind-store/revision/snapshot tests.**

  测试要求：同一 idempotency key 重复 PUT 返回同一 head；错误 parent revision 返回 `SYNC_CONFLICT` 且旧 envelope 不变；不同 account 不能读写；descriptor 只有 wrapped key；snapshot 只序列化 Host/Group/Identity/Snippet/Workspace/Host Key，不包含 live session/transfer/command/activity；快照应用失败时数据库事务回滚。

- [x] **Step 2: Run the tests to verify failure.**

  ```bash
  export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
  npm test -- --run tests/integration/server/sync-routes.test.ts tests/unit/server/sync-crypto.test.ts
  ```

  Expected: FAIL because sync tables/service/snapshot bridge are absent.

- [x] **Step 3: Add blind sync schema and repository.**

  将 schema version 从 12 升到 13，新增 `sync_vaults`、`sync_envelopes`、`sync_conflicts`、`sync_delete_requests` 和 `sync_client_state`。`sync_envelopes` 只拆存 schema/revision/device/keyVersion/nonce/ciphertext/tag/aad/hash/byteLength，不增加 Host/email/address 列；`sync_client_state` 保存加密 pending envelope、状态和错误码，不保存 plaintext。所有 PUT 在单个 SQLite transaction 内校验 account、parent revision、idempotency 和大小后写入。

- [x] **Step 4: Extract canonical snapshot and transactional apply.**

  从 `VaultBundleService` 抽取可复用的 owner-scoped payload 生成/校验逻辑，追加 Workspace、Snippet 和 schemaVersion；凭据只在 `create` 的内存 Buffer 中出现，先用 `K_sync` 加密再交给 repository。`validate` 使用现有 schemas、`validateJumpChain`、Group depth/identity references；`apply` 使用现有 repository transaction/preview 规则，先备份本地加密 envelope，再按 `keep-local`/`use-remote`/`export-both` 处理冲突，不覆盖运行态表。

- [x] **Step 5: Implement service lifecycle and secure bootstrap.**

  `enable` 在 Vault unlocked 且 account signed-in 时生成 stable `vaultId`/`K_sync`，用 `K_vault` 包装，并创建 revision 1 encrypted snapshot；`pull` 仅返回 opaque envelope。新增 `POST /api/setup/from-sync` 作为 bootstrap-only route：只接受 `masterPassword + VaultUnlockEnvelope`，在未初始化实例中用现有 Argon2id 解包并创建本地 Vault config/session；它不接受 Vault plaintext，也不属于 blind Sync API。`resolveConflict` 先保存本地加密副本，再事务应用远端或生成加密 bundle。

- [x] **Step 6: Run snapshot/revision focused tests.**

  ```bash
  export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
  npm test -- --run tests/integration/server/sync-routes.test.ts tests/unit/server/sync-crypto.test.ts tests/unit/server/vault-bundle.test.ts tests/unit/server/migrations.test.ts
  ```

  Expected: PASS; response/log/database inspection contains no plaintext secret fields.

- [x] **Step 7: Commit blind store and snapshot slice.**

  ```bash
  export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
  git add src/server/db/migrations.ts src/server/db/types.ts src/server/db/repositories.ts src/server/sync/sync-repository.ts src/server/sync/sync-snapshot.ts src/server/sync/sync-service.ts src/server/workspace/vault-bundle-service.ts src/server/api/setup-routes.ts tests/integration/server/sync-routes.test.ts tests/unit/server/sync-crypto.test.ts
  git diff --cached --check
  git commit -m "feat: add blind sync storage and revision conflicts"
  ```

## Task 6: Expose sync routes and non-blocking pending/retry lifecycle

**Files:**

- Create: `src/server/sync/sync-routes.ts`
- Modify: `src/server/sync/sync-service.ts`
- Modify: `src/server/app.ts`
- Modify: `src/server/api/host-routes.ts`
- Modify: `src/server/api/group-routes.ts`
- Modify: `src/server/api/identity-routes.ts`
- Modify: `src/server/api/workspace-routes.ts`
- Modify: `src/server/api/command-routes.ts`
- Modify: `src/server/api/ssh-import-routes.ts`
- Modify: `src/server/api/vault-routes.ts`
- Modify: `src/server/automation/snippet-service.ts`
- Test: `tests/integration/server/sync-routes.test.ts`
- Test: `tests/integration/server/restart-boundaries.test.ts`

**Interfaces:**

```ts
GET  /api/sync/v1/state
GET  /api/sync/v1/descriptor
POST /api/sync/v1/enable
GET  /api/sync/v1/envelope
PUT  /api/sync/v1/envelope
POST /api/sync/v1/pull/preview
POST /api/sync/v1/conflicts/:conflictId/resolve
POST /api/sync/v1/retry
POST /api/sync/v1/vault/delete
```

- [x] **Step 1: Write failing route/lifecycle tests.**

  覆盖：未登录/设备撤销/未开启 capability 拒绝；登录未解锁只能读 account/sync opaque metadata，不能 enable、preview/apply 或访问本地 snapshot；enable 后 envelope 云端只含密文；断网/模拟 provider 5xx 进入 `offline`/`pending` 且本地 Host mutation 仍成功；网络恢复只按 idempotency 上传一次；lock/logout/restart 不保持虚假 `syncing`；删除窗口需要二次确认字段且不删除本地 Vault。

- [x] **Step 2: Run sync integration tests to verify failure.**

  ```bash
  export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
  npm test -- --run tests/integration/server/sync-routes.test.ts tests/integration/server/restart-boundaries.test.ts
  ```

  Expected: FAIL because routes and mutation hooks are absent.

- [x] **Step 3: Implement authenticated sync routes.**

  所有 routes 验证 account cookie、device 未撤销、capability 和 request schema；`state/head/descriptor/envelope` 只返回 opaque DTO。`PUT` 强制 `parentRevision`/idempotency，冲突返回 `SYNC_CONFLICT`；preview/apply 另外要求当前 `webssh_session` 解锁并从 session 获取 Vault key。任何 route 不接受 master password、plaintext snapshot 或 owner/account 字段。

- [x] **Step 4: Add non-blocking dirty marking and retry.**

  创建 `SyncCoordinator`（放在 `sync-service.ts` 或独立同目录文件）维护 per-account serial queue：在 Host/Group/Identity/Workspace/Snippet/Import/Vault mutation 成功响应后，仅在 account signed-in + Vault unlocked 时异步生成 snapshot；先写加密 pending envelope，再调用 blind store；SSH/SFTP/command 请求不等待 queue。队列按 request id 去重、指数退避、永久错误停止重试并保存错误码；lock/logout/revoke/服务重启取消内存句柄并恢复为 `pending`/`needs-unlock`。

- [x] **Step 5: Add deletion/recovery semantics.**

  delete route 要求当前 account session、重新认证标记和 `confirmDelete === 'DELETE MY CLOUD VAULT'`；写入 `deleteAfter = now + 30 days`，期间 GET 返回 countdown metadata，恢复操作撤销删除；到期清理只删除远端 envelope/account metadata，不删除本地 Host/Vault。审计只记录 opaque account/vault id、revision、status、reason 和 request id。

- [x] **Step 6: Run lifecycle focused tests.**

  ```bash
  export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
  npm test -- --run tests/integration/server/sync-routes.test.ts tests/integration/server/restart-boundaries.test.ts tests/integration/server/host-routes.test.ts tests/integration/server/workspace-routes.test.ts
  ```

  Expected: PASS; normal local mutations and existing restart semantics remain green.

- [x] **Step 7: Commit sync route/lifecycle slice.**

  ```bash
  export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
  git add src/server/sync/sync-routes.ts src/server/sync/sync-service.ts src/server/app.ts src/server/api/host-routes.ts src/server/api/group-routes.ts src/server/api/identity-routes.ts src/server/api/workspace-routes.ts src/server/api/command-routes.ts src/server/api/ssh-import-routes.ts src/server/api/vault-routes.ts src/server/automation/snippet-service.ts tests/integration/server/sync-routes.test.ts tests/integration/server/restart-boundaries.test.ts
  git diff --cached --check
  git commit -m "feat: add sync routes and offline lifecycle"
  ```

## Task 7: Add Web account/sync adapters and UI

**Files:**

- Modify: `src/web/api.ts`
- Modify: `src/web/platform/web-adapters.ts`
- Create: `src/web/components/AccountMenu.tsx`
- Create: `src/web/components/SyncCenter.tsx`
- Modify: `src/web/App.tsx`
- Modify: `src/web/styles.css`
- Test: `tests/unit/web/account-menu.dom.test.tsx`
- Test: `tests/unit/web/sync-center.dom.test.tsx`
- Modify: `tests/unit/web/auth-views.dom.test.tsx`

**Interfaces:**

```ts
export interface WebAccountApi {
  getAccountSession(): Promise<{ account: AccountSession | null }>;
  register(email: string, password: string, deviceLabel?: string): Promise<{ account: AccountSession }>;
  signIn(email: string, password: string, deviceLabel?: string): Promise<{ account: AccountSession }>;
  signOut(): Promise<void>;
  listDevices(): Promise<DeviceDescriptor[]>;
  revokeDevice(deviceId: string): Promise<void>;
}

export interface WebSyncApi {
  getSyncState(): Promise<{ sync: SyncStatus; head: SyncHead | null; lastError?: string }>;
  getSyncDescriptor(): Promise<SyncDescriptor | null>;
  enableSync(): Promise<SyncHead>;
  retrySync(): Promise<void>;
  previewPull(): Promise<SyncPreview>;
  resolveConflict(conflictId: string, resolution: SyncResolution): Promise<void>;
}
```

- [ ] **Step 1: Write failing adapter/UI tests.**

  `AccountMenu` 测试 Local-only 显示“仅本地，不同步”、未配置 capability 不渲染登录请求、登录/注册错误有明确原因、登出不触发 Vault lock；`SyncCenter` 测试 locked → `needs-unlock`、signed-in/unlocked → enable/sync、pending/offline/retry、conflict 三种动作、device-revoked，以及 DOM/状态中不存在 password/token/privateKey/command 明文。

- [ ] **Step 2: Run Web tests to verify failure.**

  ```bash
  export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/sbin:/bin
  npm test -- --run tests/unit/web/account-menu.dom.test.tsx tests/unit/web/sync-center.dom.test.tsx tests/unit/web/auth-views.dom.test.tsx
  ```

  Expected: FAIL because API methods, adapter ports and components are absent.

- [ ] **Step 3: Implement API and optional Web ports.**

  在 `src/web/api.ts` 增加严格 response types 和 account/sync functions；使用现有 `request` 的 same-origin credentials，永不读取/写入 localStorage/sessionStorage token。`web-adapters.ts` 实现 `WebAccountSession`、`WebDeviceTrust`、`WebSync`，当 client function 缺失或 capability 不支持时统一抛 `CAPABILITY_UNAVAILABLE`；`createWebAdapters` 仅在 server negotiation 返回三项能力时注入 ports，旧 fake 保持 undefined。

- [ ] **Step 4: Implement AccountMenu and SyncCenter states.**

  AccountMenu 只显示账号 email 的非敏感摘要、Local/Synced badge、最后同步时间和 sign-in/out/device actions；首次注册/登录不超过三步。SyncCenter 显示状态文字、reason、next action、revision/pending count、device list、冲突类型/时间和 keep-local/use-remote/export-both；密码只绑定 input action，不进入 state/log；logout 回到 Local-only 且不锁 Vault。

- [ ] **Step 5: Integrate header/boot without blocking Local.**

  `App.tsx` 在能力协商后加载 account/sync status；请求失败只显示 Local fallback。Header 的本地 avatar 改为可选 AccountMenu 入口，当前页面不因为 account service unavailable 而阻塞 Host/terminal boot；SyncCenter 关闭后保留工作区和终端。

- [ ] **Step 6: Run Web focused tests.**

  ```bash
  export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
  npm test -- --run tests/unit/web/account-menu.dom.test.tsx tests/unit/web/sync-center.dom.test.tsx tests/unit/web/auth-views.dom.test.tsx tests/unit/web/app.dom.test.tsx tests/unit/web/web-adapters.test.ts
  ```

  Expected: PASS; existing setup/unlock/terminal/sftp UI remains usable when account capability is absent.

- [ ] **Step 7: Commit Web account/sync UI.**

  ```bash
  export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
  git add src/web/api.ts src/web/platform/web-adapters.ts src/web/components/AccountMenu.tsx src/web/components/SyncCenter.tsx src/web/App.tsx src/web/styles.css tests/unit/web/account-menu.dom.test.tsx tests/unit/web/sync-center.dom.test.tsx tests/unit/web/auth-views.dom.test.tsx
  git diff --cached --check
  git commit -m "feat: add account and sync web experience"
  ```

## Task 8: Extend Web/native-like contracts and cross-device browser scenarios

**Files:**

- Modify: `tests/fixtures/core-runtime-contract.ts`
- Modify: `tests/fixtures/native-runtime.ts`
- Modify: `tests/unit/shared/core-adapter-contract.test.ts`
- Modify: `tests/unit/shared/native-adapter-contract.test.ts`
- Modify: `tests/unit/web/web-adapters.test.ts`
- Modify: `tests/e2e/ssh-fixture.ts`
- Create: `tests/e2e/account-sync.spec.ts`
- Modify: `playwright.config.ts`
- Modify: `README.md`
- Modify: `docs/architecture/cross-platform.md`

**Interfaces:**

- `createInMemoryCoreRuntime(platform, supportedCapabilities, options?)` accepts optional in-memory account/device/sync ports and keeps them absent by default.
- `account-sync.spec.ts` uses an account-enabled test server, two browser contexts/devices and the existing Vault setup fixture; no test puts a master password in query params or browser storage.

- [ ] **Step 1: Write failing contract and E2E tests.**

  Contract tests run the same account/sync assertions on Web, desktop-like and Android-like fake where supported, and assert Local fake remains fully usable without account ports. E2E covers: account feature disabled → no account request; register/sign-in while Vault locked → `needs-unlock`; unlock → enable and opaque envelope; second context sees device/sync head; wrong Vault password cannot restore; logout preserves terminal/local state; device revoke blocks sync; revision conflict requires explicit resolution; cloud fixture body lacks plaintext secret markers.

- [ ] **Step 2: Run tests to verify failure.**

  ```bash
  export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
  npm test -- --run tests/unit/shared/core-adapter-contract.test.ts tests/unit/shared/native-adapter-contract.test.ts tests/unit/web/web-adapters.test.ts
  npm run test:e2e -- tests/e2e/account-sync.spec.ts
  ```

  Expected: FAIL until fake ports, test server flag and browser flow are implemented.

- [ ] **Step 3: Implement fake ports and test configuration.**

  Extend native-like fake with deterministic account/session/device/sync state and in-memory encrypted envelope (using test-only opaque bytes, never plaintext secrets). Add an account-enabled Playwright server configuration with isolated temp data; keep default fixture account disabled. Add server cleanup for account session/device state.

- [ ] **Step 4: Implement E2E flow and documentation truth.**

  E2E uses visible UI actions and asserts status/next actions, not implementation details. Add README/architecture text stating account sync is optional and controlled by `ACCOUNT_SYNC_ENABLED`; Local-only, unimplemented native clients and current server trust boundary remain explicit.

- [ ] **Step 5: Run contract and E2E tests.**

  ```bash
  export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
  npm test -- --run tests/unit/shared/core-adapter-contract.test.ts tests/unit/shared/native-adapter-contract.test.ts tests/unit/web/web-adapters.test.ts tests/unit/web/account-menu.dom.test.tsx tests/unit/web/sync-center.dom.test.tsx
  npm run test:e2e -- tests/e2e/account-sync.spec.ts
  ```

  Expected: PASS; Local-only and account-enabled paths are both covered.

- [ ] **Step 6: Commit cross-platform contract slice.**

  ```bash
  export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
  git add tests/fixtures/core-runtime-contract.ts tests/fixtures/native-runtime.ts tests/unit/shared/core-adapter-contract.test.ts tests/unit/shared/native-adapter-contract.test.ts tests/unit/web/web-adapters.test.ts tests/e2e/ssh-fixture.ts tests/e2e/account-sync.spec.ts playwright.config.ts README.md docs/architecture/cross-platform.md
  git diff --cached --check
  git commit -m "test: verify account sync across adapters"
  ```

## Task 9: Security scan, release gate and roadmap closure evidence

**Files:**

- Modify: `docs/superpowers/plans/2026-09-16-relay-long-term-roadmap.md`
- Modify: `docs/superpowers/specs/2026-09-16-relay-account-and-encrypted-sync-design.md`
- Modify: `docs/architecture/cross-platform.md`
- Modify: `README.md`
- Test/scan: all account/sync tests and existing release commands

**Interfaces:**

- Verification output must prove account/sync requirements; green unrelated tests alone are insufficient.
- `secret_persistence_findings = 0` means no master password/private key/passphrase/recovery key/token/terminal plaintext in browser persistence, sync tables, HTTP response, audit metadata or regular logs.

- [ ] **Step 1: Run focused sensitive-data scans.**

  ```bash
  export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
  rg -n -i "localStorage|sessionStorage|masterPassword|privateKey|passphrase|recoveryKey|vaultKey|syncKey|webssh_session|relay_account_session|terminal output|command" src/web src/server/account src/server/sync tests/e2e/account-sync.spec.ts
  ```

  Review every match: allowed names are input parameter/type names and explicit negative assertions only; no value may be persisted/logged/transmitted outside the intended one-time or encrypted boundary.

- [ ] **Step 2: Run account/sync focused verification.**

  ```bash
  export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
  npm test -- --run tests/unit/shared/account-sync-contract.test.ts tests/unit/server/account-service.test.ts tests/unit/server/sync-crypto.test.ts tests/integration/server/account-routes.test.ts tests/integration/server/sync-routes.test.ts tests/unit/web/account-menu.dom.test.tsx tests/unit/web/sync-center.dom.test.tsx
  npm run typecheck
  npm run lint
  ```

- [ ] **Step 3: Run the required major-change release gate.**

  由于本任务同时影响认证、加密、数据库迁移、核心 ports、服务器路由、Web UI 和跨端 contract，运行：

  ```bash
  export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
  npm test
  npm run build
  npm run test:e2e
  ```

  Confirm existing OpenSSH, Host Key, Vault, SFTP, command, restart, PWA and account/sync flows all pass；若失败，修复后重新运行受影响的 focused test，再重新运行本 gate。

- [ ] **Step 4: Update evidence and roadmap status.**

  在 X-04 下记录实际 commit、迁移版本、focused/full verification 命令与计数；spec 的状态改为已实现但保留当前 server trust boundary/optional provider 说明；README 不宣称团队同步、零知识 Relay execution、Desktop/Android native UI 或离线 SSH 已交付。

- [ ] **Step 5: Inspect task-only diff and commit release evidence.**

  ```bash
  export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
  git status --short
  git diff --stat
  git diff --check
  git add docs/superpowers/plans/2026-09-16-relay-long-term-roadmap.md docs/superpowers/specs/2026-09-16-relay-account-and-encrypted-sync-design.md docs/architecture/cross-platform.md README.md
  git diff --cached --check
  git commit -m "docs: record account sync release evidence"
  ```

## Risk-based verification summary

- Task 1–2：shared contract/crypto focused tests；不运行完整 UI/E2E。
- Task 3–6：account/session/migration/sync route focused tests，另跑受影响的 Vault/restart route tests。
- Task 7–8：Web DOM、adapter contract 和 account E2E。
- Task 9：因涉及认证、加密、迁移、核心 ports、跨模块行为和发布边界，执行 `npm test`、`npm run build`、`npm run test:e2e`、`npm run lint`、`npm run typecheck`。
- 任一任务不得把“服务端存了 encrypted JSON”当作端到端加密完成证据；必须检查云端 fixture/table/log/response 没有明文和可直接解密的 key。
