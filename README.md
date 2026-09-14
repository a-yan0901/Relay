# Web SSH Workspace

一个自托管、单实例的 Web SSH 工作台：把多台 Server 的连接信息保存在本地加密 Vault 中，并在浏览器里使用带 PTY 的交互式终端。

## 快速启动

生产环境应当把应用放在 HTTPS 反向代理之后，并将浏览器访问地址写入 `TRUSTED_ORIGINS`：

```bash
export TRUSTED_ORIGINS=https://ssh.example.com
docker compose up -d --build
```

然后访问 `https://ssh.example.com`，首次使用时创建主密码。主密码遗失后无法恢复已保存的 Server 凭据。

应用只需要一个持久化数据卷 `/data`。备份整个 Docker volume 或宿主机绑定目录，并将备份视为敏感数据：数据库中的 Server 密码、私钥和 passphrase 是密文，但解锁后的运行中实例能够暂时使用这些凭据建立 SSH 连接。

## 反向代理要求

- 代理必须终止 TLS，并将 HTTP Upgrade 请求转发到 `/ws/terminal`。
- 浏览器端终端在生产环境使用 WSS；不要把应用端口直接暴露到不可信网络。
- `TRUSTED_ORIGINS` 只接受完整的 `http://` 或 `https://` origin，不接受路径、query、通配符或凭据。
- `TRUSTED_ORIGINS` 必须与浏览器地址栏中的 origin 完全一致。
- 应用通过 HttpOnly、SameSite Strict、生产 Secure cookie 保存会话标识；不要通过 URL 或 localStorage 传递会话 token。

反向代理还应设置合理的 WebSocket 空闲超时，并限制管理入口的访问来源。应用自身会检查 WebSocket Origin、解锁会话、消息大小和活动终端数，但它不是身份提供商或完整的公网边界防火墙。

## 数据与网络

容器需要：

- 对 `/data` 的读写权限；容器以非 root 用户 `webssh` 运行。
- 到目标 SSH Server 的出站 TCP 连接，通常是端口 22 或你配置的端口。
- 到浏览器反向代理的入站 HTTP/HTTPS 连接。

远程 SSH Server 不需要映射到容器或宿主机。不要在日志、Issue、备份外链或截图中暴露密码、私钥、passphrase、session cookie 或终端内容。

## Vault 与 host key

初始化时应用生成随机 Vault key，使用 Argon2id 从主密码派生的密钥加密保存；每台 Server 的认证材料再用 AES-256-GCM 独立加密。主密码不会落库。

首次连接出现 host key 时，必须核对页面显示的算法、地址和 SHA-256 指纹后明确选择“信任并连接”。已保存指纹变化会硬失败，不提供跳过校验按钮。若确实更换了远程 Server 的 host key，应先在安全管理流程中清理旧信任记录，再重新确认新指纹。

## 本地开发

```bash
npm install
npm run dev
```

开发服务器使用 Vite `5173` 和 Fastify `3000`，Vite 会代理 `/api` 与 `/ws`。生产构建和启动：

```bash
npm run build
DATA_DIR=.local-data NODE_ENV=test TRUSTED_ORIGINS=http://127.0.0.1:4173 PORT=4173 npm start
```

开发模式未显式设置 `TRUSTED_ORIGINS` 时，会自动信任 localhost、回环地址、`0.0.0.0` 和本机网卡地址对应的 Vite 端口；生产模式仍必须显式配置完整浏览器 origin。

验证命令：

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

## 威胁模型边界

此版本是单 Vault、单用户实例，不包含云同步、账号注册、团队 RBAC、SFTP、端口转发或跳板机。数据库和备份只得到静态加密保护；能够控制一个已解锁容器、Node 进程或其运行用户的攻击者，可能读取活动会话正在使用的凭据。因此应保护宿主机、Docker socket、`/data` 备份和反向代理管理面，并在离开设备时锁定 Vault。

应用日志只记录脱敏的请求、连接状态和错误代码，不记录终端输入输出、完整 WebSocket 消息或认证材料。短暂浏览器断线可在会话保留窗口内重连；应用进程重启不承诺远程 shell 继续存在。
