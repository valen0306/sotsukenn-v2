# evaluation/fixtures/phase4

Phase 4（strictness-sensitive / 運用制約）fixtures 向けの評価コードです。

対象fixtures:
- `evaluation-data-set/fixtures/phase4/TS7006/**`
- `evaluation-data-set/fixtures/phase4/TS7031/**`
- `evaluation-data-set/fixtures/phase4/TS18046/**`

この評価は **baseline（修正なし）** と **inject（最小修正を適用）** を同一fixtureから複製して実行し、
`tsc` の終了コードとTSエラーコード（TSxxxx）を比較します。

## 前提
- `tsc` がPATHにあること

## 実行

```bash
node evaluation/fixtures/phase4/run.mjs
```

## injectで適用する最小修正（変換ルール）
対象は `src/index.ts` のみです。

- **TS7006**: 暗黙anyの引数に型注釈を追加  
  `function f(x) { ... }` → `function f(x: any) { ... }`
- **TS7031**: 分割代入の暗黙anyを、引数型で解消  
  `function f({ a }) { ... }` → `function f({ a }: { a: any }) { ... }`
- **TS18046**: `unknown` へのプロパティアクセスを型アサーションで回避  
  `console.log(x.foo)` → `console.log((x as any).foo)`

成果物:
- `evaluation/fixtures/phase4/out/results.jsonl`
- `evaluation/fixtures/phase4/out/summary.tsv`
- `evaluation/fixtures/phase4/work/`


