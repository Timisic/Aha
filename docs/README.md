# 文档地图

产品定位与架构总览见根目录 [README](../README.md)。

## 当前有效

| 文档 | 内容 |
|---|---|
| [product.md](./product.md) | 产品定义：用户、目的、设计原则、反面参照 |
| [../CONTEXT.md](../CONTEXT.md) | 领域术语表：insight/judgment 工作流、检索、评测各环节的统一语言 |
| [obsidian-plugin-operations.md](./obsidian-plugin-operations.md) | 插件运行细节：失败可见性、代理与重试、候选安全、身份幂等 |
| [obsidian-plugin-smoke.md](./obsidian-plugin-smoke.md) | 当前 Session Store + Review Panel 路径的手工 smoke 清单 |
| [../bench/README.md](../bench/README.md) | 反馈闭环、suite/profile、trace/metrics 与 named workflows |

## PRD（`prd/`）

| 文档 | 范围 |
|---|---|
| [aha-obsidian-plugin-mvp.md](./prd/aha-obsidian-plugin-mvp.md) | 插件第一版：最小可用闭环（触发 → 检索 → Review Note） |
| [aha-obsidian-plugin-full.md](./prd/aha-obsidian-plugin-full.md) | 插件完整形态的目标行为 |
| [aha-review-panel-mvp.md](./prd/aha-review-panel-mvp.md) | 右侧 Review Panel 第一版 |

## 架构决策（`adr/`）

| ADR | 决策 |
|---|---|
| [0001](./adr/0001-split-memory-surface-from-reasoning-workflow.md) | Memory Surface（插件）与 Reasoning Workflow（wrapper/LLM）分层 |
| [0002](./adr/0002-primary-benchmark-schema.md) | benchmark case 的主 schema 边界 |
| [0003](./adr/0003-use-a-single-pipeline-trace-schema.md) | 单一 PipelineTrace schema 贯穿评测与诊断 |
| [0004](./adr/0004-use-session-store-for-aha-panel-state.md) | Session Store 是 Panel 状态与 feedback 的 source of truth |

## 归档（`archive/`）

历史材料，只读不维护：最初的 Pi Extension PRD 与方案（`prd.md`、`initial.md`）、已完成的 issue 清单（`aha-review-issues.md`、`aha-review-panel-issues.md`、`aha-pipeline-trace-issues.md`）、插件就绪清单（`obsidian-plugin-readiness.md`）、实现快照（`obsidian-plugin-mvp-implementation-snapshot-2026-06-28.md`）、trajectory 调试说明（`trajectory-debugging.md`）。
