# Relay 端口转发与协议能力边界规范

**Date:** 2026-09-16
**Status:** Draft — 待安全评审
**Scope:** X-03；定义端口转发、Agent Forwarding 和其他协议的 capability、adapter、权限、生命周期、审计与平台边界。
**Implementation status:** 当前只完成边界设计；没有新增转发路由、数据面 WebSocket、协议实现或 Web 导航入口。

## 1. 决策摘要

Relay 不为了补齐 SSH 工具功能表而把所有协议塞进现有 SSH core。端口转发和每种非 SSH 协议都必须经过独立的 capability、adapter、权限和审计边界；客户端能力和服务端权限都满足时才可以使用。

本规范的默认结论如下：

1. 首个批准的 forwarding 实现只允许显式创建、显式停止和 owner-scoped 的转发；不提供无确认自动启动，不允许以任意 `0.0.0.0`、`::` 或公网地址监听。
2. `local`、`remote` 和 `dynamic SOCKS` 是三种不同的数据流，不共享含义模糊的“端口转发”开关。每种类型都声明监听侧、目标解析侧、资源配额和停止语义。
3. Web 浏览器不能直接创建本机 TCP listener，也不能通过一个 URL 代理接口访问任意内网。Web 后续如需访问转发，只能使用已认证、owner-scoped、带帧校验的 browser tunnel；该 tunnel 不是通用 HTTP proxy，也不暴露给局域网。
4. V1 默认只接受 loopback bind，端口必须显式指定并原子绑定；端口占用时返回明确错误，不静默换端口。非 loopback bind 需要单独的部署策略、权限、确认和审计，不能由普通用户输入地址直接开启。
5. 转发绑定一个 owner、一个连接路径快照和一个生命周期。Host 编辑、跳板关系变化、Vault 锁定或服务重启不会静默把活动转发切到另一条路径；恢复前必须重新校验权限、凭据、Host Key 和路径。
6. Agent Forwarding、Mosh、Serial、Telnet、RDP/VNC 和 X11 各自定义 transport 与 secret boundary；当前 Web 不广告这些能力，也不把它们的字段加入 SSH `ConnectionProfile`。
7. 本规范通过安全评审后，批准的能力仍须另立 implementation plan，再修改 shared/server contract、写失败测试和实现路由。`src/server/ssh/forwarding-manager.ts` 的现有预留接口不构成产品承诺。

## 2. 当前基线与范围

### 2.1 当前代码事实

当前仓库已经具备以下可复用安全基础：

- `ConnectionPathResolver` 从 owner-scoped Host 集合解析目标和跳板链，拒绝缺失节点、环路和超过四级跳板。
- `HostKeyPolicy` 对每个 Host/跳板 hop 规范化 SHA-256 fingerprint，首次指纹和变更指纹都需要用户决策；变更不会被静默接受。
- `host-routes` 的 Host 读取、Vault 解锁检查和跳板图校验位于服务端；路由不从客户端接受 owner 作为授权依据。
- `OperationEventBus` 按 owner 隔离事件，`/ws/operations` 会校验 session cookie 和 trusted Origin，但当前只广播已有 operation 事件，没有任意字节转发能力。
- `Ssh2Adapter` 内部使用 `forwardOut` 建立 ProxyJump hop；该内部连接能力不等于用户可创建的 forwarding API。
- `src/shared/core/models.ts` 中已有 `forwarding.local` 占位 capability，但它未加入当前 `WEB_CAPABILITIES`，不应在 UI 或服务端路由中提前广告。

这些基础能力只能作为实现时的复用点。转发拥有自己的监听器、连接计数、目标策略和关闭逻辑，不能仅通过调用现有 shell session 的 `sendInput` 或复用一个 URL 路由实现。

### 2.2 本规范包含

- local、remote、dynamic SOCKS forwarding 的语义、数据流、配置和生命周期。
- listener bind、目标地址、端口冲突、跳板、Host Key、Vault、锁定和服务重启的安全规则。
- server-mediated、desktop-local、Android 和 Web browser tunnel 的能力边界。
- Agent Forwarding、Mosh、Serial、Telnet、RDP/VNC、X11 的 adapter/capability/secret/platform 矩阵。
- 控制路由、数据通道、审计字段、稳定错误和后续 focused tests 的约束。

### 2.3 本规范不包含

- 具体 `ssh2` socket API、SOCKS parser、Mosh 握手、RDP/VNC gateway、串口驱动或 Telnet 客户端实现。
- 公网端口暴露、端口映射服务、通用 HTTP CONNECT proxy、反向代理平台或跨用户共享转发。
- 在当前 Web 主导航增加 Forwarding、Agent、Mosh 或其他协议入口。
- 将私钥、passphrase、SSH agent socket、终端原始内容或转发 payload 写入数据库、同步对象或普通日志。

## 3. 术语、owner 与信任边界

| 术语 | 定义 |
| --- | --- |
| connection host | 用于建立 SSH/协议连接的 owner-scoped Host profile；`hostId` 不由客户端单独决定授权。 |
| connection path | 目标 Host 加上按顺序展开的跳板快照；每一跳有自己的地址、端口、Host Key 和认证边界。 |
| execution scope | 实际创建 listener 或发起出站连接的边界：`relay-server`、`desktop-local` 或未来受控的 `android-local`。 |
| bind side | listener 所在的一侧：`execution` 或 `ssh-server`。local/dynamic 使用 execution，remote 使用 ssh-server。 |
| target side | 目标地址由哪一侧解析和访问；实现必须声明是 Relay/桌面执行侧还是最终 SSH server 侧。 |
| browser tunnel | 浏览器通过同源、已认证 WSS 传输控制帧和数据帧的受限通道；不提供浏览器原生 TCP listener。 |
| forwarding owner | 服务端从认证会话和依赖上下文得到的 owner；不能使用 request body 中的 ownerId。 |
| forwarding path snapshot | 创建/启动时解析出的 Host/jump id、端口、目标和安全策略摘要；恢复前必须重新验证，不自动接受已变化的路径。 |

### 3.1 四层信任边界

```text
用户/平台 UI
    │  HTTPS/WSS：session、Origin、capability、CSRF/请求校验
    ▼
Relay control plane
    │  owner / permission / Vault / Host Key / path / quota
    ▼
Forwarding manager + protocol adapter
    │  仅持有当前操作所需的短生命周期资源
    ▼
SSH server / target network / local device
```

控制面负责“能否创建、当前状态和如何停止”；数据面负责“字节或协议包如何流动”。任何数据面连接都必须先属于一个已授权的 forwarding id 或协议 session，不能通过未绑定资源的 socket、URL 或 query 参数绕过控制面。

### 3.2 不变量

- owner、Host、Identity、Group、jump path、forwarding 和 operation 的查询与变更必须使用同一个授权范围；跨 owner 的资源不得被枚举。
- 客户端传入的 `hostId`、目标地址、监听地址和端口都是不可信输入；服务端必须重新读取 Host、解析路径、计算策略并原子创建资源。
- 每一跳 SSH Host Key 都要经过同样的首次/变更策略；转发不能因为“不是交互式 shell”而跳过校验。
- Vault 锁定后不能使用缓存凭据自动建立新 hop、恢复连接或接受新的 forwarding channel；活动 listener 必须进入定义好的停止/中断流程。
- active 只表示 listener 和连接路径都已经由 transport 确认可用；UI、数据库中的旧状态或 socket 尚未关闭都不能单独证明 active。
- 转发 payload、Agent 请求内容、RDP/VNC 画面、X11 数据和终端原始内容都不进入普通 Activity、审计 metadata、通知或同步对象。
- 未实现或未协商的 capability 必须在 route/adapter 层返回 `CAPABILITY_UNAVAILABLE`，不能只隐藏按钮后仍接受请求。

## 4. Capability、权限与平台矩阵

Capability 表示代码和协议是否具备能力；permission 表示当前 owner、部署策略和用户是否获准使用。二者缺一不可，不能用 `client === 'desktop'` 或 UI 是否显示按钮代替权限检查。

### 4.1 Proposed capability 名称

以下名称是本规范提出的后续 contract 名称，不在本次文档提交中加入 TypeScript union 或 Web 广告列表：

| Capability | 代表行为 | 当前状态 |
| --- | --- | --- |
| `forwarding.local` | execution scope 上的 loopback local forwarding | 已有占位；未广告、未实现 |
| `forwarding.remote` | final SSH server 上的受限 remote listener | 未定义 |
| `forwarding.dynamic-socks` | 带目标策略和连接配额的 dynamic SOCKS | 未定义；安全评审前不实现 |
| `forwarding.browser-tunnel` | Web 使用受限 WSS 数据通道访问已批准 forwarding | 未定义 |
| `ssh.agent-forwarding` | 受策略约束的本地 Agent 请求转发 | 未定义 |
| `ssh.x11-forwarding` | 受本地 display/cookie 约束的 X11 forwarding | 未定义 |
| `protocol.mosh` | 独立的 Mosh/UDP transport | 未定义 |
| `protocol.serial` | 本地串口/USB/蓝牙 serial transport | 未定义 |
| `protocol.telnet` | 明确警告和部署开关控制的 Telnet transport | 未定义 |
| `protocol.rdp` / `protocol.vnc` | 独立远程桌面 transport 或受控 gateway | 未定义 |

能力协商只得到候选集合，最终执行仍需 route policy 和 capability-specific permission：

```text
client capability ∩ server capability
          │
          ├─ platform adapter supports
          ├─ owner/deployment permission allows
          ├─ Host/Vault/Host Key/path checks pass
          ▼
      create/start forwarding
```

当前 Web `WEB_CAPABILITIES` 继续不包含上述 forwarding/protocol 名称；未通过评审时，服务端也不应仅因 `Capability` union 中出现占位名称就开放 route。

### 4.2 平台与部署矩阵

| 能力 | Web/PWA | Windows/Linux Desktop | Android | Relay server / 部署策略 |
| --- | --- | --- | --- | --- |
| `forwarding.local` | 不创建浏览器 TCP listener；后续仅可走 browser tunnel | 可作为 server-mediated 或未来 desktop-local adapter | 默认不支持本地 listener；USB/网络边界需单独评审 | 可创建 server execution listener，但 V1 仅 loopback |
| `forwarding.remote` | 默认不广告；不提供公网入口 | 可由 server-mediated adapter 使用 | 后续评估，受后台生命周期约束 | final SSH server listener，V1 仅远端 loopback |
| `forwarding.dynamic-socks` | 不提供通用 SOCKS/URL proxy；browser tunnel 需单独 capability | 后续可选本地 SOCKS，但必须有 target allowlist | 后续可选前台、可见、可停止的 transport | 不作为开放代理；每个 CONNECT 都要策略/配额检查 |
| `ssh.agent-forwarding` | 无浏览器 Agent socket，默认不可用 | 仅在 OS agent 可明确绑定且用户逐连接确认时评估 | 默认不可用；不假设系统存在可安全复用的 Agent | 不保存/转发持久 agent socket，不接收私钥 |
| `ssh.x11-forwarding` | 不支持 | 仅本地 display/cookie adapter 后续评估 | 默认不支持 | 不在 server-mediated Web 中代理 X11 |
| `protocol.mosh` | 当前不支持 | 后续独立 UDP adapter | 后续独立移动 adapter | 需 mosh-server、UDP 策略和独立生命周期 |
| `protocol.serial` | 不支持 | 系统串口权限后续评估 | USB/蓝牙和系统权限后续评估 | 不把串口设备伪装成 SSH Host |
| `protocol.telnet` | 当前不支持 | 后续显式、默认关闭 | 后续显式、默认关闭 | 明文风险需部署开关和审计 |
| `protocol.rdp` / `protocol.vnc` | 不在当前 Web；浏览器 gateway 是另一个项目 | 后续原生 client 或受控 gateway | 后续平台 client | 不通过通用 forwarding route 代替远程桌面授权 |

“后续可选”只表示架构留有 adapter 位置，不表示已承诺交付日期或已具备安全批准。

## 5. Forwarding 资源模型

后续实现应保持 shared control-plane DTO 与平台 socket 实现分离。下面是建议的最小模型；本次不修改 `src/shared/core/models.ts`、`ports.ts` 或 `errors.ts`。

```ts
export type ForwardingKind = 'local' | 'remote' | 'dynamic-socks';

export type ForwardingState =
  | 'queued'
  | 'starting'
  | 'awaiting-host-key'
  | 'active'
  | 'reconnecting'
  | 'interrupted'
  | 'stopping'
  | 'stopped'
  | 'failed'
  | 'needs-reopen';

export interface ForwardingEndpoint {
  address: string;
  port: number;
}

export interface ForwardingTargetPolicy {
  /** At least one explicit allow rule is required for dynamic SOCKS. */
  allowedHostIds?: readonly string[];
  allowedCidrs?: readonly string[];
  allowedPorts?: readonly number[];
  denyPrivateMetadataRanges?: boolean;
}

export interface ForwardingRequest {
  kind: ForwardingKind;
  hostId: string;
  /** Existing connection/lease, if the implementation binds to a live session. */
  connectionId?: string;
  bind: ForwardingEndpoint;
  target?: ForwardingEndpoint;
  targetPolicy?: ForwardingTargetPolicy;
  autoStart?: boolean;
  reconnect?: {
    enabled: boolean;
    maxAttempts: number;
  };
}

export interface ForwardingStatus {
  id: string;
  ownerId: string;
  kind: ForwardingKind;
  state: ForwardingState;
  hostId: string;
  hopHostIds: readonly string[];
  bind: ForwardingEndpoint;
  assignedPort?: number;
  target?: ForwardingEndpoint;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  requestId?: string;
  errorCode?: string;
  nextAction: 'wait' | 'confirm-host-key' | 'unlock-vault' | 'retry' | 'stop' | 'reopen' | 'none';
}
```

模型规则：

- `ownerId`、`createdBy`、`id`、`hopHostIds` 和 `requestId` 由服务端/运行时产生或确认；客户端不得通过 body 覆盖 owner。
- `bind.port` 在 V1 必须是 `1024–65535` 的显式端口；`0`、负数、浮点数和隐式随机换端口不接受。若将来允许 ephemeral port，必须返回真实 `assignedPort`，并在 UI/审计中明确展示。
- `target` 对 local/remote 是必填；dynamic SOCKS 不接受单一 target，而必须有非空、经过 owner 校验的 `targetPolicy`。没有 allow rule 就拒绝，不形成开放代理。
- 地址在校验时规范化；IPv4-mapped IPv6、通配符、空值、控制字符、带 URL scheme 的字符串和模糊 DNS 语法不得绕过 bind policy。
- `ForwardingStatus` 是 metadata，不含凭据、私钥、Agent socket path、数据流计数中的原始 payload、终端内容或 RDP/VNC 画面。
- `autoStart` 默认为 `false`。即使为 `true`，首次创建、Host Key 决策、Vault 解锁、权限变化或路径变化也不能被自动流程绕过。

### 5.1 资源归属与路径快照

每一个 forwarding 必须记录以下运行时关联：

| 关联 | 规则 |
| --- | --- |
| owner | 由认证 session 对应的服务端 owner 确定；list/get/start/stop 全部按 owner 过滤。 |
| Host | `hostId` 必须属于 owner；已删除或转移的 Host 使 forwarding 进入 `needs-reopen`，不自动替换目标。 |
| Jump path | 启动时使用 `ConnectionPathResolver` 生成有序 hop 快照；最多四个跳板且不允许环路。 |
| Host Key | 每个 hop 独立建立 `HostKeyPolicy`；任何 hop 等待确认或 mismatch，整个 forwarding 不得 active。 |
| Vault | 只有 unlocked session 才能读取当前所需凭据；lock 使新 channel 和 reconnect 失败，并触发关闭流程。 |
| Session | 如果实现复用 live SSH resource，必须绑定 owner-scoped `connectionId`；关闭/失效后不能使用孤立 handle。若使用独立 SSH resource，也必须拥有独立 operation 和审计关联。 |
| Profile changes | 活动 forwarding 不静默读取新地址、端口、Identity 或跳板。恢复时重新解析并比较安全摘要，变化时进入 `needs-reopen`。 |

## 6. Bind 与目标策略

### 6.1 V1 bind policy

V1 的默认规则是“只监听 loopback，不把 Relay 变成端口暴露服务”：

- 允许的 bind address 只有规范化后的 `127.0.0.1`、`::1`；实现必须同时处理 IPv4-mapped IPv6 和 DNS 名称解析后的非 loopback 结果。
- 拒绝 `0.0.0.0`、`::`、`*`、广播地址、任意公网地址和未解析/多解析的 hostname。不能把空地址解释为安全默认值。
- 普通 forwarding 拒绝 `<1024` 的 privileged port；部署策略不能通过“端口占用时随机换一个高端口”掩盖用户配置错误。
- listener 建立必须是原子操作：先完成 owner/capability/target/Host Key 检查，再执行 bind；bind 失败不能留下半初始化资源或报告 active。
- non-loopback bind 不是普通配置项。未来若批准，必须同时有部署级 `allowNonLoopbackForwarding`、capability、owner/admin permission、明确的风险确认、来源限制、连接配额和审计；公网 bind 默认永久关闭。
- remote forwarding 的 bind address 是最终 SSH server 上的 listener 地址，也默认只允许该 server 的 loopback；Relay 执行侧不能把 remote request 解释成“开放远端公网端口”。

### 6.2 Target policy

转发的目标不等于一个可以随意拼接的 URL：

- local/remote 使用显式的 `address + port`，且必须在声明的 target side 上解析；实现必须在状态/诊断中显示解析侧，避免用户误以为 `localhost` 指向另一台机器。
- 如果目标可以引用 Relay Host profile，必须传 `targetHostId` 或等价的 owner-scoped ref，并重新读取该 Host；不能只信任客户端展示名称。
- dynamic SOCKS 每个 CONNECT 都要校验目标策略、端口、连接数、单连接字节/时间上限和来源 forwarding id。默认没有 allow rule 时直接拒绝。
- 实现必须阻止利用 DNS rebinding、IPv4/IPv6 表示差异、IPv4-mapped IPv6、云元数据地址和未授权的管理网段绕过策略。若 target side 无法可靠执行解析后的地址策略，则该 capability 必须返回 `CAPABILITY_UNAVAILABLE`，不能降级为 unrestricted CONNECT。
- 目标允许访问内网并不等于允许任意内网扫描。需要内网目标时应使用明确 Host/网段/端口 allowlist、显示风险确认和限额；不允许通过浏览器 query 参数临时扩大范围。
- 禁止为 forwarding 增加“输入 URL 即代理”“服务端代抓 HTTP”或“把错误重定向到任意 target”的旁路接口。

### 6.3 Port collision 与配额

- 同一 execution scope、bind address、bind port 和 owner 的冲突必须返回 `FORWARDING_PORT_IN_USE`；服务全局也应防止不同 owner 争抢同一 listener。
- 端口探测只是用户提示，不是授权或占用保证；最终以原子 bind/SSH remote bind 的结果为准。
- owner、execution scope 和部署实例分别有 forwarding 数量、listener 数量、动态 channel 数量、单 channel 带宽/时长和总连接数上限。
- 超出上限要在创建新资源前失败，不先创建 listener 再异步清理。异常断开、取消和服务停止都必须释放计数。
- 不为失败请求保留可被猜测的有效 socket、临时 token 或下一次请求可复用的未授权 handle。

## 7. 三种 forwarding 的数据流和生命周期

### 7.1 Local forwarding（`-L` 语义）

```text
execution-side loopback listener
        │ accepted local connection
        ▼
Relay/Desktop forwarding adapter
        │ SSH direct-tcpip through validated path
        ▼
target address:port as declared by the target-side policy
```

- listener 在 `execution scope`，默认只对同一台 Relay server 或桌面设备的 loopback 可见。
- 每条 accepted connection 都继承 forwarding 的 owner、target policy、超时和配额；不能通过新连接逃逸到另一个 target。
- 如果 Web 用户需要使用该能力，Web 只能通过单独的 `forwarding.browser-tunnel` 控制/数据通道访问；浏览器页面不获得本机监听端口，局域网其他应用也不能借此访问。
- browser tunnel 必须把 `forwardingId`、`channelId`、单调递增 sequence、frame type 和长度绑定到已认证 WSS；断开时关闭所有 channel，不允许从任意 origin 重连。

### 7.2 Remote forwarding（`-R` 语义）

```text
final SSH server loopback listener
        │ remote accepted connection
        ▼
SSH forwarding channel
        │ outbound target connection from declared execution side
        ▼
Relay/Desktop target adapter
```

- listener 实际位于最终 SSH server；V1 只允许该 server 的 loopback，不能因为用户填了 `0.0.0.0` 就变成公网入口。
- `targetAddress` 的解析侧必须写入 contract。若由 Relay server 解析，则该出站连接受 Relay egress policy、目标 allowlist 和 SSRF 防护约束；若由 SSH server 解析，则 adapter 必须能执行对应的策略检查，否则拒绝能力。
- remote bind 成功后才发布 `active`，并把真实分配端口（如将来允许 ephemeral）返回给用户；SSH server 拒绝 remote bind 时不能伪装成 local listener 成功。
- 远端 listener 的 owner 生命周期与 forwarding 绑定；用户 stop、Vault lock、SSH path failure 和服务重启都必须撤销/关闭 remote listener，并确认未继续接受新连接。

### 7.3 Dynamic SOCKS forwarding

```text
authorized SOCKS/browser-tunnel client
        │ CONNECT target:port
        ▼
target policy + quota + DNS/address checks
        │ allowed only
        ▼
SSH direct-tcpip through validated path → target
```

- dynamic SOCKS 是“每连接目标策略”，不是 local forwarding 的 target 字段可选化。
- V1 不批准 unrestricted SOCKS。每个 CONNECT 必须有显式 allowlist、目标端口限制、并发和流量/时长上限，且 rejection 不泄露 Relay/目标网络的扫描信息。
- 不能把 SOCKS 监听器绑定到公网，也不能通过 HTTP URL、image fetch、WebSocket proxy 或 CORS 旁路把它变成任意请求代理。
- DNS 解析侧、解析结果校验和连接目标必须可审计为规范化摘要；对于无法在远端可靠执行 IP policy 的路径，返回 `CAPABILITY_UNAVAILABLE` 或 `FORWARDING_TARGET_INVALID`。
- stop、owner logout/revocation、Vault lock、session close 和 service restart 都会关闭已建立和待建立的 CONNECT；不得只停止新 CONNECT 而留下无法管理的旧 channel。

### 7.4 Common lifecycle

```text
queued
  → starting
  → awaiting-host-key ── trust → starting
  │                    └ reject → failed
  → active
  ├─ reconnecting ── success → active
  │                 └ limit/policy failure → interrupted / needs-reopen
  └─ stopping → stopped
```

规则：

- `queued` 只表示请求已通过输入解析，不表示已经占用端口。
- `starting` 阶段依次完成 capability、owner、permission、Vault、Host、jump path、Host Key、认证和 bind/remote-bind；任何一步失败都要清理已建立的 hop 和 listener。
- `awaiting-host-key` 按 hop 提供算法、fingerprint、地址、端口和 hop index；任一 hop 未确认时不接受数据连接。
- `active` 需要 transport 和 listener/remote listener 的事实确认；`reconnecting`、`interrupted`、`needs-reopen` 不能作为可输入或可转发状态。
- `stop` 必须幂等。重复 stop 对已 `stopped`/`failed`/`needs-reopen` 的资源不重新打开连接，也不返回一个可被重放的 handle。
- `reconnect.enabled` 默认关闭；开启后使用有限次数和退避，不自动更改 bind port、target、Host Key 决策、权限或 Vault 状态。超过次数进入 `interrupted` 或 `needs-reopen`。
- Vault lock 触发停止新 channel、禁止 reconnect；实现应在有界时间内关闭 listener 和活动 channel，最终状态是 `stopped`（用户/锁定主动关闭）或 `interrupted`（底层已断且无法恢复），并提供原因。
- 服务重启后旧 handle 一律失效。可恢复的元数据最多显示 `interrupted`，需要重新获取授权、重新校验路径和 Host Key；没有事实依据时显示 `needs-reopen`，绝不显示旧的 `active`。

## 8. 控制路由与 browser tunnel 边界

本节是后续 route contract，不代表本次已创建路由。

### 8.1 建议的控制面

```text
POST   /api/forwardings              create (默认 queued 或明确 start)
GET    /api/forwardings              list current owner
GET    /api/forwardings/:id          status current owner
POST   /api/forwardings/:id/start   explicit start/reopen
POST   /api/forwardings/:id/stop    idempotent stop
```

所有控制路由必须：

1. 验证 session cookie、Vault 状态、trusted Origin/CSRF 边界、request id 和严格 schema。
2. 从服务端依赖获得 owner；`ownerId`、createdBy、host owner 和 forwarding id 做一致性校验。
3. 在 start 前重新计算 capability intersection 和 permission；不能仅信任创建时保存的“supported”。
4. 对跨 owner 的 id 使用与不存在相同的 `FORWARDING_NOT_FOUND`/`OPERATION_NOT_FOUND` 语义，避免资源枚举；不得返回“存在但属于其他用户”。
5. GET 只返回安全 metadata；不要返回凭据、密钥、socket path、代理 token、目标网络扫描结果或完整错误堆栈。
6. stop 先阻止新 channel，再关闭 listener/remote listener、活动 channel、订阅和计数；最终状态由 manager 事实确认后返回。

### 8.2 Browser tunnel

如果未来 Web 需要访问 `forwarding.local`，建议另设 `/ws/forwardings/:id`，而不是修改当前 `/ws/operations` 为任意双向字节代理：

- 握手必须验证 session cookie、trusted Origin、owner、capability、forwarding state 和一次性/短期 channel 授权。
- frame 必须带 `protocolVersion`、`forwardingId`、`channelId`、`sequence`、`type` 和长度上限；只接受 `open`、`data`、`close`、`ping/pong` 等明确类型。
- `open` 不能携带任意 URL、目标 host、目标 port 或新的 bind address；目标已由 forwarding policy 固定。
- 服务器不能把浏览器提供的文本转发成 HTTP 请求、命令、文件路径或新的 socket 参数。数据面只向已批准的 forwarding channel 写入。
- 每个 owner、forwarding、channel 和连接有数量、字节、速率和空闲超时；断线和错误要释放所有资源。
- 没有 Web capability、浏览器不支持当前 adapter、来源不受信任或 forwarding 非 `active` 时，返回 `CAPABILITY_UNAVAILABLE`/稳定协议错误，不尝试隐式降级为通用 WebSocket。

当前 `/ws/operations` 继续只做 owner-scoped operation event broadcast；不要把命令/审计事件通道与任意 TCP 数据混用。

## 9. Agent Forwarding 边界

Agent Forwarding 与 port forwarding 不是同一能力。它传递的是对本地 Agent 的签名请求，风险在于远端主机可能代表用户使用 Agent，而不在于复制私钥。

### 9.1 默认规则

- `ssh.agent-forwarding` 默认关闭，必须由用户在连接/forwarding 确认步骤中逐次启用；不能由 Host profile 的“全部连接”开关隐式打开。
- Relay 不接收、保存或同步私钥、passphrase、Agent socket 的长期路径或 Agent 返回的身份私密材料。Agent adapter 只能在当前连接生命周期内调用系统 Agent 的最小接口。
- server-mediated Web 默认不可用：浏览器没有安全的本机 Agent socket，且把 Agent 请求经 Relay 服务器转发会扩大 server、remote host 和浏览器之间的信任面。需要支持时必须另立 broker/桌面 adapter 设计和威胁评审。
- Desktop 只有在 OS agent 可明确绑定、平台权限可解释、用户有可见确认和断开即清理的条件下评估；Android 不假设存在可复用的系统 Agent，默认不可用。
- 可选的 remote host allowlist、签名次数/速率/有效期和 session 绑定必须由 adapter/manager 执行；Agent 请求失败不能自动回退到上传私钥或密码登录。
- 审计只记录是否启用、Host/forwarding id、状态、请求数/拒绝数、错误码和时间，不记录签名 payload、challenge、密钥内容或命令。

### 9.2 生命周期

Agent permission 在 forwarding 创建、SSH path 建立、每次 reconnect 时都重新确认。用户 stop、Vault lock、Agent revoke、连接关闭、窗口退出和服务重启都要关闭 Agent channel；旧 channel 不得在后台继续签名。

## 10. 其他协议能力分层

这些协议不能复用 SSH `ConnectionProfile` 的 auth、Host Key、jump 或 session 字段；每个 adapter 需要独立的 profile schema、secret policy、连接诊断、生命周期和平台测试。

| 能力 | 独立边界 | 身份/秘密规则 | 平台兼容性与默认策略 |
| --- | --- | --- | --- |
| Mosh | `MoshTransport`，包含 UDP/漫游/服务器进程状态；不能伪装成 `SshChannel` | 复用 SSH 建立阶段的 Host Key/凭据时需明确阶段；Mosh UDP token 与 session 另行管理，不进普通日志 | Desktop/Android 后续评估；Web 当前不支持；不得在 SSH reconnect UI 中伪造为已恢复 |
| Serial | `SerialTransport`，包含设备枚举、baud/data/stop/parity 和 USB/BT 生命周期 | 设备授权来自 OS；设备路径/序列号按敏感 metadata 处理；无 SSH Host Key，需独立设备 identity | Desktop/Android 后续评估；Web 不支持；拔插、锁屏、权限撤销进入 interrupted |
| Telnet | `TelnetTransport`，明确 plaintext/negotiation 状态 | 无 Host Key 不能假装有 SSH trust；密码仅一次性传递，不记录；默认需要显著明文风险确认 | 所有平台默认关闭；服务端部署开关、网络 allowlist 和审计是前置条件 |
| RDP | 独立远程桌面 client/gateway；屏幕、输入、剪贴板和文件重定向是不同权限 | 凭据从平台安全存储/服务端受控 secret 得到；不把桌面画面、剪贴板和密码进入 Activity/同步 | Desktop/Android 后续；Web 需要另行批准的 browser gateway，不复用 generic forwarding |
| VNC | 独立 VNC transport/gateway；认证和画面通道单独建模 | VNC secret、TLS/证书、剪贴板和文件通道分别授权；连接 token 不持久化 | Desktop/Android 后续；Web 不在当前范围 |
| X11 | 独立 local display adapter；需要 display、cookie 和 Unix socket/平台权限 | X11 cookie 只在短生命周期使用；不把 display socket 暴露给远端任意 Host；剪贴板/窗口输入需独立风险评估 | Desktop 后续评估；Web/Android 默认不支持；不能由 server-mediated route 直接代理本地显示 |

通用降级：平台或 server 不支持对应 capability 时，UI 隐藏入口或显示“当前平台不可用”；请求必须仍被服务端拒绝为 `CAPABILITY_UNAVAILABLE`，不允许把协议请求转成 SSH shell、Telnet 或任意 forwarding 的隐式替代。

## 11. 错误矩阵与下一步动作

新增 forwarding-specific 错误码只有在实现 plan 确定错误契约后才加入 `src/shared/errors.ts`。在此之前可以复用已有稳定码，但不能用一个泛化的“连接失败”掩盖安全原因。

| 场景 | 稳定错误码 | 状态/下一步动作 |
| --- | --- | --- |
| client/server/platform 未协商能力 | `CAPABILITY_UNAVAILABLE` | 不创建资源；选择受支持的平台或能力 |
| 无 permission、owner 被撤销或部署策略关闭 | proposed `FORWARDING_PERMISSION_DENIED` | `failed`；查看权限/部署策略，不自动重试 |
| id 不存在或属于其他 owner | proposed `FORWARDING_NOT_FOUND`（或复用 `OPERATION_NOT_FOUND`） | 不泄露资源存在性；`reopen`/返回列表 |
| wildcard/non-loopback/privileged bind | proposed `FORWARDING_BIND_DENIED` | `failed`；改用 loopback 或经批准的部署策略 |
| port 被占用或 remote bind 被拒 | proposed `FORWARDING_PORT_IN_USE` | 不换端口；选择空闲端口后重试 |
| 端口、地址、target 或 policy schema 非法 | `HOST_VALIDATION_FAILED` 或 proposed `FORWARDING_TARGET_INVALID` | `failed`；编辑配置 |
| 动态 CONNECT 没有 allow rule、超出网段/端口/配额 | proposed `FORWARDING_TARGET_INVALID` / `FORWARDING_LIMIT_REACHED` | 拒绝该 channel；forwarding 仍可 active，除非达到全局终止策略 |
| Host 不存在、跳板缺失、跳板环路或超过四级 | `HOST_NOT_FOUND` / `HOST_VALIDATION_FAILED` | `failed`；修正 Host/跳板关系 |
| 任一 hop 首次 Host Key 未确认 | `HOST_KEY_REQUIRED` | `awaiting-host-key`；展示 hop index 和指纹，确认后重试 |
| 任一 hop Host Key 变化或无效 | `HOST_KEY_MISMATCH` | `failed`；硬阻断，不能自动接受新指纹 |
| Vault 未解锁/已锁定 | `VAULT_LOCKED` | `awaiting-credential` 或 `needs-reopen`；解锁后显式重试 |
| SSH 认证或 target 连接失败 | `SSH_AUTH_FAILED` / `CONNECTION_STAGE_FAILED` | `failed`；按诊断编辑凭据或重试 |
| live connection/session 已关闭 | `SESSION_NEEDS_REOPEN` | `interrupted`/`needs-reopen`；重新打开 Host |
| 服务进程重启、旧 handle 失效 | `SERVICE_RESTARTED` / proposed `FORWARDING_INTERRUPTED` | 不显示 active；查询事实后重开 |
| Agent、串口、Mosh、RDP/VNC 等 adapter 暂不可用 | `CAPABILITY_UNAVAILABLE` | 隐藏/禁用对应入口，保留 SSH 可用能力 |
| stop 期间的重复 stop | 无错误（幂等） | 返回已结束状态；不重新建立任何资源 |

用户可见错误至少包含：阶段（bind/path/host-key/auth/target/channel）、脱敏原因、是否可重试、下一步动作和 request id。错误消息不得包含私钥、passphrase、session cookie、完整 Agent 数据、命令、终端输出或远端内部扫描结果。

## 12. 审计与可观测性

### 12.1 审计事件

后续可复用现有 `AuditRepository`，但 forwarding 事件必须采用白名单 metadata。建议事件类型：

```text
forwarding_queued
forwarding_started
forwarding_host_key_required
forwarding_active
forwarding_reconnecting
forwarding_stopped
forwarding_interrupted
forwarding_failed
agent_forwarding_enabled
agent_forwarding_disabled
protocol_session_started
protocol_session_stopped
```

每条事件至少有：

| 字段 | 规则 |
| --- | --- |
| `ownerId` | 由 repository 当前 owner 注入，不从 metadata 接受。 |
| `eventType` | 白名单事件名；不允许把用户输入拼接进事件类型。 |
| `forwardingId` / `operationId` | opaque id；便于关联生命周期，不作为秘密。 |
| `requestId` | 每次控制动作的 request id；重试/stop 不能覆盖原始关联。 |
| `kind` / `scope` | `local`/`remote`/`dynamic-socks` 和执行侧。 |
| `hostId` / `hopHostIds` | 记录 owner-scoped id，不记录凭据；跳板顺序必须可复盘。 |
| `bind` | 只记录规范化地址类别（如 `loopback-v4`）和端口；非 loopback 的真实地址若未来获批也需按部署策略脱敏。 |
| `target` | 优先记录 target Host id、端口和地址类别；literal address 使用受控 hash/脱敏摘要，不默认记录内部原文。 |
| `fromState` / `toState` / `reason` | 白名单状态转移和原因；不得记录原始 socket error/堆栈。 |
| `createdAt` / `endedAt` | 记录生命周期时间和最终状态。 |
| counters | 只记录连接数、拒绝数、字节/时长的聚合数；不记录 payload。 |

禁止进入审计、普通日志、遥测或通知：密码、私钥、passphrase、Vault key、Agent socket/path、Agent 签名数据、SOCKS CONNECT 原文、终端输入输出、RDP/VNC 画面、X11 payload、文件内容和 session token。

### 12.2 状态事实

状态查询应区分 control-plane metadata 和 data-plane fact：

- manager 失去 listener、remote bind 或 underlying SSH resource 的确认时，必须先降级为 `interrupted`/`needs-reopen`，不能只相信数据库里的 `active`。
- 重连、停止、服务退出和异常清理要发布一次可去重的状态事件；事件丢失时，GET status 仍能恢复事实。
- operation WebSocket 只发送脱敏状态/诊断摘要；未来 forwarding event 要求与 owner、forwarding id 和 request id 绑定，不发送数据流。

## 13. 威胁模型与控制

| 威胁 | 可能后果 | 必须控制 |
| --- | --- | --- |
| `0.0.0.0`/`::`/公网 bind | Relay 或远端 SSH server 变成公网服务，绕过用户意图 | V1 loopback-only；non-loopback 需部署策略、权限、确认、来源限制、配额和审计；默认拒绝 |
| SSRF/内网扫描 | 借 forwarding/SOCKS 探测 Relay、云元数据或内网管理端口 | explicit target/allowlist、解析侧声明、保留地址/元数据网段控制、每 CONNECT 策略和配额；无法校验时禁用 capability |
| DNS rebinding/地址表示绕过 | 域名、IPv6、mapped IPv4 或解析变更绕过 allowlist | 规范化地址、解析后重验、固定解析侧、阻断模糊 hostname；审计摘要含解析策略 |
| 跨 owner 访问 | 用户读取、停止或使用其他 owner 的 forwarding/Host | owner 从 session 得到；每个 list/get/start/stop/data frame 复查 owner；跨 owner 使用同样 not-found 语义 |
| jump cycle/missing/path drift | 连接到错误 Host、资源泄露或恢复后绕路 | `ConnectionPathResolver` 限制环路/深度；保存 path snapshot；恢复前重新比较和确认 |
| Host Key bypass | 中间人或错误目标被转发 | 每 hop `HostKeyPolicy`；首次/变更必须阻断；forwarding 不复用“shell 已确认”的错误假设 |
| Vault lock/revoke | 锁定后后台仍使用凭据、失去控制 | lock/revoke 停止新 channel 和 reconnect，关闭 listener/资源；禁止缓存密钥自动恢复 |
| Agent exposure | 远端代表用户签名、Agent socket 被跨用户复用 | 默认关闭；逐连接确认；OS agent 绑定；无持久 socket/私钥；次数/目标/时间限制；停止即清理 |
| Open proxy/URL proxy | 任意网站或第三方借 Relay 发起请求 | 不提供 URL fetch/HTTP CONNECT 旁路；SOCKS 需 allowlist/配额；browser tunnel 目标固定 |
| listener/port race | 端口冲突、幽灵 listener、错误显示 active | 原子 bind；冲突不换端口；启动/停止幂等；以 data-plane fact 发布状态 |
| 资源耗尽 | 大量 listener/channel、慢连接或大流量拖垮服务 | owner/实例/协议级数量、速率、时长、空闲和字节上限；异常清理和 RATE_LIMITED |
| service restart | 旧 forwarding 被伪装为仍运行或重启后绕过确认 | 旧 handle 失效；显示 interrupted/needs-reopen；恢复重新 auth/path/Host Key；不自动扩大权限 |
| browser Origin/token leakage | 第三方页面获得 TCP 数据通道 | trusted Origin、HttpOnly session、短期绑定、严格 frame schema、无 URL target、同源 WSS；不把 token 放 query/localStorage |
| Telnet plaintext | 凭据和会话被窃听 | 默认关闭、显著风险提示、部署开关、网络限制；不宣称 Host Key 保护 |
| RDP/VNC/X11 side channel | 画面、剪贴板、窗口输入或 display cookie 泄露 | 独立 capability 和权限；默认关闭高风险重定向；平台安全存储；不进日志/同步 |
| 服务端错误日志泄密 | 网络地址、协议 payload 或凭据落入日志 | 结构化白名单日志；错误码/阶段/请求 id；原始异常只进入受控脱敏诊断 |

## 14. UI 与交互约束

在安全评审完成并有真实实现前，当前 Web 主导航不增加 Forwarding 或多协议入口。未来 UI 应借鉴现代 SSH 工具“高密度但低认知负担”的方向，但把安全状态置于视觉装饰之上。

### 14.1 Forwarding panel

未来 panel/drawer 至少显示：

- 类型：Local / Remote / Dynamic SOCKS，以及实际 execution scope。
- bind：规范化后的监听地址和端口；默认明确显示 `127.0.0.1`/`::1`，不使用“本地”这种含义不清的标签。
- target：目标 Host、目标地址/端口和解析侧；Dynamic 显示 allowlist 摘要而不是“任意目标”。
- connection path：最终 Host 和跳板顺序；Host Key 等待时显示具体 hop、算法和 fingerprint。
- 状态：`starting`、`awaiting-host-key`、`active`、`reconnecting`、`interrupted`、`needs-reopen`、`stopped`、`failed` 的文字、图标和辅助颜色。
- creator/owner、创建时间、最近状态更新时间和 request id；当前单用户也保留字段位置，方便未来账号/设备扩展。
- 动作：Start、Stop、Reopen、Confirm Host Key、Unlock Vault、Retry；Stop 在 `active`、`reconnecting` 和待启动资源上都可见。

创建流程必须先预览再确认：类型 → Host/跳板 → bind/target → 风险和权限摘要 → 显式 Start。端口占用、Host Key、Vault 锁定和 capability 缺失要在原位置解释，不退化成一个泛化 toast。

### 14.2 危险动作

- 普通用户看不到可编辑的公网 bind；若未来受策略允许，必须标注“此监听可能被其他机器访问”、显示来源限制和自动停止时间，并二次确认。
- Dynamic SOCKS 明确标注“目标 allowlist”和当前连接数/限额；没有 allow rule 时提供配置指引，而不是灰掉后让用户猜原因。
- Agent Forwarding、Telnet、X11、RDP/VNC 的高风险开关必须说明秘密/画面/输入边界和停止方式；不使用与普通 SSH shell 相同的无差别“连接”文案。
- 通知、Activity 和复制动作只使用脱敏摘要；不把完整 target、命令、token 或协议 payload 放入系统通知。

## 15. 后续实现计划与验证门槛

本规范批准后，按能力拆成独立 implementation plan，顺序建议如下：

1. **Control-plane contract**：先加入 `ForwardingRequest/Status`、capability 和错误码，补 fake manager 与 shared contract test。
2. **Server-mediated local forwarding**：只做 loopback listener、显式 target、现有 SSH path/Host Key 复用、owner route、stop/cleanup 和审计；不先做公网 bind、SOCKS 或 browser tunnel。
3. **Remote forwarding**：单独评审 SSH server bind side、目标解析侧、remote bind 权限和撤销确认。
4. **Browser tunnel**：在 local forwarding 稳定后，另行设计 frame protocol、Origin/CSRF、资源限额和浏览器集成验证。
5. **Dynamic SOCKS**：最后评估；只有 target policy、解析后地址控制、审计和 open-proxy 防护可测试时才进入实现。
6. **Agent/protocol adapters**：Agent、Mosh、Serial、Telnet、RDP/VNC、X11 分别建立 spec/plan 和平台验证，不与 forwarding 共享未经审查的秘密或状态字段。

### 15.1 必须先失败的 focused tests

实现阶段至少需要以下测试，测试名称和错误码以批准后的 contract 为准：

- capability：未协商、不支持平台、server 拒绝和未批准能力均返回 `CAPABILITY_UNAVAILABLE`；当前 Web 不出现入口。
- owner/route：跨 owner 的 list/get/start/stop/data frame 均不可见；未知 id 与跨 owner 使用相同 not-found 语义。
- bind：wildcard、公网、IPv4-mapped、非法/privileged/重复端口拒绝；原子 bind 失败后没有 listener 和 active 状态。
- target：URL、控制字符、未授权 Host/CIDR/port、无 dynamic allow rule、DNS rebinding 和保留元数据地址按策略拒绝。
- connection path：缺失 Host、环路、超过四级、路径变化和跨 owner jump 均拒绝；每个 hop 都触发 Host Key challenge/mismatch 断言。
- lifecycle：starting 可取消、stop 幂等、活动 channel 随 stop/lock/restart 释放；重连次数有限，失败时不能保持 active。
- audit：状态转换、request id、owner/path 摘要齐全；凭据、Agent 内容、payload、终端输出和 token 不出现。
- protocol isolation：不支持的 Mosh/Serial/Telnet/RDP/VNC/X11/Agent adapter 不被 SSH shell route 隐式处理；各自 profile 不污染 SSH connection model。

### 15.2 发布门槛

在安全评审通过前只验证本 spec 的链接、结构和差异，不把未实现能力加入 README、发布说明或 UI。实现后按风险运行：

- shared/server contract 和 route focused tests；
- forwarding manager/SSH fake 的生命周期、Host Key、owner isolation 和 resource cleanup；
- 浏览器若有 tunnel，再运行 Chromium Origin、断线、frame limit、无公网 listener 和 no-URL-proxy E2E；
- `lint`、TypeScript typecheck 和 build；只有同时影响 SSH core、协议、数据库迁移、认证或发布链的重大变更才进入全量验证。

## 16. 待安全评审决策

本规范先给出安全默认值，评审时需要明确记录以下决策，任何未决项都不能被实现者自行放宽：

1. 是否批准第一阶段只做 server-mediated local forwarding，且 execution/remote bind 均 loopback-only。
2. 是否允许 future non-loopback bind；如果允许，部署策略、管理员权限、来源 allowlist、自动过期和审计字段是什么。
3. Dynamic SOCKS 的目标 allowlist 以 Host id、CIDR、端口还是组合策略为准；解析侧无法执行地址策略时是否永久禁用该能力。
4. Agent Forwarding 是否只允许 Desktop local adapter；是否需要 remote host、Agent identity、签名次数和时间的额外审批。
5. Mosh、Serial、Telnet、RDP/VNC 和 X11 的首个目标平台、秘密存储和平台权限；是否维持 Web 默认不支持。
6. forwarding 是否必须绑定现有 live SSH connection，还是允许独立 connection resource；两种模式的并发、Host Key 和关闭语义不能混用。

## 17. Acceptance 与关联文档

### Acceptance

- local/remote/dynamic SOCKS 都有独立的监听侧、目标解析侧、owner/session/path、权限、错误、生命周期、停止、重启和审计定义。
- Agent Forwarding、Mosh、Serial、Telnet、RDP/VNC、X11 都有独立 capability、adapter、secret/identity、平台兼容性和默认降级定义。
- V1 安全默认值禁止 wildcard/public bind、开放 SOCKS、URL proxy、跨 owner 访问、Host Key bypass、Agent 私钥上传和服务重启后的虚假 active。
- 当前 Web 不广告未批准 capability；本提交不创建转发路由、浏览器数据通道或协议实现。
- 后续 implementation plan 能直接从本规范生成失败测试、文件边界和 focused verification，不需要重新解释 owner、错误和安全默认值。

### 关联文档

- [`Relay 长期产品与体验路线图`](../plans/2026-09-16-relay-long-term-roadmap.md)
- [`统一核心与跨端/跨平台基础`](../../architecture/cross-platform.md)
- [`Relay 平台 Shell 设计规范`](./2026-09-16-relay-platform-shell-design.md)
- [`Relay 账号、设备与端到端加密同步设计`](./2026-09-16-relay-account-and-encrypted-sync-design.md)
- [`Termius gap review`](../../research/2026-09-16-termius-gap-review.md)
- [`产品需求`](../../product/2026-09-14-product-requirements.md)
