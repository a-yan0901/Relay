# Relay Windows client boundary

`main.ts`、`preload.ts`、`application.ts` 和 `local-runtime.ts` 组成桌面客户端的可测试边界：renderer 只拿到 `relayDesktop.invoke/subscribe`，本地 SQLite/Vault/ssh2/SFTP 在 main/utility 侧运行，不启动 Fastify、不监听 HTTP、不使用 Web cookie。

当前工作区没有 Electron runtime、Windows 打包工具链或 Windows 主机，因此本目录先完成并验证 IPC、窗口安全策略、本地服务组合和共享 React runtime；真正的 Electron 安装包仍须在 Windows CI/开发机完成以下门禁：

1. 用 Electron 的 `contextBridge` 暴露 `createElectronPreloadApi`，将 `createWindowsDesktopApplication` 接到 `app.getPath('userData')`，并注入系统剪贴板。
2. 验证 `better-sqlite3`、`argon2`、`ssh2` 的目标 Electron ABI，启用签名打包和单实例锁。
3. 安装、升级、退出重开、Vault 恢复、Host Key/SSH/SFTP/传输和无监听端口检查通过后，才把 Windows 任务标记为完成。

renderer 不得通过 preload 获取任意 Node API；所有新增 native 能力必须先进入 `apps/windows/ipc-contract.ts` 的 allowlist，并保持单次 IPC frame 不超过 64 KiB。
