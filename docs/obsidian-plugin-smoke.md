# Aha Obsidian 插件 Smoke

这条 smoke 验证当前产品路径：Obsidian 负责 Memory Surface，`scripts/aha/run-insight-search.mjs` 负责 shipped retrieval runtime，Session Store 保存 Panel 状态；Review Note 只在显式导出时生成。

## 构建验证

```bash
npm ci
npm ci --prefix obsidian-plugin
npm run verify
```

根目录 `verify` 覆盖脚本 lint/语法检查、wrapper 与评估测试、插件 typecheck/test/build。

## 插件配置

把 `obsidian-plugin/` 安装或 symlink 到 Obsidian community plugin 目录后，配置：

- Aha workspace：当前仓库根目录。
- Node command：可留空自动探测；Obsidian PATH 缺 Node 时填写绝对路径。
- LLM provider / Base URL / Model / API key：默认 OpenAI-compatible；key 只通过子进程环境传递。
- Codex command：只在 provider 选 Codex CLI 时使用。
- QMD runner：默认 SDK；CLI 用于 fallback/诊断。QMD 内部 rerank 默认关闭。
- QMD command 与 Obsidian CLI command：本机命令或绝对路径。
- Review note location：只影响低频的 `Aha: Export Review Note`。

第一次真实检索前运行 `Aha: Check Readiness`。

## 默认 runtime 语义

```text
OpenAI/Codex 生成有界结构化 QMD query
-> QMD SDK/CLI 检索 + source note links/backlinks
-> 合并、过滤 source self-hit、候选排序
-> 只读取 qmd://obsidian 或 vault 内候选正文
-> Relation Judge 输出 supports/challenges/resembles/bounds/weak
-> Session Record 保存最新轮次、选择、feedback 与 handoff
```

QMD、Relation Judge、wrapper 传输或 timeout 失败返回结构化 `{ ok:false, error:{ message, tool, details } }`，不会伪装成 weak-candidate 成功。运行时默认不生成 PipelineTrace；评测的 product-parity profile 会显式传 `--trace`，trace 也不会进入 Session Store。

## 成功 smoke

1. 在桌面 Obsidian 打开一篇真实 Markdown source note。
2. 运行 `Aha: Run`。
3. 确认右侧 Aha Review Panel 打开或刷新，主编辑区不跳转到 Review Note。
4. 确认 Panel 展示候选的 note、relation、hit、why，强关系带可核对证据。
5. 点击候选标题，确认旧笔记在新的 Obsidian tab 打开。
6. 改变一个候选的 handoff selection，点击 `Copy handoff`，确认剪贴板只包含当前选择。
7. 对候选记录 `accept` 或 `reject_as_noise`；再记录一条 `should_have_found`，关闭并重新打开 Panel，确认 feedback 仍存在。
8. 再运行一次搜索，确认重复候选保留 feedback 与 selection，而模型生成的关系内容可以刷新。
9. 运行 `Aha: Export Review Note`，确认此时才在配置目录生成/更新导出，并包含当前 Session Record 的候选与 handoff。
10. 检查 `.obsidian/plugins/aha-memory-surface/data.json`：存在紧凑 `sessionStore`，没有 note body 或 PipelineTrace。

## Feedback collector smoke

在仓库运行：

```bash
node scripts/bench/collect-review-seeds.mjs \
  --vault-root "$HOME/Obsidian Notes" \
  --dry-run
```

确认：

- 默认读取 plugin data 的 Session Store，不扫描 Review Notes。
- `accept / reject_as_noise / should_have_found` 分别进入 draft `gold.nice / noise / must`。
- 输出只含 vault-relative identity 与有界 event provenance，不复制 note body、hit/why prose、secret 或绝对路径。
- 重跑 event ID 稳定；相同 feedback 不重复。
- cases 固定为 `state: draft`、`suite: development`、`mode_review_required: true`。

旧 Review Note 只通过 `--legacy-review-notes` 显式导入。

## 失败 smoke

1. 临时把 QMD runner 改成 CLI，并把 QMD command 指向 `/missing/qmd`。
2. 运行 `Aha: Run`。
3. 确认 Panel/notice 显示失败，Session Record 保存 failed round，且没有成功候选。
4. 恢复配置并运行 `Aha: Check Readiness`。

## OpenAI key 失败 smoke

1. 保持 OpenAI provider，清空设置里的 key，并把 key env 改成不存在的变量。
2. 运行 `Aha: Check Readiness`。
3. 确认 OpenAI API key 检查失败，且不会错误要求 Codex CLI 通过。
4. 恢复 key 或 `OPENAI_API_KEY`。

## Fixture smoke

只检查 UI 时开启 `Use fixture result`。它会把 `scripts/aha/fixtures/stub-result.json` 写入 Session Record 并渲染到 Panel；只有显式 Export 才生成 Review Note。
