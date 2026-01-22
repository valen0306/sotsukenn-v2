# Phase1（型解決）とPhase2（型推論）の評価結果

## 概要

本研究では、TypeScript移行を3つのフェーズに分けて評価しています：

- **Phase1（型解決）**: TS2307, TS7016
- **Phase2（型推論）**: TS2305, TS2613, TS2614
- **Phase3（型整合性）**: TS2339, TS2345, TS2322, ...

Reactのケーススタディは**Phase3（型整合性）**に焦点を当てていますが、Phase1とPhase2についても評価を実施しています。

---

## Phase1（型解決）の評価結果

### 対象エラーコード
- **TS2307**: モジュールが見つからない
- **TS7016**: 暗黙的なany型（型宣言が解決できない）

### 評価方法
- **Fixtures評価**: 制御された小規模なテストケースで評価
- **実プロジェクト評価**: 実際のGitHubリポジトリで評価

### Fixtures評価結果

**対象**: `evaluation-data-set/fixtures/phase1/`
- **TS2307**: 11件のfixture
- **TS7016**: 11件のfixture
- **合計**: 22件のfixture

**結果**:
- **baseline（注入なし）**: 全22件でTS2307またはTS7016が発生（exitCode=2）
- **inject（`.d.ts`注入あり）**: 全22件でTS2307/TS7016が解消（exitCode=0）
- **改善率**: 100%（22/22件）

**解釈**:
- Phase1のfixturesでは、`.d.ts`注入により**型解決エラーが完全に解消**されることを確認
- これは「型宣言が解決可能な形で供給できたか」の評価として、**最低限の成功条件を満たしている**

### 実プロジェクト評価結果

**対象**: `evaluation/real/out/phase1-ts1000-20/`
- **総リポジトリ数**: 20件（ts1000から抽出）

**結果**（要確認）:
- baseline成功: 0件 / 20件
- inject成功: （要確認）
- TS2307/TS7016の改善: （要確認）

**注記**: 実プロジェクトの評価結果は、より詳細な分析が必要です。

---

## Phase2（型推論）の評価結果

### 対象エラーコード
- **TS2305**: モジュールにエクスポートされたメンバーが存在しない
- **TS2613**: デフォルトエクスポートが無いのにデフォルトインポート
- **TS2614**: 名前付きエクスポートが無いのに名前付きインポート

### 評価方法
- **Fixtures評価**: 制御された小規模なテストケースで評価
- **実プロジェクト評価**: 実際のGitHubリポジトリで評価

### Fixtures評価結果

**対象**: `evaluation-data-set/fixtures/phase2/`
- **TS2305**: 10件のfixture
- **TS2613**: 10件のfixture
- **TS2614**: 10件のfixture
- **合計**: 30件のfixture

**結果**:
- **baseline（修正なし）**: 全30件でTS2305/TS2613/TS2614が発生（exitCode=2）
- **inject（モジュール境界修正適用）**: 全30件でTS2305/TS2613/TS2614が解消（exitCode=0）
- **改善率**: 100%（30/30件）

**解釈**:
- Phase2のfixturesでは、**モジュール境界の修正**（import形の書き換え）により、export/import不一致エラーが完全に解消されることを確認
- これは「usage-drivenで抽出した import/require 形に対して、`.d.ts` の export 形を整合させる」評価として、**最低限の成功条件を満たしている**

### 実プロジェクト評価結果

**対象**: `evaluation/real/out/phase2-A1-localizer3-sweep-max20/`
- **総リポジトリ数**: 20件

**結果**（要確認）:
- baseline成功: （要確認）
- inject成功: （要確認）
- TS2305/TS2613/TS2614の改善: （要確認）

**注記**: 実プロジェクトの評価結果は、より詳細な分析が必要です。

---

## Phase1/Phase2とPhase3の関係

### フェーズ間の依存関係

1. **Phase1（型解決）**: 型宣言が解決可能な形で供給できたか
   - これが成立しないと、Phase2/Phase3の評価が成立しない

2. **Phase2（型推論）**: export/import形を整合させられたか
   - これが成立しないと、Phase3の評価が成立しない

3. **Phase3（型整合性）**: 型推論の"質"を評価
   - Phase1/Phase2が解消されたあとに、これらが増える/残る場合は「推論した型が使用実態とズレている」か「もともと下流の使い方が誤っている」可能性がある

### Reactケーススタディの位置づけ

**ReactのケーススタディはPhase3に焦点を当てている理由:**

1. **Phase1/Phase2は既に解決済み**: React依存のリポジトリでは、Phase1/Phase2のエラーは既に解消されている（または少ない）と仮定
2. **Phase3が主要な課題**: React依存のリポジトリでは、TS2339（プロパティ不存在）が支配的（921件中、React依存リポジトリで106件）
3. **改善例がPhase3に集中**: 改善に寄与したRepair keyの多くがTS2339関連（`TS2339::react::*::add-export-const::prop=Component/memo/createContext`）

---

## 結論

### Phase1/Phase2の評価結果

1. **Fixtures評価**: Phase1/Phase2のfixturesでは、`.d.ts`注入やモジュール境界修正により、**100%の改善率**を達成
2. **実プロジェクト評価**: 実プロジェクトでの評価結果は、より詳細な分析が必要

### Phase3との関係

- Phase1/Phase2は「型解決」と「型推論の基礎」を評価
- Phase3は「型推論の質」を評価
- Reactのケーススタディは、Phase3（型整合性）に焦点を当てることで、**より高度な型推論の課題**に取り組んでいる

---

## 参考文献

- Phase1 fixtures: `evaluation/fixtures/phase1/`
- Phase2 fixtures: `evaluation/fixtures/phase2/`
- Phase1実プロジェクト評価: `evaluation/real/out/phase1-ts1000-20/`
- Phase2実プロジェクト評価: `evaluation/real/out/phase2-A1-localizer3-sweep-max20/`
- 研究概要: `docs/research_overview.md` 第8章

