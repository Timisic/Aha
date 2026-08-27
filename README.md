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

当下判断会被近因和情绪窄化，低谷时人倾向于认为“一直如此、只会更糟”。从时间距离外以旁观视角重看自己的负面经历，情绪反应与反刍都会下降，一周后依然有效；起作用的是重新评估，重新审视。

Aha 的召回天然产生这种距离：写下想法的当下，它把数月甚至数年前与之 `supports` / `challenges` / `bounds` 的旧文字调回来。那是另一种情绪和认知状态下的自己所写，不需要记得，也不需要去翻。**旧笔记是一份不受当前心境污染的证据。**

## 架构

Aha 是一个 Obsidian 插件：触发搜索、展示候选、记录反馈都在插件里完成。检索与判断的逻辑单独封装成一个模块（`core`），评测脚本复用的是同一份逻辑，不是另外写一套。

```text
┌─ Obsidian 插件 ──────────────────┐
│  触发搜索 · Review Panel · 反馈   │
└────────────┬─────────────────────┘
             │
┌─ core（检索与判断）───────────────┐
│  生成查询 · 检索 · 候选排序        │
│  判断每条旧笔记的关系（引句校验）  │
└────────────┬─────────────────────┘
             │
┌─ scripts（评测）──────────────────┐
│  复用同一份 core 逻辑跑评测         │
└────────────────────────────────────┘
```

检索层组合多路信号：模型生成的多条结构化查询、不依赖模型措辞的确定性兜底查询、源笔记的链接网络、检索结果的进一步反链扩展。

## 仓库结构

```text
obsidian-plugin/     Obsidian 插件
  src/core/            检索与判断逻辑，插件和评测脚本共用
  src/*.ts             插件专属：触发、Review Panel、会话状态、设置
scripts/aha/         命令行工具
scripts/bench/       评测入口（run-pipeline-bench 等）
scripts/lib/         Node 侧共享工具：评分、PipelineTrace 等
bench/               评测用例与报告说明（生成物不入库）
docs/                PRD · ADR · 运行细节 · 领域术语 · 归档
```

文档入口见 [docs/README.md](./docs/README.md)；插件运行细节（失败可见性、代理与重试、候选安全）见 [docs/obsidian-plugin-operations.md](./docs/obsidian-plugin-operations.md)。

## 评估：个人记忆空间怎么衡量"找得准"

个人笔记库没有标准答案，同一条旧笔记对不同 insight 的关系不同，"该召回什么"只有笔记的主人知道。Aha 把评估设计纳入到日常的 Review 行为中：

1. **反馈即标注**：在 Review Panel 里对候选点 `accept` / `noise` / `should_have_found`，动作存进插件 Session Store（`data.json`），人工确认后进入私有评测集（`gold.must` / `nice` / `noise`，本地文件不入库）。
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

已支持：Obsidian Plugin（触发、Review Panel、候选跳转、反馈按钮）、多路混合召回、引句校验的关系判断、分批 judge 与检索先验保底排序、评测闭环与失败归因。

不再支持：Review Note（Markdown 导出/解析）已整体移除——包括导出命令、`scripts/aha/legacy-review-migration.mjs`、`scripts/bench/collect-review-seeds.mjs`；反馈只存进 Session Store，从反馈到 benchmark seed 目前没有自动收集链路，需要人工从 `data.json` 里挑。

不做：自动修改 Obsidian 原文、自动沉淀总结、把候选自动写入知识库。

边界：自用驱动的深度产品实验，评估基于真实个人 review 行为；检索层的 must 入池率已通过确定性手段做到 ~97%，top-10 排序质量仍在通过反馈判例持续校准。
