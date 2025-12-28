# scripts

## 大量リポジトリで `tsc` エラーコード（TSxxxx）を確認する

このリポジトリの研究方針（`tsc` エラーコードベースの分析）に向けて、ローカルにある多数のプロジェクトから `TSxxxx` を抽出・集計するためのスクリプトです。

## 0) まだローカルにリポジトリが無い場合（URLから収集）

`tsc-error-data-set/` に結果を保存しながら、URLリストから clone → install → typecheck → 抽出 → 集計を行います。

1. `tsc-error-data-set/sources/repos.txt` に 1行1URL で列挙
2. 実行:

```bash
node scripts/collect-tsc-error-dataset.mjs \
  --repos-file tsc-error-data-set/sources/repos.txt \
  --out-dir tsc-error-data-set/runs \
  --run-name ts200 \
  --resume \
  --concurrency 2 \
  --timeout-ms 600000 \
  --install \
  --verbose
```

出力:
- `tsc-error-data-set/runs/<timestamp>/results.jsonl`
- `tsc-error-data-set/runs/<timestamp>/scan-results.jsonl`（集計用にフラット化）
- `tsc-error-data-set/runs/<timestamp>/aggregate.tsv`

補足:
- `scan-results.jsonl` には、`tsc`出力から抽出した **エラー位置（diagnostics）** と、
  そのエラーが出たファイルが **外部パッケージをimport/requireしているか**（`errorFilesExternalImports`）も記録します。
  これにより「ライブラリ呼び出し由来っぽい」エラー（`libraryCallLike`）をフィルタできます。

### GitHubから `repos.txt` を自動生成（Search API）

事前に GitHub Token を環境変数に入れます:

```bash
export GITHUB_TOKEN=xxxxxxxx
```

例: TypeScriptプロジェクトを stars>=50 で収集（最大200件）:

```bash
node scripts/select-github-repos.mjs \
  --query "language:TypeScript stars:>=50 archived:false fork:false" \
  --max 200 \
  --out tsc-error-data-set/sources/repos.txt \
  --verbose
```

#### 1000件に増やす場合

GitHub Search API は **1クエリ最大1000件**まで取得できます（ページング上限）。同じクエリで `--max 1000` にします。

```bash
node scripts/select-github-repos.mjs \
  --query "language:TypeScript stars:>=50 archived:false fork:false" \
  --max 1000 \
  --out tsc-error-data-set/sources/repos-1000.txt \
  --verbose
```

### 1) 走査（JSONL出力）

前提: Node.js が入っていること。

ローカルにクローン済みのリポジトリが置かれているディレクトリを指定します（配下を再帰探索し、`package.json` があるディレクトリを「repo」とみなします）。

```bash
node scripts/scan-tsc-errors.mjs \
  --root /path/to/repos \
  --out /path/to/results.jsonl \
  --concurrency 2 \
  --timeout-ms 600000 \
  --verbose
```

#### インストールも自動で行う場合

（注意）依存インストールは時間がかかり、ネットワークが必要です。

```bash
node scripts/scan-tsc-errors.mjs \
  --root /path/to/repos \
  --install \
  --out /path/to/results.jsonl
```

#### 走査対象のリストファイルを使う場合

改行区切りのパス一覧（`#` 始まりはコメント）を用意して指定できます。

```bash
node scripts/scan-tsc-errors.mjs \
  --roots-file /path/to/repos.txt \
  --out /path/to/results.jsonl
```

### 2) 集計（標準出力にTSコード表）

```bash
node scripts/aggregate-tsc-errors.mjs --in /path/to/results.jsonl --top 50
```

### 3) 「各TSコードが出たrepo一覧（URL付き）」をCSVに出力

`collect-tsc-error-dataset.mjs` の `results.jsonl`（URL入り）から、long形式CSVを出します。

```bash
node scripts/export-code-repos-csv.mjs --run-dir tsc-error-data-set/runs/ts200
```

特定コードだけ:

```bash
node scripts/export-code-repos-csv.mjs --run-dir tsc-error-data-set/runs/ts200 --code TS2339
```

### 4) 「このrepoでこのTSコードが出た（コード一覧）」をCSVに出力

repo単位で、出たTSコードの一覧を1行にまとめたCSVを出します。

```bash
node scripts/export-repo-errors-csv.mjs --run-dir tsc-error-data-set/runs/ts200
```

### 5) run全体のサマリ（件数・割合・上位コード）を表示

```bash
node scripts/summarize-tsc-run.mjs --run-dir tsc-error-data-set/runs/ts200
```


