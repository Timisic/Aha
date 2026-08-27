# Aha

**个人长期笔记的 AI 召回与判断辅助工具。**

当形成一个新的想法（insight）时，Aha 从 Obsidian 笔记库里找回相关的旧笔记，并回答一个比"相关"更进一步的问题：这条旧笔记是在支持、挑战、类比还是限定你现在的判断？最终通过 Grilling 追问**让人的历史经验重新参与当前思考**。关键思考只发生在读原文、取舍候选关系、与 AI 追问时，产品只应关注并强化这一过程。

<p align="center">
  <img src="./docs/assets/plugin.jpg" alt="Aha plugin" width="660" />
</p>

## 为什么做这个

旧笔记里沉淀过判断、教训、反例和边界，在新问题出现时很难被重新调用。

语义搜索类工具已经把"浮现相关笔记"做得很好，但相似度是**对称、无立场**的信号——它答不了"所以呢"。正确的废话还是废话。一条旧笔记对当前判断的价值，取决于它对这个判断做了什么，即我要的是 Insight × History Note：

| 关系 | 含义 |
|---|---|
| `supports` | 旧内容强化了当前想法 |
| `challenges` | 旧内容让当前想法需要修正 |
| `resembles` | 旧内容来自别的领域，但结构相同 |
| `bounds` | 旧内容说明这个想法适用于哪里、停在哪里 |
| `weak` | 只是主题相近，证据不足 |

人机边界始终是：**human-authored, agent-retrieved**。人写笔记、人判断、人落笔；AI 负责召回、解释关系、提供追问，不改写原文。

## 时间距离

当下判断会被近因和情绪窄化——低谷时人倾向于认为"一直如此、只会更糟"。从时间距离外以旁观视角重看自己的负面经历，情绪反应与反刍都会下降，一周后依然有效；起作用的是重新评估，不是转移注意力。

Aha 的召回天然产生这种距离：写下想法的当下，它把数月甚至数年前与之 `supports` / `challenges` / `bounds` 的旧文字调回来。那是另一种情绪和认知状态下的自己所写，不需要记得，也不需要去翻。**旧笔记是一份不受当前心境污染的证据。**

## 架构

管线的编排逻辑（查询计划、QMD 检索、候选合并重排、Relation Judge）住在 `obsidian-plugin/src/core/`，是唯一事实来源（[ADR 0005](./docs/adr/0005-share-compiled-core-between-plugin-and-bench.md)）。它不依赖 Obsidian API 也不依赖 Node，靠外部注入依赖；esbuild 把它编译成两份产物——直接打进插件本体，另外编译出一份独立 ESM 给 bench/CLI 复用——插件和评测因此跑的是同一份逻辑，不是两套平行实现。

```text
┌─ Obsidian Plugin（Memory Surface + 编排）─────────────┐
│  触发搜索 · Capability Tier 编排                        │
│  （Neighborhood / Recall / Full + Runtime Fallback）    │
│  Review Note / Review Panel · 会话状态 · 反馈动作        │
└──────────────────┬─────────────────────────────────────┘
                   │ 进程内直接调用（不再 spawn 子进程）
┌─ core/（Reasoning Workflow · 单一事实来源）────────────┐
│  多路结构化查询生成 · QMD 混合召回 + 链接图扩展          │
│  候选合并重排 · 正文读取 · Relation Judge（引句校验）    │
└──────────────────┬─────────────────────────────────────┘
                   │ esbuild 编译为独立 ESM 产物（未入库，用时现编）
┌─ scripts/（bench 与遗留 CLI，非主路径）─────────────────┐
│  scripts/bench 通过 core-artifact.mjs 消费同一份 core，  │
│  评测结果因此仍是插件真实行为的证据                       │
│  scripts/aha/run-insight-search.mjs：DeepSeek 路径已委托 │
│  给 core，仅作隐藏回滚开关（useLegacyWrapper，默认关）    │
│  与 Codex CLI 智能体路径（无 core 对应物）                │
└──────────────────────────────────────────────────────────┘
```

检索层组合多路信号：LLM 生成的多条结构化 QMD 查询（含结构抽象、反例导向、同义扩展、外文关键词）、确定性的原文/thought 补充查询（不依赖 LLM 措辞的召回底线）、源笔记的链接/反链邻域、QMD top-10 种子的反链扩展。

DeepSeek 是唯一的 API provider（OpenAI provider 已移除）；Codex CLI 路径作为智能体式的独立分支保留，不经过 core。

## 仓库结构

```text
obsidian-plugin/     Memory Surface + 编排：Obsidian 插件
  src/core/            检索/判断逻辑的唯一事实来源（ADR 0005），esbuild 编译后插件与 scripts 共用同一份
  src/*.ts             插件专属：触发、Review Note/Panel、会话状态、设置、Capability Tier 编排
scripts/aha/         遗留 CLI wrapper：DeepSeek 路径已委托给 core，现为回滚开关 + bench 进程桥 + Codex CLI 路径
scripts/bench/       评测管线入口（run-pipeline-bench 等），通过 scripts/lib/core-artifact.mjs 消费与插件相同的 core
scripts/lib/         Node 侧共享绑定：core-artifact.mjs/core-node-deps.mjs（core 的 Node 依赖注入）、代理、评分、PipelineTrace
bench/               评测用例与报告说明（生成物不入库）
docs/                PRD · ADR · 运行细节 · 领域术语 · 归档
```

文档入口见 [docs/README.md](./docs/README.md)；插件运行细节（失败可见性、代理与重试、候选安全）见 [docs/obsidian-plugin-operations.md](./docs/obsidian-plugin-operations.md)。

## 评估：个人记忆空间怎么衡量"找得准"

个人笔记库没有标准答案，同一条旧笔记对不同 insight 的关系不同，"该召回什么"只有笔记的主人知道。Aha 把评估设计纳入到日常的 Review 行为中：

1. **反馈即标注**：在 Review Note 里对候选点 `accept` / `noise` / `should_have_found`，动作被收集为 benchmark seed（`scripts/bench/collect-review-seeds.mjs`），人工确认后进入私有评测集（`gold.must` / `nice` / `noise`，本地文件不入库）。
2. **围绕TOP10计分**：@10——`Must Recall@10`、`Useful Precision@10`、`nDCG@10`、`Negative Rate@10`。
3. **失败归因**：每个 case 自动归因到 query / retrieval / rerank / relation / 标注 / 输入表示六类，诊断指标（`Expanded Pool Recall@20`、`Dropped Must Count`）区分"没找到"和"找到了但排丢了"——决定下一步优化哪一层。

```bash
node scripts/bench/run-pipeline-bench.mjs                 # 全量评测
node scripts/bench/run-pipeline-bench.mjs --only aha-002  # 单 case 快速迭代
node scripts/bench/summarize-report.mjs bench/reports/latest/pipeline.json
```

每个 case 产出结构化 PipelineTrace（查询、逐路召回、池、重排、gold 位置、归因），细节见 [bench/README.md](./bench/README.md)。

## 开发与验证

```bash
node --test scripts/aha/tests/**/*.test.mjs   # wrapper/检索/judge/评分单测 (unit/integration/e2e)
cd obsidian-plugin && npm run verify       # 插件构建 + 测试
```

## 状态与边界

已支持：Obsidian Plugin（触发、Review Note、候选跳转、反馈按钮）、多路混合召回、引句校验的关系判断、分批 judge 与检索先验保底排序、评测闭环与失败归因、review 反馈到 benchmark seed 的收集链路。

不做：自动修改 Obsidian 原文、自动沉淀总结、把候选自动写入知识库。

边界：自用驱动的深度产品实验，评估基于真实个人 review 行为；检索层的 must 入池率已通过确定性手段做到 ~97%，top-10 排序质量仍在通过反馈判例持续校准。
