# Relay Windows client boundary

`electron-main.ts`、`electron-preload.ts`、`application.ts` 和 `local-runtime.ts` 组成桌面客户端：renderer 只拿到 `relayDesktop.invoke/subscribe`，本地 SQLite/Vault/ssh2/SFTP 在 main 侧运行，不启动 Fastify、不监听 HTTP、不使用 Web cookie。文件下载使用 main 侧临时文件和系统保存对话框，按块写入，不在 renderer 聚合完整文件。

本地开发命令：

```bash
npm run build:windows
npm run dev:windows
```

`npm run package:windows` 生成 NSIS 与 portable x64 包，实际安装、升级、退出重开、原生 ABI（`better-sqlite3`、`argon2`、`ssh2`）、签名和无监听端口检查仍应在 Windows CI/开发机完成后，才把 Windows 任务标记为完成。开发机内存有限时保持 Gradle/Node 构建串行，不要并发运行 Web、Electron 打包和测试。

renderer 不得通过 preload 获取任意 Node API；所有新增 native 能力必须先进入 `apps/windows/ipc-contract.ts` 的 allowlist，并保持单次 IPC frame 不超过 64 KiB。
