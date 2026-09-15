# SSH 跨产品迁移说明

## 入口

在右上角“偏好设置”中打开“工作区与加密数据”。

- “加密数据”是本产品的 `webssh-vault` 完整备份，使用独立导出密码，不能与其它 SSH 客户端互通。
- “跨产品迁移”用于导入其它客户端的 SSH/SFTP 配置，并提供 OpenSSH config 和通用 CSV 标准导出。

## 支持的导入

| 来源 | 文件 | 会迁移的字段 | 凭据行为 |
| --- | --- | --- | --- |
| OpenSSH | `config`、`ssh_config`、ZIP | Host、HostName、Port、User、IdentityFile、ProxyJump | 密钥路径可与同批次上传的私钥文件自动绑定；OpenSSH 本身不含密码 |
| Termius / 通用 CSV | `.csv` | 名称、地址、端口、用户、分组、标签、密码、私钥/路径、跳板引用 | 明文 CSV 密码只在当前导入请求内加密写入 Vault |
| MobaXterm | `.mxtsessions`、`MobaXterm.ini` | SSH/SFTP 会话、目录、端口、用户、私钥路径、gateway | `.mobaconf` 或受保护密码无法读取时显示“需补录” |
| Xshell | `.xsh` | SSH 主机、端口、用户、私钥路径、代理/gateway | 不解码 Xshell 保护字段，显示“需补录” |
| SecureCRT | XML 导出、session `.ini` | SSH session、目录、端口、用户、私钥路径、Firewall | 不解码 SecureCRT 保护字段，显示“需补录” |

## 导入规则

1. 上传后先预览，系统显示识别格式、记录数、分组、重复/冲突、跳板解析和凭据状态。
2. 默认只选择凭据完整且跳板链可解析的记录；不完整记录可补录密码或私钥，也可以取消选择。
3. 冲突默认跳过；“创建为新服务器”和“替换现有服务器”必须在预览后显式选择。
4. 上传的文件、源密码、补录凭据只保留在短生命周期的服务端预览上下文和当前请求中，不写入浏览器持久化存储、日志或活动日志。
5. ZIP 只读取允许的配置、CSV、会话和私钥文件，不写入服务器持久目录；压缩包路径穿越和超限文件会被拒绝。

## 标准导出

- OpenSSH config：导出别名、地址、非默认端口、用户、私钥路径和 `ProxyJump`，不导出密码。
- 通用 CSV：固定列为 `name,address,port,username,authType,identityFile,group,tags,jumpHosts`；默认不含密码。
- 勾选“包含密码导出”后，CSV 才会增加 `password` 列。密码导出需要明确确认，下载完成后前端清理临时状态。

厂商专用导出文件（如 MobaXterm、Xshell、SecureCRT 原生格式）暂不生成，避免把自有格式伪装成通用标准；如有需要，可在统一交换模型上增加独立适配器。
