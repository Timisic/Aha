# Public Synthetic Baseline

This baseline is intentionally deterministic and uses only repository-owned synthetic notes under `bench/synthetic/vault/`.

Required local/CI command:

```bash
npm --prefix insight-package run test:bench:synthetic
```

Thresholds:

| Gate | Threshold |
|---|---:|
| L1 QMD synthetic avg R@K | `>= 1.000` |
| L2 pipeline synthetic avg R@K | `>= 1.000` |
| L2 missing must-recall matches | `0` |
| L3 core-loop contract | `ok` |

Required gates use deterministic query generation (`rules`) and reranker-off mode. Agent query generation and agent reranking belong to the optional manual workflow only.
