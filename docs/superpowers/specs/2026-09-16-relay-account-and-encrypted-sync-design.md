# Relay 账号、设备与端到端加密同步设计

日期：2026-09-16
状态：M5 核心 Web/自托管切片已实现（可选、默认关闭）；完整跨端正式发布仍待恢复与密钥安全闭环
适用范围：个人账号、跨设备同步、Web/桌面/Android 的同步边界；不包含团队协作和 Agent 实现。

## 1. 决策摘要

Relay 采用“可选账号 + 端到端加密同步”的方案：

- 未登录账号时，Relay 是完整可用的 Local 模式；数据只留在当前实例/设备，不发起账号请求，也不做跨平台同步。
- 登录 Relay 账号后，当前 Vault 进入 Sync 模式；登录是开启同步的用户动作，解锁 Vault 后自动同步配置和已允许的工作区数据。
- 账号是身份、设备和同步权限，不是 Vault 解密密钥。账号密码重置不能恢复 Vault。
- 云端账号/同步服务只保存账号会话所需的身份数据、加密同步载荷和最小同步元数据，不能解密 Vault 内容。
- 当前 Web-mediated SSH 的 Relay 执行端仍是受信的解密边界：它需要在 Vault 解锁后使用凭据建立 SSH。新设计保护的是云端同步存储和传输，不宣称当前执行端对自己持有的运行时凭据是零知识。
- 桌面/Android 如果采用本地 SSH，可以在本地 OS keychain/Keystore 解密并使用凭据；如果继续使用 server-mediated transport，则沿用现有受信执行端边界。
- 个人同步与团队 Vault、RBAC、实时协作和 Agent/MCP 分开建模，分别进入后续里程碑。

> 实现边界（2026-09-17）：当前代码已经交付 Web 端可选的账号会话、设备列表/撤销、opaque encrypted snapshot、revision 冲突、pending/retry、登出、云端删除恢复窗口，以及 recovery key 的一次展示、离线确认、错误输入保护和包装轮换；`ACCOUNT_SYNC_ENABLED` 默认为关闭。该切片通过当前的 focused/full 技术验证，但不等同于完整 M5 安全发布：独立本地 Vault 的新设备恢复 UI、真实 re-auth、冲突“导出两份”和账号删除闭环仍需后续实现与评审。

## 2. 目标与非目标

### 2.1 目标

1. Local 模式不依赖账号、云服务、网络或第三方身份提供商。
2. 用户登录账号后，可以在另一台受信设备恢复同一个 Vault，而不上传主密码、私钥、passphrase 或明文配置。
3. Web、Windows/Linux 桌面和 Android 共享账号/同步语义，但平台可以使用不同的认证、密钥存储、文件和 SSH transport adapter。
4. 离线期间本地工作不被同步服务阻塞；网络恢复后可重试、可解释、幂等地同步。
5. 设备撤销、账号登出、主密码遗失、同步冲突、删除恢复和云端不可用都有明确结果。
6. 同步 UI 能让用户知道当前是 Local、已同步、待同步、冲突、需要解锁还是设备已撤销。

### 2.2 非目标

- 本设计不把登录变成单机使用前置条件。
- 本设计不实现团队共享、成员邀请、细粒度 RBAC、实时协作、SSO 管理面或自然语言 Agent。
- 本设计不把活动日志、终端原始输入输出、正在运行的 Shell、SFTP 临时文件或批量任务状态作为跨设备同步对象。
- 本设计不允许同步服务读取、搜索、修改或合并 Vault 明文。
- 本设计不在没有密钥恢复、设备撤销和冲突回滚验证前上线自动同步。

## 3. 产品模式与用户流程

### 3.1 Local 模式

Local 模式是现有默认模式：

1. 用户访问 Relay，初始化或解锁本地 Vault。
2. Host、Identity、Group、Snippet、Workspace 和加密凭据保留在本地 Relay 数据卷或本地客户端安全存储中。
3. 不创建账号会话，不调用同步 API，不向云端发送 Vault、Host、设备或活动数据。
4. 用户可以继续使用终端、SFTP、批量命令、导入导出和本地备份。

Local 模式的 UI 必须明确显示“仅本地，不同步”，不能用灰色或异常样式暗示功能损坏。

### 3.2 登录并开启同步

登录是同步的开启动作，但账号认证不能替代 Vault 解锁：

1. 用户登录账号；Account service 返回短期会话，token 不进入 localStorage、Workspace 或普通日志。
2. 当前设备创建或恢复 `deviceId`；原生端的设备私钥进入 OS keychain/Android Keystore，Web 端沿用 HttpOnly、Secure、SameSite 会话边界，不在浏览器持久化 Vault secret。
3. 如果当前 Vault 已解锁，系统展示一次同步范围、设备列表和加密说明，然后自动进入同步。
4. 如果 Vault 未初始化或仍锁定，账号可以登录，但 Sync 状态为 `needs-unlock`；解锁后才读取或上传 Vault 内容。
5. 首次绑定已有本地 Vault 时，系统先创建本地加密备份，再比较远端 revision；若本地和远端都已有数据，必须进入预览/冲突流程，不能静默覆盖。
6. 新设备没有本地 Vault 时，下载加密的 Vault key envelope 和同步快照；用户输入 Vault 主密码或离线恢复密钥后，在本地创建 Vault 并事务性应用。

默认同步的不是“登录后把所有运行状态上传”，而是“登录并解锁后自动同步允许的持久化数据”。首次登录仍需一次明确范围确认，之后沿用该选择。

### 3.3 状态模型

账号和同步状态分开表达：

| 账号状态 | 同步状态 | 用户看到的含义 |
| --- | --- | --- |
| `signed-out` | `local-only` | 当前只使用本地数据，不同步。 |
| `signed-in` | `needs-unlock` | 账号已登录，解锁 Vault 后才同步。 |
| `signed-in` | `syncing` | 正在拉取或上传加密数据。 |
| `signed-in` | `synced` | 本地 revision 与云端一致。 |
| `signed-in` | `pending` | 本地有加密变更等待上传，SSH/本地任务不受阻塞。 |
| `signed-in` | `offline` | 同步服务不可用，本地仍可使用。 |
| `signed-in` | `conflict` | 本地和远端有不可自动合并的变更，需要用户处理。 |
| `revoked` | `device-revoked` | 设备不能继续同步；本地数据是否保留由用户决定。 |

所有状态都必须有文字说明、时间和下一步动作；颜色、云朵图标或动画只能作为辅助。

### 3.4 登出、撤销与删除

- 登出立即撤销当前账号会话、停止新的同步请求并清除内存中的账号 token；本地 Vault 和本地配置默认保留，页面回到 Local 模式。
- “退出账号并删除本地数据”是独立的高风险操作，必须二次确认，不与普通登出合并。
- 设备撤销后拒绝新的拉取/上传；已经存在的本地 Vault 不自动删除，用户仍可选择继续 Local 使用或手动清除。
- 删除账号先撤销所有设备，并删除云端加密载荷及账号元数据；本地副本不因远端删除而隐式删除。M5 默认提供 30 天云端可恢复窗口，窗口结束后永久清理；倒计时和不可逆时间必须在 UI 中明确展示。

## 4. 信任边界与总体架构

### 4.1 四个逻辑平面

```text
platform UI / client adapter
          |
          v
shared application/core  <---- optional AccountSessionPort / SyncPort
          |
          +---- local Vault + SSH/SFTP/command execution boundary
          |
          +---- Account service  <---- account identity, session, device status
          |
          +---- Blind sync store <---- encrypted envelope, revision, quota, cursor
```

四个平面职责如下：

| 平面 | 保存/处理 | 明确不拥有 |
| --- | --- | --- |
| Local Vault / execution | Vault key、解锁后的凭据、Host/Identity 业务数据、SSH/SFTP/命令运行时 | 账号密码、云端 session token 的普通副本 |
| Account service | account id、认证方式元数据、设备状态、会话和撤销记录 | Vault key、Vault 明文、命令内容、终端内容 |
| Blind sync store | 加密 envelope、opaque vault id、revision、hash、size、时间、设备 id、幂等键 | 主密码、同步 key 明文、Host 地址/用户名/私钥明文 |
| Platform adapter | HttpOnly session、OS keychain/Keystore、网络、通知和文件能力 | 复制 shared core 的业务/安全规则 |

当前 Web 运行模式中，Relay server 为了连接目标 SSH，仍然是受信执行端。账号服务和 Blind sync store 必须在权限、数据表和日志域上与执行端分离；同步存储服务不能调用 Vault 解密或 SSH 凭据接口。

部署上，Local-only 模式不需要 Account service 或 Blind sync store；Sync 模式可以连接 Relay 提供的账号/同步服务，也可以连接实现同一协议的自托管服务。M5 必须选择一个可运行的具体 provider adapter，但 provider-specific 的认证字段不能进入 shared core 或加密 envelope。

### 4.2 CoreRuntime 的扩展方式

`CoreRuntime` 仍然支持完全离线的 Local 模式，账号和同步不是所有客户端必须实现的端口。跨端扩展使用可选 capability 和组合端口：

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

export type RecoveryKeyStatus = 'not-configured' | 'pending-confirmation' | 'configured';

export interface RecoveryKeyState {
  status: RecoveryKeyStatus;
  activeKeyVersion: number | null;
  pendingKeyVersion: number | null;
}

export interface AccountSession {
  accountId: string;
  deviceId: string;
  state: Exclude<AccountState, 'signed-out' | 'authenticating'>;
  expiresAt: string;
}

export interface DeviceDescriptor {
  id: string;
  label: string;
  platform: 'web' | 'desktop' | 'android';
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
  kdf: {
    algorithm: string;
    salt: string;
    memoryCost: number;
    timeCost: number;
    parallelism: number;
    hashLength: number;
  };
  wrappedVaultKey: WrappedKeyEnvelope;
  recoveryKeyVersion?: number;
  recoveryWrappedVaultKey?: WrappedKeyEnvelope;
  pendingRecoveryKeyVersion?: number;
  pendingRecoveryWrappedVaultKey?: WrappedKeyEnvelope;
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

export interface AccountSessionPort {
  status(): Promise<AccountSession | null>;
  signOut(): Promise<void>;
}

export interface DeviceTrustPort {
  listDevices(): Promise<readonly DeviceDescriptor[]>;
  revokeDevice(deviceId: string): Promise<void>;
}

export type RecoveryKeyReveal = (recoveryKey: string, keyVersion: number) => void;

export interface SyncPort {
  status(): Promise<{ sync: SyncStatus; head: SyncHead | null; recovery?: RecoveryKeyState }>;
  descriptor(): Promise<SyncDescriptor | null>;
  pull(): Promise<SyncEnvelope | null>;
  push(envelope: SyncEnvelope, idempotencyKey: string): Promise<SyncHead>;
  resolveConflict(conflictId: string, resolution: 'keep-local' | 'use-remote' | 'export-both'): Promise<void>;
  issueRecoveryKey(reveal: RecoveryKeyReveal): Promise<RecoveryKeyState>;
  confirmRecoveryKey(recoveryKey: string): Promise<RecoveryKeyState>;
}
```

以上 DTO 不包含 session token、主密码、私钥、passphrase、recovery key、解锁后的凭据或终端内容。`SyncPort` 是可选扩展；recovery key 只通过一次性 reveal callback 交给当前 UI，不进入 shared state/DTO。未协商 `account.auth`/`sync.encrypted` capability 时，UI 隐藏同步操作并保持 Local 模式。

## 5. 加密与密钥管理

### 5.1 密钥层级

复用现有 Vault 的随机 `K_vault`，不使用账号密码直接加密 SSH 凭据：

```text
Vault master password
        |
        | Argon2id + per-vault salt
        v
K_vault_encryption_key -- unwrap --> K_vault
                                      |
                                      +-- AEAD wrap --> K_sync
                                      |
                                      +-- local Vault field encryption

K_sync -- AEAD --> encrypted sync snapshot/change set
```

- `K_vault` 继续由现有 `VaultConfig.wrappedVaultKey` 保护；主密码不上传账号服务。
- 首次开启同步时生成随机 `K_sync`，使用 `K_vault` 以版本化 AAD 包装；云端只得到 `wrappedSyncKey`，得不到 `K_sync`。
- 同步载荷使用 `K_sync` 的 AEAD 加密；AAD 至少绑定 `vaultId`、`schemaVersion`、`revision`、`keyVersion` 和 `deviceId`。
- `payloadHash` 使用 SHA-256 对密文做完整性/去重辅助校验；真正的篡改检测由 AEAD auth tag 和 revision/parentRevision 校验完成。
- 所有加密结构带 `version`，算法升级必须新增版本并保留迁移/回滚策略；禁止在 UI 或业务代码里临时拼接加密格式。
- Account session token、device auth private key 和恢复密钥分别由 HttpOnly cookie、OS keychain/Keystore 或明确的受控 Web session 保存，不与 `K_sync` 混用。

### 5.2 新设备解锁与恢复

- 新设备下载的只是 `VaultConfig`/key envelope 和加密同步载荷；用户必须输入原 Vault 主密码，或使用本地生成并离线保存的 recovery key，才能得到 `K_vault`/`K_sync`。
- 账号登录成功但无法解锁 Vault 时，只能显示设备和同步元数据，不能恢复 Host 凭据或打开 SSH。
- 账号密码重置只恢复账号访问，不恢复 Vault；产品文案必须在注册、开启同步和重置密码时反复明确这一点。
- 开启同步后可生成一次展示、可轮换的 recovery key，并用它包装 Vault key；页面要求用户勾选离线保存并重新输入完全匹配后才允许完成 recovery 绑定，服务端只保存包装后的密文，不保存可解密的 recovery key。重新生成会让旧的待确认 key 失效；关闭/刷新页面不会再次显示已生成的明文。
- 丢失主密码和 recovery key 时，云端数据不可恢复；这是可验证的安全承诺，不能通过客服或管理员后门绕过。

### 5.3 密钥轮换

- 用户主动更换 Vault 主密码时，重新包装 `K_vault`，不需要重新加密每条业务数据；同步 envelope 的 `keyVersion` 递增并在后台重新加密。
- recovery key 轮换只替换 recovery wrapping，不改变 `K_sync`。
- 设备撤销不改变 Vault key；它只撤销设备 session/写入权限，避免误把撤销当成数据删除。
- 发生疑似密钥泄露时，必须支持生成新 `K_sync`、重新包装全部 sync payload、撤销旧设备并保留本地可回滚备份。

## 6. 同步对象、协议与一致性

### 6.1 同步范围

| 对象 | 默认同步 | 处理方式 |
| --- | --- | --- |
| Host、Group、Tag、Identity metadata | 是 | 进入加密快照/变更集；地址、用户名和备注也不以明文上传。 |
| Host 密码、私钥、passphrase、Snippet command | 是 | 作为 Vault 加密载荷的一部分；云端不能读取。 |
| Workspace 模板、布局、筛选和非敏感偏好 | 是 | 可同步意图，不同步 live terminal/session id。 |
| Host Key fingerprint/trust record | 是，但有额外确认 | 加密同步；新设备首次应用时仍需明确确认，指纹变化继续硬失败。 |
| 活动摘要 | 默认否 | 保留本地；未来若同步只能同步脱敏 metadata，并单独取得同意。 |
| 终端输入输出、命令结果正文、SFTP 文件内容 | 否 | 不进入同步 API、同步快照或普通日志。 |
| live Shell、terminalId、sessionId、TransferJob、CommandRun | 否 | 各设备独立创建；不伪造跨设备恢复。 |
| 浏览器 token、cookie、设备私钥、主密码、recovery key | 否 | 只在对应安全存储/内存中使用。 |

### 6.2 Envelope 与 API 边界

Blind sync store 只实现版本、大小、哈希、幂等、游标和权限，不解析 `ciphertext`：

- `GET /api/sync/v1/head`：返回 opaque vault 的 revision、keyVersion、hash、更新时间和同步状态。
- `GET /api/sync/v1/envelope`：按 account/device 权限返回 `SyncDescriptor` 和当前加密 envelope；其中 Vault/Sync key 都是包装后的密文，不返回解密 key。
- `PUT /api/sync/v1/envelope`：要求 `parentRevision` 和幂等键；revision 不匹配返回 `SYNC_CONFLICT`，不能覆盖远端。
- `POST /api/sync/v1/devices`、`DELETE /api/sync/v1/devices/:id`：设备注册、标记和撤销；撤销后所有读写请求拒绝。
- `DELETE /api/sync/v1/vault`：进入默认 30 天可恢复删除窗口；需要重新认证和二次确认，不删除本地副本，窗口结束后才永久清理。

同步 API 不接受 master password、Vault plaintext、Host address、private key、terminal output 或未加密 JSON 字段。服务器日志只记录 request id、account/device opaque id、revision、大小、结果码和耗时。

### 6.3 可靠同步流程

1. 本地事务提交成功后，生成包含 `parentRevision` 的加密 envelope；SSH/SFTP/批量任务不等待云端响应。
2. 本地以加密形式持久化待上传 envelope 和幂等键；页面显示 `pending`。
3. 上传成功后记录远端 revision；重复请求返回同一结果，不产生重复对象。
4. 网络断开或服务端 5xx 时指数退避；认证失效转为重新登录，不反复重试永久错误。
5. 下载 envelope 后先校验大小、hash、AAD、auth tag、vault id、key version 和 schema，再解密到隔离临时区。
6. 应用变更使用现有 Vault transaction/preview 语义；失败时保留现有本地 Vault，不产生半应用状态。
7. 同步成功后清理旧的加密临时 envelope；清理失败必须可诊断，但不能删除唯一可恢复副本。

### 6.4 冲突策略

第一版采用安全优先的 revision 冲突，不做服务器端明文合并：

- 本地和远端修改同一 revision 后，服务端拒绝后写入并返回 `SYNC_CONFLICT`。
- 客户端在本地解密两份快照，按 Host/Group/Identity/Snippet/Workspace 对象展示冲突。
- Workspace layout、最近筛选等低风险偏好可以选择本地优先；Host、Identity、Host Key trust 和 Snippet command 默认要求用户明确选择。
- “使用远端”先把本地版本写入加密备份；“保留本地”先下载远端为冲突副本；“导出两份”生成加密 bundle，不把明文写入日志。
- 禁止以最后写入时间静默覆盖凭据、Host Key、ProxyJump 或批量命令。
- 后续可以增加加密变更集和对象级合并，但必须保持同样的 tombstone、幂等、回滚和安全字段人工确认。

## 7. 跨端与 UI/交互要求

### 7.1 平台能力

| 能力 | Web | Desktop | Android |
| --- | --- | --- | --- |
| 账号登录 | HttpOnly Secure session、浏览器安全上下文 | 系统浏览器/深链或内嵌安全流程 | 系统浏览器/安全返回 |
| 设备凭据 | 不保存 token/主密码；设备注册遵循受控 session | OS keychain | Android Keystore |
| Vault 解锁 | 由当前 Relay server 执行 | 本地或 server-mediated，按 transport 选择 | 本地或 server-mediated，按 transport 选择 |
| 同步网络 | Fetch/HTTP adapter | 原生 HTTP adapter | 原生 HTTP adapter |
| 离线队列 | 加密 session/local server storage，不进普通浏览器存储 | 加密本地存储 | 加密应用存储/Keystore wrapping |
| 通知 | 浏览器通知需用户授权 | 系统通知 | 系统通知 |

平台差异只存在于 adapter 和 UI shell；账号状态、同步状态、冲突语义、Host Key 确认和本地/同步数据边界由 shared contract 固定。

### 7.2 现代简洁交互

- 全局账户入口显示头像/缩写、`Local only`/`Synced`/`Pending`/`Conflict` 和最后同步时间。
- 设备管理采用简洁列表：当前设备置顶，展示平台、最近活动、撤销动作和风险提示；不把设备私钥或 token 暴露到 UI。
- 首次登录采用三步以内的进度：登录账号 → 确认同步范围/恢复方式 → 同步结果。
- Quick Switcher 可以搜索“本地/同步状态、设备和冲突”，但不把账号管理塞进主机搜索结果的业务对象中。
- 断网时保留终端、SFTP 和批量本地工作；同步中心显示待上传数量、最后错误和重试动作。
- 冲突页面先显示对象类型、两侧更新时间和安全字段提示，再提供保留本地、使用远端、导出两份；不使用模糊的“覆盖全部”。
- 登出后回到 Local 模式并保留本地工作区；高风险的本地数据删除单独放在安全设置中。

## 8. 安全威胁与错误处理

| 威胁/故障 | 必须结果 |
| --- | --- |
| 云端数据库泄露 | 只有加密 envelope 和最小元数据；没有 Vault 明文或可用 key。 |
| 账号 session 被盗 | 可读取/操作的范围受设备和 Vault 解锁状态限制；用户可撤销设备；不能据此解密未解锁 Vault。 |
| 主密码或 recovery key 遗失 | 明确不可恢复；账号重置不得绕过 Vault。 |
| 恶意或过期 device | 同步 API 拒绝读写；本地数据不隐式删除。 |
| 网络断开/服务 5xx | Local 工作继续；同步进入 offline/pending，按策略重试。 |
| revision 竞争 | 返回 `SYNC_CONFLICT`，保留两边加密副本，禁止静默覆盖。 |
| ciphertext/AAD/hash 篡改 | 返回 `SYNC_PAYLOAD_INVALID`，不应用数据，不删除现有 Vault。 |
| keyVersion 不支持 | 返回 `SYNC_KEY_VERSION_UNSUPPORTED`，保留本地状态并要求升级/迁移。 |
| 账号过期/撤销 | 立即停止云同步，提示重新登录；不影响 Local 使用。 |
| 同步服务返回半包/超额载荷 | 先校验长度和配额，拒绝落盘或应用，记录脱敏错误。 |

新增错误码必须进入 `src/shared/errors.ts` 和跨端 contract tests；UI 映射必须包含原因、下一步和是否可重试。

## 9. 分阶段交付边界

### M4：架构与安全 spec

- 固定 account/sync optional ports、capability、数据分类、密钥层级、同步 envelope、冲突和恢复语义。
- 完成云端盲存储威胁模型、设备撤销、账号删除、隐私/留存和数据导出边界。
- 不加入登录按钮作为当前 Local 版本的必需入口，不改现有单 Vault 运行路径。

### M5：个人账号与加密同步

- 先做账号会话、设备注册/撤销、同步状态和 encrypted snapshot 的最小闭环。
- 再做新设备恢复、离线队列、revision 冲突、加密备份和登出/删除语义。
- 通过 Web、desktop-like 和 Android-like adapter contract 后，才把登录同步作为可选正式能力。

当前实现只达到 M5 的核心 Web/自托管切片：账号、设备、opaque snapshot、revision conflict、offline pending/retry、登出、云端删除恢复窗口和 recovery key 生命周期已落地；同步默认关闭，且当前 Relay server 仍是 Web-mediated SSH 的受信解密边界。独立新设备恢复交互、真实删除 re-auth、冲突“导出两份”、Desktop/Android 原生实现和安全评审仍是 M5 退出条件，不应由当前代码或测试结果推断为已完成。

### M6：团队与受控 Agent

- 团队 Vault 不复用个人同步的“同一主密码/同一拥有者”假设。
- 另行设计成员 key wrapping、RBAC、离线副本、审批、审计、撤销、Agent scope 和恢复。
- 在独立 spec 和实现计划通过前，保持当前产品无团队/同步协作入口。

## 10. 验收与验证

### 必测路径

1. 未登录启动：无账号/同步请求，Local 模式全部可用。
2. 登录但未解锁：账号成功，Sync 为 `needs-unlock`，不能访问 Vault 数据或 SSH。
3. 登录并解锁：加密 envelope 上传，云端 fixture 不出现主密码、Host 地址、用户名、私钥、Snippet command 或终端内容。
4. 新设备恢复：下载密文，输入正确主密码后恢复；错误密码不改变本地 Vault。
5. 断网：本地新增 Host/Workspace 仍可用，恢复网络后只上传一次并最终一致。
6. 并发修改：服务端返回 `SYNC_CONFLICT`，两边保留，用户确认后才应用。
7. 登出/撤销：停止云同步、清理 session、保留本地数据；撤销设备无法继续同步。
8. Host Key：同步的 trust record 在新设备首次应用仍需要明确确认，已知 fingerprint 变化仍硬失败。
9. 跨端 contract：Web、desktop-like、Android-like runtime 对 account/sync 状态、错误码、加密 envelope 和 Local fallback 通过同一套断言。

### 发布门槛

- Shared/core contract、加密单元测试、同步服务 integration、数据迁移和安全扫描全部通过。
- 至少一个真实 OpenSSH 任务路径证明账号/同步故障不会改变 SSH Host Key、SFTP 路径、批量确认和任务终态安全规则。
- Web、桌面和 Android 的 secret store、生命周期、离线和网络切换走查完成。
- `secret_persistence_findings = 0`、冲突覆盖测试无静默覆盖、错误恢复无半应用 Vault、设备撤销测试通过。
- 涉及核心数据模型、加密、迁移、账号权限或跨模块行为时，按 Q-01 Release gate 执行全量验证；纯 UI 文案或文档变化使用 Artifact/Focused 验证。

本次实现验证记录（2026-09-17）：X-04A focused Vitest 8 files / 65 tests、`npm run typecheck`、`npm run lint`、full Vitest 105 files / 473 tests、`npm run build`、默认 E2E 4/4，以及 account-enabled `tests/e2e/account-sync.spec.ts` 2/2 均通过；敏感数据扫描未发现 recovery key 进入浏览器持久化、审计 metadata 或普通日志。技术门禁通过不代表上述未交付的 new-device/re-auth/export-both 功能已经具备发布资格。

## 11. 明确结论

- Relay 同时支持 Local-only 和 Account-sync 两种模式；账号是同步能力的开关，不是产品可用性的门槛。
- “登录账号即可同步”在产品上成立，但必须以 Vault 已解锁或可用恢复密钥为前提；账号本身不能解锁 Vault。
- 云端同步采用加密盲存储；当前 Web 的 Relay 执行端继续属于受信解密边界，不能包装成零知识服务。
- 个人同步先采用加密 snapshot + revision conflict；团队共享、对象级合并和 Agent 权限另行设计。
- 当前版本实现了默认关闭的 Web Account-sync 核心切片和 recovery key 生命周期；桌面/Android 原生 UI、独立新设备恢复、团队能力和完整 M5 安全发布仍未交付。
