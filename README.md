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

## 架构

```text
┌─ Obsidian Plugin（Memory Surface）────────────────┐
│  从当前笔记触发搜索 · 展示候选与关系理由               │
│  打开旧笔记 · Session Store 保存选择/反馈 · 可选导出     │
└──────────────────┬───────────────────────────────┘
                   │ 调用
┌─ scripts/aha wrapper（机械连接层）────────────────┐
│  环境检查 · QMD SDK/CLI · 代理与重试 · 候选过滤     │
│  正文读取 · JSON schema 校验 · 结构化失败记录       │
└──────────────────┬──────────────────────────────┘
                   │ 编排
┌─ LLM + QMD（Reasoning Workflow）─────────────────┐
│  多路结构化查询生成 · 混合召回 + 链接图扩展           │
│  候选原文阅读 · Relation Judge（引句校验）· 重排     │
└──────────────────────────────────────────────────┘
```

产品检索层组合多路信号：LLM 生成的结构化 QMD 查询、确定性的原文/thought 补充查询，以及源笔记链接图。评测中的更深 top-seed 图扩展与 judge 重排保留为显式的 `diagnostic-enhanced` profile，不冒充产品运行时。

## 仓库结构

```text
obsidian-plugin/     Memory Surface：Obsidian 插件（触发、Review Panel、Session Store、可选导出）
scripts/aha/         产品 wrapper：检索编排、Relation Judge、结果 schema 校验
scripts/bench/       评测工作流与底层 runner（validate / baseline / diagnostic 等）
scripts/lib/         wrapper 与评测共享的模块（LLM 传输、代理、评分、PipelineTrace）
bench/               评测用例与报告说明（生成物不入库）
docs/                PRD · ADR · 运行细节 · 领域术语 · 归档
```

文档入口见 [docs/README.md](./docs/README.md)；插件运行细节（失败可见性、代理与重试、候选安全）见 [docs/obsidian-plugin-operations.md](./docs/obsidian-plugin-operations.md)。

## 评估：个人记忆空间怎么衡量"找得准"

个人笔记库没有标准答案，同一条旧笔记对不同 insight 的关系不同，"该召回什么"只有笔记的主人知道。Aha 把评估设计纳入到日常的 Review 行为中：

1. **反馈先进入草稿**：Panel 的 `accept` / `reject_as_noise` / `should_have_found` 写入紧凑 Session Record；收集器幂等地产生本地 draft seed。只有人工确认输入、标签、身份与模式后，才显式晋升到 development，绝不自动改写 canonical benchmark 或 holdout。
2. **围绕 TOP10 计分**：`Must Recall@10`、`Useful Precision@10`、`nDCG@10`、`Negative Rate@10`；development/holdout 与 discovery/graph-assisted 分开报告。
3. **证据先于归因**：稳定性只比较兼容的重复运行；没有比较时明确 `not_measured`。失败归因沿产品运行时 trace 中真实的 query / retrieval / relation / ordering 路径判断，证据不足就保留 `unattributed`。

```bash
npm run bench:validate              # 公开 synthetic schema / privacy 验证
npm run bench:smoke                 # 快速确定性检查
npm run bench:diagnostic            # development，diagnostic-enhanced
npm run bench:baseline              # product-parity，development + holdout
node scripts/bench/summarize-report.mjs bench/reports/latest/product-parity.json
```

`baseline` 直接调用 shipped runtime，并为每个 case 产出 privacy-bounded `PipelineTrace`。只有同一 clean commit 上完整、兼容、全部成功且可计分的运行，才会原子更新 latest pointer。细节见 [bench/README.md](./bench/README.md)。

## 开发与验证

```bash
node --test scripts/aha/tests/*.test.mjs   # wrapper/检索/judge/评分单测
cd obsidian-plugin && npm run verify       # 插件构建 + 测试
npm run verify                             # 仓库完整确定性验证
```

## 状态与边界

已支持：Obsidian Plugin（触发、Review Panel、候选跳转、Session Store、可选 Review Note 导出）、多路召回、引句校验的关系判断、反馈到 development draft seed 的闭环、canonical note identity、development/holdout 与 discovery/graph-assisted 分层评估、产品同构 trace 与证据式归因。

不做：自动修改 Obsidian 原文、自动沉淀总结、把候选自动写入知识库。

边界：自用驱动的深度产品实验，真实 case、笔记路径、trace 与报告只保存在本地；公开仓库只保留 synthetic fixture。评测数字必须来自当前、可复现、可审计的 baseline，不在 README 固化容易失真的快照结论。
