# データセット：React層（Case Study）の定義

## 1. 背景と目的

本研究では、Phase3 coreエラー（特にTS2339）が支配的であることが観測されている（baselineでTS2339=921件）。この中で、React依存のTS2339に限定して深掘りすることで、因果説明と改善の量産を目指す。

**重要**: React層は「React専用研究」ではなく、**機械的な条件で抽出されたケーススタディ**として位置づける。これにより、恣意性を排除し、一般性を担保する。

---

## 2. React層の機械的な定義

### 2.1 抽出条件

**必須条件:**

1. **Phase3 coreでTS2339を含む**
   - baselineの`tsErrorCounts.TS2339 > 0`
   - 対象エラーを固定することで、評価の一貫性を保つ

2. **LocalizerのTop3モジュールに `react` が入る**
   - `phase3.localizer.topModuleFreq`の上位3件に`react`が含まれる
   - Localizer自体が「エラー位置から依存モジュールを特定して範囲を絞る」設計
   - この条件により、「react依存」をログから機械的に定義し、恣意性を排除

**推奨条件（可能なら追加）:**

3. **TS2339の対象シンボルが `React.Component` / `React.memo` / `React.createContext` 等**
   - 実際に改善例がそれらで出ているため（勝ち筋に寄せる）
   - ただし、必須条件ではない（統計的な十分性を優先）

### 2.2 抽出方法

**スクリプト**: `evaluation/real/extract-react-cohort.mjs`

```bash
node evaluation/real/extract-react-cohort.mjs --out-dir evaluation/real/out/<dir>
```

**出力**: `react_cohort.jsonl`（React層に該当するリポジトリのリスト）

**各エントリの構造:**
```json
{
  "url": "https://github.com/...",
  "repo": "...",
  "baseline_phase3_total": 123,
  "baseline_ts2339": 45,
  "top3_modules": ["react", "lodash", "..."],
  "react_symbols": ["Component", "memo", ...],
  "has_win_symbol": true,
  "matched_conditions": {
    "has_ts2339": true,
    "has_react_in_top3": true,
    "has_win_symbol": true
  }
}
```

---

## 3. 抽出結果（Week7評価結果から）

**評価対象**: `evaluation/real/out/phase5-week7-max30`（max=30）

**統計（Week7評価結果、max=30）:**
- 総リポジトリ数: 30
- Top3にreactを含む: 8
- Top10にreactを含む: 8
- TS2339を含む: 14
- **Top3にreactを含む AND TS2339>0: 5**
- **Top3にreactを含む（TS2339=0も含む）: 8**

**最終的なReact層のサイズ: 7件**（複数の評価結果から統合、TS2339=0も含む）

**抽出されたリポジトリ（最終版）:**
1. `https://github.com/airbnb/react-sketchapp.git`
   - Top3: `@sketch-hq/sketch-file-format-ts`, `react`, `react-test-renderer`
   - TS2339: 0（React依存だがTS2339は0件）

2. `https://github.com/alibaba/formily.git`
   - Top3: `react`, `@testing-library/react`, `@testing-library/vue`
   - TS2339: 39

3. `https://github.com/balena-io/etcher.git`
   - Top3: `i18next`, `lodash`, `react`
   - TS2339: 3

4. `https://github.com/bepass-org/oblivion-desktop.git`
   - Top3: `classnames`, `react`
   - TS2339: 0
   - React symbols: `Component`（勝ち筋シンボル）

5. `https://github.com/DIYgod/RSSHub-Radar.git`
   - Top3: `@plasmohq/messaging`, `react`, `lodash`
   - TS2339: 1

6. `https://github.com/lyswhut/lx-music-mobile.git`
   - Top3: `react`, `react-native-background-timer`, `react-native-track-player`
   - TS2339: 0

7. `https://github.com/uber/baseweb.git`
   - Top3: `react`, `date-fns`, `react-view`
   - TS2339: 30
   - React symbols: `memo`（勝ち筋シンボル）

---

## 4. なぜReactを選んだのか（恣意性の排除）

### 4.1 機械的な条件による選定

本研究では、以下の理由によりReactを選定した：

1. **TS2339が支配的**: baselineでTS2339=921件（Phase3 coreの約70%）
2. **Localizerによる自動選定**: エラー位置から依存モジュールを特定するLocalizerが、Top3に`react`を含むリポジトリを自動的に抽出
3. **改善実績の存在**: 既に`React.Component/memo/createContext`に対する改善が確認されている

### 4.2 恣意性の排除

- **Localizerの設計**: エラー位置から依存モジュールを特定する設計により、「react依存」をログから機械的に定義
- **条件の明示**: 抽出条件を明示することで、再現性を担保
- **一般性の維持**: 全体層（max=30）を維持することで、「任意のJSライブラリへ適用」の一般性を担保

---

## 5. データセットの使用

### 5.1 全体層との関係

- **全体層（General）**: max=30を維持（一般性の担保）
- **React層（Case study）**: 上記条件で抽出された3件（因果説明・改善の量産）

### 5.2 評価指標

両層で同じ指標を算出し、比較する：

- `win_rate_vs_top1`（Top1超え）
- `worse`率（安全性）
- Oracle（候補集合の上限）
- `avg_tsc_calls`（探索効率）

---

## 6. 今後の拡張

### 6.1 抽出条件の調整

統計的な十分性を確保するため、以下の調整を検討：

- 推奨条件3（React勝ち筋シンボル）を必須条件にしない（現状3件→必須にすると1件になる）
- より多くの評価結果から抽出（複数の評価結果を統合）

### 6.2 データセットの拡張

- より多くのリポジトリを評価し、React層のサイズを拡大
- 他のライブラリ（例: `lodash`, `date-fns`）でも同様の抽出を実施

---

## 7. 参考文献

- 本研究の評価設計: `docs/policy/policyA_v2.md` 第10章
- 抽出スクリプト: `evaluation/real/extract-react-cohort.mjs`
- 評価結果: `evaluation/real/out/phase5-week7-max30/react_cohort.jsonl`

