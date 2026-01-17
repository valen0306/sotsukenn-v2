## ranked30 比較（Qwen2.5-Coder-1.5B-Instruct / Phase3）

対象: `evaluation/real/inputs/phase3_ts1000_ranked100.txt` の先頭30件

### 条件

- **A: heuristic**: `evaluation/real/out/phase3-ts1000-ranked30-qwen1_5b-v18-heuristic`
- **B: depsfilter（timeout再実行をマージ）**: `evaluation/real/out/phase3-ts1000-ranked30-qwen1_5b-v20-depsfilter-merged`

### 集計（Phase3 core / valid injectionのみ）

| 指標 | A: heuristic(v18) | B: depsfilter merged(v20) |
|---|---:|---:|
| repos_total | 30 | 30 |
| repos_valid_injection | 20 | 16 |
| repos_invalid_dts | 1 | 1 |
| repos_model_timeout | 0 | 0 |
| phase3Reduced_valid | 7 | 5 |
| phase3Eliminated_valid | 4 | 3 |
| phase3Total_valid_baseline | 633 | 523 |
| phase3Total_valid_injected | 689 | 579 |
| phase3Total_valid_delta | +56 | +56 |

### コード別（Phase3 core / valid injectionのみ）

| code | A baseline | A injected | A delta | B baseline | B injected | B delta |
|---|---:|---:|---:|---:|---:|---:|
| TS2339 | 205 | 296 | +91 | 143 | 231 | +88 |
| TS2345 | 247 | 27 | -220 | 239 | 42 | -197 |
| TS2322 | 72 | 127 | +55 | 71 | 65 | -6 |
| TS2554 | 11 | 196 | +185 | 11 | 187 | +176 |
| TS2769 | 61 | 5 | -56 | 24 | 14 | -10 |
| TS2353 | 2 | 4 | +2 | 2 | 3 | +1 |
| TS2741 | 6 | 5 | -1 | 6 | 7 | +1 |
| TS7053 | 29 | 29 | 0 | 27 | 30 | +3 |

### ケーススタディ候補（差が大きいもの）

差分TSV（repo別）: `evaluation/real/report-ranked30-compare.tsv`

- **depsfilterで改善（TS2339/Phase3が減る）**
  - `alibaba/formily`: TS2339 **105→60**（-45）, Phase3 **303→187**（-116）
- **depsfilterで悪化（TS2339/Phase3が増える）**
  - `BetterDiscord/BetterDiscord`: TS2339 **3→31**（+28）, Phase3 **43→106**（+63）


