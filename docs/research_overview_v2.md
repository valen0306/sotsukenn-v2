# Research Overview v2（進捗反映版）

本書は `docs/research_overview.md` の更新版（v2）として、現時点の実装進捗と観測結果を踏まえて
研究方針・評価設計・次に回す実験を再整理する。

## 研究目的（変わらない軸）

目的は、**JSライブラリに対して自動生成した TypeScript 宣言（`.d.ts`）を注入**することで、
downstream TypeScript プロジェクトの **`tsc` 成功率（error-free）を最大化**すること。
局所的な型予測精度よりも、**下流のコンパイル成功**（TypeWeaver哲学）を一次指標とする。

## フェーズ分解（現時点の採用）

### Gate A/B（実験の成立条件）
- **Gate A**: repo root に `tsconfig.json` がある（real runner の前提）
- **Gate B**: 対象集合の定義（`S_err`, `S_lib`）が妥当であること

### Phase 1: 型“解決”（Type Resolution）
- 対象: `TS2307`, `TS7016`
- 介入: missing module specifier を抽出し `declare module '...'` スタブを注入

### Phase 2: 境界整合（Module Boundary Alignment）
- 対象: `TS2305`, `TS2613`, `TS2614`
- 介入: import/export 形の不整合を決定的変換（default→namespace等）で整える

### Phase 3: API整合（Type Inference Quality / API Alignment）
- 対象（core）: `TS2339, TS2345, TS2322, TS2554, TS2769, TS2353, TS2741, TS7053`
- 介入: `.d.ts` を注入（DTS_STUB / DTS_MODEL）して API レベルの型不整合を減らす

### Phase 4: Strictness-sensitive（副次）
- 対象: `TS7006`, `TS7031`, `TS18046` 等
- 介入: ノイズ除去/最小修正（研究としては副次）

## 現時点の実装状況（進捗）

### Fixtures（制御実験）
- Phase1〜4の fixtures と runner は実装済み

### Real evaluation（実プロジェクト）
- `evaluation/real/phase1-run.mjs`: Phase1注入→`tsc`差分
- `evaluation/real/phase2-run.mjs`: Phase2変換→`tsc`差分
- `evaluation/real/phase3-run.mjs`: Phase3注入→`tsc`差分
  - `--mode stub|model` をサポート
  - 注入を確実に読み込ませるため `tsconfig.__phase3__.json` を生成（`typeRoots/types`）
  - **`--resume`** 実装済み（中断→再開が可能）
  - **`--max-stub-modules`** 実装済み（巨大repoの暴走回避）

### DTS_MODEL（生成モデル）
当初の「TypeBERT」よりも、Phase3が `.d.ts` “生成”タスクである点を重視し、
**小型コード生成モデル（CausalLM）**を採用してエンドツーエンドを成立させた。

- アダプタ: `evaluation/model/typebert_infer.py`
  - ローカルHF checkpoint + `torch/transformers` で推論
  - キャッシュ: `evaluation/real/cache/typebert`（adapter_versionを含む）
  - 安全策（必須）:
    - `declare module '...' { ... }` ブロックのみ抽出（brace balancing）
    - 壊れやすい構文をサニタイズし、危険なら stub(any)にフォールバック

## Phase3実験A（モデル比較）: 現状の観測と課題

### “壊れた`.d.ts`”問題（偽陽性対策）
LLM生成 `.d.ts` が壊れると `TS1005/TS1109` 等で `tsc` が先に落ち、
Phase3エラーが「消えた」ように見える偽陽性を生む。

対策として runner に以下を導入済み:
- `phase3InjectedDtsInvalid` / `phase3InjectedDtsSyntaxCodes` を記録
- invalid/timeout の場合は `phase3Reduced/eliminated` を `false` にする
- 集計スクリプト `evaluation/real/analyze-phase3-results.mjs` で invalid/timeout を除外集計

### ranked100 実験（ts1000由来）
「Phase1/2完全除外」だと母数が足りないため、
**Phase1/2ノイズが少ない順にランキングして上位100件**を選ぶ方式を採用した。

- リスト生成: `evaluation/real/make-phase3-ranked-list.mjs`
- 100件リスト: `evaluation/real/inputs/phase3_ts1000_ranked100.txt`

観測（初回100件）:
- valid injection: 78/100
- invalid d.ts: 2/100
- model-timeout: 2/100
- reduced/eliminated は一定数ある一方で、**TS2339が増える例が多く、合計は悪化**する傾向が見えた

### TS2339爆増の主要因（解決済みの部分）
`import * as ns from 'm'` / `import x from 'm'` の後に `ns.foo` / `x.foo` と参照しているのに、
注入`.d.ts`が “named importされた名前だけ” を export していたため、
`ns.foo` が存在しない扱いになり TS2339 が増えるケースが大きかった。

対策:
- Phase3 runner に「namespace/default import の **member access（`.foo`）を抽出して export に追加**」する
  ヒューリスティックを実装し、トップ回帰2件（Signal-Desktop, prisma）で **TS2339を大幅抑制**できた。

## 以降の研究方針（v2での意思決定）

### Phase3 実験A（モデル比較）を優先して推進
- 目的: **モデル由来の改善/悪化を統計として捉える**
- 手段:
  - ranked100をベースに、invalid/timeout を除外した上で
    - reduced/eliminated
    - Phase3 core 合計差分
    - コード別内訳（特に TS2339）
  を定量化する

### 次に回すべき実験（優先順）
1. **ranked100 の再実行（v2）**
   - TS2339ヒューリスティック導入後の全体効果を再測定
   - `--resume` を前提に長時間実行を運用
2. **回帰分析（TS2339/TS2305等）**
   - “悪化repo上位” を抽出し、パターンを分類（外部依存/namespace参照/Phase2露出など）
3. **モデル条件の比較**
   - 同じ入力リスト・同じ制約で別モデル（同規模）を差し替え比較
4. （必要なら）Phase2+Phase3合成実験
   - 実運用性能（tsc成功率最大化）を測る実験Bとして別立てで実施

## Phase3（モデル固定）で進める場合の方針（2026-01追記）

モデル比較を後回しにする場合でも、研究として説得力を落とさず前進するために、
Phase3は「平均的改善の主張」より先に **失敗要因の体系化 → 軽量対策 → 同一入力で再評価**を軸にする。

### 1) 目的（主張の置きどころ）
- **評価パイプラインが成立している**こと（抽出→生成→注入→tsc→集計、invalid検知、resume等）
- Phase3 core の回帰（特に **TS2339 / TS2554**）がどのような条件で起きるかを **分類**し、
  「どこに手当てすると改善するか」を示す（RQ3寄りの貢献）

### 2) 進め方（ケーススタディ運用）
- ranked100 の結果から「悪化上位」「改善上位」をそれぞれ数件選び、注入`.d.ts`とエラー差分を読む
- 失敗パターンをカテゴリ化し、対策を“最小限のヒューリスティック”として runner/adapter 側に入れる
- **同じ ranked100 を再実行**して、(a) 悪化の上位が減ったか、(b) TS2339/TS2554の総量が減ったか、を確認する

#### 例: TS2339回帰への軽量対策（モデル出力の“欠落”を埋める）
Phase3の回帰では「モデルが requested exports を出し忘れる」ことで、注入後に TS2339/TS2554 が増えることがある。
そのため adapter 側で、各 `declare module` ブロックに対して **requested な export 名が存在しない場合は `any` として補完**する。
（結果ファイルに `.d.ts` 本体を埋めずに、キャッシュ参照 + `meta.missing_exports_filled_with_any` で追えるようにする）

### 3) `.d.ts`生成物の追跡（重要）
Phase3の失敗要因分析では「どのrepoで、どんな`.d.ts`が注入されたか」を後から辿れる必要がある。
そのため adapter は `cache_key` を返し、runner は結果にその参照だけを保存する（結果ファイル肥大を避ける）。

抽出例（1repoのケースを取り出す）:

```bash
node evaluation/real/extract-phase3-case.mjs \
  --out-dir evaluation/real/out/<OUT_DIR> \
  --url https://github.com/<owner>/<repo>.git \
  --dts-head 120
```

## 実行/再開の運用（重要）

長時間実験は中断が起きるため、以下を標準運用とする。
- `evaluation/real/phase3-run.mjs --resume` で再開（処理済URLをスキップし、results.jsonlに追記）
- `--max-stub-modules` で巨大repoを制限
- 実験終了後は `evaluation/real/analyze-phase3-results.mjs` で invalid/timeout 除外の統計を作成

## 成果物（現時点）
- Phase3の詳細サマリー: `docs/phase3_dts_model_summary.md`
- 実験の集計: `evaluation/real/analyze-phase3-results.mjs`
- 2つのout-dir比較: `evaluation/real/compare-phase3-outs.mjs`


