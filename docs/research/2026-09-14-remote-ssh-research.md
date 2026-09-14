# Web SSH 远程工具调研

日期：2026-09-14

## 1. 调研目标

本调研服务于一个轻量、自托管、浏览器使用的 SSH 工具。首发部署形态确定为 Docker，核心任务是配置多个远程 Server，并通过浏览器完成交互式 SSH 连接。Termius 作为体验标杆，但不复制其云同步和跨端产品范围。

## 2. 用户问题与机会

个人开发者和运维人员通常需要重复处理以下动作：记住不同服务器的 IP、端口和账号；在不同客户端之间复制 SSH 配置；重新打开终端后找回工作上下文；在浏览器环境或临时设备上快速连接。产品机会不是重新发明 SSH，而是把主机信息管理、连接入口和终端工作区做成一个低摩擦的自托管入口。

本项目的首要价值主张：

> 在用户自己的网络环境里，用一个浏览器页面安全、快速地连接多台 SSH Server。

## 3. 产品竞品与参考

### 3.1 Termius

Termius 官方页面展示了主机、分组、Vault、SFTP 等资源组织方式，以及保存连接信息后的一键连接和工作区恢复等体验。其 Vault 说明还强调了跨设备同步、团队共享和客户端加密后的云端保存。

参考：

- [Termius Modern SSH Client](https://www.termius.com/)
- [Termius Vault](https://www.termius.com/vault)
- [Meet Vaults](https://termius.com/blog/meet-vaults)

可借鉴的体验：

1. 主机是第一类资源，而不是让用户每次手写命令。
2. 主机列表需要搜索、分组、收藏和最近连接。
3. 连接动作应该接近一键完成。
4. 终端是工作区的一部分，多个连接应当可以通过标签切换。
5. 敏感凭据需要明确的 Vault/锁定概念。

首版不直接复制的能力：云端同步、团队实时协作、多平台原生客户端、复杂订阅体系。它们会改变部署和身份体系，不符合轻量自托管的首发目标。

### 3.2 Apache Guacamole

Apache Guacamole 是支持 SSH、RDP 和 VNC 的 clientless remote desktop gateway。其 SSH 实现由服务端的 SSH 客户端和终端模拟器组合而成，并提供较丰富的授权、录制和多协议网关能力。

参考：[Apache Guacamole](https://guacamole.apache.org/)、[Guacamole 配置手册](https://guacamole.apache.org/doc/gug/configuring-guacamole.html)

可借鉴的能力：服务端代理、浏览器无需安装客户端、主机身份校验和集中式访问控制。

不采用的方向：Guacamole 的多协议网关和多组件部署对于本项目的 SSH-only、单实例首发过重。

### 3.3 WeTTY 与 WebSSH 类工具

WeTTY 证明了“xterm.js + WebSocket + SSH”可以构成一个简洁的浏览器终端，并支持 Docker 部署、SSH 主机、端口和用户配置。类似 WebSSH2 的项目也验证了 Node.js `ssh2`、WebSocket 和 xterm.js 的组合。

参考：[WeTTY](https://github.com/butlerx/wetty)、[WebSSH2](https://github.com/billchurch/webssh2)、[WebSSH](https://github.com/huashengdun/webssh)

它们的共同短板是：连接入口更偏向一次性终端，主机资产管理、分组、凭据生命周期和持续工作区通常不如 Termius 完整。这正是本项目首版的产品差异化位置。

## 4. 技术调研

### 4.1 浏览器终端

xterm.js 是浏览器端终端模拟器，官方文档提供 fit、search、web links、serialize 和 WebSocket attach 等扩展能力。它只负责终端显示和输入，不负责连接 SSH Server。

参考：[xterm.js 文档](https://xtermjs.org/docs/)、[xterm.js Addons](https://xtermjs.org/docs/guides/using-addons/)

因此前端选择 xterm.js，连接逻辑放在服务端。

### 4.2 SSH 桥接

浏览器不能直接建立任意到 SSH TCP 端口的原始连接，服务端必须充当 SSH client，再通过 WebSocket 把输入输出转发给浏览器。Node.js `ssh2` 是纯 JavaScript 的 SSH2 client/server 模块，支持交互式 shell、伪终端、SFTP 和端口转发等能力，适合首版在同一个 Node 服务内完成 SSH 桥接。

参考：[ssh2 项目](https://github.com/mscdex/ssh2)

SSH Connection Protocol 将交互式终端表示为 channel，并通过 `pty-req` 携带终端类型、字符行列数和像素尺寸。实现中必须在首次打开和每次浏览器尺寸变化时同步 PTY 尺寸。

参考：[RFC 4254 SSH Connection Protocol](https://www.rfc-editor.org/rfc/rfc4254)

### 4.3 凭据与密钥

产品需要使用 SSH 密码和私钥完成远程认证，因此凭据属于可恢复的秘密，不能只做单向哈希。应用层应将凭据与主密码派生的加密密钥分离保存：主密码本身不落库；数据库只保存密文、随机 nonce、版本和必要的 KDF 参数。

OWASP 建议密码验证使用 Argon2id 等慢速、内存困难的算法，并为每个密码使用唯一 salt；秘密应遵循最小权限、生命周期、可撤销、不可写入日志等原则。

参考：[OWASP Password Storage Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)、[OWASP Secrets Management Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Secrets_Management_Cheat_Sheet.html)

首版采用实例级 Vault：用户第一次打开实例时设置一个主密码，应用生成随机 Vault key，用 Argon2id 从主密码派生 KEK，再用 AES-256-GCM 包裹 Vault key。运行时解锁后的 Vault key 只驻留在内存中，远程连接结束或实例锁定后清理。此模型保护数据库文件和备份中的静态数据，但不宣称能抵御已经控制运行中容器的攻击者。

### 4.4 WebSocket 安全

WebSocket 是长连接，不能只依赖 HTTP 请求阶段的安全检查。生产环境必须使用 WSS；握手校验 Origin 和认证会话；消息必须做类型、长度和状态校验；连接、授权失败和异常断开需要记录事件，但不能记录终端内容、密码、私钥、token 或完整消息。

参考：[OWASP WebSocket Security Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/WebSocket_Security_Cheat_Sheet.html)、[xterm.js Security](https://xtermjs.org/docs/guides/security/)

### 4.5 主机身份校验

首版采用 TOFU（首次连接时确认）策略：第一次看到 Server host key 时显示算法、SHA-256 指纹和目标地址；用户确认后保存指纹。后续指纹变化必须硬失败，并提供清晰的“删除旧指纹后重新信任”操作，不能提供无条件跳过校验的默认按钮。

## 5. 调研结论

### 产品结论

1. 首发应做“主机工作区”，而不是单次 SSH 终端。
2. 最小完整闭环是：新增主机 → 保存凭据 → 列表检索 → 一键连接 → 终端交互 → 断线重连。
3. 分组、收藏、最近连接和多标签是低成本但高价值的 Termius 式体验。
4. SFTP、端口转发、片段和团队协作应后置，避免首版变成重型远程桌面网关。

### 架构结论

1. 单体 Node.js 服务最符合自托管轻量目标。
2. React + xterm.js 负责浏览器交互，Node.js + `ssh2` 负责 SSH 连接和 PTY 桥接。
3. SQLite + Docker 数据卷足以支撑单实例首发。
4. 需要从第一版建立主机指纹、凭据加密、WebSocket 会话和审计事件边界。

### 验证结论

验收不能只测“能打开页面”，还必须用真实 OpenSSH Server 验证密码/私钥登录、PTY resize、主机指纹变化、断线重连、数据库密文和 WebSocket Origin 校验。

