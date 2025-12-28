# evaluation/fixtures/phase1

Phase 1（型“解決”）用の評価コードです。

対象fixtures:
- `evaluation-data-set/fixtures/phase1/TS2307/**`
- `evaluation-data-set/fixtures/phase1/TS7016/**`

この評価は **baseline（注入なし）** と **inject（`.d.ts` 注入あり）** を同一fixtureから複製して実行し、
`tsc` の終了コードとTSエラーコード（TSxxxx）を比較します。

## 前提
- `tsc` がPATHにあること（例: `tsc --version` が通る）

## 実行

```bash
node evaluation/fixtures/phase1/run.mjs
```

成果物:
- `evaluation/fixtures/phase1/out/results.jsonl`（1プロジェクト=1行の詳細）
- `evaluation/fixtures/phase1/out/summary.tsv`（一覧）
- `evaluation/fixtures/phase1/work/`（一時作業ディレクトリ）


