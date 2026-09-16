# AGENTS.md

## 环境陷阱：PATH 被覆盖

Codex CLI 启动时会把 PATH 改成只含它自己工具的目录，导致 `ls`、`python3`、`node`、`curl`、`git` 等基础命令在 `exec_command` 里全部 `command not found`。

修复：每条命令前加

```bash
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
```

每条 exec_command 是新 shell，不读 .bashrc，所以必须每条都加。

## 其他限制

- `apply_patch` 在本环境 unsupported
- `multi_agent_v1__spawn_agent` 在 default 模式不可用
- 没有持久化记忆工具

## 工具链（PATH 修复后）

Python 3.12 · Node 22 · curl · git · ffmpeg · make · gcc · jq · npm 全部可用。

## 任务完成、验证与提交

代码或文档任务完成后，按变更风险选择适当的验证，不默认执行项目全量验证：

- 纯文档、HTML/Markdown、配置或静态资源：检查文件存在、编码、语法/结构、引用/链接；影响页面展示时，补充必要的浏览器渲染或响应式检查。
- 单模块或低风险代码改动：执行受影响模块的 lint、类型检查和相关测试；涉及 API、协议或数据格式时，补充对应的集成测试。
- 只有重大或高风险改动才执行全量验证，典型包括跨模块或公共接口变更、核心流程变更、安全/认证/加密/权限变更、数据迁移、构建或依赖变更，以及可能影响全项目回归的行为变更。
- 如果影响范围不清楚，先做影响面判断；无法可靠判断时采用更高一级验证。验证范围应与变更风险匹配，避免为纯文档改动运行全项目测试。
- 如果同一范围的全量验证已经新鲜通过，且之后代码、依赖、环境、生成物和验证范围均未变化，提交前不要仅因通用流程重复执行验证。

验证通过后，提交前检查 `git status`、`git diff` 和 `git diff --check`，只提交当前任务相关改动。发现无法安全区分的既有改动时，先暂停并说明。

除非用户明确要求，只创建 git commit，不 push 到远端。
