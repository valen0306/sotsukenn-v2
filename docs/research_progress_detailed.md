# 研究進捗詳細報告書
**最終更新**: 2025年1月（Week7完了時点）

## 1. 研究概要

### 1.1 研究テーマ
**JSライブラリ向け `.d.ts` 自動整備による下流TypeScript移行支援**

### 1.2 研究目的
- JavaScriptライブラリに対する型定義（`.d.ts`）整備を自動支援
- 下流プロジェクトにおけるTS導入の障壁（依存の型欠如）を低減
- **下流プロジェクトが実際に`tsc`を通るか**を成功基準として評価

### 1.3 研究課題（Research Questions）
- **RQ1（実用効果）**: JSライブラリに生成した`.d.ts`を注入することで、下流プロジェクトの**`tsc`成功率（型検査成功率）**はどれだけ改善するか
- **RQ2（「anyで通しただけ」への反証）**: 改善はトリビアル型（例: `any`）の濫用ではないか。**トリビアル型割合**や**エラー内訳**から、モデル条件の価値を検証できるか
- **RQ3（失敗要因）**: 失敗はどのTSエラーコードに集中し、どの種類が増減するか。典型パターンを抽出できるか

---

## 2. 研究フェーズと現在の位置

### 2.1 フェーズ構成
本研究はエラーコードで段階を追跡する設計：

- **Phase 0**: ゲート（実験成立性と対象集合の確定）
- **Phase 1**: 型解決（TS2307, TS7016）
- **Phase 2**: 型推論（TS2305, TS2613, TS2614）
- **Phase 3**: 型整合性（TS2339, TS2345, TS2322, TS2554, TS2769, TS2353, TS2741, TS7053）
- **Phase 4**: 高度な型機能（TS18046, TS7006, TS7031）

### 2.2 現在のフェーズ
**Phase5（Week5-7完了）**: Phase3 coreエラーに対するRepair Operator実装と評価

---

## 3. 主要な成果と指標

### 3.1 第1貢献（確定）
**探索効率化**: Localizer + Rerankerにより、`tsc`回数を削減しつつ同等の改善を維持

**根拠:**
- A1（Localizerのみ）: `avg_tsc_calls = 4.41`
- A3（Localizer + Reranker）: `avg_tsc_calls = 3.76`（**14.7%削減**）
- Phase3改善量は同等（`delta = -100`）

### 3.2 第2貢献（進行中）
**エラー型に直結する局所修復**: Repair Operatorにより、Top1を超える改善候補を生成

**現状（Week7完了時点）:**
- `win_rate_vs_top1 = 0.250`（Week5で0.176から42%向上、Week6-7で維持）
- Oracle上限: `avg_oracle_phase3 = 23.765`（Top1: 25.000）
- 改善4件を確認（TS2339由来: `react` missing export / `@webpack` callee widen）
- `avg_tsc_calls = 3.69`（セーフガードにより削減）

**目標（Week7-8）:**
- `win_rate_vs_top1` を **0.40以上**に向上（現実的な目標に調整）
- TS2339以外のエラー型（TS2345/TS2322）でも改善候補を生成
- エラー型別のrepair operatorの効果を定量化

### 3.3 主要指標の推移

| 指標 | Week5 | Week6 | Week7 | 目標 |
|------|-------|-------|-------|------|
| `win_rate_vs_top1` | 0.250 | 0.250 | 0.250 | 0.30+ |
| `worse`率 | 0.375 | 0.375 | 0.375 | 0.35以下 |
| `avg_tsc_calls` | 3.81 | 3.69 | 3.69 | 3.5以下 |
| Oracle `win_rate_vs_top1` | 0.250 | 0.250 | 0.250 | - |

---

## 4. 実装済み機能の詳細

### 4.1 Localizer（モジュール特定）
**機能**: エラー位置から依存モジュールを特定し、候補生成の範囲を絞る

**実装:**
- Top3モジュールを特定（`--localizer-top-modules 3`）
- エラーコード別にモジュールをランキング

**効果:**
- 探索空間を削減し、`tsc`回数を削減

### 4.2 Reranker（候補優先順位付け）
**機能**: 学習により候補の優先順位を付け、改善候補を早期に発見

**実装:**
- 軽量MLモデル（TypeBERTベース）
- `tsc`フィードバック（Δerrors）から学習

**効果:**
- `avg_tsc_calls`を削減しつつ、改善率を維持

### 4.3 Repair Operator（Candidate Generator v3）

#### 4.3.1 実装済みRepair Operator

**TS2339（プロパティ不存在）対応:**
1. **`add-export-const`**: namespace import (`ns.Prop`) に対して `export const Prop: any;` を追加
2. **`widen-callee-to-any`**: call-return由来のTS2339に対して、callee関数の戻り値型をany化
3. **`widen-imported-to-any`**: named/default importに対して、exportをany化
4. **`export-to-any`**: named importのexportをany化（interface prop追加のフォールバック）
5. **`type-to-any`**: `import type` された型をany化
6. **`iface-add-prop`**: interfaceにプロパティを追加（Week5実装）
7. **`type-add-prop`**: type aliasにプロパティを追加（Week5実装、Week6で適用条件整備）
8. **`ns-member-add`**: namespaceにメンバーを追加（Week5実装、Week6で適用条件整備）
9. **`widen-return-prop`**: 戻り値型の特定プロパティのみany化（Week5実装、Week6で適用条件整備）

**TS2345/TS2322（型不一致）対応:**
1. **`widen-callee-to-any`**: call-siteからcalleeを解決し、関数全体をany化
2. **`add-any-overload`**: 関数にany引数のoverloadを追加（arity-specific対応）
3. **外部起因の厳密な判定**（Week7実装）: 型の起源を追跡し、外部モジュール由来の場合のみrepair候補を生成

#### 4.3.2 勝ち筋（改善に寄与したRepair）

**確認済みの改善パターン:**
- `TS2339::react::*::add-export-const::prop=Component/memo/createContext`
- `TS2339::@webpack::getByKeys::widen-callee-to-any::prop=MenuSeparator`

**改善例:**
- BetterDiscord: `@webpack.getByKeys(...)` の戻り値に対する TS2339 を **callee widen**で解消 → `phase3: 106 → 93`
- oblivion-desktop: `React.Component` の TS2339 を **export補完**で解消 → `phase3: 3 → 2`
- baseweb: `React.memo` / `React.createContext` の TS2339 を **export補完**で解消 → `phase3: 83 → 79`
- etcher: TS2345を **widen-callee-to-any**で解消 → `phase3: 3 → 2`

### 4.4 セーフガード（探索効率化と安定化）

#### 4.4.1 早期停止
- **`--early-stop-after-improve`**: Top1より良い候補が出たら探索を打ち切り
- **`--early-stop-tie-streak 2`**: Top1と同点が2回続いたら探索を打ち切り

**効果:**
- `avg_tsc_calls` を `4.47 → 3.65` に削減（**18.3%削減**）
- `win_rate_vs_top1 = 0.176` を維持

#### 4.4.2 事前評価（Week6実装）
- **`--repair-safeguard-sample N`**: 少数consumer（1件）での事前評価
- **`--repair-safeguard-worse-threshold R`**: 悪化率の閾値（0.5）

**ロジック:**
- baselineより悪化 **AND** top1より改善していない場合のみ棄却
- top1より改善している候補は保持（baselineより悪化していても）

**効果:**
- 棄却率: 68.2% → 13.6%に改善（**80%削減**）
- 改善候補が棄却されず、Week5の結果を維持
- `avg_tsc_calls = 3.69`（悪化候補の早期棄却により効率化）

---

## 5. Week5-7の詳細実装と評価

### 5.1 Week5: TS2339拡張

#### 実装内容
1. **Missing Export補完の強化**
   - Interface/Type拡張: `addPropertyToExportedInterfaceInDeclareModuleBlock`
   - Type alias拡張: `addPropertyToExportedTypeInDeclareModuleBlock`
   - Namespace拡張: `addNamespaceMemberToDeclareModuleBlock`

2. **Call-Return由来のTS2339の拡張**
   - 戻り値型の部分widen: `widenReturnTypePropertyInDeclareModuleBlock`
   - 関数の戻り値型がobjectの場合、特定プロパティだけをany化

#### 評価結果（max=30）
- `win_rate_vs_top1 = 0.250`（Week4の0.176から**42%向上**）
- `worse`率 = 0.375（変化なし）
- `avg_tsc_calls = 3.81`（Week4の3.65から僅増）
- 改善4件を確認（BetterDiscord, oblivion-desktop, baseweb, etcher）

#### 課題
- 新operator（type-add-prop, ns-member-add, widen-return-prop）がまだ使われていない（条件が整っていない）
- `worse`率が0.375と高い（目標0.35以下）
- `win_rate_vs_top1`が0.250（目標0.30には未達）

### 5.2 Week6: 悪化率削減 + 新operator適用条件整備

#### 実装内容
1. **セーフガードの拡張（悪化候補の早期棄却）**
   - 事前評価ロジックの実装: `evaluateRepairCandidateWithSample`
   - baselineより悪化 AND top1より改善していない場合のみ棄却
   - 改善候補（top1より良い）は保持（baselineより悪化していても）
   - 棄却率: 68.2% → 13.6%に改善

2. **新operatorの適用条件整備**
   - ブロックが存在しない場合の処理改善
   - `widenReturnTypePropertyInDeclareModuleBlock`: ブロックなしでも新しいブロックを作成
   - `addPropertyToExportedTypeInDeclareModuleBlock`: ブロックなしでも新しい型定義を作成
   - `addNamespaceMemberToDeclareModuleBlock`: ブロックなしでも新しいnamespace定義を作成

#### 評価結果（max=30）
- `win_rate_vs_top1 = 0.250`（Week5と同水準を維持）
- `worse`率 = 0.375（変化なし）
- `avg_tsc_calls = 3.69`（Week5の3.81から**3.1%改善**）
- 棄却率 = 13.6%（事前評価により悪化候補を適切に棄却）

#### 改善点
- 事前評価ロジックの改善により、改善候補が棄却されず、Week5の結果を維持
- 棄却率を68.2%から13.6%に大幅改善（悪化候補のみを適切に棄却）
- `avg_tsc_calls`を改善（悪化候補の早期棄却により効率化）

#### 課題
- `worse`率は変化なし（0.375、目標0.35以下には未達）
- `win_rate_vs_top1`は維持（0.250、目標0.30以上には未達）
- 新operator（type-add-prop, ns-member-add, widen-return-prop）の使用は限定的

### 5.3 Week7: TS2345/TS2322拡張 + 分析

#### 実装内容
1. **外部起因の厳密な判定**
   - `isTypeFromExternalModule`関数を追加
   - 型の起源を追跡し、`node_modules`/`@types`由来かどうかを判定
   - `resolveCallCalleeViaTs`で引数型の外部起因チェックを追加
   - `strictExternalOk`でTS2345/TS2322の場合のみ外部起因チェックを適用

2. **Repair Operator別の効果分析スクリプト**
   - `analyze-repair-operator-effects.mjs`を作成
   - Repair Operator別、エラー型別、モジュール別の統計を集計
   - TSV形式で出力

#### 評価結果（max=30）
- `win_rate_vs_top1 = 0.250`（Week6と同水準を維持）
- `worse`率 = 0.375（変化なし）
- `avg_tsc_calls = 3.69`（維持）
- TS2345/TS2322の候補生成: 2件（選択0件）
- TS2339の候補生成: 6件（選択0件）

#### 課題
- 外部起因の厳密な判定が現時点では大きな変化をもたらしていない
- TS2345/TS2322の候補が選択されていない
- `win_rate_vs_top1`が0.250で維持（目標0.30以上には未達）

---

## 6. 分析ツールとスクリプト

### 6.1 実装済み分析スクリプト

1. **`analyze-oracle.mjs`**: Oracle分析（候補集合内の上限）
   - `oracle_win_rate_vs_top1`: Oracle選択時の改善率
   - `avg_oracle_phase3`: Oracle選択時の平均Phase3エラー数

2. **`analyze-error-distribution.mjs`**: エラーコード分布
   - Phase3 coreの総量（baseline側の合計）
   - エラー型別の分布

3. **`analyze-trial-effects.mjs`**: trial効果（改善/同点/悪化）
   - `trials_improve_vs_top1`: Top1より改善したtrial数
   - `trials_tie_vs_top1`: Top1と同点のtrial数
   - `trials_worsen_vs_top1`: Top1より悪化したtrial数

4. **`analyze-repair-causes.mjs`**: 改善原因の分析
   - 改善に寄与したrepair keyのランキング
   - モジュール別、operator別、プロパティ別の集計

5. **`analyze-call-repair-coverage.mjs`**: call-based repairのカバレッジ
   - `tsCallAttempted`: call repair試行数
   - `tsCallResolved`: call repair解決数
   - `tsCallCandidateAdded`: call repair候補追加数

6. **`analyze-call-repair-debug.mjs`**: call-based repairのデバッグ
   - 解決失敗の理由（`unmapped_identifier_callee`, `unmapped_root_identifier`など）
   - 解決成功時のモジュール分布

7. **`analyze-repair-operator-effects.mjs`**（Week7実装）: Repair Operator別の効果分析
   - Repair Operator別の改善率、選択率、worse率
   - エラー型別、モジュール別の統計

### 6.2 分析結果の主要な知見

#### エラーコード分布（baseline, max=30）
- `TS2339 = 921`（支配的）
- `TS2345 = 254`（2位）
- `TS2322 = 87`
- `TS2769 = 63`
- `TS7053 = 32`
- `TS2554 = 11`
- `TS2741 = 6`
- `TS2353 = 2`

#### Oracle分析（max=30, valid=17）
- `oracle_win_rate_vs_top1 = 0.250`
- `oracle_tie_rate_vs_top1 = 0.750`
- `oracle_loss_rate_vs_top1 = 0.000`
- `avg_top1_phase3 = 25.000` → `avg_oracle_phase3 = 23.765`

**解釈:**
- OracleでもTop1を超える改善は限定的（0.250）
- 候補集合の質を向上させる必要がある

#### Call-based repairのカバレッジ（smoke, max=10）
- `avg_tsCallAttempted_per_repo = 9.13`
- `avg_tsCallResolved_per_repo = 0.88`（**9.6%の解決率**）
- `avg_tsCallExternalOk_per_repo = 0.88`
- `avg_tsCallCandidateAdded_per_repo = 0.38`

**解釈:**
- TS2345/2322/2769/2554の多くが「外部d.ts修復で動くエラー」ではなく、**内部/標準API由来**である可能性が高い
- call-based repairを強化しても勝ち筋が増えない可能性が高い

---

## 7. 課題と次のステップ

### 7.1 主要な課題

1. **`win_rate_vs_top1`が0.250で停滞**
   - 目標0.30以上には未達
   - Oracleでも0.250が上限（候補集合の質が律速）

2. **`worse`率が0.375で高い**
   - 目標0.35以下には未達
   - 事前評価により棄却率は改善したが、最終的なworse率は変化なし

3. **TS2345/TS2322の候補が選択されていない**
   - 候補生成は確認（2件）だが、選択は0件
   - 外部起因の判定が厳しすぎる可能性

4. **新operatorの使用が限定的**
   - `type-add-prop`, `ns-member-add`, `widen-return-prop`の使用が少ない
   - 適用条件が整っていない可能性

### 7.2 次のステップ（Week8以降）

#### 優先度: 高
1. **引数型の部分widenを実装**
   - object型の特定プロパティのみany化
   - Union型の部分widen
   - TS2345/TS2322の改善候補を増やす

2. **失敗パターンの分類と分析**
   - 悪化を引き起こすrepair operatorのパターンを抽出
   - 回避ルールの生成

#### 優先度: 中
3. **TS2339系の勝ち筋拡張**
   - グローバル/代入経由のTS2339対応
   - 型チェーン追跡の強化

4. **候補の優先順位付け**
   - 過去の改善実績があるrepair keyを優先
   - エラー型の優先順位（TS2339 > TS2345 > TS2322）

#### 優先度: 低
5. **論文/卒論の執筆準備**
   - 結果の整理と可視化
   - 主張の固め
   - 追加実験の必要性の判断

---

## 8. 研究としての新規性

### 8.1 主張

1. **tsserver由来のシンボル解決**: エラー位置から依存モジュールの特定シンボルを解決し、局所的に修復
2. **エラー型に直結する候補生成**: エラー型（TS2339/TS2345など）に応じたrepair operatorを設計

### 8.2 根拠

- 「とにかくany化」ではなく、tsserverでシンボル解決を経由した「狙い撃ちの局所修復」
- 改善が出た4件の勝ち筋は2パターンに収束：
  - **missing export補完**（`react`の代表API）
  - **call-return由来のTS2339をcallee側widenで吸収**（`@webpack.getByKeys`）

### 8.3 既存研究との違い

- **TypeWeaver**: 依存パッケージに型定義が存在することを保証（フィルタリング）
- **本研究**: 依存ライブラリの`.d.ts`整備を主題とし、型定義欠如が観測される下流を集める

---

## 9. 評価データセット

### 9.1 実プロジェクト評価
- **対象**: GitHubから収集したTypeScriptプロジェクト
- **評価規模**: max=30（主要評価）、max=10（スモーク評価）
- **評価指標**: `win_rate_vs_top1`, `worse`率, `avg_tsc_calls`, Oracle分析

### 9.2 Fixtures評価
- **配置**: `evaluation-data-set/fixtures/`
- **目的**: 再現性と因果の説明のためのsanity check
- **例**: `TS2307/`, `TS7016/`, `TS2339/`, `TS2345/`など

---

## 10. 技術スタック

### 10.1 主要ツール
- **TypeScript Compiler (`tsc`)**: 型検査とエラー検出
- **TypeScript Language Service (`tsserver`)**: シンボル解決と型情報取得
- **TypeBERT**: 型推論モデル（ベースライン）

### 10.2 実装言語
- **JavaScript/Node.js**: 評価スクリプトとRepair Operator実装
- **TypeScript**: 型定義生成と注入

---

## 11. 判断基準

### 11.1 実装を進める判断基準
- ✅ Week5で `win_rate_vs_top1 = 0.250` を達成（基準クリア）
- ✅ `avg_tsc_calls = 3.69`（許容範囲内）
- Week6以降: 新operatorの使用を確認できる
- Week7以降: TS2345/TS2322由来の改善候補を生成できる

### 11.2 実装を中止/変更する判断基準
- `worse`率が0.40以上で改善しない（2週間以上）
- `win_rate_vs_top1`が0.20以下に低下
- `avg_tsc_calls`が5.0以上に増加

---

## 12. まとめ

### 12.1 達成状況
- **第1貢献（確定）**: 探索効率化を実現（`avg_tsc_calls`を14.7%削減）
- **第2貢献（進行中）**: `win_rate_vs_top1 = 0.250`を達成（0から改善）
- **実装完了**: Repair Operator v3、セーフガード、分析ツール一式

### 12.2 残課題
- `win_rate_vs_top1`を0.30以上に向上（現状0.250）
- `worse`率を0.35以下に削減（現状0.375）
- TS2345/TS2322由来の改善候補を増やす

### 12.3 次のマイルストーン
- **Week8**: 引数型の部分widen実装、失敗パターン分析、論文/卒論執筆準備

---

**文書作成日**: 2025年1月  
**最終評価実行**: Week7（max=30）  
**次回評価予定**: Week8（引数型の部分widen実装後）

