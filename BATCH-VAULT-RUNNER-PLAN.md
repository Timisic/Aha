# 方案：批量跑真实笔记，结果落进 Obsidian

> 临时文档，放在根目录方便你先看；后续会挪进 `docs/archive/`。只是方案，未写代码。

## 目标

给一批真实笔记（一个文件夹，或一份路径清单），逐条跑真实的 Aha 管线（真实 vault、真实 DeepSeek、真实 QMD 索引），把结果写回 Obsidian 插件的状态里，让你事后打开 Obsidian 就能在 Review Panel 里点开每一条看结果——不用一条条手动触发。跑完之后，从里面手动挑有用的候选，整理进 `bench/aha-memory-cases.json` 的评测集。

## 已确认的现状（不是猜测，都是看代码/看已有脚本得出的）

1. **单条真实笔记怎么跑，已经有参照实现**：`scripts/debug-pipeline.mjs` 读真实 vault（`~/Obsidian Notes`）里的一条笔记、读真实插件 `data.json` 里的 DeepSeek key/model、调 `scripts/lib/core-artifact.mjs` 的 `runFullPipeline`——和插件在 Obsidian 里跑的是**同一份编译逻辑**（ADR 0005）。批量工具的"跑一条"这一步，直接照抄这个脚本的做法即可，不用重新设计。

2. **结果要写进哪、长什么样，已经有 schema**：`obsidian-plugin/src/session-store.ts` 定义了 `data.json` 里 `sessionStore` 字段的结构——`{ schemaVersion: 1, records: { [key]: AhaSessionRecord } }`，每个 `AhaSessionRecord` 有 `source`（笔记身份）、`rounds`（每轮结果，含 `candidates`）、`feedback`。`recordSuccessfulSessionRound()` / `recordFailedSessionRound()` 这两个纯函数就是插件自己写入结果时用的逻辑。`data.json` 整体结构见 `main.ts:45`：`{ settings, sessionStore, schemaVersion }`（`reviewIndex` 字段已随 Review Note markdown 功能一起移除）。

3. **笔记身份怎么算**：`obsidian-plugin/src/source-identity.ts` 的 `sourceIdentity()`——本质是对文件的 `dev`/`ino`/`birthtimeMs`（或退化到 `ctime`）做哈希，只用了 `node:crypto`/`node:fs`，不真的依赖 Obsidian 运行时，只是类型签名上写了 `TFile`。

4. **原本有个绊脚石，现在已经解决**：`session-store.ts` 曾经顶部 `import ... from "./review-note"`，而 `review-note.ts` 里有 `import { normalizePath } from "obsidian"`——这条依赖链在纯 Node 环境下解析不了 `"obsidian"` 这个模块，需要 esbuild alias/stub 才能绕过。清理 Review Note markdown 功能那次改动顺手把 `review-note.ts` 裁剪到只剩 `renderGrillHandoff`/`seedLabelForAction`/`obsidianLink` 这几个纯逻辑函数，`normalizePath` 那个 import 整个消失了。`session-store.ts` 剩下的依赖只有 `./schema`（纯类型/纯逻辑）和 `./source-identity`（`import type { TFile } from "obsidian"` 是类型导入，编译期整个擦除，不产生运行时依赖）。也就是说 `session-store.ts` 现在整条依赖链在运行时已经完全不碰 `obsidian` 模块——不需要任何 shim/alias，比下面方案 A 最初设想的还要简单。

5. **并发这件事，仓库里已经有先例，跟你的直觉一致**：`scripts/bench/run-pipeline-bench.mjs` 对多个 case 就是一个 `for (const caseItem of cases) { await ... }` 的串行循环，没有跨 case 并发；`docs/archive/prd.md` 里也有一条历史记录"本地 PGLite 在并发查询下会锁死，所以要串行跑"。QMD 背后是本地索引/CLI 进程，没有证据说明它能安全地扛并发调用。**结论：批量工具跨笔记必须严格串行**，笔记内部的候选判断并发（`DEFAULT_PER_CANDIDATE_CONCURRENCY = 5`，`obsidian-plugin/src/core/relation-judge.ts:478`）维持不变，那是另一层，跟 QMD 无关，是纯 LLM 调用。

## 设计

### 输入

一份笔记清单：可以是一个 vault 内的文件夹（递归取所有 `.md`），也可以是一份显式路径清单文件（一行一个 vault-relative 路径，方便你先手选一批想测的笔记）。两种都留，`--folder` 和 `--notes-file` 二选一。

### 执行模型：严格串行

对清单里的每条笔记，**一条跑完（QMD 检索 + Relation Judge 全部结束）才开始下一条**。不做任何跨笔记的 `Promise.all`。这既是对 QMD 稳定性的保护，也让失败定位简单——出问题了，日志上一眼看出是第几条、哪条笔记。

### 结果写入：方案 A（已选定，现在比最初设想的更简单）

给 `session-store.ts` 也编一份 Node 可用产物（仿照 `core` 目标）。在 `esbuild.config.mjs` 里加一个新的 build target（比如 `session`），入口选 `session-store.ts` 里要用到的导出（`recordRunningSessionRound`、`recordSuccessfulSessionRound`、`recordFailedSessionRound`、`sessionRecordKeyForSource`、`normalizeSessionStore`、`createEmptySessionStore`），跟 `core` 目标一样 `bundle: true` + `platform: "neutral"` 直接编译。**不需要任何 alias/stub 插件**——上面第 4 点已经确认这条依赖链在运行时不碰 `obsidian` 模块，plain esbuild 就能编译成功，比最初设想的"给 obsidian 挂个空实现 shim"更简单，本质上和 `core-artifact.mjs` 是同一套路子。

优点：批量工具用的和插件用的是**同一份逻辑**，不会出现"改了 session-store.ts 但批量工具没跟着改"的漂移——这正是这次文档整理反复踩到的坑（`openai-json-agent.mjs` 那次、`collect-review-seeds.mjs` 没跟上 ADR 0004 那次）。

（方案 B——批量工具自己手写一份写入逻辑，不 import `session-store.ts`——原本是留给"A 搭建成本较高"时的备选，现在 A 的成本已经降到跟 `core-artifact.mjs` 一样低，B 的"更快写"优势基本不存在了，只剩"两份平行实现容易drift"的代价，不再是需要认真权衡的选项，这里不再展开。）

### 安全前提（这条是硬约束，不是建议）

`data.json` 是 Obsidian 运行时在内存里维护、按需 `saveData()` 落盘的。**批量工具在 Obsidian 开着的时候写 `data.json`，随时可能被 Obsidian 自己下一次保存动作（改设置、点一下 Review Panel、甚至只是插件内部的定时逻辑）整体覆盖冲掉。**

所以：
- 批量运行期间，**Obsidian 必须关闭**，跑完之后再打开（或者重载插件），这样 `loadSettings()` 才会从磁盘读到批量工具写的新内容。
- 工具本身应该**每跑完一条笔记就立刻读-合并-写一次 `data.json`**，而不是攒在内存里等全部跑完再写一次——这样万一中途崩溃或者你手动 Ctrl+C，已经跑完的笔记不会丢。
- 跑之前自动备份一份 `data.json`（比如 `data.json.bak-<timestamp>`），万一写坏了能恢复。
- 建议用 `scripts/dev/install-dev-plugin.mjs` 装的 `-dev` 装载对应的 `data.json` 来跑（`.obsidian/plugins/aha-memory-surface-dev/data.json`），不要直接碰生产装载的那份，跑坏了影响小。

### 单条笔记失败不该拖垮整批

`AhaSessionRound` 本来就有 `status: "failed"` 这个状态（`recordFailedSessionRound`）。批量工具里某条笔记的 pipeline 抛错（LLM 超时、QMD 报错等），记一条 failed round 然后继续下一条，不要让整个批量任务因为一条笔记而中断。跑完在终端汇总"成功 N 条 / 失败 M 条，失败的是哪几条"。

### 输出：除了写进 data.json，建议再单独出一份可浏览报告

写进 `sessionStore` 是为了能在 Obsidian 里点开看；但如果你想不开 Obsidian、先粗筛一遍再决定看哪几条，光靠 `data.json` 不方便。建议批量工具跑完额外写一份 `bench/reports/latest/vault-batch-run.json`（或者类似路径），每条笔记的 candidates 摘要（notePath/relation/hit/why）都在里面，方便你用编辑器或者一个小脚本快速扫一遍，圈出想细看或者想收进评测集的几条，再去 Obsidian 里点开确认。这一步是加分项，不是必须，你可以砍掉。

### CLI 形状（草案）

```bash
node scripts/dev/run-batch-vault.mjs \
  --vault-root "$HOME/Obsidian Notes" \
  --plugin-id aha-memory-surface-dev \
  --folder "个人复盘" \
  # 或者： --notes-file bench/batch-notes.txt
  --limit 20 \
  --dry-run
```

- `--plugin-id` 默认指向 `-dev` 装载，明确要求手动传 `aha-memory-surface`（生产）才会碰生产数据，避免手滑。
- `--dry-run`：只打印会跑哪些笔记、预计调用次数，不真的调用 LLM/QMD，不写文件——批量跑之前先看一眼清单对不对。
- `--limit`：先跑一小批探路，确认没问题再跑全量。

## 测试计划

对应仓库现有的 `scripts/aha/tests/{unit,integration,e2e}` 三层惯例：

- **unit**：方案 A 编译出的 Node-safe session 写入逻辑的纯函数测试——给定一批模拟的 pipeline 结果，断言写出的 `sessionStore` 形状对、`MAX_ROUNDS_PER_RECORD` 剪枝对、`schemaVersion` 保留、`settings` 没被误改。笔记身份哈希（沿用 `sourceIdentity` 的算法）也要单测，保证同一条笔记多次跑对应同一个 `records` key。
- **integration**：批量工具本身（参数解析、清单读取、串行调度、单条失败不中断整批、`--dry-run` 不产生副作用、增量写入 `data.json` 的读-合并-写逻辑）——用 fixture 笔记 + 注入一个假的 `runFullPipeline`（不打真实 LLM/QMD），验证调度和落盘逻辑，不验证 pipeline 本身的检索质量（那是 bench 的职责）。
- **e2e（可选，仿照现有 `scripts/aha/tests/e2e` 的真实 DeepSeek 惯例）**：挑 1 条真实笔记、真实调一次 DeepSeek + QMD，验证端到端不报错、写出的 `data.json` 能被 `normalizeSessionStore()` 正常读回——这层照现有 e2e 分层的规矩，应该是可选跳过（没配 API key/QMD 就跳），不是每次 `npm run verify` 都强制跑。
- **guard test**：额外加一条，仿照仓库里已有的"schema 双份保持同步"惯例（比如 `schema.ts` 和 `aha-result.schema.json` 之间的 guard test），确保 esbuild 编译出的 session 产物导出的函数签名/行为和 `session-store.ts` 源码没有分叉。

## 待你决定的点

1. **方案 A 还是 B**（编一份 Node 产物 vs. 手写平行实现）——按照 A 来；Review Note markdown 功能清理后 A 的搭建成本进一步降低（不需要 obsidian shim），B 已经不用再权衡。
2. **批量工具放哪个目录**：`scripts/dev/`（因为它操作真实 vault、有点像 `install-dev-plugin.mjs` 那一类"直接碰真实环境"的工具）还是 `scripts/bench/`（因为目的是喂养评测集）？我倾向 `scripts/dev/`，但你更清楚自己会怎么找这个脚本。 同意。
3. **要不要做那份额外的可浏览报告**（`bench/reports/latest/vault-batch-run.json`）——加分项，你可以要也可以不要。 不需要。
4. **e2e 层要不要现在就写**——真实调用 DeepSeek/QMD 的批量测试会花真钱、跑得慢，可以先只做 unit/integration，e2e 留到工具本身稳定之后再补。 可以写。

方案定下来之后，我可以照着写实现和对应的三层测试。
