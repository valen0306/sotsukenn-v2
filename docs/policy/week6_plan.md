# Week6 実装計画（悪化率削減 + 新operator適用条件整備）

## 1. Week5の成果と課題の整理

### 成果
- ✅ `win_rate_vs_top1`: 0.176 → 0.250（42%向上）
- ✅ 改善4件を確認（BetterDiscord, oblivion-desktop, baseweb, etcher）
- ✅ 新operator実装完了（type-add-prop, ns-member-add, widen-return-prop）
- ✅ `avg_tsc_calls`: 3.81（セーフガードにより削減）

### 課題
- ❌ `worse`率が 0.375 と高い（目標0.35以下）
- ❌ 新operatorがまだ使われていない（条件が整っていない）
- ❌ `win_rate_vs_top1` が 0.250（目標0.30には未達）

---

## 2. Week6の目標

**主要目標:**
- `worse`率を **0.35以下**に削減（現状0.375から）
- `win_rate_vs_top1` を **0.30以上**に向上（現状0.250から）
- 新operatorの使用を確認

**副次目標:**
- `avg_tsc_calls` を 3.5以下に維持
- 新operator（type-add-prop, ns-member-add, widen-return-prop）の使用回数を増やす

---

## 3. タスク1: 悪化率削減（最優先）

### 3.1 現状分析

**問題:**
- `chosen_worse_than_baseline_rate = 0.375`（37.5%が悪化）
- セーフガード（early-stop）は実装済みだが、悪化候補の事前棄却は未実装
- 悪化候補が選択されることで、全体の指標が悪化

**既存のセーフガード:**
- `--early-stop-after-improve`: 改善候補が出たら探索を打ち切り（実装済み）
- `--early-stop-tie-streak N`: 同点がN回続いたら探索を打ち切り（実装済み）

**不足している機能:**
- 悪化候補の事前棄却（全consumerに適用する前に、少数で評価して悪化を検出）

### 3.2 実装方針

#### 3.2.1 少数consumerでの事前評価

**アプローチ:**
1. repair候補を生成した後、全consumerに適用する前に、少数（1-2件）のconsumerで評価
2. 事前評価で悪化（Phase3 core増加）が観測された場合は候補を棄却
3. 改善/同点の場合のみ全consumerに適用

**実装詳細:**

```javascript
// 疑似コード
async function evaluateRepairCandidateWithSample(candidate, allConsumers, sampleSize = 2) {
  // 1. 少数のconsumerをランダムに選択
  const sampleConsumers = selectRandomConsumers(allConsumers, sampleSize);
  
  // 2. サンプルconsumerで評価
  let worseCount = 0;
  for (const consumer of sampleConsumers) {
    const result = await runTrialOnConsumer(candidate, consumer);
    if (result.phase3Total > consumer.baselinePhase3) {
      worseCount++;
    }
  }
  
  // 3. 悪化率が閾値を超えた場合は棄却
  const worseRate = worseCount / sampleConsumers.length;
  if (worseRate >= 0.5) {
    return { shouldReject: true, reason: "sample_worse_rate_too_high" };
  }
  
  // 4. 問題なければ全consumerに適用
  return { shouldReject: false };
}
```

**実装場所:**
- `evaluation/real/phase3-run.mjs` の `repair-from-top1` セクション
- repair候補を生成した後、`runTrial`を呼ぶ前に事前評価を実行

**新規オプション:**
- `--repair-safeguard-sample N`: 事前評価のconsumer数（デフォルト: 2）
- `--repair-safeguard-worse-threshold R`: 悪化率の閾値（デフォルト: 0.5）

#### 3.2.2 候補の優先順位付け

**アプローチ:**
- 過去の改善実績があるrepair keyを優先
- 勝ち筋（`react::add-export-const`, `@webpack::widen-callee-to-any`）を優先的に試行

**実装詳細:**
- repair候補のリストをソートして、優先度の高いものを先に試行
- 優先度は過去の改善実績から算出（現状は固定値で開始）

### 3.3 評価指標

**主要指標:**
- `worse`率の削減（0.375 → 0.35以下）
- `avg_tsc_calls` の維持（3.5以下）
- `win_rate_vs_top1` の維持/向上（0.25以上）

**副次指標:**
- 事前評価で棄却された候補数
- 事前評価の精度（全consumer評価との一致率）

### 3.4 実装手順

1. **事前評価関数の実装**
   - `evaluateRepairCandidateWithSample` 関数を追加
   - 少数consumerでの評価ロジックを実装

2. **オプションの追加**
   - `--repair-safeguard-sample N` オプションを追加
   - `--repair-safeguard-worse-threshold R` オプションを追加

3. **repair候補生成後の処理を修正**
   - repair候補を生成した後、事前評価を実行
   - 棄却された候補は`candidates`リストから除外

4. **ログ出力の追加**
   - 事前評価で棄却された候補数を記録
   - `result.phase3.repair.safeguard.rejectedBySample` に記録

5. **スモーク評価（max=10）**
   - 実装が正しく動作するか確認
   - `worse`率が削減されるか確認

6. **max=30での評価**
   - 本格的な評価を実行
   - 目標指標を達成できるか確認

---

## 4. タスク2: 新operatorの適用条件整備

### 4.1 現状分析

**問題:**
- `type-add-prop`, `ns-member-add`, `widen-return-prop` が実装済みだが使用されていない
- 原因: ブロックが存在しない、または対象となる型定義が存在しない

**デバッグ情報から判明したこと:**
- `@webpack`モジュールで `hasBlock = false`（ブロックが存在しない）
- `widenReturnTypePropertyInDeclareModuleBlock` がブロックなしでは動作しない

### 4.2 実装方針

#### 4.2.1 ブロックが存在しない場合の処理改善

**`widenReturnTypePropertyInDeclareModuleBlock` の拡張:**

現在の実装は、既存のブロック内の関数定義を修正することを想定している。
ブロックが存在しない場合でも動作するように拡張する。

**実装方針:**
1. ブロックが存在しない場合、新しいブロックを作成
2. 関数定義を追加（戻り値型にプロパティを含む）
3. 例: `declare module '@webpack' { export function getByKeys(...): { MenuSeparator: any }; }`

**実装詳細:**

```javascript
function widenReturnTypePropertyInDeclareModuleBlock(dtsText, mod, exportName, propName) {
  const rng = getDeclareModuleBlockRange(dtsText, mod);
  
  // ブロックが存在する場合（既存の処理）
  if (rng) {
    // ... 既存の処理 ...
  }
  
  // ブロックが存在しない場合: 新しいブロックを作成
  const newBlock = buildMinimalDeclareModule(mod, [
    `export function ${exportName}(...args: any[]): { ${propName}: any };`
  ]);
  return newBlock ? `${dtsText}\n${newBlock}` : null;
}
```

#### 4.2.2 型定義の存在確認強化

**`addPropertyToExportedTypeInDeclareModuleBlock` の拡張:**

型定義が存在しない場合でも、新しい型定義を作成する。

**実装方針:**
1. 型定義が存在しない場合、新しい型定義を作成
2. プロパティを含む型定義を追加
3. 例: `export type Foo = { Prop?: any; }`

**実装詳細:**

```javascript
function addPropertyToExportedTypeInDeclareModuleBlock(dtsText, mod, typeName, propName) {
  const rng = getDeclareModuleBlockRange(dtsText, mod);
  
  // ブロックが存在する場合（既存の処理）
  if (rng) {
    // ... 既存の処理 ...
  }
  
  // ブロックが存在しない場合: 新しいブロックと型定義を作成
  const newBlock = buildMinimalDeclareModule(mod, [
    `export type ${typeName} = { ${propName}?: any; };`
  ]);
  return newBlock ? `${dtsText}\n${newBlock}` : null;
}
```

#### 4.2.3 Namespace拡張の改善

**`addNamespaceMemberToDeclareModuleBlock` の拡張:**

既存の実装は、exportが存在する場合にnamespaceを追加する。
ブロックが存在しない場合でも動作するように拡張する。

### 4.3 評価指標

**主要指標:**
- 新operatorの使用回数の増加
- `win_rate_vs_top1` への寄与

**副次指標:**
- 新operatorが使われたrepo数
- 新operatorによる改善件数

### 4.4 実装手順

1. **`widenReturnTypePropertyInDeclareModuleBlock` の拡張**
   - ブロックが存在しない場合の処理を追加
   - 新しいブロックを作成して関数定義を追加

2. **`addPropertyToExportedTypeInDeclareModuleBlock` の拡張**
   - ブロックが存在しない場合の処理を追加
   - 新しいブロックと型定義を作成

3. **`addNamespaceMemberToDeclareModuleBlock` の拡張**
   - ブロックが存在しない場合の処理を追加

4. **スモーク評価（max=10）**
   - 新operatorが使用されるか確認
   - デバッグ情報を確認

5. **max=30での評価**
   - 新operatorの使用回数を確認
   - `win_rate_vs_top1` への寄与を確認

---

## 5. 実装の優先順位

### 最優先（Week6前半）
1. **悪化率削減（タスク1）**
   - 事前評価による悪化候補の棄却
   - スモーク評価で効果を確認

### 高優先（Week6後半）
2. **新operatorの適用条件整備（タスク2）**
   - ブロックが存在しない場合の処理改善
   - スモーク評価で新operatorの使用を確認

---

## 6. 評価計画

### スモーク評価（max=10）
- 各タスクの実装後に実行
- 実装が正しく動作するか確認
- 目標指標への寄与を確認

### 本格評価（max=30）
- Week6の全タスク完了後に実行
- 目標指標の達成を確認
- `worse`率: 0.35以下
- `win_rate_vs_top1`: 0.30以上

---

## 7. 成功基準

**Week6が成功したと判断する基準:**
- ✅ `worse`率が 0.35以下に削減
- ✅ `win_rate_vs_top1` が 0.30以上に向上
- ✅ 新operatorの使用を確認（少なくとも1回以上）
- ✅ `avg_tsc_calls` が 3.5以下に維持

**Week6が部分的に成功したと判断する基準:**
- ✅ `worse`率が 0.36以下に削減（目標に近い）
- ✅ `win_rate_vs_top1` が 0.28以上に向上（目標に近い）
- ✅ 新operatorの使用を確認

---

## 8. リスクと対策

### リスク1: 事前評価の精度が低い
**対策:** サンプルサイズを調整可能にする（`--repair-safeguard-sample N`）

### リスク2: 新operatorがまだ使われない
**対策:** デバッグ情報を活用して、適用条件を特定・改善

### リスク3: `avg_tsc_calls` が増加
**対策:** 事前評価のサンプルサイズを小さくする（1-2件）

---

## 9. 参考資料

- Week5の評価結果: `evaluation/real/out/phase5-ts2339-extend-week5-max30/`
- 既存のセーフガード実装: `evaluation/real/phase3-run.mjs` (Week3)
- 新operatorの実装: `evaluation/real/phase3-run.mjs` (Week5)

