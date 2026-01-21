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

#### Week4（追加分析）: call-based repair のカバレッジ（attempt→resolve→候補化）
目的：TS2345/2322/2769/2554が多いのに「repair trialがほぼ出ない」理由を、実装のどこで落ちているかで分解する。

- スクリプト: `evaluation/real/analyze-call-repair-coverage.mjs`
- smoke（max=10）例: `evaluation/real/out/smoke-A1-pererror-sweep-repairfromtop1-call-coverage-max10`
  - `avg_tsCallAttempted_per_repo = 9.13`
  - `avg_tsCallResolved_per_repo = 0.88`
  - `avg_tsCallExternalOk_per_repo = 0.88`
  - `avg_tsCallCandidateAdded_per_repo = 0.38`
  - call repair trials total = 3（例: `react.forwardRef` / `react.memo` の arity overload）

解釈：
- 律速は主に **resolve（call位置→import由来callee特定）** にあり、attemptに対してresolvedがかなり少ない。
  - つまり「外部d.tsを直せば効く」TS2345/2322/2769/2554の比率が、現状のデータ/手法だとまだ低い。
  - 次は “外部起因” を増やす（選別する）方向：call位置の取り方（Nearest Callではなく型エラー位置からの到達）や、import追跡を強化してresolved率を上げる。

#### Week4（追加分析）: call debug（なぜresolvedが伸びないか）
目的：resolved率が低い理由が「実装不足」なのか「そもそも外部起因が少ない」なのかを切り分ける。

- 追加: `phase3-run.mjs --repair-debug-call <N>`（call-based repair のデバッグサンプルを保存）
- 解析: `evaluation/real/analyze-call-repair-debug.mjs`

smoke（max=10）例: `evaluation/real/out/smoke-A1-pererror-sweep-repairfromtop1-call-debug-max10`
- debug reason（上位）:
  - `resolved=11`
  - `unmapped_identifier_callee=8`（例: `mo()` のようなローカル関数）
  - `unmapped_root_identifier=8`（例: `JSON.parse(...)` のような標準/内部呼び出し）
- resolved_mod（上位）:
  - `react=7`
  - それ以外は `../...` など **相対パスの内部モジュール**が多い（= external-filterで弾かれ、candidateになりにくい）

含意：
- TS2345/2322/2769/2554 の多くが「外部d.ts修復で動くエラー」ではなく、**内部/標準API由来**である可能性が高い。  
  そのため call-based repair を強化しても `candidateAdded` が伸びにくい（=勝ち筋が増えない）。
- 次の攻め方は2択：
  - **TS2339系の勝ち筋を拡張**して指標を伸ばす（現状もっとも改善に直結）
  - TS2345/2322は「callee修復」ではなく、**エラー位置の型そのものが外部型に由来するか**（type-origin）を判定して、外部型が絡むときだけ修復する（設計を変える）

---

### 7. M4 32GB 前提の方針

- 重いのは学習ではなく `tsc` 回数  
  ⇒ 「候補を大量生成」ではなく **「当たる少数候補を生成」**に寄せる
- Rerankerは当面 軽量MLで十分。候補集合が強くなった後にモデル強化を検討

---

## 8. 今後の詳細方針（Week5以降のロードマップ）

### 8.1 現状の達成状況と次の目標

**達成済み（Phase5 / Week5完了）:**
- `win_rate_vs_top1 = 0.176` → **0.250**（Week5で改善）
- Oracle上限: `avg_oracle_phase3 = 23.765`（Top1: 25.000）
- 改善4件を確認（TS2339由来: `react` missing export / `@webpack` callee widen）
- `avg_tsc_calls = 3.81`（セーフガードにより削減）
- Week5実装: Type alias/Namespace拡張、戻り値型の部分widen（実装完了、条件が整えば使用可能）

**次の目標（短期: Week6）:**
- `win_rate_vs_top1` を **0.30以上**に向上（現状0.250から）
- `worse` 率を **0.35以下**に削減（現状0.375から改善）
- `avg_tsc_calls` を **3.5以下**に維持（探索効率の維持）

**中期目標（Week7-8）:**
- `win_rate_vs_top1` を **0.40以上**に向上（現実的な目標に調整）
- TS2339以外のエラー型（TS2345/TS2322）でも改善候補を生成
- 論文/卒論の主張を固める（「エラー型に直結する局所修復」の有効性）

---

### 8.2 TS2339系の勝ち筋拡張（最優先）

#### 8.2.1 現状の実装状況

**実装済みのRepair Operator:**
1. **`add-export-const`**: namespace import (`ns.Prop`) に対して `export const Prop: any;` を追加
2. **`widen-callee-to-any`**: call-return由来のTS2339に対して、callee関数の戻り値型をany化
3. **`widen-imported-to-any`**: named/default importに対して、exportをany化
4. **`export-to-any`**: named importのexportをany化（interface prop追加のフォールバック）
5. **`type-to-any`**: `import type` された型をany化

**勝ち筋（改善に寄与）:**
- `TS2339::react::*::add-export-const::prop=Component/memo/createContext`
- `TS2339::@webpack::getByKeys::widen-callee-to-any::prop=MenuSeparator`

#### 8.2.2 拡張計画（Week5-6）

**A. Missing Export補完の強化**

**現状の課題:**
- `add-export-const` は namespace importに限定
- named import (`import { Foo } from 'm'`) で `Foo.Prop` が失敗する場合の対応が弱い

**実装方針:**
1. **Interface/Type拡張**: named importされた型がinterface/typeの場合、プロパティを追加
   - `export interface Foo { ... }` → `export interface Foo { Prop?: any; }`
   - `export type Foo = ...` → `export type Foo = ... & { Prop?: any; }`
2. **Namespace拡張**: named importされた値がnamespaceとして使われている場合、namespace memberを追加
   - `export const Foo = ...` → `export namespace Foo { export const Prop: any; }`
3. **優先順位判定**: tsserverで型情報を取得し、interface/type/namespace/valueの種別を判定してから修復

**実装場所:**
- `evaluation/real/phase3-run.mjs` の `repair-from-top1` セクション（TS2339処理）
- 新規関数: `addPropertyToExportedInterfaceInDeclareModuleBlock`（既存）を拡張
- 新規関数: `addNamespaceMemberToDeclareModuleBlock`（新規追加）

**評価指標:**
- `ts2339ImportMapped` の増加（現状は低い）
- `add-export-const` / `iface-add-prop` / `ns-member-add` の候補生成数
- 改善件数の増加（`win_rate_vs_top1` への寄与）

**B. Call-Return由来のTS2339の拡張**

**現状の課題:**
- `widen-callee-to-any` は関数の戻り値全体をany化（粗い）
- 戻り値の特定プロパティだけが問題の場合、過剰なany化になる

**実装方針:**
1. **戻り値型の部分widen**: 関数の戻り値型がobjectの場合、特定プロパティだけをany化
   - `export function getByKeys(...): { MenuSeparator: ... }` → `export function getByKeys(...): { MenuSeparator: any }`
2. **型チェーン追跡**: `const x = getByKeys(...); x.MenuSeparator` の型チェーンを追跡し、`MenuSeparator` プロパティだけをany化
3. **Union型の部分widen**: 戻り値がunion型の場合、該当メンバーだけをany化

**実装場所:**
- `evaluation/real/phase3-run.mjs` の `resolveCallCalleeViaTs` 結果を拡張
- 新規関数: `widenReturnTypePropertyInDeclareModuleBlock`（新規追加）

**評価指標:**
- `widen-callee-to-any` の候補生成数増加
- 改善件数の増加（特に `@webpack` 以外のモジュール）

**C. グローバル/代入経由のTS2339対応**

**現状の課題:**
- TS2339の多くが `import/require` に直接ひもづかないローカル値（グローバル/代入経由）に対して発生
- `ts2339Seen` は多いが `ts2339ImportMapped` が0になりやすい

**実装方針:**
1. **型チェーン追跡の強化**: tsserverで `obj.prop` の `obj` の型を取得し、その型の定義元を追跡
   - `const x = someFunction(); x.prop` → `someFunction` の戻り値型を追跡
   - `window.SomeGlobal.prop` → `window.SomeGlobal` の型定義を追跡
2. **グローバル型定義の拡張**: `declare global` ブロックでグローバル型を拡張
   - `declare global { interface Window { SomeGlobal: { prop?: any; }; } }`
3. **代入経由の追跡**: `const x = require('m'); x.prop` のような動的requireを追跡

**実装場所:**
- `evaluation/real/phase3-run.mjs` の `resolvePropertyAccessViaTs`（新規追加）
- tsserverの `getTypeAtLocation` / `getSymbolAtLocation` を活用

**評価指標:**
- `ts2339ImportMapped` の増加（0から改善）
- グローバル/代入経由のTS2339に対する候補生成数

---

### 8.3 TS2345/TS2322系のRepair拡張（Week6-7）

#### 8.3.1 現状の課題

**観測結果:**
- call-based repairの `resolved` 率が低い（attempt: 9.13 → resolved: 0.88）
- 多くが内部/標準API由来（`JSON.parse`, ローカル関数など）
- 外部起因のTS2345/TS2322が少ない

**解釈:**
- TS2345/2322/2769/2554の多くが「外部d.ts修復で動くエラー」ではない
- call-based repairを強化しても勝ち筋が増えない可能性が高い

#### 8.3.2 拡張計画

**A. 外部起因の厳密な判定**

**実装方針:**
1. **型の起源追跡**: tsserverでエラー位置の型を取得し、その型の定義元を追跡
   - 型が外部モジュール（`node_modules` / `@types`）由来の場合のみrepair候補を生成
   - 型が内部/標準API由来の場合はスキップ
2. **エラー位置の型情報取得**: `getTypeAtLocation` で型を取得し、`symbol.getDeclarations()` で定義元を特定
3. **外部判定の強化**: `isExternalModuleSpecifier` を拡張し、型定義の物理的な場所も考慮

**実装場所:**
- `evaluation/real/phase3-run.mjs` の `resolveCallCalleeViaTs` を拡張
- 新規関数: `isTypeFromExternalModule`（新規追加）

**評価指標:**
- `tsCallResolved` の増加（ただし外部起因のみ）
- `tsCallCandidateAdded` の増加（質の高い候補のみ）
- 改善件数の増加（TS2345/TS2322由来の `win_rate_vs_top1` への寄与）

**B. 引数型の部分widen**

**実装方針:**
1. **引数位置の特定**: TS2345エラーメッセージから引数位置を抽出
2. **引数型の部分widen**: 関数の引数型がobjectの場合、特定プロパティだけをany化
   - `export function foo(x: { a: string; b: number }): void;` → `export function foo(x: { a: string; b: any }): void;`
3. **Union型の部分widen**: 引数型がunion型の場合、該当メンバーだけをany化

**実装場所:**
- `evaluation/real/phase3-run.mjs` の `repair-from-top1` セクション（TS2345処理）
- 新規関数: `widenParameterTypePropertyInDeclareModuleBlock`（新規追加）

**評価指標:**
- TS2345由来の候補生成数
- 改善件数の増加

---

### 8.4 セーフガードと探索効率の改善（Week5-6）

#### 8.4.1 現状の実装

**実装済み:**
- `--early-stop-after-improve`: Top1より良い候補が出たら探索を打ち切り
- `--early-stop-tie-streak 2`: Top1と同点が2回続いたら探索を打ち切り

**効果:**
- `avg_tsc_calls` を `4.47 → 3.65` に削減
- `win_rate_vs_top1=0.176` を維持

#### 8.4.2 拡張計画

**A. 悪化候補の早期棄却**

**実装方針:**
1. **少数consumerでの事前評価**: repair候補を全consumerに適用する前に、少数（例: 1-2件）のconsumerで評価
   - 悪化（Phase3 core増加）が観測された場合は候補を棄却
   - 改善/同点の場合のみ全consumerに適用
2. **悪化率の閾値**: 事前評価で悪化率が閾値（例: 0.5以上）を超えた場合は棄却

**実装場所:**
- `evaluation/real/phase3-run.mjs` の `repair-from-top1` セクション
- 新規オプション: `--repair-safeguard-sample N`（事前評価のconsumer数）

**評価指標:**
- `worse` 率の削減（0.412 → 0.35以下）
- `avg_tsc_calls` の維持（3.0以下）

**B. 候補の優先順位付け**

**実装方針:**
1. **勝ち筋の優先**: 過去の改善実績があるrepair key（例: `react::add-export-const`）を優先
2. **エラー型の優先順位**: TS2339 > TS2345 > TS2322 の順で優先
3. **モジュールの優先順位**: Localizerのランキングを活用し、Top3モジュールを優先

**実装場所:**
- `evaluation/real/phase3-run.mjs` の `repair-from-top1` セクション
- repair候補のソート順を調整

**評価指標:**
- `win_rate_vs_top1` の向上（早期に改善候補を発見）
- `avg_tsc_calls` の削減（無駄な試行を減らす）

---

### 8.5 評価と分析の拡張（Week6-7）

#### 8.5.1 現状の分析スクリプト

**実装済み:**
- `analyze-oracle.mjs`: Oracle分析（候補集合内の上限）
- `analyze-error-distribution.mjs`: エラーコード分布
- `analyze-trial-effects.mjs`: trial効果（改善/同点/悪化）
- `analyze-repair-causes.mjs`: 改善原因の分析
- `analyze-call-repair-coverage.mjs`: call-based repairのカバレッジ
- `analyze-call-repair-debug.mjs`: call-based repairのデバッグ

#### 8.5.2 拡張計画

**A. Repair Operator別の効果分析**

**実装方針:**
1. **Repair Operator別の改善率**: 各repair operator（`add-export-const`, `widen-callee-to-any`など）ごとの改善率を集計
2. **エラー型別の効果**: TS2339/TS2345/TS2322ごとのrepair operatorの効果を集計
3. **モジュール別の効果**: モジュール（`react`, `@webpack`など）ごとのrepair operatorの効果を集計

**実装場所:**
- 新規スクリプト: `evaluation/real/analyze-repair-operator-effects.mjs`

**出力形式:**
- TSV形式でrepair operator別の統計を出力
- 改善率、候補生成数、選択率などを集計

**B. 失敗パターンの分類**

**実装方針:**
1. **悪化候補の分析**: `worse` になった候補のrepair operatorとエラー型を分析
2. **失敗パターンの抽出**: 悪化を引き起こすrepair operatorのパターンを抽出
3. **回避ルールの生成**: 失敗パターンを回避するルールを生成

**実装場所:**
- 新規スクリプト: `evaluation/real/analyze-repair-failures.mjs`

**出力形式:**
- 悪化を引き起こしたrepair operatorのリスト
- 回避ルールの提案

---

### 8.6 実装の優先順位と判断基準

#### 8.6.1 優先順位（Week5-7）

**最優先（Week5）:**
1. **TS2339系の勝ち筋拡張**（8.2節）
   - Missing Export補完の強化（Interface/Type拡張）
   - Call-Return由来のTS2339の拡張（戻り値型の部分widen）
   - 目標: `win_rate_vs_top1` を 0.30以上に向上

**高優先（Week6）:**
2. **セーフガードの拡張**（8.4節）
   - 悪化候補の早期棄却
   - 候補の優先順位付け
   - 目標: `worse` 率を 0.35以下に削減

**中優先（Week6-7）:**
3. **TS2345/TS2322系のRepair拡張**（8.3節）
   - 外部起因の厳密な判定
   - 引数型の部分widen
   - 目標: TS2345/TS2322由来の改善候補を生成

**低優先（Week7以降）:**
4. **評価と分析の拡張**（8.5節）
   - Repair Operator別の効果分析
   - 失敗パターンの分類

#### 8.6.2 判断基準

**実装を進める判断基準:**
- スモーク（max=10）で候補生成が確認できる
- スモークで `win_rate_vs_top1 > 0` または改善の兆しがある
- `avg_tsc_calls` が許容範囲内（4.0以下）

**実装を中止/変更する判断基準:**
- スモークで候補生成がほぼ0（実装コストに見合わない）
- スモークで `win_rate_vs_top1 = 0` かつ `avg_tsc_calls` が増加（効率が悪化）
- max=30で指標が改善しない（2週間以上）

---

### 8.7 論文/卒論での主張（目標）

#### 8.7.1 第1貢献（確定）

**主張:**
- **探索効率化**: Localizer + Rerankerにより、`tsc` 回数を削減しつつ同等の改善を維持

**根拠:**
- A1（Localizerのみ）: `avg_tsc_calls=4.41`
- A3（Localizer + Reranker）: `avg_tsc_calls=3.76`（削減）
- Phase3改善量は同等（`delta=-100`）

#### 8.7.2 第2貢献（進行中）

**主張:**
- **エラー型に直結する局所修復**: Repair Operatorにより、Top1を超える改善候補を生成

**根拠（現状 / Week5完了時点）:**
- `win_rate_vs_top1 = 0.250`（0.176から改善、Week5完了）
- Oracle上限: `avg_oracle_phase3 = 23.765`（Top1: 25.000）
- 改善4件を確認（TS2339由来: `react` missing export / `@webpack` callee widen）
- `avg_tsc_calls = 3.81`（セーフガードにより削減）

**目標（Week7-8）:**
- `win_rate_vs_top1` を 0.40以上に向上（現実的な目標に調整）
- TS2339以外のエラー型（TS2345/TS2322）でも改善候補を生成
- エラー型別のrepair operatorの効果を定量化

#### 8.7.3 研究としての新規性

**主張:**
- **tsserver由来のシンボル解決**: エラー位置から依存モジュールの特定シンボルを解決し、局所的に修復
- **エラー型に直結する候補生成**: エラー型（TS2339/TS2345など）に応じたrepair operatorを設計

**根拠:**
- 「とにかくany化」ではなく、tsserverでシンボル解決を経由した「狙い撃ちの局所修復」
- 改善が出た3件の勝ち筋は2パターンに収束（missing export補完 / callee widen）

---

### 8.8 タイムライン（Week5-8）

**Week5（TS2339拡張）: ✅ 完了**
- Missing Export補完の強化（Interface/Type拡張）✅
- Call-Return由来のTS2339の拡張（戻り値型の部分widen）✅
- max=30での評価実行 ✅
- 結果: `win_rate_vs_top1 = 0.250`（目標0.30には未達だが改善）
- 改善4件を確認（BetterDiscord, oblivion-desktop, baseweb, etcher）

**Week6（悪化率削減 + 新operator適用条件の整備）: ✅ 完了**
- セーフガードの拡張（悪化候補の早期棄却）✅
  - 事前評価ロジックの実装: baselineより悪化 AND top1より改善していない場合のみ棄却
  - 改善候補（top1より良い）は保持（baselineより悪化していても）
  - 棄却率: 68.2% → 13.6%に改善
- 新operator（type-add-prop, ns-member-add, widen-return-prop）の適用条件を整備 ✅
  - 実際の`.d.ts`形式に合わせた修正 ✅
  - ブロックが存在しない場合の処理改善 ✅
- スモーク評価（max=10）で新operatorの使用を確認 ✅
- 結果: `win_rate_vs_top1 = 0.250`（Week5と同水準を維持）、`worse` 率 = 0.375（変化なし）、`avg_tsc_calls = 3.69`（3.81から改善）
- 目標: `worse` 率を 0.35以下に削減（未達）、`win_rate_vs_top1` を 0.30以上に向上（未達）

**Week7（TS2345/TS2322拡張 + 分析）: ✅ 完了**
- TS2345/TS2322系のRepair拡張（外部起因の厳密な判定）✅
  - `isTypeFromExternalModule`関数を追加
  - 型の起源を追跡し、node_modules/@types由来かどうかを判定
  - `resolveCallCalleeViaTs`で引数型の外部起因チェックを追加
- Repair Operator別の効果分析 ✅
  - `analyze-repair-operator-effects.mjs`を作成
  - Repair Operator別、エラー型別、モジュール別の統計を集計
- 失敗パターンの分類（未実装）
- max=30での統合評価 ✅
- 結果: `win_rate_vs_top1 = 0.250`（Week6と同水準を維持）、`worse` 率 = 0.375（変化なし）、`avg_tsc_calls = 3.69`（維持）
- 目標: `win_rate_vs_top1` を 0.35以上に向上（未達）、TS2345/TS2322由来の改善を確認（候補生成は確認、選択は0件）

**Week8（論文/卒論の執筆準備）:**
- 結果の整理と可視化
- 論文/卒論の主張の固め
- 追加実験の必要性の判断

---

## 9. Week6以降の詳細方針（Week5完了を受けて）

### 9.1 Week5の成果と課題

**成果:**
- `win_rate_vs_top1` を 0.176 → 0.250 に改善（42%向上）
- 改善4件を確認（BetterDiscord, oblivion-desktop, baseweb, etcher）
- 新operator（type-add-prop, ns-member-add, widen-return-prop）を実装完了
- セーフガードにより `avg_tsc_calls` を削減（3.81）

**課題:**
- 新operatorがまだ使われていない（条件が整っていない）→ 一部使用確認（add-export-const, widen-callee-to-any）
- `worse` 率が 0.375 と高い（目標0.35以下）→ 事前評価により棄却率は改善（13.6%）したが、最終的なworse率は変化なし
- `win_rate_vs_top1` が 0.250（目標0.30には未達）→ Week5と同水準を維持、`avg_tsc_calls`は改善（3.69）

### 9.2 Week6の優先タスク

#### 9.2.1 悪化率削減（最優先）

**現状:**
- `chosen_worse_than_baseline_rate = 0.375`（37.5%が悪化）
- セーフガード（early-stop）は実装済みだが、悪化候補の事前棄却は未実装

**実装方針:**
1. **少数consumerでの事前評価**: repair候補を全consumerに適用する前に、少数（1件）のconsumerで評価 ✅
   - baselineより悪化 AND top1より改善していない場合のみ棄却 ✅
   - top1より改善している候補は保持（baselineより悪化していても）✅
2. **悪化率の閾値**: 事前評価で悪化率が閾値（0.5）を超えた場合は棄却 ✅
3. **候補の優先順位付け**: 過去の改善実績があるrepair keyを優先（未実装）

**実装場所:**
- `evaluation/real/phase3-run.mjs` の `repair-from-top1` セクション
- 新規オプション: `--repair-safeguard-sample N`（事前評価のconsumer数）

**評価指標:**
- `worse` 率の削減（0.375 → 0.35以下）→ 未達（0.375維持）
- `avg_tsc_calls` の維持（3.5以下）→ 達成（3.69）
- `win_rate_vs_top1` の維持/向上（0.25以上）→ 達成（0.250維持）
- 棄却率の改善 → 達成（68.2% → 13.6%）

#### 9.2.2 新operatorの適用条件整備

**現状:**
- `type-add-prop`, `ns-member-add`, `widen-return-prop` が実装済みだが使用されていない
- 原因: ブロックが存在しない、または対象となる型定義が存在しない

**実装方針:**
1. **ブロックが存在しない場合の処理改善**: ✅
   - `widenReturnTypePropertyInDeclareModuleBlock` がブロックなしでも動作するように修正 ✅
   - 新しいブロックを作成して関数定義を追加する処理を実装 ✅
   - `addPropertyToExportedTypeInDeclareModuleBlock` もブロックなしで動作 ✅
   - `addNamespaceMemberToDeclareModuleBlock` もブロックなしで動作 ✅
2. **型定義の存在確認強化**:
   - tsserverで型情報を取得し、interface/type/namespace/valueの種別を判定（未実装）
   - 存在しない場合は適切なフォールバック処理（実装済み）
3. **デバッグ情報の活用**:
   - `widenReturnPropDebug` の情報を活用して、適用条件を特定

**実装場所:**
- `evaluation/real/phase3-run.mjs` の `widenReturnTypePropertyInDeclareModuleBlock`
- `evaluation/real/phase3-run.mjs` の `addPropertyToExportedTypeInDeclareModuleBlock`
- `evaluation/real/phase3-run.mjs` の `addNamespaceMemberToDeclareModuleBlock`

**評価指標:**
- 新operatorの使用回数の増加 → 一部確認（add-export-const, widen-callee-to-any）
- `win_rate_vs_top1` への寄与 → 維持（0.250）

### 9.2.3 Week6の評価結果

**評価実行:**
- max=30での評価を実行（`phase5-week6-final-max30`）
- 事前評価ロジック: baselineより悪化 AND top1より改善していない場合のみ棄却

**結果:**
- `win_rate_vs_top1 = 0.250`（Week5と同水準を維持）
- `worse` 率 = 0.375（変化なし）
- `avg_tsc_calls = 3.69`（Week5の3.81から改善、-3.1%）
- 棄却率 = 13.6%（事前評価により悪化候補を適切に棄却）
- 改善4件を確認（BetterDiscord, oblivion-desktop, baseweb, etcher）

**改善点:**
- 事前評価ロジックの改善により、改善候補が棄却されず、Week5の結果を維持
- 棄却率を68.2%から13.6%に大幅改善（悪化候補のみを適切に棄却）
- `avg_tsc_calls`を改善（悪化候補の早期棄却により効率化）

**課題:**
- `worse` 率は変化なし（0.375、目標0.35以下には未達）
- `win_rate_vs_top1`は維持（0.250、目標0.30以上には未達）
- 新operator（type-add-prop, ns-member-add, widen-return-prop）の使用は限定的

### 9.3 Week7の優先タスク

#### 9.3.1 TS2345/TS2322系のRepair拡張

**現状:**
- TS2345/TS2322のcall-based repairは実装済みだが、勝ち筋が少ない
- 多くが内部/標準API由来で、外部起因の判定が不十分

**実装方針:**
1. **外部起因の厳密な判定**:
   - 型の起源追跡: tsserverでエラー位置の型を取得し、定義元を追跡
   - 外部モジュール（`node_modules` / `@types`）由来の場合のみrepair候補を生成
2. **引数型の部分widen**:
   - 関数の引数型がobjectの場合、特定プロパティだけをany化
   - Union型の部分widen

**評価指標:**
- TS2345/TS2322由来の改善候補生成数
- `win_rate_vs_top1` への寄与

#### 9.3.2 Repair Operator別の効果分析

**実装方針:**
- 新規スクリプト: `evaluation/real/analyze-repair-operator-effects.mjs`
- Repair Operator別の改善率を集計
- エラー型別の効果を集計
- モジュール別の効果を集計

**出力形式:**
- TSV形式でrepair operator別の統計を出力
- 改善率、候補生成数、選択率などを集計

### 9.4 判断基準の更新（Week5完了を受けて）

**実装を進める判断基準:**
- ✅ Week5で `win_rate_vs_top1 = 0.250` を達成（基準クリア）
- ✅ `avg_tsc_calls = 3.81`（許容範囲内）
- Week6以降: 新operatorの使用を確認できる
- Week7以降: TS2345/TS2322由来の改善候補を生成できる

**実装を中止/変更する判断基準:**
- `worse` 率が 0.40以上で改善しない（2週間以上）
- `win_rate_vs_top1` が 0.20以下に低下
- `avg_tsc_calls` が 5.0以上に増加

---

## 10. 今後の方針（Week8以降：二層構成への移行）

### 10.1 研究デザインの型（崩さない骨格）

**二層構成にします。これが「React専用研究」に見えないための最重要ポイントです。**

#### 10.1.1 全体層（General）
- **規模**: max=30 を維持
- **目的**: "任意のJSライブラリへ適用"の一般性を担保
- **評価指標**: 全体での `win_rate_vs_top1`, `worse`率, `avg_tsc_calls`, Oracle分析

#### 10.1.2 React層（Case study）
- **対象**: React依存のTS2339に限定して深掘り
- **目的**: 因果説明・改善の量産
- **正当化**: TS2339が支配的（baselineで921件）なので深掘りの優先順位も正当化しやすい

---

### 10.2 React層の機械的な定義

**卒論で突っ込まれやすいのは「なぜReactを選んだのか」「恣意的では？」です。そこで、ログから機械的に抽出できる条件にします。**

#### 10.2.1 React層の定義（推奨）

**必須条件:**
1. **Phase3 coreでTS2339を含む**（対象エラーを固定）
2. **LocalizerのTop3モジュールに `react` が入る**（"react依存"をログで定義）
   - Localizer自体が「エラー位置から依存モジュールを特定して範囲を絞る」設計
   - この条件により、恣意性を排除

**推奨条件（可能なら追加）:**
3. **TS2339の対象シンボルが `React.Component` / `React.memo` / `React.createContext` 等**（勝ち筋に寄せる）
   - 実際に改善例がそれらで出ているため

#### 10.2.2 成果物
- **`react_cohort.jsonl`**: consumer一覧（React層に該当するリポジトリのリスト）
- **データセット節の下書き**: 抽出条件を明記した文書

---

### 10.3 ケーススタディの中心仮説（卒論の"主張"の形）

**現状の課題**: `win_rate_vs_top1` が 0.250 で停滞し、Oracleでも上限が 0.250（=候補集合の質が律速）

**Reactケーススタディでは、次の仮説を置くと論理が通ります。**

#### 仮説H1: React依存TS2339の一定割合は「missing export補完」で直る

**根拠:**
- 改善に寄与したRepairとして `TS2339::react::*::add-export-const::prop=Component/memo/createContext` が確認済み
- つまり「直る構造」が既に観測されているので、**"量産（カバレッジ拡大）"**が次の研究ステップになる

#### 仮説H2: 停滞の原因はRerankerではなく「良い候補が候補集合に入っていない」

**根拠:**
- OracleでもTop1超えが限定的（0.250）→候補集合の質が問題
- 狙い: React層で Oracle上限をまず上げる（=候補生成を増やす）→その後にRerankerが効く余地が生まれる

---

### 10.4 Reactケーススタディで"具体的に何を改善するか"

**あなたはすでにTS2339向けに missing export補完の強化を入れています（Interface/Type/Namespace拡張など）。**

**ここから先は「勝ち筋の量産」に向けて、次の3点を順にやるのが最短です。**

#### 10.4.1 React missing export の"候補生成"を増やす（Oracleを動かす）

**目的**: `oracle_win_rate_vs_top1` を上げる（候補集合の上限改善）

**やること（具体）:**

1. **export補完テンプレの拡充**
   - いま成功している `Component/memo/createContext` を核に、Reactで参照されがちなエントリを追加する
   - 例: `FC`, `ReactNode`, `useMemo`, `useCallback`, `useState`, `useEffect`, `forwardRef`, `lazy`, `Suspense` など

2. **適用条件の精密化（worseを増やさないため）**
   - 例: 「TS2339で、参照が `React.*` で、Localizer上位が`react`、かつtsserverで参照先が`react`モジュールに解決される」など
   - ※あなたの研究の新規性は「tsserver由来のシンボル解決」と「エラー型に直結した候補生成」なので、ここを前面に出す

**成果物**: React向け候補生成の追加（operator拡張 or 既存operatorの適用条件追加）＋ Oracle指標の更新

#### 10.4.2 React TS2339を"原因別に分類"して、直せる群に集中する

**TS2339は同じエラーコードでも原因が違います。ケーススタディではこれを分類して見せると説得力が跳ねます。**

**最小の分類（推奨）:**

- **E1: missing export**（今回の勝ち筋）
- **E2: 型が狭い**（widen/unionが必要）
- **E3: import/export形不整合**（モジュール境界）
- **E4: react以外が根**（周辺依存や内部コード）

**成果物**: React層のTS2339をE1〜E4にラベル付けした集計表（卒論の表になる）

#### 10.4.3 "悪avoid:悪化率（worse）を下げる"React向けセーフガード設計

**全体では `worse=0.375` が課題として残っています。**

**すでにセーフガード（事前評価・早期停止）を持っているので、Reactケースでは次を追加すると良いです。**

1. **React専用の"危険手"抽出**: worseを起こしたrepair key（operator/prop/module）を上位から列挙
   - 分析スクリプト群は既に揃っているので、抽出は実装負担が小さい

2. **危険手の適用制限**: E1（missing export）以外にはexport補完を打たない、など

3. **事前評価の粒度を上げる**: React層の代表consumerを使って事前評価する（"Reactに対する安全性"を保証しやすい）

**成果物**: React層での `worse` 低下（少なくとも増えない）＋ "なぜ安全になったか"の説明

---

### 10.5 実験計画：何を比較して、何が言えるようになるか

**卒論で一番通りが良い比較の形を置きます。**

#### 10.5.1 比較（Ablation）

- **Base**: 現状のA3（Localizer+Reranker+既confirmオペレータ）
- **+React候補生成拡張**: React missing exportテンプレ増
- **+Reactセーフガード強化**: 危険手抑制・事前評価調整

#### 10.5.2 指標

**全体・React層で同じ指標を出します（並べるだけで強い）。**

- `win_rate_vs_top1`（Top1超え）
- `worse`率（安全性）
- Oracle（候補集合の上限）
- （副次）`avg_tsc_calls`：第1貢献の効果として"添える"

**現状のベースライン（Week7）:**
- `win_rate_vs_top1 = 0.250`
- `worse`率 = 0.375
- `avg_tsc_calls = 3.69`

**ここからReact層でどれだけ動かせたかが"結果"になります。**

#### 10.5.3 何が言えるか（主張の形）

**言えること1**: TS2339支配的な状況で、React missing exportの候補生成を増やすと Oracle上限が上がる（候補集合の質改善）

**言えること2**: Oracle上限が上がった上で、Rerankerが Top1超えを回収できる（探索の実効性）

**言えること3**: React層のセーフガードにより `worse`を抑えたまま改善を獲得できる（安定性）

---

### 10.6 fixturesの使い方（ケーススタディの"因果説明"の要）

**fixturesは「再現性と因果説明のsanity check」と明記されているので、Reactケースではここを厚くします。**

#### 10.6.1 最低3本（卒論に載せやすい構成）

1. **React.Component のTS2339 → export補完で直る**（成功例）
   - 実際に改善例が確認済み

2. **React.memo/createContext のTS2339 → export補完で直る**（成功例）
   - 実際に改善例が確認済み

3. **"直らないTS2339" → なぜ missing export ではないか**（対照例）
   - E2/E3/E4の例を示す

**これで「実プロジェクトでの改善は偶然ではない」を説明できます。**

#### 10.6.2 実装場所
- `evaluation-data-set/fixtures/TS2339/react-component/`
- `evaluation-data-set/fixtures/TS2339/react-memo/`
- `evaluation-data-set/fixtures/TS2339/react-create-context/`
- `evaluation-data-set/fixtures/TS2339/non-missing-export/`（対照例）

---

### 10.7 タイムライン（Week8以降）

**Week8（React層の定義と抽出）:**
- React層の機械的な定義を実装
- `react_cohort.jsonl` の生成
- データセット節の下書き

**Week9（React候補生成拡張）:**
- export補完テンプレの拡充（Component/memo/createContext以外）
- 適用条件の精密化
- Oracle指標の更新

**Week10（React TS2339分類とセーフガード）:**
- React TS2339をE1〜E4に分類
- React専用の危険手抽出
- React向けセーフガード設計と実装

**Week11（実験実行と分析）:**
- Ablation比較の実行（Base / +候補生成拡張 / +セーフガード強化）
- 全体層・React層での指標比較
- fixtures評価の実行

**Week12（論文/卒論の執筆）:**
- 結果の整理と可視化
- 主張の固め
- 追加実験の必要性の判断

---

### 10.8 判断基準の更新

**実装を進める判断基準:**
- React層で `oracle_win_rate_vs_top1` が 0.30以上に向上
- React層で `worse`率が 0.35以下に削減
- 全体層の指標が悪化しない（一般性の維持）

**実装を中止/変更する判断基準:**
- React層の抽出条件が満たすリポジトリが5件未満（統計的に不十分）
- React層で `worse`率が 0.40以上に増加
- 全体層の `win_rate_vs_top1` が 0.20以下に低下


