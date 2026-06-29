# Aha Review Panel Issues

这份 issue 列表把下一轮优化压成两个可独立完成的 vertical slices。第一条先整理 Review Note 输出，使现有 artifact 更适合做面板数据底座；第二条实现右侧 Aha Review Panel MVP。

## Issue 01: Localize Review Note output and remove inline Open buttons

## What to build

调整当前 Aha Review Note 渲染输出，使生成笔记主体保持中文，并移除候选行里的 HTML `Open` 按钮。旧笔记打开依赖 Obsidian 内链和后续面板链接，不在 Markdown artifact 中写入额外按钮。

## Acceptance criteria

- [ ] 新生成的 Aha Review Note 标题、状态、候选区、Selected Memories、Grill Handoff 的主体文案为中文。
- [ ] `relation` / `hit` / `why` 等 schema 字段名可以作为英文小标保留，但 `why` 主体内容应优先由 LLM 生成中文。
- [ ] relation enum 继续使用 `supports` / `challenges` / `resembles` / `bounds` / `weak`。
- [ ] Review Note 中不再出现 `<button class="aha-open-candidate"...>Open</button>`。
- [ ] 候选旧笔记仍以 Obsidian 内链呈现，可点击打开。
- [ ] 回归测试覆盖中文输出 shape、无 inline Open button、manual content 不被覆盖。
- [ ] `cd obsidian-plugin && npm run verify` 通过。

## Blocked by

None - can start immediately.

## Issue 02: Build the Aha Review Panel MVP

## What to build

实现一个右侧 sidebar Aha Review Panel。Aha 搜索完成后默认打开面板，而不是自动打开 Review Note。面板读取当前 source note 或当前 Aha Review Note 对应的最新成功搜索轮次，以紧凑表格展示候选，并支持选择哪些候选纳入 Grill Handoff。

## Acceptance criteria

- [ ] 新增命令 `Aha: Open Aha Review Panel`。
- [ ] `Aha: Search from current note` 成功后打开或刷新 Aha Review Panel，不自动打开 Review Note。
- [ ] Panel 位于右侧 sidebar，不占用主编辑区。
- [ ] Panel 第一版只展示最新成功搜索轮次，不做跨轮候选池合并。
- [ ] 表格只保留 `纳入` / `旧笔记` / `关系` / `理由` 四类信息。
- [ ] 候选默认纳入 handoff；用户可取消勾选。
- [ ] 旧笔记标题可点击，并按 Obsidian 默认行为打开笔记。
- [ ] `hit` 不常驻为独立列；可折叠或并入理由详情。
- [ ] 勾选状态写回 Aha Review Note 的 Markdown checkbox，Review Note 是 source of truth。
- [ ] `复制 Grill Handoff` 会同步当前选择、更新 Review Note handoff 区块、复制 handoff 到剪贴板。
- [ ] 面板保持低负担，不出现说明页、功能介绍或多余文案。
- [ ] 测试覆盖 Review Note 解析、latest round 选择、checkbox 状态同步、handoff export shape。
- [ ] 真实 Obsidian smoke 覆盖：运行搜索、打开 panel、取消候选、复制 handoff、确认 Review Note 与剪贴板一致。
- [ ] `cd obsidian-plugin && npm run verify` 通过。

## Blocked by

Issue 01.
