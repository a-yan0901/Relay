# Relay Windows client boundary

`electron-main.ts`、`electron-preload.ts`、`application.ts` 和 `local-runtime.ts` 组成桌面客户端：renderer 只拿到 `relayDesktop.invoke/subscribe`，本地 SQLite/Vault/ssh2/SFTP 在 main 侧运行，不启动 Fastify、不监听 HTTP、不使用 Web cookie。文件下载使用 main 侧临时文件和系统保存对话框，按块写入，不在 renderer 聚合完整文件。

本地开发命令：

```bash
npm run build:windows
npm run dev:windows
npm run package:windows:portable
```

`npm run package:windows` 会先检查并准备 `node_modules/electron/dist`，再生成 NSIS 与 portable x64 包；这一步覆盖了 `npm ci` 未自动下载 Electron runtime 的干净环境。实际安装、升级、退出重开、原生 ABI（`better-sqlite3`、`argon2`、`ssh2`）、签名和无监听端口检查仍应在 Windows CI/开发机完成后，才把 Windows 任务标记为完成。开发机内存有限时保持 Gradle/Node 构建串行，不要并发运行 Web、Electron 打包和测试。

`package:windows:portable` 是 Linux/macOS 预览用的单文件 portable 构建，跳过本机 native dependency rebuild，并输出到 `dist/releases-portable-preview/`；它不能替代 Windows 主机上的 ABI、安装器和升级验证。

仓库中的 `.github/workflows/windows-package.yml` 可通过 `workflow_dispatch` 或 `v*` 标签触发 Windows CI 打包。工作流在 Windows runner 上执行 typecheck、lint、NSIS/Portable 打包，并生成包含大小、SHA-256 和 Authenticode 状态的 `release-manifest.json`，再上传 90 天受控制品。`NotSigned` 只会如实记录，不能替代配置证书后的签名发布门禁。

renderer 不得通过 preload 获取任意 Node API；所有新增 native 能力必须先进入 `apps/windows/ipc-contract.ts` 的 allowlist，并保持单次 IPC frame 不超过 64 KiB。

Vault 导入按 32 KiB IPC 块写入有界二进制收集器，最多保留 8 MiB，完成时只做一次 UTF-8 组装；原生 Vault 导出在有文件写入句柄时按块直接落盘，避免 renderer 同时持有完整 bundle 和 `Uint8Array`。窗口导航只允许当前打包的 renderer 文件，任意其它 `file://` 或外部 URL 均被拦截。
