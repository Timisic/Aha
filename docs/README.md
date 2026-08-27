# 文档地图

产品定位与架构总览见根目录 [README](../README.md)。本目录只保留仍然有效的文档，过期材料一律移入 `archive/`。

## 当前有效

| 文档 | 内容 |
|---|---|
| [product.md](./product.md) | 产品定义：用户、目的、设计原则、反面参照 |
| [../CONTEXT.md](../CONTEXT.md) | 领域术语表：insight/judgment 工作流、检索、评测各环节的统一语言 |
| [obsidian-plugin-operations.md](./obsidian-plugin-operations.md) | 插件运行细节：失败可见性与降级、传输与重试、候选边界、会话身份 |
| [architecture-audit-serendipity.md](./architecture-audit-serendipity.md) | 管线流程与关键参数速查 + serendipity 优化待办清单（P0–P3 均未实施） |
| [../bench/README.md](../bench/README.md) | 评测用例 schema、运行方式、eval-v2 指标与 PipelineTrace |
| [../scripts/README.md](../scripts/README.md) | scripts/ 目录布局与常用命令 |

## 架构决策（`adr/`）

| ADR | 决策 |
|---|---|
| [0001](./adr/0001-split-memory-surface-from-reasoning-workflow.md) | Memory Surface 与 Reasoning Workflow 分层（其中 Review Note 作为状态底座、wrapper/Codex 承担检索编排两点已分别被 0004、0005 取代） |
| [0002](./adr/0002-primary-benchmark-schema.md) | benchmark case 的主 schema 边界 |
| [0003](./adr/0003-use-a-single-pipeline-trace-schema.md) | 单一 PipelineTrace schema 贯穿评测与诊断 |
| [0004](./adr/0004-use-session-store-for-aha-panel-state.md) | 面板状态存在 Session Store，Review Note 降级为显式导出 |
| [0005](./adr/0005-share-compiled-core-between-plugin-and-bench.md) | `src/core/` 是编排逻辑唯一事实来源，插件与 bench 共用同一份编译产物 |

## 归档（`archive/`）

历史材料，只读不维护，不代表当前架构：最初的 Pi Extension PRD 与方案（`prd.md`、`initial.md`）、已交付的三份 PRD（`aha-obsidian-plugin-mvp-prd.md`、`aha-obsidian-plugin-full-prd.md`、`aha-review-panel-mvp-prd.md`）、已完成的 issue 清单（`aha-review-issues.md`、`aha-review-panel-issues.md`、`aha-pipeline-trace-issues.md`）、插件就绪清单与实现快照（`obsidian-plugin-readiness.md`、`obsidian-plugin-mvp-implementation-snapshot-2026-06-28.md`）、MVP 期手工 smoke 清单（`obsidian-plugin-smoke.md`）、已落地的 sprint 决策记录（`sprint-weak-noise-and-trace.md`）、trajectory 调试说明（`trajectory-debugging.md`）、已完成的管线内化迁移进度记录（`PROGRESS.md`，#54–#61，#61 遗留 wrapper/codex 清理未做但下一阶段工作另行跟踪）。
