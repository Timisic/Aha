# Aha 偶然发现式推荐：架构审计与优化路线图

> 审计基准：`internalize-pipeline` 分支。
> 设计原则：**Surprise 来自召回层**（找到用户想不到的旧笔记），**Relevance 来自判定层**（引句校验保障），两者不互损。

---

## 1. 管线流程

```
source note
  → [查询计划] LLM 生成 3-5 条 QMD 查询（失败时确定性兜底）
  → [QMD 多路检索] 每条查询调 store.search / searchLex
  → [候选合并] mergeAndRankQueryResults：按 finalScore 排序，取 top-20
  → [正文读取] excerptNoteMarkdown（全文，不截断）+ isSubstantiveExcerpt 过滤
  → [Relation Judge] 每条候选独立 LLM 调用（并发 5），判定关系 + 引句校验
  → [输出] AhaResult
```

核心路径（orchestrator.ts）与遗留路径（run-insight-search.mjs）的唯一结构差异：遗留路径在检索后有一步 **Obsidian 图扩展**（1 跳出链 + 反链，score 0.14/0.18），核心路径没有。

---

## 2. 关键参数速查

### 查询层

| 参数 | 值 | 说明 |
|---|---|---|
| Prompt 版本 | `aha-query-plan-v7` | `buildQueryPlanPrompt()` in query-plan-llm.ts |
| 查询 kind | raw / abstracted_judgment / contextual / explicit_cue / bounds | query-plan-deterministic.ts |
| 查询数量 | LLM 3-5 条 + 1 条确定性兜底 = 4-6 条 | normalizeQueryPlan 硬上限 5 条 LLM + 1 fallback |
| QMD 字段上限 | intent ≤ 180 字, lex ≤ 4×32 字, vec ≤ 360 字, hyde ≤ 320 字 | query-plan-deterministic.ts |
| Source summary | title + headings(12) + wikiLinks(20) + salient lines(60), ≤ 5000 字符 | queryPlanSourceSummary() |

### 重排公式（pool.ts）

```
finalScore = bestScore + rankScore × 0.18 + diversity
diversity  = queryKinds.size × 0.12 + commands.size × 0.04
```

注意：diversity 实质是 **consensus bonus**——被更多查询命中的候选得分越高，系统性压低只被非常规查询命中的高 surprise 候选。

### Relation Judge

| 参数 | 值 |
|---|---|
| Prompt 版本 | `aha-relation-judge-v5` |
| 调用方式 | 每条候选独立 LLM 调用，并发 5（`DEFAULT_PER_CANDIDATE_CONCURRENCY`） |
| 关系权重 | supports=3, challenges=3, bounds=2.5, resembles=2.5, weak=1 |
| 引句校验 | enforceQuoteBackedRelation：三级匹配（精确→指纹→松弛前缀），无证据则降级为 weak |
| Slate reserve | 每 10 条保留 2 个检索排名槽位（composeFinalSlate，仅 bench 路径） |

---

## 3. 已完成的优化

| 项 | 改动 | 服务目标 |
|---|---|---|
| Query plan v7 | abstracted_judgment 要求侧向搜索（跳出表层机制，搜共享隐含前提的不同现象）；hyde 按 kind 分语气（复盘/分析/反思） | Surprise |
| Relation judge v5 | 切换中文 prompt；weak 定义改为"无引句"而非"话题近"；显式鼓励跨领域连接（"话题距离是特征不是降级理由"） | Surprise |
| 截断移除 | excerptNoteMarkdown 不再限 120 行/3600 字；orchestrator 不再 compactLine；relation judge 不再截 source 到 3500 字 | Relevance |
| 每候选独立判定 | 从 batch 改为 per-candidate LLM 调用（并发 5），每条候选拿到完整 source + 完整 excerpt | Relevance |

---

## 4. 待实施优化路线图

按投入产出比排序：

| 优先级 | 方向 | 做什么 | 为什么 | 风险 |
|---|---|---|---|---|
| **P0** | 重排 rarity bonus | pool.ts 公式加一项：只被 abstracted_judgment/bounds 命中且 rank ≤ 5 的候选 +0.25 | 对冲 diversity consensus bonus 对 surprise 候选的系统性惩罚 | 可能挤出 rank 19-20 的 must-recall 候选；需消融验证 |
| **P1** | 反事实基线实验 | 用 `AHA_BENCH_QUERY_GENERATOR=rules` 跑 bench，对比 LLM 查询的增量召回 | 量化 LLM query plan 对 surprise 的真实贡献，指导后续投入方向 | 零代码风险 |
| **P2** | 探索性召回层 | 截断后从 rank 21-40 中按信号冲突/非常规 kind 选最多 5 条额外候选送入 Judge | 让被 finalScore 排除但被非常规查询强命中的候选有机会进入判定 | +5 条候选的 LLM 成本（~$0.016/次） |
| **P2** | Slate serendipity reserve | composeFinalSlate 每 10 条保留 1 个位置给 challenges/bounds/resembles | 保底曝光反方向和跨领域候选 | 可能挤出 1 个 supports 候选 |
| **P3** | accept-surprising 反馈 | accept 按钮旁加 surprising 标记，数据层扩展 feedback 枚举 | 建立 surprise 量化信号，驱动后续优化 | 用户可能忽略标记 |
| **P3** | Embedding 距离分析 | 一次性脚本，分析 bench gold set 的 source×candidate cosine distance 分布 | 验证"中等距离 = 高 accept 率"假设 | 依赖 QMD SDK 暴露 embedding |
