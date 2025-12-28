# evaluation/fixtures/phase3

Phase 3（API整合: 型推論の“質”）の評価コードです。

Phase3 fixtures は「下流TSプロジェクトが **外部JSライブラリ（擬似）** を import して使う」構造で作られており、
baseline では **ライブラリ側の `.d.ts` がズレている**ため、特定のTSエラーコードが単体で出ます。

inject では「より良い `.d.ts`（DTS_STUB 相当）」を **node_modules に注入**して `tsc` を再実行し、
エラーが消えるか（exitCode=0、TSコード無し）を確認します。

## 対象fixtures
- `evaluation-data-set/fixtures/phase3/TS2339/**`
- `evaluation-data-set/fixtures/phase3/TS2322/**`
- `evaluation-data-set/fixtures/phase3/TS2345/**`
- `evaluation-data-set/fixtures/phase3/TS2554/**`
- `evaluation-data-set/fixtures/phase3/TS2769/**`
- `evaluation-data-set/fixtures/phase3/TS2353/**`
- `evaluation-data-set/fixtures/phase3/TS2741/**`
- `evaluation-data-set/fixtures/phase3/TS7053/**`

## 実行

```bash
node evaluation/fixtures/phase3/run.mjs
```

成果物:
- `evaluation/fixtures/phase3/out/results.jsonl`
- `evaluation/fixtures/phase3/out/summary.tsv`
- `evaluation/fixtures/phase3/work/`


