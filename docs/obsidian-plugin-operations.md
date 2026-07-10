# Obsidian 插件运行细节

面向开发与排障的运行约束说明。产品定位与架构见根目录 [README](../README.md)。

## 失败处理与可见性

- Relation Judge、QMD、wrapper 传输或超时失败不会伪装成成功轮次；wrapper 会保留结构化 `{ ok:false, error:{ message, tool, details } }`，插件会把它写成 failed search record。
- 搜索开始、成功或失败都会更新当前 source note 对应的 Session Record；Panel 从这里显示最新状态。Review Note 不再是默认运行依赖，只有显式导出时才生成。
- OpenAI 请求带传输层重试（退避 2 次），仅对网络错误与 408/429/5xx 重试；失败信息包含尝试次数与代理来源。

## 环境与进程

- Obsidian 桌面 App 的 PATH 可能没有 Node；插件会优先用设置里的 Node command，其次自动探测常见桌面安装路径，并用 Node 显式执行 wrapper，不再依赖 `#!/usr/bin/env node`。
- OpenAI HTTPS 请求优先走 Node 内置请求；如果本地代理导致 Node TLS 握手被 reset，wrapper 会读取 `HTTPS_PROXY` / macOS 系统代理（scutil）并用 curl fallback 发起同一请求。共享代理解析位于 `scripts/lib/https-proxy.mjs`，对 loopback 与 http 目标永不代理。
- CLI 和插件侧外部进程都关闭 stdin、设置超时，并限制 stdout/stderr 缓冲大小。
- LLM 生成的多条 QMD plan query 会逐条执行，避免多个 QMD 检索争用 QMD/SQLite runtime；单条默认 30 秒超时。SDK runner 默认关闭 QMD 内部 rerank；CLI fallback 会给 QMD 传 `-C 20` 限制内部候选数。某条 QMD 慢或卡住时会作为 warning 保留，不会自动降级到 `qmd vsearch`。

## 候选安全与过滤

- 候选正文读取只允许 `qmd://obsidian/...` 或 vault 内真实路径，避免把 vault 外文件内容带入 Relation Judge prompt。
- wrapper 会过滤可选的 Aha Review Note 导出和 `Aha/Reviews/` 生成物；共享排除目录默认还包含 `templates/`，可用 `AHA_EXCLUDED_FOLDERS` 扩展（见 `scripts/lib/candidate-fields.mjs`）。
- `--target-candidates` 在 wrapper CLI 层也会限制到 15-20，和插件 UI slider 保持一致。

## 身份与幂等

- Session Store 以 source note identity 为主键；桌面本地文件系统可用时使用 inode 级身份，降级到 ctime 时同时核对 `source_path`，避免碰撞污染别的 session。
- Rerun 会刷新模型生成的 relation 内容，但保留重复候选的 feedback 与 handoff selection。显式导出的 Review Note 仍使用 marker-backed 区块，marker 外人工内容不会被删除。
- wrapper 的 note identity 默认大小写不敏感，匹配 macOS/Obsidian vault 常用行为；路径归一化统一处理 qmd URI 的标点混写（全角标点、弯引号、撇号、破折号），避免同一笔记以多种路径形态出现。

## 配置

- 插件默认使用 OpenAI-compatible API 做 query plan 与 Relation Judge：`provider=openai`、`baseUrl=https://api.openai.com/v1`。API key 可填在插件设置里（注入 wrapper 子进程环境），留空则回退读取本地环境变量（默认 `OPENAI_API_KEY`）。
- 直接填写在插件里的 API key 保存在当前 vault 的 Obsidian 插件数据中，只用于本机运行；不要把 `.obsidian/plugins/.../data.json` 提交到仓库。
- 同一个 plugin data 文件还保存紧凑 Session Store。它是 Panel 状态和 feedback 的 source of truth，不保存 PipelineTrace；评测收集器默认从这里生成 ignored development draft seeds。
- QMD 默认走 SDK runner；`qmdCommand` 保留用于 SDK module 推导和 CLI fallback。注意：QMD 的 index 是按名字独立的 sqlite 文件，重建 Obsidian 索引需显式 `qmd update --index obsidian && qmd embed --index obsidian`。

## Pi Extension（历史形态）

`insight-package/` 保留了最初的 Pi Extension 实现（`/insight` 会话流），作为运行时参考不再演进。session 保存在 `~/.pi/agent/insights/`（或 `$PI_CODING_AGENT_DIR/insights/`），支持 `/insight list` / `resume <session>` / `current`。
