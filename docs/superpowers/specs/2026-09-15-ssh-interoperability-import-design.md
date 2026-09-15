# SSH 跨产品迁移与标准交换设计

**状态：** Approved for implementation

**日期：** 2026-09-15

## 1. 目标

把现有的 Vault 导入/导出从“本产品加密备份”扩展为“跨产品迁移入口”，优先支持将 OpenSSH、MobaXterm、Termius、Xshell 和 SecureCRT 的 SSH 连接配置导入当前产品，同时提供 OpenSSH config 和通用 CSV 标准导出。

现有 `webssh-vault` 加密 bundle 继续保留，定位为本产品的完整备份格式；它不承担第三方互操作职责。

## 2. 背景与事实边界

不同 SSH 客户端没有一个能够同时表达主机、目录、跳板链、密码和私钥的统一格式：

- OpenSSH `config` 是最通用的连接配置格式，可以表达 `Host`、`HostName`、`Port`、`User`、`IdentityFile` 和 `ProxyJump`，但不承载密码。
- Termius 支持导入 `.ssh`、CSV、PuTTY、MobaXterm 和 SecureCRT；其 SSH config 导入对跳板机可转为 Host Chain，但 `ProxyCommand` 和部分平台上的密钥引用存在限制。
- MobaXterm 的会话主要保存在 `MobaXterm.ini` 或导出的 `.mxtsessions` 中；新版本还支持从通用 CSV 导入。
- Xshell 使用 `.xsh` 会话文件和会话导出包，密码可能受 Xshell Master Password 保护。
- SecureCRT 使用 XML 设置导出和 `Sessions` 目录下的 `.ini` 文件；是否包含敏感数据取决于其配置导出选项。

因此，兼容策略是“标准格式优先、厂商格式适配、凭据状态显式化”，不尝试绕过第三方的主密码或操作系统密钥链。

## 3. 范围

### 3.1 首期导入

首期提供以下输入：

1. OpenSSH：`config`、`ssh_config`，以及包含这些文件的多文件选择或压缩包；可选读取同批次上传的私钥文件和 `known_hosts`。
2. CSV：通用 SSH CSV，以及 Termius 常见字段别名；字段解析不依赖列顺序，列名大小写和空白可归一化。
3. MobaXterm：`.mxtsessions`、`MobaXterm.ini`；对 `.mobaconf` 先识别加密/封装状态，能解析的内容正常导入，不能解析时给出明确警告。
4. Xshell：单个 `.xsh` 会话文件和可识别的会话导出包。
5. SecureCRT：XML 设置导出和单个/多个 session `.ini` 文件。

首期只导入 SSH/SFTP 连接。Telnet、RDP、VNC、Serial、X11、端口转发、宏和终端外观设置进入原始字段/警告，不转化为可连接主机。

### 3.2 首期标准导出

1. OpenSSH config：导出主机别名、地址、端口、用户、密钥路径和 `ProxyJump`；不导出密码。
2. 通用 CSV：导出名称、地址、端口、用户、认证类型、密钥路径、分组、标签和跳板机链；密码默认留空，并提供显式的“包含密码”开关和二次确认。

### 3.3 非目标

- 不把第三方私有格式伪装成统一标准。
- 不通过逆向或调用第三方进程绕过 Master Password、OS Keychain 或 Credential Manager。
- 不在浏览器 `localStorage`、`sessionStorage`、普通日志或审计 metadata 中保存导入文件、源密码、私钥或主机密码。
- 首期不生成可被每个厂商原生 GUI 直接导入的专用导出文件；专用导出作为后续适配器能力。

## 4. 统一交换模型

导入解析器输出不直接生成数据库 Host ID，而是输出带来源引用的中间文档。数据库 ID、分组 ID 和冲突策略由导入服务统一处理。

```ts
type ImportFormat =
  | 'openssh-config'
  | 'ssh-csv'
  | 'mobaxterm'
  | 'xshell'
  | 'securecrt';

type ImportedCredentialState =
  | 'ready'
  | 'needs-source-passphrase'
  | 'needs-user-input'
  | 'reference-only'
  | 'unsupported';

interface ImportedConnection {
  sourceId: string;
  name: string;
  address: string;
  port: number;
  username: string;
  authType: 'password' | 'private_key' | 'unknown';
  credentialState: ImportedCredentialState;
  credentialSource?: string;
  groupPath: string[];
  tags: string[];
  jumpHostSourceIds: string[];
  identityFile?: string;
  hostKeyAlgorithm?: string;
  hostKeyFingerprint?: string;
  notes: string[];
  sourceFields: Record<string, string>;
}

interface ImportDocument {
  format: 'ssh-connection-exchange';
  version: 1;
  source: { format: ImportFormat; filename: string };
  groups: Array<{ path: string[]; sourceId: string }>;
  connections: ImportedConnection[];
  warnings: string[];
}
```

解析器可以在服务端保留短生命周期的秘密材料，但统一模型返回给 Web 的预览只包含 `credentialState` 和脱敏来源信息，不返回密码、私钥或源密码。

## 5. 解析与导入流程

```text
文件选择/上传
  -> 格式识别（扩展名 + 内容特征）
  -> 厂商解析器
  -> 统一字段标准化
  -> 分组和跳板机引用解析
  -> 地址/端口/用户名去重
  -> 凭据状态与警告计算
  -> 预览
  -> 用户选择记录、补录凭据、处理冲突
  -> 单事务写入 Vault
```

### 5.1 格式识别

用户可以自动识别，也可以手动指定格式。自动识别优先使用内容特征，扩展名只作为提示：

- OpenSSH：出现 `Host`、`HostName`、`ProxyJump` 等指令。
- CSV：首行可解析为列名，包含地址/主机/端口等已知字段。
- MobaXterm：`[Bookmarks]`、`[Bookmarks_N]` 和会话编码结构。
- Xshell：`.xsh` 扩展名或 Xshell session key/value 结构。
- SecureCRT：XML 根节点/设置节点或 session `.ini` 键值结构。

无法可靠识别时，预览接口返回支持的格式和用户可选择的格式，不直接写库。

### 5.2 跳板机解析

- OpenSSH 的 `ProxyJump` 按逗号顺序解析为跳板链。
- MobaXterm、Xshell 和 SecureCRT 的跳板机字段先生成源引用，再在同一导入批次内按源 ID、完整路径、名称和地址依次匹配。
- 引用不存在时保留目标主机但标记警告；该记录不能直接应用为可连接主机，除非用户删除该跳板引用或补齐映射。
- 不把 `ProxyCommand` 猜测转换为跳板机；仅保留原始字段并标记“不支持的代理命令”。

### 5.3 凭据状态

- 已有明文密码、可读取的私钥内容或用户同时上传的私钥文件：状态为 `ready`，写入当前 Vault 时重新加密。
- 源文件需要密码/主密码才能读取：状态为 `needs-source-passphrase`，提示用户输入；源密码只用于当前预览，不落库。
- 只有私钥路径、密码被第三方加密或格式未支持：状态为 `needs-user-input` / `reference-only`，预览中可补录密码或上传私钥。
- `unsupported` 记录默认不应用，但保留在预览结果和导入报告中。

为避免引入“无凭据 Host”这一跨全系统的数据状态，首期应用规则是：用户可以只应用 `ready` 记录；`needs-user-input` 记录只有在预览中补齐凭据后才能应用。后续若需要大量导入后再补录，再增加持久化的 `credentialStatus`。

## 6. API 与平台边界

新增独立于现有 Vault bundle 的接口：

```text
POST /api/import/preview
POST /api/import/apply
GET  /api/import/formats
GET  /api/export/openssh
GET  /api/export/csv
```

导入预览使用 multipart 文件上传，服务端限制单批文件总大小、单文件大小、文件数量和解析记录数；文件只存在于内存和短 TTL 的预览上下文中。应用请求只携带预览 ID、选中的源记录、冲突策略和补录后的凭据引用，不携带旧文件内容。

跨端边界：

- `src/shared/import` 保存平台无关的字段模型、格式识别、纯文本解析、标准化和冲突匹配函数。
- 服务端 import service 负责上传、秘密材料、Vault 加密、数据库事务和审计。
- Web adapter 只负责文件选择、FormData、预览展示和下载 Blob。
- 未来桌面/Android 复用 API、统一模型和冲突规则；平台 adapter 只替换文件选择、系统密钥/文件权限和下载能力。

## 7. 安全要求

- 导入文件、源密码、补录密码和私钥不写入日志、审计 metadata、浏览器持久化存储或错误消息。
- 解析器拒绝路径穿越；压缩包只展开允许的文本/密钥文件，禁止写入服务器持久目录。
- 应用前再次校验地址、端口、用户名、分组、跳板图和凭据类型，不能只信任预览阶段的结果。
- 导入和导出记录审计事件，但只记录格式、记录数、成功/失败数和耗时。
- 标准 CSV 导出默认不含密码；含密码必须二次确认，并在下载后清理内存中的明文。

## 8. 验收标准

1. 上传 OpenSSH config 能导入 Host、HostName、Port、User、IdentityFile 和多级 ProxyJump。
2. 上传 Termius/通用 CSV 能按列名识别主机、端口、用户、分组、标签和认证字段，列顺序变化不影响导入。
3. 上传 MobaXterm `.mxtsessions` 能保留目录层级、SSH 主机、端口、用户、私钥引用和可识别的跳板字段。
4. 上传 Xshell `.xsh` 能导入主机、端口、用户和认证类型；受 Master Password 保护的密码被标记并要求补录。
5. 上传 SecureCRT XML/INI 能导入可识别的 session；配置中被省略的敏感字段不被伪造。
6. 预览会显示识别格式、导入数量、冲突、跳板解析结果、凭据状态和逐条警告。
7. 导入不会覆盖现有数据，除非用户在预览中明确选择替换；应用失败保持事务回滚。
8. OpenSSH config 和 CSV 导出能被再次解析，且不导出密码，除非用户主动确认。
9. shared import 模块在浏览器和 Node TypeScript 目标下编译，不依赖 React、DOM、Node 专属 API 或 ssh2。

## 9. 分阶段优先级

### P0

- 统一交换模型、格式识别、预览/应用协议。
- OpenSSH config 导入与导出。
- 通用 CSV/Termius 字段导入与 CSV 导出。
- 冲突、去重、跳板链和凭据状态。

### P1

- MobaXterm `.mxtsessions`/`.ini` 导入。
- Xshell `.xsh` 导入。
- SecureCRT XML/INI 导入。
- Web UI 集成和导入报告。

### P2

- `.mobaconf` 加密封装的完整解包。
- 厂商专用导出文件。
- 导入后持久化“待补录凭据”状态。
- known_hosts、端口转发和更多厂商字段的可选迁移。
