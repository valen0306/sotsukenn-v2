## 今後の方針 v2（改訂版：Phase5到達を前提）

### 1. 方針の結論

- **第1貢献（確定）**: A3（Localizer + Reranker）はA1より `tsc` 回数を削減できた → **「探索効率化」**は成立
- **次の本命（第2貢献）**: Top1を超える候補がほぼ存在しない（`win_rate_vs_top1=0`）ため、Reranker改良だけでは指標が動かない  
  ⇒ 研究の中心を **Candidate Generator v3（Repair Operator）** に移す

---

### 2. 次フェーズで狙うこと

- Top1注入後に残る `tsc` エラーに対し、**エラー型に直結する“局所型修復”**を生成して  
  **`win_rate_vs_top1 > 0`** を出す（＝改善が起きる世界を作る）
- 悪化率（worse）の低下は、学習器強化より先に **選択ポリシー（セーフガード）**で抑える

---

### 3. まず入れるべき分析（重要）

- **Oracle分析**: 候補集合内で「最良候補（Δphase3最小）」を後から選ぶ上限を算出し、
  - oracleでもTop1を超えない → **候補集合が律速（生成器が本命で確定）**
  - oracleは超える → **rerank/localizeにも改善余地**
  を定量で示す（論文/卒論の説得力が一段上がる）

**実装メモ（このリポジトリ）**
- スクリプト: `evaluation/real/analyze-oracle.mjs`
- 実行例:

```bash
node evaluation/real/analyze-oracle.mjs --out-dir evaluation/real/out/phase5-A1-localizer3-pererror-sweep-max30
```

**現状のoracle結果（max=30, valid=17）**
- 対象: `phase5-A1-localizer3-pererror-sweep-max30`（trial-max=6で候補集合は比較的広い）
- 結果:
  - `oracle_win_rate_vs_top1 = 0.000`
  - `oracle_tie_rate_vs_top1 = 1.000`
  - `avg_top1_phase3 = avg_oracle_phase3 = 25.000`
- 解釈:
  - **oracleでもTop1を超えない**ため、現状の候補集合では「改善が起きる世界」を作れていない  
  → v2の結論どおり、研究の中心を **Repair Operator（Candidate Generator v3）** に置くのが最短

---

### Week1（追加）: エラーコード分布・trial効果の定量

#### baselineエラーコード分布（max=30）
- スクリプト: `evaluation/real/analyze-error-distribution.mjs`
- 対象: `phase5-A1-localizer3-pererror-sweep-max30`
- Phase3 coreの総量（baseline側の合計、参考）:
  - `TS2339=921`, `TS2345=254`, `TS2322=87`, `TS2769=63`, `TS7053=32`, `TS2554=11`, `TS2741=6`, `TS2353=2`
- 解釈:
  - **TS2339が支配的**で、次点がTS2345。Repair Operator v3はまずこの2つを最優先で狙うのが合理的

#### trial効果（Top1に対して改善/同点/悪化が起きたか）
- スクリプト: `evaluation/real/analyze-trial-effects.mjs`
- 観測（max=30 / valid top1=17）:
  - baseline A1(per-error)（any-module試行あり）: `trials_improve_vs_top1=0`, `trials_tie_vs_top1=58`, `trials_worsen_vs_top1=0`
  - export-to-any（max=30）: `trials_improve_vs_top1=0`, `trials_tie_vs_top1=87`, `trials_worsen_vs_top1=0`
  - type-to-any（スモーク max=10）: `trials_improve_vs_top1=0`, `trials_tie_vs_top1=38`, `trials_worsen_vs_top1=0`
- 解釈:
  - 現状の候補型は **「Top1からPhase3 coreが動かない（同点）」**が大半で、改善が起きる候補が生成できていない
  - Repair Operator v3では「同点を量産する候補」ではなく、**TS2339/TS2345を実際に減らせる“内部局所修復”**を設計する必要がある

---

### 4. Candidate Generator v3（Repair Operator）の方向性

`tsc` のエラー型ごとに「刺さる少数候補」を作る（候補数を増やして `tsc` 回数を爆増させない）：

- **TS2345 / TS2322（型不一致）**: 当該引数だけ `unknown` / `union` / `optional` / `nullable` に局所拡張
- **TS2339（プロパティ不存在）**: index signature追加・Record化・交差型で補強
- **複合ケース**: overload追加（引数個数/型別）
- **exports / 解決**: missing exports補完・namespace member生成（ただしエラー起点で狙い撃ち）

---

### 5. 悪化率を下げる（モデルより先にポリシー）

- **セーフガード**: 採用前に少数consumerで事前評価→悪化なら棄却
- **tiesが多い前提の早期停止**: 同点が続くなら探索終了（無駄試行と悪化機会を減らす）

---

### Week3（実測）: セーフガードで `tsc` 回数を削減しつつ安定化

#### 実装（phase3-run.mjs）
- `--early-stop-after-improve`: Top1より良い候補が出たら探索を打ち切り（無駄な `tsc` を減らす）
- `--early-stop-tie-streak 2`: Top1と同点が2回続いたら探索を打ち切り（tieが支配的な状況で効果）

#### 評価（max=30 / valid=17）
- 対象（セーフガード無し）: `phase5-A1-localizer3-pererror-repairfromtop1-max30`
  - `avg_tsc_calls=4.47`, `win_rate_vs_top1=0.176`, `worse=0.412`, `better=0.353`
- 対象（セーフガード有り）: `phase5-A1-localizer3-pererror-repairfromtop1-safeguard-max30`
  - `avg_tsc_calls=3.65`（**改善**）
  - `win_rate_vs_top1=0.176`（維持）
  - `worse=0.412`, `better=0.353`（維持）

#### セーフガードの発火状況（repos_total=30）
- `stopped_tie_streak=9`
- `stopped_improve=3`
- 解釈:
  - tieが多い前提では、**tie-streak早期停止が特に効く**
  - 改善を維持したまま `tsc` 回数を下げられたので、Week3の狙い（安定性維持＋効率化）が成立

---

### Week3（追加分析）: 「どのRepairが効いたか」の原因分析（勝ち筋の特定）

目的：`win_rate_vs_top1 > 0` を“出せた”だけでなく、**何が効いてTop1を超えたか**を具体例とランキングで示し、卒論の説得力を上げる。

#### スクリプト
- `evaluation/real/analyze-repair-causes.mjs`

```bash
node evaluation/real/analyze-repair-causes.mjs --out-dir evaluation/real/out/phase5-A1-localizer3-pererror-repairfromtop1-max30 --top 30
node evaluation/real/analyze-repair-causes.mjs --out-dir evaluation/real/out/phase5-A1-localizer3-pererror-repairfromtop1-safeguard-max30 --top 30
```

#### 結果（max=30 / valid top1=17）
両設定（セーフガード有無）で、**改善（chosenがTop1を超えた）=3件**はいずれも「chosenがRepair-from-top1」だった。

- **効いたRepair key（例）**
  - `TS2339::react::*::add-export-const::prop=Component`
  - `TS2339::react::*::add-export-const::prop=memo` または `prop=createContext`
  - `TS2339::@webpack::getByKeys::widen-callee-to-any::prop=MenuSeparator`

- **頻度（改善3件に対する内訳）**
  - module: `react` が2件 / `@webpack` が1件
  - op: `add-export-const` が2件 / `widen-callee-to-any` が1件

- **改善したrepo例（抜粋）**
  - BetterDiscord: `@webpack.getByKeys(...)` の戻り値に対する TS2339 を **callee winden**で解消 → `phase3: 106 → 93`
  - oblivion-desktop: `React.Component` の TS2339 を **export補完**で解消 → `phase3: 3 → 2`
  - baseweb: `React.memo` / `React.createContext` の TS2339 を **export補完**で解消 → `phase3: 83 → 79`（safeguard有）または `83 → 76`（safeguard無）

#### 解釈（卒論で主張できること）
- 「とにかくany化」ではなく、**tsserver由来のシンボル解決（エラー位置→依存モジュールの特定）**を経由した  
  **“狙い撃ちの局所修復”**がTop1超えを作っている。
- 改善が出た3件の勝ち筋は（少数ながら）**2パターンに収束**しており、Repair Operator設計の方向性が具体化できた：
  - **missing exportの補完（reactの代表API）**
  - **call-return由来のTS2339をcallee側widenで吸収**

---

### 6. 次の3週間ロードマップ（短期で成果を出す順）

- **Week 1**: oracle分析 / エラーコード分布 / Δを動かした宣言抽出（設計の根拠固め）
- **Week 2**: Repair Operator v3実装（TS2345・TS2339・overloadを優先）

**Week2 実装メモ（途中経過）**
- `--repair-from-top1`（Top1注入後の診断からTS2339/TS2345/TS2322を拾ってrepair候補を生成）を試作
- スモークの観測では、TS2339の多くが **import/require に直接ひもづかないローカル値（例: グローバル/代入経由）**に対して発生し、
  - `ts2339Seen` は多いが `ts2339ImportMapped` が 0 になりやすい
  - その結果、`declare module 'dep' { ... }` を編集するタイプのrepair候補が生成できないケースがある
- 含意:
  - TS2339に対して「当該オブジェクトがどの依存モジュール/シンボル由来か」を突き止めるには、regexのimport解析では足りず  
    **TypeScript Language Service（tsserver相当）でのシンボル解決**が必要になる可能性が高い（ここが研究としても面白いポイント）

**Week2 実装メモ（更新：Repair Operatorが指標を動かした）**
- `--repair-from-top1` を TypeScript API（repo内の `typescript`）で強化し、TS2339の `obj.prop` を
  - 「objが import された値」だけでなく
  - **「objが import 関数の戻り値（例: `const x = getByKeys(...)`）」**の場合も辿って、元のimportシンボル（`getByKeys`）を特定してwiden
  できるようにした（= “エラー位置→依存モジュールのどのシンボルを直すか” が解決できるようになった）

**Phase5（max=30 / Repair Operator v3）**
- out-dir: `evaluation/real/out/phase5-A1-localizer3-pererror-repairfromtop1-max30`
- valid 17件の集計（`analyze-phase3-trials.mjs`）:
  - `win_rate_vs_top1 = 0.176`（**0から動いた**）
  - `chosen_worse_than_baseline_rate = 0.412`（旧0.471から改善）
  - `chosen_better_than_baseline_rate = 0.353`（旧0.294から改善）
  - `avg_tsc_calls = 4.47`（旧4.41より僅増）
- Oracle（`analyze-oracle.mjs`）:
  - `oracle_win_rate_vs_top1 = 0.176`
  - `avg_top1_phase3 = 25.000` → `avg_oracle_phase3 = 23.765`
- 解釈:
  - **Repair Operator v3 が「Top1より良い候補を作る」ことに成功**し、v2の第2貢献に直結
  - 次は「候補数/tsc回数を増やさずに同等以上の改善」を狙い、セーフガード（Week3）と組み合わせて安定化を進める
- **Week 3**: セーフガード導入＋統合評価（A3 + Gen v3）  
  → 目標：`win_rate_vs_top1` を動かす ＆ `worse` を下げる/同等 ＆ `avg_tsc_calls` 維持

---

### Week4（着手）: TS2345 / TS2322 を動かすRepair（call-site→callee解決）

狙い：これまでの勝ち筋はTS2339中心だったため、次は頻度2位の **TS2345（型不一致）** と **TS2322（代入不一致）** を動かせるrepairを増やす。

#### 実装（phase3-run.mjs）
- `repair-from-top1` において、Top1注入後の診断（TS2345/TS2322）から
  - エラー位置近傍の **CallExpression** をtsserver（Program）で取得
  - calleeを **import由来のモジュール/シンボル**に解決
  - `widen-callee-to-any`（安全寄り）または `add-any-overload`（関数exportがある場合のみ）を候補として追加

#### Smoke（max=10 / v2 run）
- out-dir: `evaluation/real/out/smoke-A1-pererror-repairfromtop1-ts2345call-max10-v2`
- 観測（valid compare=5）:
  - TS2322由来のrepair候補が生成され、`react.memo` / `react.forwardRef` に対して `widen-callee-to-any` が追加された
  - chosenがrepairになるケースも確認（ただしこの小標本では Top1超えは未観測）

次：max30で `win_rate_vs_top1` への寄与が出るか（または tie止まりか）を確認し、効いたrepair keyのランキングを更新する。

#### Max30（比較実験）
- out-dir（新）: `evaluation/real/out/phase5-A1-localizer3-pererror-sweep-repairfromtop1-ts2345call-safeguard-max30`
- out-dir（旧）: `evaluation/real/out/phase5-A1-localizer3-pererror-repairfromtop1-safeguard-max30`
- 集計（`analyze-phase3-trials.mjs` / max=30 / valid=17）:
  - 新: `avg_tsc_calls=2.53`, `win_rate_vs_top1=0.176`, `worse=0.412`, `better=0.353`
  - 旧: `avg_tsc_calls=3.65`, `win_rate_vs_top1=0.176`, `worse=0.412`, `better=0.353`
- Oracle（`analyze-oracle.mjs`）:
  - 新: `oracle_win_rate_vs_top1=0.176`, `avg_top1_phase3=25.000` → `avg_oracle_phase3=23.941`
- 原因分析（`analyze-repair-causes.mjs`）:
  - Top1超え3件は引き続きTS2339由来のrepair（`react` missing export補完 / `@webpack` callee widen）が中心

**解釈（暫定）**
- TS2345/TS2322のcall-site repairは smoke では候補生成・採用を確認できたが、現状のmax30では **Top1超えの勝ち筋を増やすには未到達**。
- 一方で、同等の品質指標を維持したまま `avg_tsc_calls` を下げられているため、**探索効率（tsc削減）の観点ではプラス**。

#### Week4（追加）: arity-specific overload + call-chain対応（結果：指標は不変）
目的：TS2345/TS2769/TS2554（呼び出し不一致）に対して、単なるcallee any化より強い候補を作る。

- 実装（phase3-run.mjs）:
  - call callee解決で `React.Children.toArray(...)` のような **property chain** を扱えるようにした
  - `export function foo(a0:any, a1:any, ...): any;` の **arity-specific overload** を追加できるようにした（spreadがある場合はvariadicへフォールバック）
  - call repairの対象を `moduleToStub` に限定せず、`external-filter=deps/heuristic` の外部判定で通すように緩和（repairMaxで上限）

- Smoke（max=10）:
  - call-repair trials（TS2345/TS2322/TS2769/TS2554）=3（小）

- Max30（比較）:
  - out-dir: `evaluation/real/out/phase5-A1-localizer3-pererror-sweep-repairfromtop1-call-overload-arity-safeguard-max30`
  - `avg_tsc_calls=2.59`, `win_rate_vs_top1=0.176`, `worse=0.412`, `better=0.353`
  - 原因分析でTop1超えは引き続きTS2339中心（勝ち筋は増えず）

含意：
- 既存データ（Top3 localizer）では、TS2345/2322/2769/2554を「外部モジュール修復」で動かせる局面がまだ少ない可能性が高い。  
  次の打ち手は「どのエラーが外部起因か」をより厳密に絞ってからrepair設計するか、またはTS2339系の勝ち筋をさらに拡張する。

---

### 7. M4 32GB 前提の方針

- 重いのは学習ではなく `tsc` 回数  
  ⇒ 「候補を大量生成」ではなく **「当たる少数候補を生成」**に寄せる
- Rerankerは当面 軽量MLで十分。候補集合が強くなった後にモデル強化を検討


