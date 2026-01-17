## Plan A: Compiler-feedback Learning Roadmap（方針メモ / 実行可能な形に落とす）

このPDF（`docs/policy/planA_roadmap_seminar.pdf`）の内容を、実装・実験にそのまま反映できる形にしたメモ。
（PDFは編集しづらいので、研究を進める際の“単一の参照点”としてここを更新していく）

### ゴール
- **下流プロジェクトの `tsc --noEmit` を改善**する（成功率/エラー数/Phase別集計）
- その際に「`any`で通しただけ」ではないことを、**トリビアル率**・**エラー内訳**・**Ablation**で示す

### 研究コンポーネント（PDFの M1/M2/M3 と対応）

#### M1. Base Type Generator（Base）
- **現状の対応箇所**:
  - `evaluation/real/phase3-run.mjs` の `--mode model`
  - Pythonアダプタ: `evaluation/model/typebert_infer.py`
- **役割**:
  - 外部モジュールの `.d.ts` を生成（複数 `declare module '...' { ... }`）
  - 生成が壊れる場合は **安全にDTS_STUBへフォールバック**（研究パイプラインを止めない）

#### M2. Error Localizer（Localizer / Top-M）
- **狙い**: 注入対象（外部モジュール）を絞って回帰を減らし、valid母数を増やす
- **現状の対応箇所**:
  - Phase3のdiagnosticが出たファイルから import を集めて stub 対象にする（既存ロジック）
  - **追加した機能**: `--localizer-top-modules <N>`
    - Phase3 diagnosticファイルでの出現頻度で外部モジュールをランキングし、Top-Nのみをstub対象にする
    - `results.jsonl` に `phase3.localizer.*` としてメタ情報を保存（後で分析・学習に使える）

#### M3. Error-aware Reranker（Reranker / Top-k）
- **狙い**: 生成候補（複数の `.d.ts`）がある場合に、`tsc`の改善が大きい候補を選ぶ
- **現状**:
  - まだ本格実装は無し（ただし `evaluation/real/compare-phase3-outs.mjs` 等で条件比較は可能）
- **次にやる（v0案）**:
  - まずは **“候補A vs 候補B” のpairwiseデータ**を作る（ラベル = Phase3 core差分）
  - v0: LightGBM等の学習器 / v1: Transformer(+LoRA) のどちらに進むかは、データ量と再現性で決める

### 実験設計（Ablationの最低限）
- **B0**: Base（現状の `phase3-run.mjs` の stub）
- **B1**: Base + `external-filter=deps`（外部判定の精度を上げる）
- **P1**: Base + Localizer（`--localizer-top-modules N`）
- **P2/P3**: Base + Reranker / Localizer + Reranker（次フェーズ）

### 直近の実行ToDo（このリポジトリで進める順番）
1. `--localizer-top-modules` の N を振って ranked30 で比較（例: N=5,10,20,∞）
2. `TS2339/TS2554` の回帰が強いrepoをケーススタディ化（`report-ranked30-compare.md` の候補から）
3. Localizer/Reranker 用のJSONLエクスポート（features + ラベル）を追加


