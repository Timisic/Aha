# Aha Obsidian 插件 Smoke

这条 smoke 用来验证第一版 Obsidian 插件 MVP。它不迁移、不删除现有 `insight-package/`；插件只作为 Memory Surface，检索编排和关系判断仍在 `scripts/aha/aha-wrapper.mjs`。

## 构建验证

```bash
cd obsidian-plugin
npm run verify
```

`verify` 会依次运行 TypeScript typecheck、wrapper/review-note 回归测试，以及 production build。

## 插件配置

把 `obsidian-plugin/` 安装或 symlink 到 Obsidian community plugin 目录后，在插件设置里配置：

- Aha workspace：当前仓库根目录。
- Review note location：默认 `Aha/Reviews`。
- Node command：可留空自动探测；如果 Obsidian 内运行时报 `env: node: No such file or directory`，填 `/opt/homebrew/bin/node`。
- Codex command：本机 Codex CLI 命令或绝对路径。
- QMD command：本机 QMD CLI 命令或绝对路径。
- Obsidian CLI command：本机 Obsidian CLI 命令或绝对路径。

第一次真实检索前，先在命令面板运行 `Aha: Check local readiness`。

## 默认 pipeline 语义

wrapper 默认使用 bounded `pipeline`：

```text
Codex 生成 3-5 条 QMD query
-> wrapper 混合 QMD 检索与 Obsidian links/backlinks
-> 合并、去 source self-hit、按分数/排名/跨 query 多样性重排
-> 只读取 qmd://obsidian 或 vault 内候选正文
-> bounded Relation Judge 判断 supports/challenges/resembles/bounds/weak
```

重要失败语义：

- Relation Judge、QMD、wrapper 传输或超时失败会返回结构化 `{ ok:false, error:{ message, tool, details } }`，不会伪装成成功搜索轮次。
- Obsidian 桌面 App 的 PATH 往往比终端更窄；插件会用显式 Node command 或常见 Node 路径来执行 wrapper，不再直接依赖 wrapper shebang。
- wrapper 会过滤当前 Aha Review Note 和 `Aha/Reviews/` 生成物；如果 QMD 全部失败，搜索应该失败并保留诊断，而不是把 review shell 当成成功候选。
- QMD plan queries 并发执行，单条默认 20 秒超时。慢查询会出现在 warning 中，避免多条 120 秒 timeout 串行累积。
- QMD / Obsidian / Codex 子进程都会关闭 stdin、设置超时，并限制 stdout/stderr 缓冲。
- 搜索开始时，Review Note 的 `## Search Results` 会马上出现 `Running Search Round`。如果 wrapper 失败，失败记录也追加在同一个 Search Results marker 区块里。
- `--target-candidates` 在 CLI 层限制到 15-20，和插件 UI slider 保持一致。
- Aha Review Note frontmatter 写入 `source_id`；桌面本地文件系统可用时使用 inode 级身份，可跨 source note 改名、编辑大小或 mtime 变化复用 review note。若降级到 ctime 身份，则必须同时匹配 `source_path`，避免同时间戳碰撞污染别的 review note。
- Search Results / Selected Memories / Grill Handoff 使用 `<!-- aha:* -->` marker 追加生成内容，避免用户改标题或添加手写内容时被整段覆盖。

## 成功 smoke

1. 在桌面 Obsidian vault 中打开一篇真实 Markdown source note。
2. 运行 `Aha: Search from current note`。
3. 确认 `Aha/Reviews/` 下创建或复用了一个 Aha Review Note。
4. 确认检索完成后 review note 被打开。
5. 确认 `## Search Results` 下追加了新的 `### Search Round`，并包含候选、relation、hit、why 和 quote-backed strong relation。
6. 确认 `## Selected Memories` 与 `## Grill Handoff` 下也追加了对应轮次内容。
7. 确认 review note frontmatter 有 `source_id`。
8. 再运行一次搜索，确认旧的人工记录、Selected Memories 和 Grill Handoff 内容没有被删除。
9. 从 review note 点击候选 `Open` 按钮，或运行 `Aha: Open candidate under cursor in new tab`。
10. 确认候选笔记在新的 Obsidian leaf/tab 打开，source insight note 没有被替换。

## 失败 smoke

1. 临时把 QMD command 改成 `/missing/qmd`。
2. 运行 `Aha: Search from current note`。
3. 确认 Aha Review Note 仍保留。
4. 确认 review note 追加了 visible failed search record，并写明失败 prerequisite。
5. 恢复 QMD command，重新运行 `Aha: Check local readiness`。

## Relation Judge 失败 smoke

1. 临时把 Codex command 指向一个会在 relation-judge 阶段非零退出的本地脚本。
2. 运行 `Aha: Search from current note`。
3. 确认 wrapper 输出或 review note failure record 中是 `{ ok:false, error:{ message, tool, details } }` 语义，而不是 weak candidates 的成功轮次。
4. 恢复 Codex command。

## Fixture smoke

如果只想检查插件 UI，不运行 Codex/QMD，可以在设置里开启 `Use fixture result`。该模式会把 `scripts/aha/fixtures/stub-result.json` 渲染到 review note，用于验证 review-note 渲染和候选打开行为。
