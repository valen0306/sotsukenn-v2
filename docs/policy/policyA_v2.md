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

### 6. 次の3週間ロードマップ（短期で成果を出す順）

- **Week 1**: oracle分析 / エラーコード分布 / Δを動かした宣言抽出（設計の根拠固め）
- **Week 2**: Repair Operator v3実装（TS2345・TS2339・overloadを優先）
- **Week 3**: セーフガード導入＋統合評価（A3 + Gen v3）  
  → 目標：`win_rate_vs_top1` を動かす ＆ `worse` を下げる/同等 ＆ `avg_tsc_calls` 維持

---

### 7. M4 32GB 前提の方針

- 重いのは学習ではなく `tsc` 回数  
  ⇒ 「候補を大量生成」ではなく **「当たる少数候補を生成」**に寄せる
- Rerankerは当面 軽量MLで十分。候補集合が強くなった後にモデル強化を検討


