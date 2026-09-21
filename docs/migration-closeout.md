# 管线迁移收尾（0.3.2）

2026-09-21 核对当前代码、已安装插件和历史提交后收尾。产品评估以用户的 Surprise 反馈为核心；旧检索指标继续作为工程诊断。

## Issue 处理

| Issue | 结论与范围 |
|---|---|
| #52 | 用户明确选择结束旧指标驱动的方案晋级计划，按 **not planned** 关闭。不宣称历史 holdout 门槛通过，也不借本次清理切换检索策略。 |
| #60 | 补充 [QMD 安装与验收](./qmd-setup.md)，验证当前能力与真实安装。历史上线记录为 `14e5762`；本次使用已启用的 Dev 通道，升级至 0.3.2。 |
| #61 | 删除确认无日常调用的 wrapper、插件进程桥接、Node 路径检测、旧 SDK runner、隐藏回退开关及对应废弃配置。保留仍在使用的 bench 代理传输。 |
| #53 | 共享 core、插件内管线、能力降级、设置迁移及本次收尾交付完成。 |

原 tickets 中的双 provider、Review Note、永久保留 wrapper 回退等验收项已被之后的产品变更取代。DeepSeek 是当前唯一 provider，Session Store 保存会话和反馈。本文记录当前验收范围，不追认已移除功能的旧验收，也不声称在全新操作系统上重装过全部依赖。

## 删除与保留的依据

- 清理前，真实 vault 启用 `aha-memory-surface-dev` 0.3.1，`useLegacyWrapper=false`，没有正在运行的搜索；已跨过原 ticket 要求的一个发布周期。
- 删除 `obsidian-plugin/src/process.ts`、`scripts/aha/run-insight-search.mjs`；插件始终调用既有 `runTieredSearchForFile`。QMD CLI 的有界子进程和能力降级保持原实现。
- 删除 core Node adapter 中的 QMD SDK runner。现存 batch/debug 调用已显式注入 CLI adapter；默认 adapter 也统一为 CLI。
- wrapper 专属的进程、SDK、命令参数和 stdout 测试随入口移除。原文件中的结果 schema / 路径身份测试保留在 `result-contract.test.mjs`；core 与插件侧的查询失败降级、引句校验、过滤、超时、反馈测试继续执行。
- Codex CLI provider 和一次性 Review Note migration 在此次工作前已移除。迁移测试中仍保留旧字段作为历史输入，用于确认升级后会丢弃它们。
- **保留 `scripts/lib/openai-json-agent.mjs` 与 `https-proxy.mjs`**：`scripts/aha/query-plan.mjs`、`relation-judge.mjs` 和评测入口仍调用该传输。文件名是历史名称，不表示当前插件支持 OpenAI。它们不是死代码，本次没有更换其网络行为。
- 配置 schema 升至 4：从持久化数据中移除旧字段，迁移旧 endpoint 到 `qmdEnvironment`，已有现代配置（包括明确的空字符串）优先。没有重新生成或清空用户反馈。

## 验证证据

| 检查 | 结果 |
|---|---|
| `npm run verify` | lint、脚本语法、TypeScript、359 项测试和生产构建全部通过；无失败、无跳过 |
| 真实模型 | 测试覆盖真实 DeepSeek 查询生成、引句关系判断、三候选中文说明 |
| 真实批量入口 | 已有 E2E 用临时测试源笔记完成真实 QMD / DeepSeek 搜索，写入独立测试插件数据；测试随后清理临时产物 |
| QMD 隔离安装验收 | 复用已安装 QMD 2.5.3，在独立 config/cache 和合成 vault 注册 collection、update、embed、status；BM25 与向量检索各返回正确候选 1 条 |
| 健康与能力降级 | 测试覆盖 QMD 缺失、空索引、无 key、LLM 失败及 Full → Recall 的诚实结果；更新后的真实 Obsidian 健康检查返回 `Aha ready` |
| 已安装插件的三档搜索 | 在 Obsidian 中调用已加载插件的方法，使用隔离合成笔记和设置副本；Neighborhood / Recall / Full 均成功返回候选 1 条。Full 候选为 weak，仅证明调用与结果协议正常，不代表用户认可的有效关系或 Surprise |
| 安装与设置迁移 | 已启用 Dev 插件读回 0.3.2、schema 4；19 个遗留字段消失，所有保留设置逐项一致 |
| 会话与 Surprise | 重载前后完整 `sessionStore` 深度比较相等，包含所有历史候选、选择、反馈和 Surprise 想法；无需重新标注 |
| 另一安装副本 | 未启用的 `aha-memory-surface` 文件和数据与备份逐字节相等 |

历史 bench 等价性结论见 `124e7df`（基线）、`71547be`（确定性检索）、`e63af7b`（LLM 管线）。这些是历史提交记录，本次没有重跑私有 holdout 或重新报告 Recall / nDCG 改善。上表记录本地验收；远端 CI 结果以推送后对应提交的 GitHub Actions 记录为准。

隔离测试首次失败于测试库的 index / collection 名称不一致，以及 macOS 临时目录别名与真实路径不一致。改为同名 `obsidian` 并使用真实路径后通过；没有为通过测试修改产品的检索或关系判定逻辑。

## 本机备份与恢复

清理前备份：`~/Downloads/aha-cleanup-backup-20260921-135716/`。`manifest.json` 记录源文件清单；`source/` 保存删除前代码；`installed/` 保存两个插件的完整安装副本，含私有设置与 Session Store，不入库。

若需要恢复程序，停用 Dev 插件，将备份中的 `main.js`、`manifest.json`、`styles.css`、`versions.json` 复制回同名 Dev 目录并重新启用。数据优先保留升级后的最新文件；只有确认需要恢复历史状态时才替换 `data.json`，避免覆盖备份之后的新反馈。恢复旧源码可取 `source/`，不需要清空整个工作区。
