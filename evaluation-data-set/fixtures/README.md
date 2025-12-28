# Fixtures: usage-driven `.d.ts` synthesis のための簡易データセット

この `evaluation-data-set/fixtures/` は、研究概要 `docs/research_overview.md` の「fixtures（小規模・制御された下流）」を実体化したものです。

目的:
- **依存JSライブラリが型定義（`.d.ts`）を持たない**ことにより、下流TSプロジェクトの `tsc --noEmit` が **TS7016** で確実に失敗する状態を作る
- 将来的に `.d.ts` を「注入」したときに `tsc` が通ることを sanity check できるようにする

## 構成

- `error-TS7016/fixture-lib-no-types/`
  - 型定義を提供しないJSライブラリ（`.d.ts`無し、`package.json` に `types/typings` も無し）
- `error-TS7016/downstream-*/`
  - 上記ライブラリに `file:../fixture-lib-no-types` で依存する下流TSプロジェクト群

各 downstream は、import/require の形とAPI利用形（call/new/property/await/then/callback 等）を分けてあります。

## 期待される挙動（ベースライン）

各 downstream で `tsc --noEmit` を実行すると、概ね次が発生します:
- **TS7016**: `Could not find a declaration file for module 'fixture-lib-no-types'.`

（研究概要の「TS2307/TS7016起点のデータセット定義」に沿うため、fixtures では狙って TS7016 を起こします。）

## 実行方法（ローカルで）

前提:
- Node.js が入っていること
- `npm` が使えること

例: `error-TS7016/downstream-default-call/` を実行

```bash
cd evaluation-data-set/fixtures/error-TS7016/downstream-default-call
npm install
npm run typecheck
```

## 将来の `.d.ts` 注入ポイント（実装は別ステップ）

下流側に以下のような「ローカル型定義」を追加すると、TS7016が解消されます（例）。
（このリポジトリでは、注入ロジックの実装は後で行います。）

- `downstream-*/types/fixture-lib-no-types/index.d.ts`
- かつ `tsconfig.json` の `typeRoots` や `paths`、または `typesVersions` などで解決させる


