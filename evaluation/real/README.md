# evaluation/real

実プロジェクト（GitHubから収集したrepo）に対して、Phaseごとの評価（baseline→inject→`tsc`差分）を回すための評価コードです。

## 入力（例: ts1000から抽出したS_lib）

`tsc-error-data-set/runs/ts1000/scan-results.jsonl` から、
- `libraryCallLike.hasAny=true`
- かつ `tsErrorCounts` が非空（= `codeCount>0`）

のURL一覧を作って、それを評価対象にします。

```bash
node evaluation/real/make-slib-list.mjs \
  --run-dir tsc-error-data-set/runs/ts1000 \
  --out evaluation/real/inputs/s_lib_ts1000.txt
```

先頭20件だけを作る例:

```bash
node evaluation/real/make-slib-list.mjs \
  --run-dir tsc-error-data-set/runs/ts1000 \
  --out evaluation/real/inputs/s_lib_ts1000_20.txt \
  --max 20
```

## 入力（Phase2向け: Phase2コードを含むS_lib）

S_libのうち、さらに **Phase2対象コード（TS2305/TS2613/TS2614）のいずれかを含む** repo だけを抽出します。

```bash
node evaluation/real/make-phase2-list.mjs \
  --run-dir tsc-error-data-set/runs/ts1000 \
  --out evaluation/real/inputs/phase2_ts1000.txt
```

## 入力（Phase3向け: Phase3コードを含むS_lib）

S_libのうち、さらに **Phase3対象コード（API整合系）のいずれかを含む** repo だけを抽出します。

対象コード（Phase3 core）:
- `TS2339, TS2345, TS2322, TS2554, TS2769, TS2353, TS2741, TS7053`

```bash
node evaluation/real/make-phase3-list.mjs \
  --run-dir tsc-error-data-set/runs/ts1000 \
  --out evaluation/real/inputs/phase3_ts1000.txt
```

### Phase3（"できるだけPhase3単独"）向けリスト

Phase3の効果を見たい場合、Phase1/2（TS2307/7016/2305/2613/2614）や設定ノイズ（TS17004/6142）が混ざると
評価が歪みやすいので、それらを除外したリストも用意できます。

```bash
node evaluation/real/make-phase3-pure-list.mjs \
  --run-dir tsc-error-data-set/runs/ts1000 \
  --out evaluation/real/inputs/phase3_ts1000_pure.txt \
  --max 100
```

（より多く集めたい場合は `--max` を外す / 増やす）

### Phase3（100件向け: “Phase3っぽさ”でランキングして選ぶ）

ts1000では「Phase1/2を完全除外」だと母数が少ないため、100件に拡大する場合は
**Phase3 core を含む候補を“Phase1/2ノイズが少ない順”にランキングして上位N件を取る**のが現実的です。

```bash
node evaluation/real/make-phase3-ranked-list.mjs \
  --run-dir tsc-error-data-set/runs/ts1000 \
  --out evaluation/real/inputs/phase3_ts1000_ranked100.txt \
  --max 100
```

## Phase 1（TS2307/TS7016）: 実プロジェクト評価

Phase1は「型“解決”」なので、baselineのログから `TS2307/TS7016` の対象モジュールspecifierを抽出し、
`declare module "..."` のスタブを一時的に注入して `tsc` を再実行します。

注記:
- `TS2307` は相対パス等でも発生するため、Phase1の注入対象は **外部パッケージっぽいspecifierのみ**（非相対）に限定します。
- 注入は `.evaluation-types/phase1/@types/__phase1_stub__/index.d.ts` を生成し、`tsconfig.__phase1__.json`（extends元tsconfig）を作ってそこから読み込ませます。
  - `compilerOptions.typeRoots` に stub と `node_modules/@types` を含める
  - もし `compilerOptions.types` が設定されている場合は、`__phase1_stub__` を追加して取りこぼしを防ぎます

```bash
node evaluation/real/phase1-run.mjs \
  --repos-file evaluation/real/inputs/s_lib_ts1000_20.txt \
  --out-dir evaluation/real/out/phase1-ts1000-20 \
  --concurrency 1 \
  --timeout-ms 600000
```

成果物:
- `<out-dir>/results.jsonl`（1repo=1行）
- `<out-dir>/summary.tsv`

## Phase 2（TS2305/TS2613/TS2614）: 実プロジェクト評価

Phase2は import/export 形の不一致を **決定的なソース変換**で揃え、`tsc` を再実行して
`TS2305/TS2613/TS2614` がどれだけ減るかを測ります。

変換ルール（real runner）:
- **TS2613**（no default export）: `import X from "m"` → `import * as X from "m"`
- **TS2305/TS2614**（no exported member 'x'）:
  - named import から `x` を除去
  - 代わりに `import * as __phase2_mod_<hash> from "m"; const local = (__phase2_mod_<hash> as any).x;` を注入

デフォルトでは外部パッケージっぽいspecifier（非相対/非alias）だけを対象にします。
alias/相対も含めたい場合は `--include-non-external` を指定してください。

```bash
node evaluation/real/phase2-run.mjs \
  --repos-file evaluation/real/inputs/s_lib_ts1000_20.txt \
  --out-dir evaluation/real/out/phase2-ts1000-20 \
  --concurrency 1 \
  --timeout-ms 600000 \
  --verbose
```

成果物:
- `<out-dir>/results.jsonl`（1repo=1行）
- `<out-dir>/summary.tsv`

## Phase 3（API整合; DTS_STUB baseline）: 実プロジェクト評価

Phase3は API整合（型推論の質）なので、まず下限ベースラインとして **DTS_STUB** を回します。
これは「Phase3エラーが出たファイルの外部importを集め、importされている名前を `any` に落とす `.d.ts` を生成して注入」する方式です。

対象コード（Phase3 core）:
- `TS2339, TS2345, TS2322, TS2554, TS2769, TS2353, TS2741, TS7053`

```bash
node evaluation/real/phase3-run.mjs \
  --repos-file evaluation/real/inputs/phase3_ts1000.txt \
  --out-dir evaluation/real/out/phase3-ts1000-20 \
  --concurrency 1 \
  --timeout-ms 600000 \
  --max 20 \
  --verbose
```

### Phase3（DTS_MODEL; TypeBERT adapter）

`--mode model` を指定すると、Node側で抽出した「(module specifier → importされた名前)」を
Pythonのアダプタに渡し、返ってきた `.d.ts` を注入します。

アダプタは `evaluation/model/typebert_infer.py` です。
`--model <checkpoint>` を指定すると、ローカルのHuggingFace/Transformers互換checkpointを読み込み、
1repoにつき1回の推論で `.d.ts`（複数 `declare module '...' { ... }` を含む）を生成します。

注記:
- 依存（`torch`/`transformers`）が無い、または `--model`（もしくは環境変数 `TYPEBERT_MODEL`）が未設定の場合、
  **安全にDTS_STUB（any型）へフォールバック**し、パイプラインは止めません（`ok=true`で返します）。

```bash
node evaluation/real/phase3-run.mjs \
  --mode model \
  --model-cmd python3 \
  --model-script evaluation/model/typebert_infer.py \
  --model-cache-dir evaluation/real/cache/typebert \
  --model-backend typebert \
  --model /path/to/local/checkpoint \
  --model-device auto \
  --model-max-new-tokens 800 \
  --model-temperature 0.0 \
  --model-seed 0 \
  --repos-file evaluation/real/inputs/phase3_ts1000.txt \
  --out-dir evaluation/real/out/phase3-ts1000-20-model \
  --concurrency 1 \
  --timeout-ms 600000 \
  --model-timeout-ms 120000 \
  --max 20 \
  --verbose
```

環境変数でも指定できます（CLIが優先）:
- `TYPEBERT_MODEL`: `--model` 相当
- `TYPEBERT_BACKEND`: `--model-backend` 相当（通常は `typebert`）
- `TYPEBERT_DEVICE`, `TYPEBERT_MAX_NEW_TOKENS`, `TYPEBERT_TEMPERATURE`, `TYPEBERT_SEED`

成果物:
- `<out-dir>/results.jsonl`
- `<out-dir>/summary.tsv`

### 途中再開（resume）

長時間の実行（例: 100件）で中断した場合、`--resume` を付けて再実行すると、
既存の `<out-dir>/results.jsonl` を読み込み、**処理済みURLをスキップして続きから実行**できます。
（`results.jsonl` は追記モードで増えていきます）

```bash
node evaluation/real/phase3-run.mjs \
  --resume \
  --mode model \
  --repos-file <FILE> \
  --out-dir <out-dir> \
  --concurrency 1 \
  --timeout-ms 600000 \
  --verbose
```

### Phase3結果の集計（invalid/timeout除外の統計）

Phase3は生成`.d.ts`が壊れると `TS1005/TS1109` 等で `tsc` が先に落ち、偽陽性の改善に見えることがあります。
このリポジトリでは `phase3-run.mjs` が `phase3InjectedDtsInvalid` を記録し、集計スクリプトでも除外します。

```bash
node evaluation/real/analyze-phase3-results.mjs \
  --out-dir <out-dir> \
  --top 10
```


