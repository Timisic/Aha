# Aha Review Panel MVP PRD

## Problem Statement

当前 Aha Obsidian 插件已经能从当前笔记跑通检索，并把候选旧笔记写入 Aha Review Note。下一步不应该继续把 Review Note 当成主要操作界面，因为 Markdown 里勾选、比较、复制 handoff 的成本仍然偏高。

用户需要一个简洁低负担的右侧面板：搜索完成后直接进入候选审阅，快速看到旧笔记和理由，删除不想纳入 handoff 的候选，最后一键复制 Grill Handoff。Aha Review Note 仍然是可追溯的 Markdown artifact 和状态底座，但默认工作面应切到 Aha Review Panel。

## Solution

实现一个 Obsidian 右侧 sidebar view：`Aha Review Panel`。

`Aha: Search from current note` 完成后不再自动打开 Aha Review Note，而是打开 Aha Review Panel。面板读取当前 source note 对应的 Aha Review Note，展示最新一轮搜索结果，并把候选以表格形式呈现。

面板第一版只服务一个动作：决定哪些候选纳入 Grill Handoff。候选默认纳入；用户取消勾选弱项；点击 `复制 Grill Handoff` 时，插件先把当前面板勾选状态写回 Review Note 的 Markdown checkbox，再更新 Review Note 的 Grill Handoff 区块，最后复制 handoff 到剪贴板。

## Product Boundary

- Obsidian plugin 是 Memory Surface，不是 agent runtime。
- Aha Review Panel 是 Review Note 的低负担操作面，不替代 Review Note。
- Aha Review Note 是选择状态、候选记录、handoff 的 source of truth。
- Panel 不运行 grill、不生成最终判断、不自动启动 Codex。
- Benchmark seed 不进入第一版主路径；后续可以在已纳入 handoff 的候选上增加显式保存。

## User Stories

1. 作为用户，我想在 Aha 搜索完成后直接看到候选面板，而不是跳到 Review Note。
2. 作为用户，我想在右侧面板里审阅候选，这样主编辑区可以继续放当前 insight 或打开旧笔记。
3. 作为用户，我想候选以表格形式显示，这样我能快速扫过旧笔记、关系和理由。
4. 作为用户，我想候选默认纳入 handoff，这样我只需要删除弱项。
5. 作为用户，我想点击旧笔记标题直接打开 Obsidian 笔记，不需要额外的 `Open` 按钮。
6. 作为用户，我想生成的 Review Note 主体保持中文，`relation` / `hit` / `why` 等字段名可以保留英文小标。
7. 作为用户，我想一键复制 Grill Handoff，这样选完候选后可以直接粘贴到 Codex 里继续 grill。
8. 作为开发者，我想选择状态写回 Review Note checkbox，而不是藏在 plugin data 里。
9. 作为开发者，我想第一版只展示最新搜索轮次，避免提前实现跨轮候选池合并。

## Panel Layout

第一版面板应保持紧凑，不放说明页、不放功能介绍、不放多余文案。

顶部：

- Source note 标题或链接
- 最新搜索状态与候选数量，使用短文本

表格：

| 列 | 用途 |
| --- | --- |
| 纳入 | checkbox，默认选中，控制是否进入 handoff |
| 旧笔记 | Obsidian 内链；点击后按 Obsidian 默认行为打开 |
| 关系 | `supports` / `challenges` / `resembles` / `bounds` / `weak` |
| 理由 | 以中文为主，简短说明为什么值得读；quote-backed `hit` 可折叠或并入详情 |

底部：

- 已纳入数量
- `复制 Grill Handoff` 主按钮

## Review Note Output

生成的 Aha Review Note 应以中文为主：

- 标题、段落、状态说明、候选说明、handoff 说明使用中文。
- `relation` / `hit` / `why` 可作为英文小标保留，方便和 schema 对齐。
- `why` 的主体内容应优先要求中文。
- relation enum 保持英文：`supports` / `challenges` / `resembles` / `bounds` / `weak`。
- Review Note 中不再写入 `<button class="aha-open-candidate"...>Open</button>`。
- 旧笔记打开依赖 Obsidian 内链或面板里的笔记链接，不依赖 Markdown 中的 HTML 按钮。

## Behavior

搜索完成：

1. 插件创建或复用 Aha Review Note。
2. 插件追加 running / success / failure 记录。
3. 成功后写入最新候选结果。
4. 插件打开或刷新 Aha Review Panel。
5. 插件不自动打开 Review Note。

面板打开：

1. 若当前文件是 source note，则定位对应 Review Note。
2. 若当前文件是 Aha Review Note，则直接读取该 Review Note。
3. 若没有 Review Note，显示空状态和最短可操作提示。
4. 只读取最新成功搜索轮次。

勾选候选：

1. 候选默认选中。
2. 用户取消勾选表示不纳入 handoff。
3. 勾选状态应能写回 Review Note checkbox。
4. Review Note 手动修改 checkbox 后，面板重新打开或刷新时应反映当前状态。

复制 handoff：

1. 同步当前面板勾选状态到 Review Note。
2. 基于已纳入候选重建 Grill Handoff。
3. 更新 Review Note 的 Grill Handoff 区块。
4. 复制 handoff Markdown 到剪贴板。
5. 显示短 notice，不打开新页面。

## Testing Decisions

- Review Note renderer 测试：中文主体、无 inline Open button、checkbox 仍可解析。
- Panel parser 测试：从 Review Note 读取最新成功轮次和 checkbox 状态。
- Panel behavior 测试：切换 checkbox 后能生成正确 selected set。
- Handoff export 测试：同步 Review Note、更新 handoff、复制内容 shape 正确。
- Manual smoke：从真实 Obsidian note 运行搜索，完成后打开右侧 panel，取消部分候选，复制 handoff，确认 Review Note 与剪贴板一致。

## Out of Scope

- 跨搜索轮次候选池合并。
- 复杂筛选、排序、搜索、分组。
- Benchmark seed 保存按钮。
- 自动 Codex launch。
- Panel 内嵌 grill 聊天。
- 最终 judgment 编辑器。
- 移动端支持。

## Success Criteria

第一版成功的标准是：用户运行 Aha 搜索后，不需要读一整份 Markdown 结果，就能在右侧面板里扫一遍候选、删掉弱项、复制可用的 Grill Handoff；同时 Review Note 仍然保留完整、可追溯、可手工修改的中文 artifact。
