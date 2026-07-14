# Aha Obsidian 插件 Smoke

这条 smoke 用来验证第一版 Obsidian 插件 MVP。插件只作为 Memory Surface，检索编排和关系判断在 `scripts/aha/run-insight-search.mjs`。

## 构建验证

```bash
npm ci
npm ci --prefix obsidian-plugin
npm run verify
```

根目录 `verify` 会依次运行脚本 lint、脚本语法检查、TypeScript typecheck、wrapper/review-note 回归测试，以及 production build。

## 插件配置

把 `obsidian-plugin/` 安装或 symlink 到 Obsidian community plugin 目录后，在插件设置里配置：

- Aha workspace：当前仓库根目录。
- Review note location：默认 `Aha/Reviews`。
- Node command：可留空自动探测；如果 Obsidian 内运行时报 `env: node: No such file or directory`，填 `/opt/homebrew/bin/node`。
- LLM provider：可选 `OpenAI API`、`DeepSeek API` 或 `Codex CLI`。OpenAI 与 DeepSeek 的配置独立保存，切换不会覆盖另一方。
- OpenAI：Base URL 默认 `https://api.openai.com/v1`，Model 默认 `gpt-5.5`，key env 默认 `OPENAI_API_KEY`。
- DeepSeek：Base URL 默认 `https://api.deepseek.com`，Model 默认 `deepseek-v4-pro`，key env 默认 `DEEPSEEK_API_KEY`；请求显式关闭 thinking。
- API key 可直接填在插件设置里；插件只把当前 provider 的 key 注入 wrapper 子进程环境，不作为 CLI 参数传递。直接 key 保存在当前 vault 的 Obsidian 插件数据中。
- 每套 API 配置下都有检测按钮，向所选模型发出最小 JSON 请求，验证网络、鉴权、endpoint 与 model ID。
- API 网络统一使用受控代理配置和有限重试的 curl transport；macOS GUI 环境会从 `HTTPS_PROXY` 或系统代理读取代理地址，并放入权限为 `0600` 的临时 config，不会在 fallback 时静默改走直连，也不会把代理凭据暴露在 argv。
- Codex command：本机 Codex CLI 命令或绝对路径，仅在 LLM provider 设为 `Codex CLI` 时使用。
- QMD runner：默认 `SDK`；`CLI` 保留为诊断和 fallback。
- QMD command：本机 QMD CLI 命令或绝对路径。SDK runner 会优先 import `@tobilu/qmd`，失败后可用该路径推导 SDK module。
- QMD rerank：默认关闭；Aha 会在混合召回后自己评分重排，再让 Relation Judge 读候选正文。
- Obsidian CLI command：本机 Obsidian CLI 命令或绝对路径。

第一次真实检索前，先在命令面板运行 `Aha: Check local readiness`。

## 默认 pipeline 语义

search runner 默认使用 bounded `pipeline`：

```text
OpenAI/DeepSeek/Codex 生成 3-5 条改写 QMD query
-> runtime 追加 1 条保留原 source note 表达的确定性 fallback query
-> search runner 通过 QMD SDK/CLI 混合语义检索与 Obsidian links/backlinks
-> 合并、去 source self-hit、按分数/排名/跨 query 多样性重排
-> 只读取 qmd://obsidian 或 vault 内候选正文
-> bounded Relation Judge 判断 supports/challenges/resembles/bounds/weak
```

重要失败语义：

- Relation Judge、QMD、wrapper 传输或超时失败会返回结构化 `{ ok:false, error:{ message, tool, details } }`，不会伪装成成功搜索轮次。
- Obsidian 桌面 App 的 PATH 往往比终端更窄；插件会用显式 Node command 或常见 Node 路径来执行 wrapper，不再直接依赖 wrapper shebang。
- search runner 会过滤当前 Aha Review Note 和 `Aha/Reviews/` 生成物；如果 QMD 全部失败，搜索应该失败并保留诊断，而不是把 review shell 当成成功候选。
- QMD plan queries 逐条执行，避免多个 QMD 检索争用 QMD/SQLite runtime；单条默认 30 秒超时。SDK runner 默认不启用 QMD 内部 rerank，CLI fallback 会给 QMD 传 `-C 20` 限制内部候选数。慢查询会出现在 warning 中，避免旧版多条 120 秒 timeout 累积；search runner 不会自动降级到 `qmd vsearch`。
- QMD / Obsidian / Codex fallback 子进程都会关闭 stdin、设置超时，并限制 stdout/stderr 缓冲。
- 搜索开始时，Review Note 的 `## 搜索结果` 会马上出现 `正在检索` 记录。成功或失败后，同一个 marker 区块会被替换为最新结果，不保留旧搜索轮次作为审计日志。
- `--target-candidates` 在 CLI 层限制到 15-20，和插件 UI slider 保持一致。
- Aha Review Note frontmatter 写入 `source_id`；桌面本地文件系统可用时使用 inode 级身份，可跨 source note 改名、编辑大小或 mtime 变化复用 review note。若降级到 ctime 身份，则必须同时匹配 `source_path`，避免同时间戳碰撞污染别的 review note。
- Search Results / Selected Memories / Grill Handoff 使用 `<!-- aha:* -->` marker 管理生成内容；marker 内只保留最新轮次，marker 外的手写内容不会被覆盖。

## 成功 smoke

1. 在桌面 Obsidian vault 中打开一篇真实 Markdown source note。
2. 运行 `Aha: Search from current note`。
3. 确认 `Aha/Reviews/` 下创建或复用了一个 Aha Review Note。
4. 确认检索完成后右侧 Aha Review Panel 被打开或刷新，主编辑区不自动切到 Review Note。
5. 确认 `## 搜索结果` 下显示最新 `### 搜索轮次`，并包含候选、relation、hit、why 和 quote-backed strong relation。
6. 确认 `## 纳入 Handoff 的记忆` 与 `## Grill Handoff` 下也显示同一轮最新内容。
7. 确认 review note frontmatter 有 `source_id`。
8. 在 panel 中取消或勾选一个候选，确认 Review Note 的最新 Selected Memories checkbox 与 Grill Handoff 同步更新。
9. 从 panel 点击候选旧笔记标题，确认候选笔记在新的 Obsidian tab 打开。
10. 点击 `复制 handoff`，确认剪贴板包含当前勾选候选。
11. 再运行一次搜索，确认旧搜索轮次被替换，marker 外的人工记录没有被删除。

## 失败 smoke

1. 临时把 QMD runner 改成 `CLI`，并把 QMD command 改成 `/missing/qmd`。
2. 运行 `Aha: Search from current note`。
3. 确认 Aha Review Note 仍保留。
4. 确认 review note 显示最新 visible failed search record，并写明失败 prerequisite。
5. 恢复 QMD runner 与 QMD command，重新运行 `Aha: Check local readiness`。

## OpenAI key 失败 smoke

1. 保持 LLM provider 为 `OpenAI API`，临时清空 OpenAI API key 字段，并把 OpenAI key env 改成一个不存在的变量名，例如 `AHA_MISSING_OPENAI_KEY`.
2. 运行 `Aha: Check local readiness`。
3. 确认 readiness 显示 `OpenAI API key` 失败，且不会要求 Codex CLI 通过。
4. 恢复 OpenAI API key，或恢复 OpenAI key env 为 `OPENAI_API_KEY`。

## Provider 切换与连接检测 smoke

1. 在设置页选择 `OpenAI API`，点击 `Test OpenAI`，确认提示包含当前 OpenAI model 且成功。
2. 切换到 `DeepSeek API`，确认 OpenAI 的 base URL、model 与 key 未被覆盖。
3. 点击 `Test DeepSeek`，确认提示包含当前 DeepSeek model 且成功。
4. 临时把 DeepSeek model 改成不存在的 ID，确认检测明确失败；恢复 model 后再次检测通过。
5. 在两个 provider 间往返切换并各跑一次真实 source note，确认 session record 标记的失败工具名与当前 provider 一致。

## Relation Judge 失败 smoke

1. 临时把 LLM provider 改成 `Codex CLI`，并把 Codex command 指向一个会在 relation-judge 阶段非零退出的本地脚本。
2. 运行 `Aha: Search from current note`。
3. 确认 wrapper 输出或 review note failure record 中是 `{ ok:false, error:{ message, tool, details } }` 语义，而不是 weak candidates 的成功轮次。
4. 恢复 LLM provider 与 Codex command。

## Fixture smoke

如果只想检查插件 UI，不运行 LLM/QMD，可以在设置里开启 `Use fixture result`。该模式会把 `scripts/aha/fixtures/stub-result.json` 渲染到 review note，用于验证 review-note 渲染和候选打开行为。
