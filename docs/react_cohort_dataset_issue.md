# React層データセットが集まらない問題と解決策

## 問題の構造

### 1. React由来のエラーが多いという結果

**Week7評価結果（max=30）:**
- **TS2339が支配的**: 921件（Phase3 coreの約70%）
- **React依存リポジトリが26.7%**: 30件中8件（Top3にreactを含む）
- **改善例の66.7%がReact関連**: 3件中2件
- **勝ち筋がReact関連に収束**: missing export補完（react.Component/memo/createContext）

→ **React由来のエラーが「かなり強く出ていた」という根拠は明確**

### 2. しかし、ケーススタディ用データセットが集まらない

**条件別のリポジトリ数（Week7評価結果、max=30）:**

| 条件 | リポジトリ数 | 減少 |
|------|------------|------|
| 総リポジトリ数 | 30件 | - |
| Top3にreactを含む | **8件** | - |
| + TS2339>0 | **5件** | **3件減少** |
| + React勝ち筋シンボル | **1-2件** | **さらに3-4件減少** |

**問題:**
- TS2339>0を必須条件にすると、**5件に減少**（統計的に不十分）
- React勝ち筋シンボル（Component/memo/createContext）を含む条件を追加すると、**さらに1-2件に減少**

### 3. 具体的な内訳

**Top3にreactを含むリポジトリ（8件）:**

**TS2339>0のリポジトリ（5件）:**
1. `alibaba/formily`: TS2339=39件
2. `uber/baseweb`: TS2339=30件
3. `BetterDiscord/BetterDiscord`: TS2339=31件
4. `DIYgod/RSSHub-Radar`: TS2339=1件
5. `web-clipper/web-clipper`: TS2339=5件

**TS2339=0のリポジトリ（3件）:**
1. `airbnb/react-sketchapp`: TS2339=0（top3: @sketch-hq/sketch-file-format-ts, react, react-test-renderer）
2. `lyswhut/lx-music-mobile`: TS2339=0（top3: react, react-native-background-timer, react-native-track-player）
3. `bepass-org/oblivion-desktop`: TS2339=0（top3: classnames, react）

**問題の本質:**
- React依存リポジトリは8件あるが、**TS2339>0を必須条件にすると5件に減少**
- さらに、React勝ち筋シンボルを含む条件を追加すると、**1-2件に減少**
- **統計的に不十分**（5件未満）という判断基準を満たせない

---

## 解決策

### 1. TS2339=0でも含める（Week8改善）

**根拠:**
- React由来のエラーが多いという結果から、TS2339=0でもReact依存のリポジトリは分析対象として価値がある
- 他のエラー型（TS2345, TS2322など）も分析対象として含めることで、より包括的なケーススタディになる
- React依存のリポジトリ全体をケーススタディとして扱うことで、統計的に十分なサイズを確保できる

**結果:**
- **8件まで拡大可能**（Top3にreactを含むリポジトリ全体）

### 2. 複数の評価結果から統合

**方法:**
- 複数の評価結果（`phase5-*-max30`）からReact層を抽出
- `merge-react-cohorts.mjs`で統合

**結果:**
- **7件まで拡大可能**（統計的に十分なサイズ）

### 3. 条件の緩和

**最終的な抽出条件（Week8改善後）:**

**必須条件:**
1. **LocalizerのTop3モジュールに `react` が入る**（"react依存"をログで定義）
   - Localizer自体が「エラー位置から依存モジュールを特定して範囲を絞る」設計
   - この条件により、恣意性を排除
   - **Week8改善**: React由来のエラーが多いという結果から、TS2339=0でも含める（より包括的なケーススタディ）

**推奨条件（可能なら追加）:**
2. **Phase3 coreでTS2339を含む**（対象エラーを固定）
   - ただし、TS2339=0でもReact依存のリポジトリは含める（他のエラー型も分析対象）

3. **TS2339の対象シンボルが `React.Component` / `React.memo` / `React.createContext` 等**（勝ち筋に寄せる）
   - 実際に改善例がそれらで出ているため

---

## 最終的なReact層のサイズ

**統合結果（Week8改善後）:**
- **React層のサイズ: 7件** ✅（統計的に十分なサイズ）
- TS2339を含む: 4件
- TS2339=0: 3件（React依存だがTS2339は0件）
- React勝ち筋シンボルを含む: 2件

**抽出されたリポジトリ（最終版）:**
1. `airbnb/react-sketchapp` (TS2339: 0)
2. `alibaba/formily` (TS2339: 39)
3. `balena-io/etcher` (TS2339: 3)
4. `bepass-org/oblivion-desktop` (TS2339: 0, symbols: Component)
5. `DIYgod/RSSHub-Radar` (TS2339: 1)
6. `lyswhut/lx-music-mobile` (TS2339: 0)
7. `uber/baseweb` (TS2339: 30, symbols: memo)

---

## 結論

### 問題の本質

**React由来のエラーが多いにもかかわらず、ケーススタディ用データセットが集まらない理由:**

1. **条件が厳しすぎる**: TS2339>0を必須条件にすると、8件 → 5件に減少
2. **さらに条件を追加すると減少**: React勝ち筋シンボルを含む条件を追加すると、5件 → 1-2件に減少
3. **統計的に不十分**: 5件未満という判断基準を満たせない

### 解決策

1. **TS2339=0でも含める**: React依存のリポジトリ全体をケーススタディとして扱う
2. **複数の評価結果から統合**: 7件まで拡大可能（統計的に十分なサイズ）
3. **条件の緩和**: React依存のリポジトリ全体を分析対象として扱う

### 根拠

- React由来のエラーが多いという結果から、TS2339=0でもReact依存のリポジトリは分析対象として価値がある
- 他のエラー型（TS2345, TS2322など）も分析対象として含めることで、より包括的なケーススタディになる
- 統計的に十分なサイズ（7件 ≥ 5件）を確保できる

---

## 参考文献

- React由来のエラーの強さ: `docs/react_error_evidence.md`
- React層の定義: `docs/policy/policyA_v2.md` 第10章
- データセット抽出: `docs/dataset_react_cohort.md`
- 評価結果: `evaluation/real/out/phase5-week7-max30/`

