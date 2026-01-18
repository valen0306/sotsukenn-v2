## 改訂版：現状を踏まえた方針A（今後の方針）

### 0. 結論（最初に言う1文）
現状の評価ハーネス（`.d.ts`注入 → consumerで`tsc` → ログ取得）があるため方針Aは十分適用可能。  
ただし「研究としての新規性」を立てるために、**宣言単位の追跡（ID化）**と **Δerrors による弱教師データ生成**を追加し、Localizer/Rerankerを段階的に導入する。

---

### 1. 現状資産をどう位置づけるか（ゼミ用）
#### すでに揃っている前提（応用可能な理由）
- consumerに `.d.ts` を注入して `tsc` を回すパイプライン
- `tsc` の診断（エラー）を取得できるログ基盤
- 再現性確保のための実行手順（固定化の意識）

→ これらは方針Aの **学習データ生成と評価ループ**の土台。

#### 足りないもの（研究として成立させるための最小追加）
- **宣言ID**: どの `.d.ts` のどの宣言を変えたか追える
- **候補ID**: Top-k のどれを採用したか追える
- **Δerrorsログ**: 候補を変えたとき、エラーが増減したか（弱教師）

---

### 2. 提案（方針A）を“現状に合わせて”定義し直す
方針Aの中心を次の2点に固定する。

#### 新規性の焦点
- **Error Localizer**: `tsc`エラーから「直すべき宣言」を局所化して探索空間を縮める
- **Error-aware Reranker**: `tsc`の結果（Δerrors）を教師にして「次に試す候補」を学習で当てる

※ Base Generator（TypeBERT相当）は“既存利用”で良い。新規性はLocalize/Rerankに置く。

---

### 3. 実装・研究の進め方（段階的に“成果が出る”順）
Apple M4 32GBでは学習より `tsc` 回数がボトルネックになりやすい。  
よって、まず **探索回数を減らす仕組み**から入れる。

#### Phase 0：ログとIDの整備（最優先）
**目的**: 現状の資産を“学習できる資産”に変換する。
- `tsc`診断をJSON化（`code/file/range/message`）
- `.d.ts`宣言を分割して `declaration_id` を付与
- Top-k候補に `candidate_id` を付与
- 差し替え試行ごとに **Δerrors** を記録

**この時点でできること**
- 「どの宣言変更が、どのエラーを減らしたか」をログとして説明可能  
→ ここだけでもゼミで「次の研究段階へ進める根拠」が出せる

#### Phase 1：Localizer v0（ルール）で探索を減らす
**目的**: 学習なしでも“研究としての仮説”を検証する第一歩。
- エラー位置のASTから `call/property/import` を辿り、関連しそうな宣言 Top-M を返す
- その Top-M だけ探索する

**このリポジトリでのまず最初の実装（v0）**
- `evaluation/real/phase3-run.mjs` に **探索モード**を追加する（候補を複数試してΔerrorsを貯める）
  - `--trial-strategy module-any-sweep`
  - `--trial-max N`（Top-1 + N-1候補を試す）
  - モジュール候補は `--localizer-top-modules M` で絞る（Top-M外部モジュール）

例（まずはconsumer 10件で小さく回す）:

```bash
node evaluation/real/phase3-run.mjs \
  --mode model \
  --repos-file evaluation/real/inputs/phase3_ts1000_ranked100.txt \
  --out-dir evaluation/real/out/phase3-ts1000-10-model-sweep \
  --max 10 \
  --concurrency 1 \
  --timeout-ms 600000 \
  --external-filter deps \
  --localizer-top-modules 10 \
  --trial-strategy module-any-sweep \
  --trial-max 6 \
  --verbose
```

**期待できる結果**
- 成立率が同程度でも、`tsc`回数（試行回数）が減る
- 悪化ステップ（エラー増）が減る可能性

**ゼミでの言い方**
- “`tsc`のエラー位置≠原因宣言”問題に対し、局所化で探索空間を縮める

#### Phase 2：ベースライン確立（比較できる状態にする）
**目的**: 提案の効果を言い切るための比較軸を作る。

最低限の比較を揃える：
- **B0**: Base Top-1固定
- **B1**: 単純探索（Localizerなし、Top-k順）
- **A1**: Localizerあり探索（学習なし）

**アウトプット**
- “局所化だけでどれだけ回数が減ったか”のグラフ
- M4環境で回る実験スケール感が確定

**Phase2（実測の最小結果 / max=5の例）**
- 比較対象:
  - B0: `--trial-strategy top1 --trial-max 1`
  - B1: `--trial-strategy module-any-sweep --trial-max 6 --localizer-top-modules 999999`
  - A1: `--trial-strategy module-any-sweep --trial-max 6 --localizer-top-modules 3`
- 観測（比較できた3repoの平均）:
  - B1: `avg_trialsRun=4.00` / `avg_tsc_calls=5.00`
  - A1(top3): `avg_trialsRun=3.33` / `avg_tsc_calls=4.33` （探索回数が減った）
- Phase3 core の総量（valid only）は B1 と A1 で同一（このスケールでは「性能を落とさず回数削減」が示せた）

#### Phase 3：学習データ生成（弱教師）を本格化
**目的**: Rerankerを学習させるためのデータを自動で貯める。
- Localizerが出した宣言候補について、Top-k候補を一つずつ差し替えて `tsc`
- Δerrors をログに貯め、pairwise（AよりBが良い）形式に変換

**ポイント**
- 人手で正解型を作らない
- “`tsc`が改善したか”を教師にする＝卒論として再現性が高い

**このリポジトリでの実行（Phase3 v0: JSONL生成）**
- 前提: `evaluation/real/phase3-run.mjs` が `results.jsonl` に `trials[].delta_phase3` / `trials[].delta_errors` を出力している
- 生成: `evaluation/real/export-phase3-pairwise.mjs` で pairwise JSONL を作る（弱教師）

例（max=20のB1/A1結果から生成）:

```bash
node evaluation/real/export-phase3-pairwise.mjs \
  --out-dir evaluation/real/out/phase2-B1-sweep-nolocalizer-max20 \
  --out-dir evaluation/real/out/phase2-A1-localizer3-sweep-max20 \
  --out-file evaluation/real/out/phase3-pairwise-max20.jsonl
```

#### Phase 4：Reranker v0（軽量ML）で「収束」を改善
**目的**: 方針Aの主張（探索を学習で賢くする）を成立させる。
- まずは軽量モデル（ロジスティック / LightGBM）で十分
- 入力: エラー特徴（code等）＋宣言特徴＋候補型特徴
- 出力: Top-k順位（次に試す候補を決める）

**期待結果（言えると強い）**
- 同じ成功率で `tsc`回数をさらに削減
- 悪化率（Δ>0）を減らす
- any率を上げずに到達（目的関数を入れる場合）

**このリポジトリでの実行（Phase4 v0: ロジスティック回帰/SGD）**
1) Phase3でpairwise JSONLを作る（`evaluation/real/export-phase3-pairwise.mjs`）
2) それを学習してモデル(JSON)を書き出す（Nodeのみ、外部依存なし）

例:

```bash
# 1) pairwise生成（特徴量入り）
node evaluation/real/export-phase3-pairwise.mjs \
  --out-dir evaluation/real/out/phase2-B1-sweep-nolocalizer-max20 \
  --out-dir evaluation/real/out/phase2-A1-localizer3-sweep-max20 \
  --out-file evaluation/real/out/phase3-pairwise-max20.jsonl

# 2) 学習（簡易評価: train/test accuracy を出力）
node evaluation/real/train-reranker-v0.mjs \
  --pairwise evaluation/real/out/phase3-pairwise-max20.jsonl \
  --out-model evaluation/real/out/reranker-v0-max20.json
```

#### Phase 5：統合評価（A3）と分析（卒論の核）
- **A3**: Localizer + Reranker（提案）
- エラーコード別（TS2345など）で効果差を分析
- “効く条件/効かない条件”を整理（module解決系は別枠など）

**このリポジトリでの実行（Phase5 / A3）**
- A1（Localizerのみ探索）に対して、A3（Localizer + Reranker）で
  - `avg_tsc_calls` の削減（=探索回数削減）
  - 悪化率（chosen が baseline より悪い割合）の低下
  - Phase3 core 改善の維持
  を比較する。

例（max=20、Top3に絞り、Rerankerで候補順を決めて少ない試行で収束させる）:

```bash
# A3: Localizer + Reranker（候補順を学習で決める）
node evaluation/real/phase3-run.mjs \
  --mode model \
  --repos-file evaluation/real/inputs/phase3_ts1000_ranked100.txt \
  --out-dir evaluation/real/out/phase5-A3-localizer3-reranker-v0-max20 \
  --max 20 \
  --concurrency 1 \
  --timeout-ms 600000 \
  --external-filter deps \
  --localizer-top-modules 3 \
  --trial-strategy reranker-v0 \
  --trial-max 3 \
  --reranker-model evaluation/real/out/reranker-v0-max20.json \
  --verbose
```

**Phase5（実測 / max=30）**
- 母数: `repos_total=30`, `repos_valid_injection=17`（A1/A3共通）
- Phase3 core（valid only）: A1/A3ともに `delta=-103`（改善量は同等）
- 探索回数（= tsc回数、valid 17件平均）:
  - A1（module-any-sweep, trial-max=6）: `avg_tsc_calls=4.41`
  - A3（reranker-v0, trial-max=3）: `avg_tsc_calls=3.76`（**削減**）
- 悪化率/改善率（baseline比）:
  - A1: `chosen_worse_than_baseline_rate=0.471`, `chosen_better_than_baseline_rate=0.294`
  - A3: 同値（現状の特徴量では「順序付け」で回数削減はできるが、悪化率の低減はまだ出ていない）

**追加実験：Reranker特徴量の強化（feat2）**
- 変更: pairwiseの特徴量を拡張（例: `override_localizer_rank`, `override_mention_ts2307/ts2614`, `baseline_ts2339/ts2345/...` などの数値特徴）
- 学習（max=20由来pairwise 146件）: `train_acc=0.702`, `test_acc=0.643`
- 統合評価（A3 feat2 / max=30）:
  - `avg_tsc_calls=3.76`, `chosen_worse_than_baseline_rate=0.471`, `chosen_better_than_baseline_rate=0.294`
  - **旧A3と完全一致**（Phase3 deltaも同じ）
- 解釈（現時点の仮説）:
  - 候補集合（trial-max=3）の中で **Top1が支配的**で、順序を変えても選択が変わりにくい
  - そもそも「Top1より良い候補」がほぼ無い（`win_rate_vs_top1=0`）ため、特徴量を増やしても悪化率が動かない
  - 次の改善は、(a) 候補生成の多様化（Top1以外に“良い候補”を作る）か、(b) エラー位置→外部モジュールの結びつきを特徴量化して“悪い候補”を避ける、のどちらかが必要

**追加実験：Localizer v1（per-error）= エラー位置→モジュール結びつきの重み付け**
- 変更: `--localizer-mode per-error` を追加し、モジュールのランキングを
  - `per-file`（従来）: 「Phase3エラーが出たファイル」ごとのimport頻度
  - `per-error`（新）: 「Phase3エラー1件」ごとに、そのファイルがimportする外部モジュールへ加点
  に切替可能にした（エラー位置ベースの信号を強める）
- Phase5（max=30）結果:
  - A1(per-error): `phase3Total_valid_delta=-100`, `avg_tsc_calls=4.41`, `worse=0.471`, `better=0.294`
  - A3(per-error, reranker feat2): `phase3Total_valid_delta=-100`, `avg_tsc_calls=3.76`, `worse=0.471`, `better=0.294`
  - **worse率は改善せず**、Phase3改善量もわずかに悪化（-103 → -100）
- 解釈:
  - “ランキングの出し方”を変えても、Top3の候補集合自体が弱い（Top1より良い候補がほぼ無い）ため、悪化率が動きにくい
  - 次の打ち手は Localizerの重み付けよりも、**候補生成（Candidate set）を強化して win_rate_vs_top1>0 を作る**ことが優先

**追加実験：Candidate Generator v1（2モジュール同時 any-stub / sweep-any-k=2）**
- 変更: `--sweep-any-k 2` を追加し、`module-any-sweep` の候補に「2モジュール同時any-stub（ペア）」を混ぜられるようにした
  - `trial-max=5` のとき、Top1 + 単体3 + ペア1（計5候補）を試す
- Phase5（A1 per-error, max=30）:
  - ペア候補は **30repo中14repoで生成**されたが、**選択された回数は0**（`repos_chosen_anypair=0`）
  - `win_rate_vs_top1=0` は変わらず（Top1より良い候補が見つからない）
  - `avg_tsc_calls` は増加（`4.41 → 5.18`）し、探索コストだけが上がった
- 解釈:
  - “any-stubを増やす”方向（単体→ペア）は、このデータ/指標では改善候補を作れていない
  - 次のCandidate Generator改善は、ペア化ではなく **「TS2339/TS2345等のエラー内容に沿った候補型（symbol-levelのwidening等）」**を作る必要がある

**追加実験：Candidate Generator v2（any-topK = Top-Kモジュールを一括 any-stub）**
- 目的: 候補数を増やしすぎず、複数モジュールの相互作用（複合原因）に対応できる“強い候補”を1つだけ追加する
- 実装: `--sweep-any-topk 3`（Top3を一括any化）で `c_anytopk_*` 候補を追加
- フェア比較（両者とも trial-max=3）:
  - baseline（any-topKなし）: `phase3Total_valid_delta=-100`, `avg_tsc_calls=3.76`, `worse=0.471`, `better=0.294`, `win_rate_vs_top1=0`
  - any-topK3あり: **同値**（上記すべて一致）
- 観測:
  - 選択が変わったrepoは2件あったが、全体指標は不変
- 解釈:
  - “強い一括any化候補”を足しても、Top1を上回る改善（Phase3 coreのさらなる減少）に繋がっていない
  - 次は **any化の範囲を広げる方向ではなく、エラー内容に沿って「特定シンボル/特定exportだけをwidenする」候補**を作る必要がある

**追加実験：symbol-level候補（module augmentation で局所的にwiden）**
- 目的: “モジュール丸ごとany化”ではなく、エラーに関係する **特定シンボルだけ**をwidenして悪化率を下げる
- 実装した候補タイプ（スモーク max=10 で確認）:
  - `namespace-members`: `declare module 'm' { export namespace Foo { export const bar: any } }`（`Foo.bar` 型のTS2339対策）
  - `interface-indexer`: `export interface X { [key: string]: any }` を module augmentation で付与
  - `function-any-overload`: `export function f(...args:any[]): any` を overload として追加（TS2345系を狙う）
  - `missing-exports`: consumerがimportしているが `.d.ts` に見当たらない export を any で追加
- 観測（スモーク）:
  - `namespace-members` は一部repoで候補生成できたが、Top1を上回る改善は観測できず（選択されない）
  - `interface-indexer` / `function-any-overload` / `missing-exports` は、対象となる宣言が model output 側に少なく、候補がほぼ生成されなかった
- 解釈:
  - 現状の model output 形式では “安全にmergeできる宣言” が少なく、augmentationベースのsymbol-levelは効きにくい
  - 次のsymbol-levelは、augmentationではなく **モデル出力の declare module ブロックを「部分置換」する編集**（export単位のwiden）へ進める必要がある

**追加実験：symbol-level候補（declare module 内 export の部分置換 / export-to-any）**
- 目的: augmentation依存を避け、モデル出力の `declare module 'm' { ... }` の中だけを直接編集して局所的にwidenする
- 実装: `--symbol-widen-mode export-to-any`（`export const Foo: ...` / `export function Foo(...)` を any に置換）
- スモーク（max=10, trial-max=6, symbol-max=5）:
  - 候補生成は確認できた（`repos_with_exporttoany_candidate=6/10`）
  - ただし現状では Top1に勝てず（`win_rate_vs_top1=0`、選択もTop1に戻る）
  - 探索コストは増える（試行回数が増える）ため、このままmax=30に拡大する前に「勝てる条件」を絞り込む必要がある

---

### 4. 研究質問（改訂版）
- **RQ1**: Localizerは探索空間を縮め、`tsc`回数を減らせるか？
- **RQ2**: RerankerはΔerrorsを教師にして、収束をより速く・安定にできるか？
- **RQ3**: 成功率を維持しつつ、any率（情報落ち）を抑制できるか？

---

### 5. M4 32GB を踏まえた実験設計（無理しない方針）
- 新規性は「大規模モデル学習」ではなく **探索効率化**に置く
- まず軽量MLで効果を出す（CPUで回る）
- `tsc`回数削減＝実験が回る＝研究が進む、という設計
- consumer数は段階拡張（10→20→30）

---

### 6. deepresearch（やるならこの順）
Phase 1/2の結果が出てから着手するのが効率的。

優先順：
1. error localization（コンパイルエラーから原因箇所を絞る研究）
2. compiler feedback learning（コンパイラ結果を学習信号にする系譜）
3. TypeScript module解決・exports不整合の分析研究（実験統制の根拠）

---

### まとめ（ゼミでの締め）
- 現状のハーネスは方針Aの土台として活用できる
- 追加するのは「宣言ID化」「Δerrorsの弱教師ログ」「Localizer→Reranker」の段階導入
- 成果は“成立率”だけでなく **探索回数/悪化率/any率**で示し、研究としての貢献を明確化する


