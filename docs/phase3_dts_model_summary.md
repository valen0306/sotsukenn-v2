# Phase 3 サマリー（DTS_MODEL: Qwen2.5-Coder-1.5B-Instruct / `.d.ts`注入）

## 目的（Phase3の研究対象）

Phase3は **API整合 / 型推論の質**を対象とするフェーズで、Phase1/2（型解決・境界整合）を前提に、
downstream TypeScript を編集せずに **外部JS/TSライブラリの型宣言（`.d.ts`）を注入**することで、
`tsc` の Phase3 core エラーがどれだけ減るかを評価する。

- **Phase3 core codes**: `TS2339, TS2345, TS2322, TS2554, TS2769, TS2353, TS2741, TS7053`

## 実装（評価パイプライン）

### 1) Real runner（`evaluation/real/phase3-run.mjs`）

- clone → install → baseline `tsc`
- baseline出力から Phase3 core を含む診断を抽出し、**診断が出たファイル**の `import` だけを対象に
  `module specifier` と `importされた名前`（value/type）を収集
- **注入用型パッケージ**を作成し、`tsconfig.__phase3__.json` を生成して `typeRoots/types` で確実に読み込ませる

### 2) Model adapter（`evaluation/model/typebert_infer.py`）

当初は「TypeBERT」を想定していたが、Phase3は「`.d.ts`生成」なので encoder-only BERT よりも
**小型のコード生成モデル（CausalLM）**が実装・評価に適しているため、以下に切替えた。

- **使用モデル**: `Qwen/Qwen2.5-Coder-1.5B-Instruct`（ローカル実行 / MPS）
- I/O: stdin JSON（modules）→ stdout JSON（`dts` 文字列）
- **キャッシュ**: `evaluation/real/cache/typebert`（入力+設定+adapter_versionでキー化）
- **安全策（重要）**
  - `declare module '...' { ... }` ブロックのみを抽出（brace balancing）
  - LLMが出しがちな “壊れるTS構文” を保守的に修正/除去
    - `export type { X }` → `export type X = any;`
    - `export { X }` → `export const X: any;`
    - `export type X: any;` → `export type X = any;`
  - 安全に抽出できない場合は **stub(any)へフォールバック**（パイプラインを止めない）

## 実験結果（ts1000由来 20件 / v4）

実行ログ:
- `evaluation/real/out/phase3-ts1000-20-qwen1_5b-model-v4/summary.tsv`
- `evaluation/real/out/phase3-ts1000-20-qwen1_5b-model-v4/results.jsonl`

### 重要な健全性指標（注入`.d.ts`が壊れていないか）

LLM生成 `.d.ts` は壊れると `TS1005/TS1109` 等で `tsc` が先に落ち、Phase3が「消えた」ように見えて
**偽陽性の改善**を生む。これを防ぐため、runner側で以下を導入した。

- `phase3InjectedDtsInvalid`: `TS1005/TS1109/...` が注入後に出た場合は `true`
- `phase3Reduced/eliminated` は **invalid/timeoutを除外してのみ** `true` を付与

v4の結果:
- **injectedDtsInvalid**: **1/20**
- **model-timeout**: **3/20**

### Phase3の改善（invalid/timeout除外の上で）

v4の集計:
- **phase3Reduced**: **3/20**
- **phase3Eliminated**: **2/20**
- Phase3 core 合計（全20件の単純合算）: **13555 → 7109（-6446）**
  - ※ timeout/invalidの扱いを含むため、最終的な統計は「有効注入のみ」で再集計するのが望ましい

代表例（有効注入での改善）:
- `DIYgod/RSSHub`: `7583 → 2717`
- `mermaid-js/mermaid`: `713 → 0`（eliminated）
- `type-challenges/type-challenges`: `21 → 0`（eliminated）

## 追加検証：drizzle-orm（invalid除去・timeout対策）

v4で唯一 invalid になった `drizzle-orm` は、生成`.d.ts`に `export type X: any;` が混入し、
`TS1005: '=' expected` を誘発していた。

対策:
- adapterに上記の修正ルールを追加（`export type X: ...` → `export type X = ...`）
- `--model-timeout-ms` を 600000 に増やして単体再実行

結果（`evaluation/real/out/phase3-drizzle-qwen1_5b-model-v6/summary.tsv`）:
- `phase3InjectedDtsInvalid=false`（構文的に健全）
- ただし Phase3 core は `1681 → 1917` と増加
  - 注入により **Phase2系（TS2305など）**が表面化し、Phase3単独介入としてはノイズが大きい例になった

## 解釈（現時点の結論）

- `.d.ts`生成モデルを Phase3 に接続する「評価の骨格（抽出→生成→注入→tsc→集計）」は成立した。
- LLM生成物の **構文健全性**は評価の前提条件であり、invalid検知とサニタイズが必須。
- Phase3単独介入では、repoによっては **Phase2/Phase1の不備が露出**して評価が歪む。
  - Phase3比較実験では、Phase2コードが少ないrepoに絞る、または Phase2+3の合成評価が必要。

## 次のステップ（推奨）

- **(A) 20→100件へ拡大**（まずは “Phase3単独で評価が成立するrepo” に絞って統計を安定化）
  - 有効注入のみの集計（invalid/timeout/Phase0除外）を正式指標にする
- **(B) timeout対策**（対象モジュール数上限/生成長上限、または `--model-timeout-ms` 調整）
- **(C) Phase2+Phase3合成評価**（Phase2で境界整合を先に整え、Phase3モデルの純粋な効果を見る）


