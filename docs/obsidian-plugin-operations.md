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
- `hit` 是命中材料，不是文件定位符。Full Tier 的弱关系没有引句时允许 `hit: ""`；不得用 `notePath` 兜底。面板和 Handoff 也会隐藏旧 Session Record 中的路径型 hit，不修改历史反馈或选择。

## Trace 与开发安装

- Advanced → **Trace directory** 设置 JSON 保存目录；留空关闭。当前本机使用 `/Users/hong/Downloads/Pi/traces`，不在 Obsidian vault 内。文件含有限的源笔记摘录，应按私有资料处理。
- 插件每轮返回结果后写 trace，面板显示可展开的保存路径。写入失败会显示警告，保留已经完成的搜索结果。进程退出或管线抛出未返回结果的异常仍可能没有完整 trace。
- 文件名统一为 `标题__YYYYMMDD-HHmmss.json`（本机时区），同秒同名时追加 `-2`、`-3`，不再拼接路径 hash、毫秒数或 UUID。JSON 内的 `generated_at` 使用 ISO 时间。
- 每个 Session Round 的 `trace: { path, origin }` 保存独立引用，不受 warning 数量截断影响；失败轮次也保留引用。`data.json` 仍只保存候选、标注与引用，不塞入完整 trace。Full Tier trace 保存完整结构化 query 与执行文本，并以 `q1`、`q2` 等区分同 kind 查询。
- 历史改名工具：`node scripts/dev/rename-traces.mjs traces` 默认只预览；`--apply` 会先备份和保存映射，再改名，不重写 JSON 证据。运行中的插件应通过自身的 `saveSettings()` 更新 Session Store 引用，不能与插件并发覆盖 `data.json`。
- `scripts/dev/run-batch-vault.mjs` 同样读取该设置并写入 trace，标记 `origin: "batch"`；界面触发的运行标记 `origin: "plugin"`。历史缺失的 trace 不能从 Session Store 还原为完整检索过程，不做伪造回填。
- `npm run build` 只生成本仓库构建，不会安装到真实 vault。`npm run dev:install` 构建并安装到 `~/Obsidian Notes/.obsidian/plugins/aha-memory-surface-dev`，不覆盖 `data.json` 或正式插件。随后执行 `obsidian plugin:reload id=aha-memory-surface-dev`；其他 vault 可通过 `AHA_DEV_VAULT_ROOT` 指定。
- 2026-08-30 排查：真实 vault 启用的 Dev 构建尚无 `surprise`，但 Git 提交 `83b72a3` 已包含该按钮。旧代码还把缺失 hit 回填为候选路径；批量入口只写 Session Store、不写 trace。这些分别通过真实界面检查、Judge/Handoff 回归和批量 trace 回归复现。当天 21:40、21:42 的界面搜索已有 trace，不能把历史缺口概括为插件全面停止写入。
- 同日 trace 重放进一步发现 QMD 把空格/标点转换为连字符，导致 URI 对应的真实笔记在路径过滤时丢失。现在逐级解析完整路径，只接受唯一匹配，保留 realpath 的 vault 边界、歧义拒绝和源笔记排除；插件和批量共享该逻辑。同一份原始召回重放，池从 19 恢复到 40，新增 21 篇，源笔记仍被排除。这是路径修复结果，不是 query 优化效果。

## 批量启动门槛

- **批量笔记清单必须由用户确认，确认前只允许列单和 dry-run。** 本次没有启动正式批量，也没有擅自选择新笔记。
- CLI 批量写入的是指定 plugin id 的 Session Store；必须与随后打开的插件一致（本机当前为 `aha-memory-surface-dev`）。执行期间停用该插件或关闭 Obsidian，避免后台插件覆盖批量结果；完成后重新启用/重载，再打开对应源笔记的 Aha Panel，无需手动导入。
- 标注按钮直接保存到该源笔记的 Session Record，`surprise` 与 `accept/noise` 独立。完整 trace 留在配置目录，Panel 候选与反馈留在 `data.json`。生成模型的 relation 不是用户金标准，不能据此宣称准确率。
- 已保存的按钮使用高亮与 `✓` 显示，并设置 `aria-pressed`；重新打开 Panel 或重载插件后从反馈恢复。`surprise` 独立高亮，`accept/noise` 取最近一次分类。重复点击当前高亮动作不会重复记录，保存中暂时禁用同一候选的反馈按钮；保存失败不会更新高亮。所有可点击控件使用手形光标。
- 2026-08-30 用户已授权本次重跑 `个人复盘/2026月复盘/8月` 下除 `2026-08-01 离家回京独自一人没法从根本改变什么.md` 外的全部笔记；执行前按文件列表固定本次范围，不以旧结果是否存在跳过。

## 身份与幂等

- Session Record 以 Source Note Identity 为主键：桌面本地文件系统可用时使用 inode 级身份，因此 source note 改名、编辑大小或 mtime 变化后仍复用同一条记录；降级到 ctime 身份时要求 `source_path` 同时匹配，避免同时间戳碰撞。
- 路径归一化统一处理 qmd URI 的标点混写（全角标点、弯引号、撇号、破折号），默认大小写不敏感，匹配 macOS/Obsidian vault 行为。
- Session Store（`data.json`）是唯一状态底座（[ADR 0004](./adr/0004-use-session-store-for-aha-panel-state.md)）；Review Note（Markdown 导出/解析、`Aha: Export Review Note` 命令、`legacy-review-migration.mjs`）已整体移除，不再有任何形式的 vault 内 Markdown 状态文件。

## 配置

- DeepSeek 是唯一 API provider（OpenAI 已移除）：默认 `baseUrl=https://api.deepseek.com`、`model=deepseek-v4-pro`。设置页的 `Test DeepSeek` 会发一个最小 JSON 请求，同时验证网络、鉴权、endpoint 与 model ID。
- 直接填写的 API key 保存在当前 vault 的 Obsidian 插件数据中；留空则读取 `DEEPSEEK_API_KEY`。不要把 `.obsidian/plugins/.../data.json` 提交到仓库。
- QMD 默认走 SDK runner；`qmdCommand` 保留用于 SDK module 推导和 CLI fallback。QMD 的 index 是按名字独立的 sqlite 文件，重建 Obsidian 索引需显式 `qmd update --index obsidian && qmd embed --index obsidian`。
