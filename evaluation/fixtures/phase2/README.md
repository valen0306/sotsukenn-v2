# evaluation/fixtures/phase2

Phase 2（モジュール境界: export/import形の整合）の評価コードです。

対象fixtures:
- `evaluation-data-set/fixtures/phase2/TS2305/**`
- `evaluation-data-set/fixtures/phase2/TS2613/**`
- `evaluation-data-set/fixtures/phase2/TS2614/**`

この評価は **baseline（修正なし）** と **inject（モジュール境界の修正を適用）** を同一fixtureから複製して実行し、
`tsc` の終了コードとTSエラーコード（TSxxxx）を比較します。

## 前提
- `tsc` がPATHにあること

## 実行

```bash
node evaluation/fixtures/phase2/run.mjs
```

## 変換ルール（injectで適用する “モジュール境界修正”）

Phase2では `.d.ts` 注入というより、**下流の import 形を、供給側モジュール（`src/lib.ts`）の export 形に合わせる**変換を適用します。
（実装は `evaluation/fixtures/phase2/run.mjs` の `applyPhase2Fix`）

対象は **`src/index.ts` の import 1行のみ**です。

- **TS2613（default export が無いのに default import）**:

```ts
import x from "./lib";
```

を

```ts
import { x } from "./lib";
```

へ変換

- **TS2614（named export が無いのに named import：default-only module）**:

```ts
import { greet } from "./lib";
```

を

```ts
import greet from "./lib";
```

へ変換

- **TS2305（exported member が無いのに named import：別名で整合させる）**:

```ts
import { b } from "./lib";
```

を

```ts
import { a as b } from "./lib";
```

へ変換（`lib.ts` 側が `export const a = ...` のため）

成果物:
- `evaluation/fixtures/phase2/out/results.jsonl`（1プロジェクト=1行の詳細）
- `evaluation/fixtures/phase2/out/summary.tsv`（一覧）
- `evaluation/fixtures/phase2/work/`（一時作業ディレクトリ）


