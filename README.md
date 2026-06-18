# Pi Insight Extension

把突然出现的想法，带着旧笔记一起走到一份可回看的判断草稿。

这个 Pi 本地扩展提供一条 `/insight` 工作流：你把当前想法、背景和可选的原始笔记贴进去，Agent 会帮你检索相关旧笔记、组织回看顺序、提出追问，并在你确认后输出 summary draft。

它重点降低的是这段认知阻力：从“我感觉这个想法很重要”，到“我能说清它连接了哪些旧经验、改变了什么判断、应该怎样沉淀下来”。

![Insight-to-Judgment 流程图](./docs/assets/insight-flowchart.png)

## 快速开始

在 Pi 中输入：

```text
/insight
```

然后粘贴这几类内容：

- 当前想法：一句让你感觉需要更新理解的话。
- 背景：它来自哪里，正在回应什么问题。
- 原始笔记：可选，可以贴 Obsidian 原文或片段。
- 旧笔记线索：可选，如果你已经想到某些相关旧内容，可以写上标题或关键词。

也可以直接行内启动：

```text
/insight 这里写当前想法和背景
```

## 它帮你完成什么

### 找回旧记忆

很多想法出现时，只能隐约感觉它和过去某些笔记、项目、场景有关。`/insight` 会把当前想法交给 agent 生成多条结构化 QMD 查询，再用 QMD 和 Obsidian backlink 找回本地旧笔记。

### 降低重新翻找成本

你不用先在知识库里自己翻一轮。扩展会先给出一张 agent rerank 后的候选表，让你从几个最可能相关的旧笔记开始看。

### 显影相似、反例和边界

旧笔记和当前想法的关系可能有几种：

- 支持：旧内容强化了当前想法。
- 挑战：旧内容让当前想法需要修正。
- 相似：旧内容来自别的领域，但结构很像。
- 边界：旧内容说明这个想法适用于哪里，停在哪里。

这一步的目的，是让你更快看到“这个想法到底改变了什么”。

### 保留追问过程

Agent 会围绕候选判断追问你：你接受哪部分，拒绝哪部分，哪里需要补充，是否真的形成了新判断。中间过程会保存在 `grill-context.md`，方便回看。

### 输出判断草稿

当你明确表示可以总结时，Agent 会输出一份 summary draft。它可以包括：

- 原始想法；
- 被更新的旧理解；
- 新形成的判断；
- 参与判断的旧笔记；
- 适用边界；
- 可能影响的行动；
- 仍未解决的问题。

## 工作流

```text
输入想法和背景
-> agent 生成多条 QMD 查询
-> QMD 检索旧笔记
-> 用 QMD top10 扩展 Obsidian backlinks
-> 合并候选并 agent rerank
-> 回看候选内容
-> 接受追问
-> 形成判断
-> 输出草稿
```

中间会形成一个小循环：你在 Review 旧笔记，Agent 在 Grill 你的判断。过程中如果出现新的重要想法，可以再次触发 memory search，继续找相关旧内容。

## 命令

```text
/insight
```

没有 active insight mode 时，打开编辑器并创建新 session。已经处在 insight mode 时，取消当前模式并清掉待注入上下文。

```text
/insight list
```

列出近期 session。

```text
/insight resume <session>
```

恢复某个旧 session。`<session>` 可以是 session id 或目录名片段。

```text
/insight current
```

查看当前 active session。

## 文件位置

session 默认保存在 Pi agent 的全局目录：

```text
~/.pi/agent/insights/
```

如果设置了 `PI_CODING_AGENT_DIR`，则保存在：

```text
$PI_CODING_AGENT_DIR/insights/
```

目录结构：

```text
insights/
  index.json
  sessions/
    yyyy-mm-dd-short-slug-sessionid/
      state.json
      grill-context.md
      summary-draft.md
```

每个想法都有独立 session 目录。`state.json` 会记录启动路径 `originCwd`，所以你可以知道这次 session 从哪里开始；session 本身集中保存在全局 insight storage 中，方便从不同项目路径继续使用。

## 设计原则

- 用户确认判断，Agent 提供检索、追问和草稿。
- 旧笔记是 memory candidates，需要用户 Review 后才进入最终判断。
- Summary 由用户明确触发，Agent 不自动跳到完成。
- 原始 Obsidian 笔记由用户掌控，扩展只输出建议和 draft。
- Pi core 保持不变，产品能力放在 extension 层。
- 本地 JSON 记录 session state，让多阶段认知过程不会丢。

## 当前状态

已经支持：

- `/insight` 启动和恢复 session；
- QMD 结构化检索；
- QMD top10 seed backlink 扩展；
- QMD/backlink 候选合并和 agent rerank；
- memory candidate 表格；
- review-grill 过程记录；
- summary draft 保存；
- 跨路径 list / resume；
- QMD 超时后的进程组清理。

暂时还没有：

- 独立 Web UI；
- 自动修改 Obsidian 原文；
- 多 Agent 分发。

## 评测

小评测集在 `bench/aha-memory-cases.json`。每条 case 保存真实会输入 `/insight` 的原始内容来源，以及人工标注的 `must_recall` / `nice_to_have` 笔记。

核心指标：

- `R@10`：must-recall 笔记是否进入最终前 10。当前假设是你愿意扫十条自己写过的笔记。
- `nice_to_have R@20`：有帮助但不必强制命中的发散笔记是否进入前 20。
- `found_must_recall_ranks`：命中的 must-recall 排名，用来判断是不是只是勉强压线。
- `expanded_pool_recall`：QMD + backlink 合并池里是否已经有答案，用来区分 retrieval 问题和 rerank 问题。

L1 只测 QMD 直接召回：

```bash
node scripts/bench/run-qmd-bench.mjs
```

L2 近似真实 `/insight` retrieval：

```bash
node scripts/bench/run-pipeline-bench.mjs
```

L2 流程是：

```text
raw insight input
-> query-generation agent 生成 3-5 条 intent/lex/vec/hyde 查询
-> 逐条调用 QMD
-> 用 QMD top10 作为 backlink seeds
-> 合并 QMD/backlink 候选
-> rerank agent 排序
-> 计算 R@10 / nice R@20
```

最新报告写到：

```text
bench/reports/latest/qmd.json
bench/reports/latest/pipeline.json
```

时间戳历史报告写到：

```text
bench/reports/archive/
```

## 开发与验证

标准回归测试：

```bash
INSIGHT_EXTENSION_PATH=/Users/hong/Downloads/Pi/insight-package/extensions/insight.ts bun scripts/insight/test-extension.mjs
```

对抗式 QA：

```bash
INSIGHT_EXTENSION_PATH=/Users/hong/Downloads/Pi/insight-package/extensions/insight.ts bun scripts/insight/ultraqa-extension.mjs
```

Package 内部回归：

```bash
cd insight-package
bun run build
bun run test
bun run test:ultraqa
```

构建检查扩展：

```bash
bun build /Users/hong/Downloads/Pi/insight-package/extensions/insight.ts --target=node --outfile=/tmp/insight-extension-build.js
```

Pi 加载烟测：

```bash
pi --verbose --offline --no-tools --print ""
```
