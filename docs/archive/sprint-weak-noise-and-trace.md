# Sprint：降噪 + Trace 治理 + 实习叙事

> 基于 2026-08-24 Grilling Session 的决策记录

## 诊断结论

用 [[2026-08-23 放弃太早容易丢失很多]] 做现场诊断，15 条结果中 8 条 weak（53%）。

**管线没有坏。** Judge 正确地把无引句证据的候选标为 weak。问题在于：
1. **Weak 候选未降权展示** — 8 条 weak 和 7 条有证据的结果混在一起，稀释了质量感知
2. **召回多样性不足** — 15 条里 12 条来自 `个人复盘/`，查询过度聚焦表层关键词
3. **Trace 中间层缺失** — `qmd_runs`、`pre_rerank_candidates` 为空，只有首尾数据

## 行动计划

| # | 任务 | 预估 | 做什么 |
|---|------|------|--------|
| 1 | 砍 weak 噪音 | 1-2h | weak 候选排到底部、默认不勾选（不勾选已实现，只需排序） |
| 2 | Trace 数据治理 | 1-2天 | 填充 qmd_runs 和 pre_rerank_candidates；双层输出：底层 JSON + 上层人可读 Markdown |
| 3 | Bench 最小化 | 半天 | 5 个 case（含"放弃太早"），建基线数字，拿 before/after 对比 |
| 4 | 实习叙事包装 | — | 主线：评测迭代 + 架构演进；用真实 case + trace 分析做演示 |

## Serendipity 定位

- 砍 weak 本身就是 serendipity 第一步（为 surprise 候选腾视觉空间）
- 架构审计文档 (`architecture-audit-serendipity.md`) 作为"未来规划"纳入实习叙事
- 深度优化（rarity bonus、探索性召回层、slate reserve）推迟到实习之后

## 明确推迟

- Serendipity 深度优化 → 实习后
- 上架 Obsidian 插件市场 → 远期
- 完整 bench 自动化 + 大规模 gold set → 远期
