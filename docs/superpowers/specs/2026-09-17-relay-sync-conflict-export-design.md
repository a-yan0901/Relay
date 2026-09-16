# Relay 同步冲突加密导出设计

日期：2026-09-17
状态：Proposed
适用范围：个人账号同步的 local/remote 冲突导出；不包含团队共享、账号删除和自动合并。

## 1. 目标与决策

X-04C 为现有 SyncResolution = 'export-both' 补齐真正可恢复的加密导出能力：

- 用户在已解锁的 Sync Center 中选择“导出本地与远端”。
- Relay 在当前 Web 的受信执行端内短暂解密冲突两侧的同步 snapshot。
- 使用用户本次输入的导出密码，为 local 和 remote 各生成一份独立的加密 copy。
- 两份 copy 放入一个单次 HTTP 响应的下载包，保证两侧来自同一次冲突读取；未来可从包中分别恢复。
- 导出不改变冲突、不推进 revision、不写入 pending state，也不创建服务端临时文件。

当前 Web 是 server-mediated 架构，因此导出密码会通过受保护请求到达 Relay 执行端；它不会写入账号服务、盲同步存储、数据库、浏览器持久化、审计 metadata、普通日志或响应中的明文 snapshot。Desktop/Android 的 local-SSH adapter 后续可以在本地安全存储内实现同一文件格式。

## 2. 非目标

- 不在本任务中自动选择 local/remote、覆盖本地数据或解决冲突。
- 不把导出密码变成账号密码、Vault 主密码或 recovery key。
- 不导出 live Shell、terminal/session id、TransferJob、CommandRun、终端输出、SFTP 文件、默认 Activity 输出或账号 token。
- 不把明文 snapshot 放入 shared core state、URL、localStorage、sessionStorage、导出文件名或审计事件。
- 不引入异步导出 job、对象存储或服务端持久化 staging。

## 3. 加密文件格式

下载包是 UTF-8 JSON，格式标识为 relay-sync-conflict，版本为 1。包的顶层只包含固定字段：

    export interface SyncConflictExport {
      format: 'relay-sync-conflict';
      version: 1;
      conflictId: string;
      createdAt: string;
      copies: readonly [SyncConflictExportCopy, SyncConflictExportCopy];
    }

    export interface SyncConflictExportCopy {
      copy: 'local' | 'remote';
      revision: number;
      payloadHash: string;
      kdf: {
        algorithm: 'argon2id';
        memoryCost: number;
        timeCost: number;
        parallelism: number;
        hashLength: number;
        salt: string;
      };
      wrappedBundleKey: WrappedKeyEnvelope;
      payload: WrappedKeyEnvelope;
    }

copies 必须恰好包含一次 local 和一次 remote。每一侧都使用独立的随机 32-byte bundle key、16-byte salt、AES-256-GCM nonce 和 auth tag；导出密码通过现有 Argon2id 参数派生 wrapping key：

其中 `WrappedKeyEnvelope` 使用现有 shared core 的字符串字段契约（`version`、`nonce`、`ciphertext`、`authTag`、`aad`）；服务端现有的 `EncryptedJson` 是同一 wire shape 的内部别名，不能泄漏到 shared core。

    export password
          |
          +-- Argon2id + copy-specific random salt
          v
    copy wrapping key --AES-256-GCM--> copy bundle key
    copy bundle key   --AES-256-GCM--> canonical SyncSnapshot JSON

两侧的 AAD 分别为 relay-sync-conflict:v1:<conflictId>:local 和 relay-sync-conflict:v1:<conflictId>:remote。明文 payload 是通过现有 SyncSnapshotService.validate 验证过的完整 SyncSnapshot，包含 Host、Identity、Group、Snippet 和 Workspace；不包含同步 envelope、账号字段、导出密码或运行时状态。

包头的 conflictId、copy 类型、revision、payload hash、KDF 参数和密文 envelope 不是 Vault 明文。包头不包含 Host 名称、地址、用户名、私钥、密码、Snippet command 或 Workspace 内容。解析器必须严格校验 exact keys、copy 唯一性、长度/数量上限、KDF 固定参数、base64 envelope、hash 和 ISO 时间。

单侧解密 payload 上限沿用 SYNC_MAX_PAYLOAD_BYTES = 32 MiB；整个 JSON 下载包的序列化上限为 96 MiB。超限在生成前拒绝，不生成部分结果。

## 4. 服务端 API 与生命周期

新增接口：

    POST /api/sync/v1/conflicts/:conflictId/export
    Content-Type: application/json
    Cookie: relay_account_session=...; webssh_session=...

    {
      "exportPassword": "..."
    }

请求 body 使用严格 schema：

    interface SyncConflictExportRequest {
      exportPassword: string; // 8–4096 Unicode code units
    }

请求必须同时满足：

1. ACCOUNT_SYNC_ENABLED=true 且 capability 已启用。
2. 当前账号 session 有效，conflictId 属于当前账号。
3. 当前 Vault session 有效且已解锁。
4. 冲突仍未解决，并且 local/remote envelope 都能按当前 descriptor 解密。
5. 两侧 snapshot 均通过完整 schema validation。

服务端流程固定为：

    require account + unlocked Vault session
            |
            v
    load unresolved local/remote encrypted envelopes
            |
            v
    unwrap K_sync -> decrypt both -> validate snapshots
            |
            v
    re-encrypt local + remote independently with export password
            |
            v
    zero plaintext / sync key / export keys / bundle keys
            |
            v
    send encrypted JSON package with Cache-Control: no-store

成功响应使用 application/json 和 Cache-Control: no-store。服务端不保存导出密码、明文、导出包或下载 token；导出异常时冲突数据库行和本地 Vault 均不变。审计事件（如保留）只记录 conflictId、local/remote revision、request id 和结果，不记录密码、payload、Host 标识或密钥。

如果冲突已不存在、已解决、输入密码不符合限制或 snapshot 校验失败，返回稳定错误码；不返回局部 copy。若服务端在读取期间检测到冲突 envelope 与记录不一致，返回 SYNC_CONFLICT，用户必须重新打开冲突预览。

## 5. Shared core 与平台边界

SyncPort 增加：

    export interface SyncPort {
      // existing methods remain unchanged
      exportConflict(conflictId: string, exportPassword: string): Promise<SyncConflictExport>;
    }

SyncConflictExport、SyncConflictExportCopy 和文件格式校验属于 shared contract；它们只使用字符串、数字、只读数组和 `WrappedKeyEnvelope`，不引入 Blob、File、URL、DOM 或 Node stream。

Web API/adapter 负责：

- 将严格的 export request 发往服务端并解析严格 response。
- 把下载包转换成 UTF-8 bytes。
- 通过 Web 文件能力触发一次下载，默认文件名为 relay-sync-conflict-<conflictId>.json；文件名只使用受限 ID，不使用 Host 名称。
- 不把 export password 或解密后的内容写入 shared state、URL、浏览器存储或普通错误消息。

Desktop/Android adapter 复用同一 SyncPort 和文件格式，分别使用平台安全的 save-as 能力；shared core 不感知文件系统。

## 6. UI/交互

Sync Center 的冲突区域增加“导出加密副本”入口：

1. 显示 local revision、remote revision、冲突类型和“不会改变当前数据”的说明。
2. 弹出导出密码与确认密码；两次输入必须一致且至少 8 个字符。
3. 明确提示：导出密码不是账号密码；当前 Web 会通过受保护请求交给 Relay 执行端；文件丢失或密码遗失无法恢复。
4. 提交期间按钮进入 busy 状态，禁止重复请求。
5. 成功后触发一次文件保存，清空两个密码输入和临时 package 引用，并保留原冲突状态。
6. 取消、卸载、异常和成功后都清空输入；导出失败只显示原因和可重试动作。
7. 若返回 SYNC_CONFLICT 或 SYNC_NOT_FOUND，关闭旧预览并要求重新加载冲突；不自动覆盖或自动 resolve。

UI 不显示 local/remote snapshot 明文，也不在页面文本、文件名或通知中展示 Host 地址、用户名、凭据和命令。

## 7. 错误与不变量

| 场景 | 结果 | 本地/冲突状态 |
| --- | --- | --- |
| 未登录账号 | ACCOUNT_SESSION_INVALID | 不变 |
| Vault 未解锁 | SESSION_INVALID 或现有锁定错误 | 不变 |
| 冲突不存在/已解决 | SYNC_NOT_FOUND | 不变 |
| 导出密码为空、过短、过长或额外字段 | SYNC_PAYLOAD_INVALID | 不变 |
| local/remote 解密或 schema 校验失败 | SYNC_PAYLOAD_INVALID | 不变 |
| 冲突 envelope 竞争变化 | SYNC_CONFLICT | 不变 |
| 服务器/加密失败 | 稳定 provider/internal 错误 | 不变 |
| 成功 | 返回完整双 copy 加密包 | 冲突仍未解决 |

导出成功不能被误认为“已应用远端”；只有现有 keep-local/use-remote 流程才改变冲突状态。

## 8. 测试与发布门槛

必须新增或扩展以下验证：

- shared contract：包头 exact keys、local/remote 恰好各一份、固定 KDF、长度/数量上限和无明文字段。
- server integration：未登录、未解锁、未知冲突、严格 request、成功双 copy 解密回读、错误输入、坏 snapshot、冲突竞争和导出后冲突仍存在。
- crypto unit：每份 copy 独立 salt/AAD/key；正确密码可分别解密；错误密码、交换 copy、篡改 payload/header 都失败。
- Web API/adapter：请求只发送显式 export password；response 严格解析；缺少可选能力返回 CAPABILITY_UNAVAILABLE；保存动作不进入 shared core。
- Sync Center DOM：确认密码、busy/错误/重试、成功清空输入、取消不改变冲突。
- account-enabled E2E：真实冲突产生后下载加密包，断言 raw response/数据库/审计/日志没有 snapshot 明文或导出密码；导出后仍可再次选择 keep-local/use-remote。
- default Local-only E2E：未协商账号/同步能力时不出现导出同步入口、不产生账号请求。

由于涉及加密、核心 Sync port、账号权限和跨模块响应，完成 focused 验证后执行 npm test、npm run typecheck、npm run lint、npm run build、默认 E2E、account-enabled E2E 和敏感数据扫描。只有全部通过后才将路线图 X-04C 标记完成；X-04D 保持未完成。

## 9. 明确结论

X-04C 采用“单次下载包 + 两份独立加密 copy”的格式，兼顾一次性一致性、未来分别恢复和当前 Web server-mediated 架构。导出是只读安全操作，不改变冲突；任何真正的 merge、apply、账号删除或 re-auth 都不属于本设计。
