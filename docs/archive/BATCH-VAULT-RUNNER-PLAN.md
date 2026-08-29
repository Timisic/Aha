# 方案：批量跑真实笔记，结果落进 Obsidian

> 临时文档，放在根目录方便你先看；后续会挪进 `docs/archive/`。方案已定，未写代码。

## 目标

给一批真实笔记（一个文件夹，或一份路径清单），逐条跑真实的 Aha 管线（真实 vault、真实 DeepSeek、真实 QMD 索引），把结果写回 Obsidian 插件的状态里，让你事后打开 Obsidian 就能在 Review Panel 里点开每一条看结果——不用一条条手动触发。跑完之后，从里面手动挑有用的候选，整理进 `bench/aha-memory-cases.json` 的评测集。

工具位置：`scripts/dev/run-batch-vault.mjs`。

## 设计

### 输入

一份笔记清单：可以是一个 vault 内的文件夹（递归取所有 `.md`），也可以是一份显式路径清单文件（一行一个 vault-relative 路径，方便你先手选一批想测的笔记）。两种都留，`--folder` 和 `--notes-file` 二选一。

### 单条笔记怎么跑

照抄 `scripts/debug-pipeline.mjs` 的做法：读真实插件 `data.json` 里的 DeepSeek key/model，调 `scripts/lib/core-artifact.mjs` 的 `runFullPipeline`——和插件在 Obsidian 里跑的是同一份编译逻辑。

### 执行模型：严格串行

对清单里的每条笔记，**一条跑完（QMD 检索 + Relation Judge 全部结束）才开始下一条**，不做跨笔记的 `Promise.all`。QMD 背后是本地索引/CLI 进程，没有证据表明能安全扛并发调用（`scripts/bench/run-pipeline-bench.mjs` 对多个 case 本身也是串行）。笔记内部的候选判断并发（`DEFAULT_PER_CANDIDATE_CONCURRENCY = 5`）维持不变，那是另一层，跟 QMD 无关。

### 结果写入

给 `session-store.ts` 也编一份 Node 可用产物（仿照 `esbuild.config.mjs` 里的 `core` target）：新增一个 build target（比如 `session`），入口选 `recordRunningSessionRound`、`recordSuccessfulSessionRound`、`recordFailedSessionRound`、`sessionRecordKeyForSource`、`normalizeSessionStore`、`createEmptySessionStore`，`bundle: true` + `platform: "neutral"` 直接编译，不需要任何 alias/stub 插件（`session-store.ts` 运行时依赖链已经完全不碰 `obsidian` 模块）。批量工具跟插件用的是同一份逻辑，不会出现"改了 session-store.ts 但批量工具没跟着改"的漂移。

`data.json` 结构（`main.ts:45`）：`{ settings, sessionStore, schemaVersion }`，`sessionStore = { schemaVersion: 1, records: { [key]: AhaSessionRecord } }`。笔记身份用 `source-identity.ts` 的 `sourceIdentity()`（对 `dev`/`ino`/`birthtimeMs` 哈希，退化到 `ctime`）。

### 安全前提（硬约束）

`data.json` 是 Obsidian 运行时在内存里维护、按需 `saveData()` 落盘的。**批量工具在 Obsidian 开着的时候写 `data.json`，随时可能被 Obsidian 自己下一次保存动作整体覆盖冲掉。**

- 批量运行期间，**Obsidian 必须关闭**，跑完之后再打开（或重载插件），`loadSettings()` 才会读到新内容。
- 每跑完一条笔记就立刻读-合并-写一次 `data.json`，不要攒到全部跑完再写——中途崩溃或 Ctrl+C 也不丢已跑完的。
- 跑之前自动备份一份 `data.json`（如 `data.json.bak-<timestamp>`）。
- 用 `scripts/dev/install-dev-plugin.mjs` 装的 `-dev` 装载对应的 `data.json` 来跑，不要直接碰生产装载的那份。

### 单条笔记失败不该拖垮整批

用 `AhaSessionRound` 已有的 `status: "failed"`（`recordFailedSessionRound`）：某条笔记 pipeline 抛错就记一条 failed round，继续下一条。跑完在终端汇总"成功 N 条 / 失败 M 条，失败的是哪几条"。

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

- `--plugin-id` 默认指向 `-dev` 装载，需手动传 `aha-memory-surface`（生产）才会碰生产数据。
- `--dry-run`：只打印会跑哪些笔记，不调用 LLM/QMD，不写文件。
- `--limit`：先跑一小批探路。

## 测试计划

对应仓库现有的 `scripts/aha/tests/{unit,integration,e2e}` 三层惯例：

- **unit**：编译出的 Node-safe session 写入逻辑的纯函数测试——给定一批模拟 pipeline 结果，断言写出的 `sessionStore` 形状对、`MAX_ROUNDS_PER_RECORD` 剪枝对、`schemaVersion` 保留、`settings` 没被误改。笔记身份哈希也要单测，保证同一条笔记多次跑对应同一个 `records` key。
- **integration**：批量工具本身（参数解析、清单读取、串行调度、单条失败不中断整批、`--dry-run` 无副作用、`data.json` 的增量读-合并-写）——用 fixture 笔记 + 注入假的 `runFullPipeline`，不打真实 LLM/QMD。
- **e2e**：挑 1 条真实笔记、真实调一次 DeepSeek + QMD，验证端到端不报错、写出的 `data.json` 能被 `normalizeSessionStore()` 正常读回，仿照现有 e2e 分层（无 API key/QMD 时跳过）。
- **guard test**：仿照仓库已有的"schema 双份保持同步"惯例，确保编译出的 session 产物导出的函数签名/行为和 `session-store.ts` 源码没有分叉。
