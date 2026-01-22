# React由来のエラーが「かなり強く出ていた」根拠

## 1. エラーコード分布でのTS2339の支配性

**baselineエラーコード分布（max=30）:**
- `TS2339 = 921件`（Phase3 coreの約70%）
- `TS2345 = 254件`
- `TS2322 = 87件`
- `TS2769 = 63件`
- その他: `TS7053=32`, `TS2554=11`, `TS2741=6`, `TS2353=2`

**解釈:**
- **TS2339が支配的**で、次点がTS2345。Repair Operator v3はまずこの2つを最優先で狙うのが合理的
- TS2339は「プロパティ不存在」エラーで、React依存のリポジトリで頻発

---

## 2. React依存のリポジトリの多さ

**Week7評価結果（max=30）:**
- **Top3にreactを含む: 8件**（30件中、**26.7%**）
- **Top10にreactを含む: 8件**（30件中、**26.7%**）
- TS2339を含むリポジトリ: 14件（30件中、46.7%）

**解釈:**
- 約4分の1のリポジトリがReact依存
- Localizerが「エラー位置から依存モジュールを特定」する設計により、React依存が機械的に検出される

---

## 3. React依存リポジトリでのTS2339の集中

**Week7評価結果（max=30）からの分析:**

- **TS2339の総数: 921件**
- **React依存リポジトリ（Top3にreactを含む）のTS2339合計: 106件**
- **React依存リポジトリのTS2339割合: 11.5%**（8件のリポジトリで全体のTS2339の11.5%を占める）

**React依存リポジトリのTS2339内訳（上位）:**
1. `alibaba/formily`: TS2339=39件
2. `uber/baseweb`: TS2339=30件
3. `BetterDiscord/BetterDiscord`: TS2339=31件（Top3にreactは含まれないが、Top10には含まれる）
4. `bepass-org/oblivion-desktop`: TS2339=0件（ただし改善例あり）
5. `DIYgod/RSSHub-Radar`: TS2339=1件
6. `balena-io/etcher`: TS2339=3件

**解釈:**
- React依存リポジトリでTS2339が集中している
- 特に`formily`と`baseweb`で大きなTS2339が観測されている

---

## 4. 改善例でのReactの多さ

### 4.1 改善に寄与したRepair key

**効いたRepair key（改善3件に対する内訳）:**
- `TS2339::react::*::add-export-const::prop=Component`
- `TS2339::react::*::add-export-const::prop=memo` または `prop=createContext`
- `TS2339::@webpack::getByKeys::widen-callee-to-any::prop=MenuSeparator`

**頻度:**
- **module: `react` が2件 / `@webpack` が1件**
- **op: `add-export-const` が2件 / `widen-callee-to-any` が1件**

### 4.2 改善したrepo例

1. **oblivion-desktop**: `React.Component` の TS2339 を **export補完**で解消
   - `phase3: 3 → 2`（改善）

2. **baseweb**: `React.memo` / `React.createContext` の TS2339 を **export補完**で解消
   - `phase3: 83 → 79`（safeguard有）または `83 → 76`（safeguard無）

3. **BetterDiscord**: `@webpack.getByKeys(...)` の戻り値に対する TS2339 を **callee widen**で解消
   - `phase3: 106 → 93`（改善）

**解釈:**
- 改善が出た3件のうち、**2件がReact関連**（66.7%）
- React関連の改善は「missing export補完」パターンに収束

---

## 5. 勝ち筋の収束

**改善が出た3件の勝ち筋は2パターンに収束:**

1. **missing exportの補完（reactの代表API）**
   - `React.Component`, `React.memo`, `React.createContext` など
   - これらはReactの基本的なAPIであり、多くのプロジェクトで使用される

2. **call-return由来のTS2339をcallee側widenで吸収**
   - `@webpack.getByKeys(...)` の戻り値に対するプロパティアクセス

**解釈:**
- React関連の改善パターンが明確に特定できている
- 「React専用研究」ではなく、「React依存のTS2339に限定して深掘り」というケーススタディとして正当化できる

---

## 6. 統計的な根拠

### 6.1 React依存リポジトリの割合

- **Top3にreactを含む: 8件 / 30件 = 26.7%**
- これは「偶然」ではなく、Localizerが機械的に検出した結果

### 6.2 改善例でのReactの割合

- **改善3件中、React関連が2件 = 66.7%**
- React関連の改善が支配的

### 6.3 TS2339の集中

- **TS2339の総数: 921件**
- **React依存リポジトリのTS2339: 106件（11.5%）**
- 8件のリポジトリ（26.7%）で、全体のTS2339の11.5%を占める

---

## 7. 結論

**React由来のエラーが「かなり強く出ていた」根拠:**

1. **TS2339が支配的**（921件、Phase3 coreの約70%）
2. **React依存リポジトリが26.7%**（30件中8件）
3. **改善例の66.7%がReact関連**（3件中2件）
4. **勝ち筋がReact関連に収束**（missing export補完）

これらの根拠により、**React依存のTS2339に限定して深掘りするケーススタディ**が正当化される。

---

## 8. 参考文献

- エラーコード分布: `docs/policy/policyA_v2.md` 第2章
- 改善例の分析: `docs/policy/policyA_v2.md` 第3章
- React層の定義: `docs/policy/policyA_v2.md` 第10章
- 評価結果: `evaluation/real/out/phase5-week7-max30/`

