# 统一核心与跨端/跨平台基础

Relay 当前以 Web app 为核心客户端，服务端负责 SSH、SFTP、批量命令和 Vault 的执行边界。桌面版后续覆盖 Windows 和 Linux，Android 版复用同一套 shared core、错误码和 wire protocol，再替换 transport 与 secret store；本阶段不绑定 Tauri、Electron 或移动 UI 框架，也不提前实现原生 UI。

## Review 结论

当前代码已经有 `src/shared/core/models.ts`、`ports.ts`、状态机、错误码和 capability 的基础，但“统一核心”还没有形成完整的应用边界：

- `ports.ts` 目前主要覆盖 session、file、command 和 host 读取，Identity、Group、Workspace template、Snippet、Activity 仍可能由各端自行拼接。
- `src/web/App.tsx` 仍直接调用 `src/web/api.ts` 的一部分 CRUD、轮询和生命周期方法；未来客户端若照此复制，会把 Web API 细节带入业务流程。
- `WorkspaceWebAdapter` 的导入/导出接口暴露了浏览器 `File`/`Blob`，这适合 Web UI，但不能成为 shared core 的契约。

因此，跨端能力不再只作为未来说明，而是本轮实现的硬约束：先固定 platform-neutral runtime、ports、wire/capability 和 contract tests，再由 Web 作为第一个 adapter 实现。桌面和 Android 现在不做 UI，但未来可以替换 adapter 而不复制领域规则和用户任务流程。

## 核心边界与依赖方向

依赖方向固定为：

~~~text
platform UI  ->  shared application/core  <-  platform adapter
                                      ^
                                      |
                                server adapter
~~~

`src/shared` 允许领域模型、schema、错误码、状态机、连接路径解析、目标快照和用例组合；不得导入 Node、DOM、React、浏览器存储、WebSocket、HTTP、`ssh2`、桌面 keychain 或 Android API。React 组件只能依赖 shared 类型和 runtime/port，不直接把 HTTP 响应当作业务模型使用。

`src/web/api.ts`、浏览器 WebSocket、`File`、`Blob`、`FormData` 和下载行为属于 Web adapter/UI 边界；Fastify、SQLite、Vault、`ssh2` 和服务端文件流属于 server adapter。未来的桌面/Android adapter 可以使用本地 SSH 或继续调用服务端，但都必须实现同一组 shared ports。

## 共享契约

核心 runtime 至少包含以下端口；具体 DTO 放在 `src/shared/core/models.ts` 或 `src/shared/validation.ts`，秘密载荷不进入 metadata：

~~~ts
export interface SecretRef {
  kind: 'host' | 'identity';
  id: string;
}

export type VaultPhase = 'uninitialized' | 'locked' | 'unlocked';

export interface VaultStatus {
  phase: VaultPhase;
}

export interface ConnectionTestResult {
  ok: boolean;
  hostKey?: {
    algorithm: string;
    fingerprint: string;
    address: string;
    port: number;
  };
}

export interface SecretStore<Secret = unknown> {
  get(ref: SecretRef): Promise<Secret | null>;
  set(ref: SecretRef, secret: Secret): Promise<void>;
  remove(ref: SecretRef): Promise<void>;
}

export interface VaultSessionPort {
  status(): Promise<VaultStatus>;
  setup(masterPassword: string): Promise<VaultStatus>;
  unlock(masterPassword: string): Promise<VaultStatus>;
  lock(): Promise<void>;
}

export interface ConnectionProbe {
  test(hostId: string): Promise<ConnectionTestResult>;
}

export interface CoreRuntime {
  platform: ClientPlatform;
  capabilities: CapabilitySet;
  vault: VaultSessionPort;
  hosts: HostStore;
  connection: ConnectionProbe;
  identities: IdentityStore;
  groups: GroupStore;
  workspace: WorkspaceStore;
  secrets: SecretStore;
  sessions: SessionTransport;
  files: FileTransport;
  commands: CommandTransport;
  snippets: SnippetStore;
  activity: ActivityStore;
  imports: ImportExportPort;
}
~~~

其中 `WorkspaceStore` 只保存非敏感工作区意图，`IdentityStore` 只返回 Identity metadata，`SecretStore` 由平台决定保存位置，`ImportExportPort` 使用 shared 的 `ImportSourceFile` 和 `Uint8Array`，不使用浏览器 `File`/`Blob`。Web adapter 可以在边界把浏览器对象转换成这些类型，native adapter 则把文件选择器或系统路径转换成同一输入。

Host Key policy、ProxyJump 每一跳校验、SFTP 路径规范化、批量目标快照、并发/超时/输出上限、任务终态、重启中断和审计脱敏属于 core/server 共同不变量，不能由某个平台 UI 自行放宽。

## 平台职责矩阵

| 层 | 共享内容 | 平台/部署差异 |
| --- | --- | --- |
| Domain/application | Host、Identity、Group、Workspace、Snippet、Transfer、CommandRun、Activity；validation、错误码、状态机、目标解析 | 无平台 API |
| Client ports | VaultSession/ConnectionProbe；Workspace/Identity/Group/Snippet/Activity store；Session/File/Command transport；SecretStore；ImportExportPort | 由 Web、桌面、Android 分别实现 |
| Web | React UI、HTTP/WSS、浏览器 WebSocket、server-mediated SSH、浏览器文件读写 | 不能在浏览器保存凭据或 Vault secret |
| Desktop | Windows/Linux UI shell、OS keychain、安全文件选择器；可选本地 SSH 或 server-mediated transport | 不选择具体桌面框架，不改变 core 语义 |
| Android | Android UI、Keystore、系统文件选择器、移动网络/生命周期 adapter | 处理后台挂起和网络切换，不改变重连/终态定义 |
| Server | Fastify、SQLite、Vault、`ssh2`、权限/owner 校验、任务和审计 | 作为当前 Web 的 SSH/SFTP/command 安全边界 |

## Web adapter

`src/web/platform/web-adapters.ts` 是 Web 对 `CoreRuntime` 的唯一实现入口。它负责把 setup/unlock/lock、Host CRUD、connection probe、activity、任务轮询、HTTP/WSS、浏览器 WebSocket、浏览器文件和服务端响应映射为 shared ports；`App.tsx` 的新功能只能从 runtime/adapter 调用，不新增直接 `api.ts` wiring。现有直接调用逐步迁入 adapter，不要求本轮重写所有页面。

Web 的 `SecretStore` 不在浏览器中保存主密码、服务器凭据、导出密码、bundle、token 或命令输出；Web session 由服务端 Vault 解析凭据。若未来桌面/Android 采用本地 SSH，则由 OS keychain/Android Keystore 实现 `SecretStore`，且凭据不会因为复用 core 而自动上传。

服务端通过 `GET /api/capabilities` 返回版本化能力集合。客户端应按 capability 判断功能是否可用，不能根据平台名称复制业务分支；未支持的操作统一返回 `CAPABILITY_UNAVAILABLE`。Terminal/operation wire message 使用 shared 的版本和状态语义，adapter 只负责传输编码与连接生命周期。

## Desktop / Windows / Linux / Android 适配要求

Windows/Linux 桌面端可以使用 OS keychain 或桌面安全存储，Android 端使用 Android Keystore；三者仍需保持同样的状态语义和确认步骤。替换 transport 时必须保留：

- 每一跳独立的 Host Key 校验与可解释诊断；
- 远程路径拒绝控制字符和越界 `..`；
- 多主机执行前展示完整目标、展开命令、并发、超时和输出保存选项；
- 结果按主机隔离，输出有大小和 TTL 限制；
- 活动日志只记录脱敏结构化摘要，不记录交互式 shell 原始输入输出；
- 移动端后台挂起、网络切换和进程回收只能产生明确的 reconnecting/interrupted/needs-reopen 状态，不能伪造继续执行。

平台差异应存在于 adapter，不应进入 shared core 或改变服务端的安全默认值。云同步不是 CoreRuntime 的必选端口；如果未来增加 `SyncStore`/`SyncTransport`，必须另写数据归属、冲突、加密和离线语义 spec。

## Contract tests 与发布门槛

- `tests/unit/shared/core-adapter-contract.test.ts` 对 in-memory fake 和 Web adapter 复用同一套 session、file、command、store 和终态断言。
- `tests/unit/web/web-adapters.test.ts` 只验证 HTTP/WSS/浏览器对象到 shared port 的映射，不把 Web 实现细节泄露给 core。
- CI 对 `src/shared` 做静态依赖检查，禁止出现 Node/DOM/React/WebSocket/`ssh2`/浏览器存储依赖；同时运行 Web 和 server 两个 TypeScript target。
- 每个新功能先修改 shared contract 和 fake contract test，再实现 Web adapter；没有 shared port 的功能不得直接写入 `App.tsx`。

这套约束保证 Relay 仍是 Web-first、local-first、单 Vault 产品，同时保留跨 Web、Windows/Linux 桌面和 Android 的扩展可能，不提前承担云同步或原生 UI 的实现成本。
