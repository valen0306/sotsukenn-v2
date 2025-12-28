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

現状のアダプタは `evaluation/model/typebert_infer.py` で、入出力（JSON stdin/stdout）の契約だけ先に固めています。
実際のTypeBERTモデル重みが準備できたら、このスクリプトの backend 実装を差し替える想定です。

```bash
node evaluation/real/phase3-run.mjs \
  --mode model \
  --model-cmd python3 \
  --model-script evaluation/model/typebert_infer.py \
  --model-cache-dir evaluation/real/cache/typebert \
  --repos-file evaluation/real/inputs/phase3_ts1000.txt \
  --out-dir evaluation/real/out/phase3-ts1000-20-model \
  --concurrency 1 \
  --timeout-ms 600000 \
  --model-timeout-ms 120000 \
  --max 20 \
  --verbose
```

成果物:
- `<out-dir>/results.jsonl`
- `<out-dir>/summary.tsv`


