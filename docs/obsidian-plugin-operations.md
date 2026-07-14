# Obsidian 插件运行细节

面向开发与排障的运行约束说明。产品定位与架构见根目录 [README](../README.md)。

## 失败处理与可见性

- Relation Judge、QMD、wrapper 传输或超时失败不会伪装成成功轮次；wrapper 会保留结构化 `{ ok:false, error:{ message, tool, details } }`，插件会把它写成 failed search record。
- 搜索开始时插件会立即把 running record 写入 Review Note 的 Search Results 区块；成功或失败退出后替换为最新结果，避免后台状态不可见，同时不把 review note 变成追加式审计日志。
- OpenAI 与 DeepSeek 请求共享同一套传输层重试（退避 2 次），仅对网络错误与 408/429/5xx 重试；失败信息包含尝试次数与代理来源。

## 环境与进程

- Obsidian 桌面 App 的 PATH 可能没有 Node；插件会优先用设置里的 Node command，其次自动探测常见桌面安装路径，并用 Node 显式执行 wrapper，不再依赖 `#!/usr/bin/env node`。
- API HTTPS 请求统一通过受控 curl transport 发起；wrapper 会读取 `HTTPS_PROXY` 或 macOS 系统代理（scutil），把代理与鉴权写入权限为 `0600` 的临时 curl config，没有代理时显式使用 `--noproxy '*'`，避免 Obsidian GUI 环境因缺少代理变量而误走受污染的直连 DNS。共享代理解析位于 `scripts/lib/https-proxy.mjs`，对 loopback 与 http 测试端点永不代理。
- CLI 和插件侧外部进程都关闭 stdin、设置超时，并限制 stdout/stderr 缓冲大小。
- LLM 生成的多条 QMD plan query 会逐条执行，避免多个 QMD 检索争用 QMD/SQLite runtime；单条默认 30 秒超时。SDK runner 默认关闭 QMD 内部 rerank；CLI fallback 会给 QMD 传 `-C 20` 限制内部候选数。某条 QMD 慢或卡住时会作为 warning 保留，不会自动降级到 `qmd vsearch`。
- Query planner 生成 3-5 条改写查询后，runtime 会额外追加 1 条由原 source note 确定性构造的 `source_fallback` 查询；模型改写不能覆盖或挤掉这条原文兜底。

## 候选安全与过滤

- 候选正文读取只允许 `qmd://obsidian/...` 或 vault 内真实路径，避免把 vault 外文件内容带入 Relation Judge prompt。
- wrapper 会过滤当前 Aha Review Note 和 `Aha/Reviews/` 生成物；共享排除目录默认还包含 `templates/`，可用 `AHA_EXCLUDED_FOLDERS` 扩展（见 `scripts/lib/candidate-fields.mjs`）。
- `--target-candidates` 在 wrapper CLI 层也会限制到 15-20，和插件 UI slider 保持一致。

## 身份与幂等

- Aha Review Note 会在 frontmatter 写入 `source_id`；桌面本地文件系统可用时使用 inode 级身份，因此 source note 改名、编辑大小或 mtime 变化后仍可复用同一个 review note。若只能降级到 ctime 身份，插件会要求 `source_path` 同时匹配，避免同时间戳碰撞污染别的 review note。
- Aha Review Note 的生成区块采用 marker-backed 替换语义；重新运行只保留最新 Search Results / Selected Memories / Grill Handoff，marker 外的人工记录不会被删除。
- wrapper 的 note identity 默认大小写不敏感，匹配 macOS/Obsidian vault 常用行为；路径归一化统一处理 qmd URI 的标点混写（全角标点、弯引号、撇号、破折号），避免同一笔记以多种路径形态出现。

## 配置

- 插件可在 OpenAI 与 DeepSeek 两套独立 profile 间切换。OpenAI 默认 `baseUrl=https://api.openai.com/v1`、`model=gpt-5.5`，走 Responses API；DeepSeek 默认 `baseUrl=https://api.deepseek.com`、`model=deepseek-v4-pro`，走 Chat Completions JSON mode。
- DeepSeek `deepseek-v4-pro` 请求显式传 `thinking: { type: "disabled" }`；query planning 和 Relation Judge 默认使用非思考模式，避免不必要的延迟与 reasoning token。
- 两套 profile 分别保存 base URL、model、API key 与 key env；切换 provider 不会覆盖另一套配置。设置页的 `Test OpenAI` / `Test DeepSeek` 会向对应模型发出最小 JSON 请求，同时验证网络、鉴权、endpoint 和模型可用性。
- 直接填写在插件里的 API key 保存在当前 vault 的 Obsidian 插件数据中，只注入对应 provider 的 wrapper 子进程环境，不进入 argv；留空则分别读取 `OPENAI_API_KEY` / `DEEPSEEK_API_KEY`。不要把 `.obsidian/plugins/.../data.json` 提交到仓库。
- QMD 默认走 SDK runner；`qmdCommand` 保留用于 SDK module 推导和 CLI fallback。注意：QMD 的 index 是按名字独立的 sqlite 文件，重建 Obsidian 索引需显式 `qmd update --index obsidian && qmd embed --index obsidian`。

## Pi Extension（历史形态）

`insight-package/` 保留了最初的 Pi Extension 实现（`/insight` 会话流），作为运行时参考不再演进。session 保存在 `~/.pi/agent/insights/`（或 `$PI_CODING_AGENT_DIR/insights/`），支持 `/insight list` / `resume <session>` / `current`。
