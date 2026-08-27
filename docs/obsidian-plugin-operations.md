# Obsidian 插件运行细节

面向开发与排障的运行约束说明。产品定位与架构见根目录 [README](../README.md)。

主路径：插件在进程内直接调用 `src/core/`，不再 spawn wrapper 子进程。遗留 wrapper 仅在 `useLegacyWrapper`（隐藏开关，默认关）下才会被启动；Codex CLI（曾经的另一个 LLM provider 选项）已整体移除，DeepSeek 是唯一 provider。

## 失败可见性与降级

- 每轮搜索先写入 running 记录，结束后被 success 或 failed 记录替换；失败保留结构化 `{ ok:false, error:{ message, tool, details } }`，不会伪装成成功轮次。记录写在 Session Store 的 Search Round History 里，不写进 vault。
- Capability Tier 按轮次决定：无检索后端走 Neighborhood，无 LLM 走 Recall，两者都在走 Full。
- Runtime Tier Fallback：Full 轮次中途丢失 LLM 时，落到 Recall 结果（`ok:true`，候选 relation 全为 `weak`），并在 `error` 里保留失败原因；检索本身没产出候选时才算真失败。

## 传输与外部进程

- LLM 走 DeepSeek Chat Completions JSON mode，经 Obsidian `requestUrl` 发出（Chromium 网络栈，自动遵循系统代理）。重试最多 3 次，只对网络错误与 408/429/5xx 重试，失败信息带尝试次数。请求显式传 `thinking: { type: "disabled" }`。
- QMD 由插件自身的桌面 Node runtime 直接 spawn qmd 二进制：关闭 stdin、超时后 SIGTERM/SIGKILL、限制 stdout/stderr 大小。
- LLM 生成的多条 QMD plan query 逐条执行，避免争用 QMD/SQLite runtime；单条默认 30 秒超时。SDK runner 默认关闭 QMD 内部 rerank，CLI fallback 传 `-C 20`。某条 QMD 慢或卡住作为 warning 保留，不会自动降级到 `qmd vsearch`。
- Query planner 生成 3-5 条改写查询后，runtime 额外追加 1 条由原 source note 确定性构造的 `source_fallback` 查询；模型改写不能挤掉这条原文兜底。
- 只有遗留 wrapper 路径才需要 Node 可执行文件：Obsidian 桌面 App 的 PATH 可能没有 Node，插件会优先用设置里的 Node command，其次探测常见安装路径。该路径的 HTTPS 请求走受控 curl transport（代理写入权限 `0600` 的临时 config，无代理时 `--noproxy '*'`），共享解析在 `scripts/lib/https-proxy.mjs`。

## 候选边界与过滤

- 候选正文读取只允许 `qmd://obsidian/...` 或 vault 内真实路径（realpath 校验），避免把 vault 外文件内容带入 Relation Judge prompt。
- 默认排除目录为 `templates`、`Aha/Reviews`（`DEFAULT_EXCLUDED_CANDIDATE_FOLDERS` in `core/candidates.ts`），可用设置里的 Excluded folders 或 Node 侧的 `AHA_EXCLUDED_FOLDERS` 扩展。
- 目标候选数在设置 slider 与 wrapper CLI 层都限制在 15-20。

## 身份与幂等

- Session Record 以 Source Note Identity 为主键：桌面本地文件系统可用时使用 inode 级身份，因此 source note 改名、编辑大小或 mtime 变化后仍复用同一条记录；降级到 ctime 身份时要求 `source_path` 同时匹配，避免同时间戳碰撞。
- 路径归一化统一处理 qmd URI 的标点混写（全角标点、弯引号、撇号、破折号），默认大小写不敏感，匹配 macOS/Obsidian vault 行为。
- Session Store（`data.json`）是唯一状态底座（[ADR 0004](./adr/0004-use-session-store-for-aha-panel-state.md)）；Review Note（Markdown 导出/解析、`Aha: Export Review Note` 命令、`legacy-review-migration.mjs`）已整体移除，不再有任何形式的 vault 内 Markdown 状态文件。

## 配置

- DeepSeek 是唯一 API provider（OpenAI 已移除）：默认 `baseUrl=https://api.deepseek.com`、`model=deepseek-v4-pro`。设置页的 `Test DeepSeek` 会发一个最小 JSON 请求，同时验证网络、鉴权、endpoint 与 model ID。
- 直接填写的 API key 保存在当前 vault 的 Obsidian 插件数据中；留空则读取 `DEEPSEEK_API_KEY`。不要把 `.obsidian/plugins/.../data.json` 提交到仓库。
- QMD 默认走 SDK runner；`qmdCommand` 保留用于 SDK module 推导和 CLI fallback。QMD 的 index 是按名字独立的 sqlite 文件，重建 Obsidian 索引需显式 `qmd update --index obsidian && qmd embed --index obsidian`。
