# tsc-error-data-set

大量のOSSリポジトリを対象に `tsc` を実行し、`TSxxxx` エラーコードの出現を記録するためのデータセット格納先です。

## ディレクトリ構成

- `sources/`
  - `repos.txt`: 1行1URL のリポジトリ一覧（`#` から始まる行はコメント）
- `runs/<timestamp>/`
  - `results.jsonl`: 1リポジトリ=1行のスキャン結果（JSON Lines）
  - `aggregate.tsv`: エラーコード別の repo 出現数/出現回数（TSコードの分布）
  - `meta.json`: 実行時のオプションや対象件数など
- `work/`（git管理外 / `.gitignore`）
  - クローン作業領域（巨大になるのでコミットしません）

## 実行

`sources/repos.txt` を用意してから、以下を実行します。

```bash
node scripts/collect-tsc-error-dataset.mjs \
  --repos-file tsc-error-data-set/sources/repos.txt \
  --out-dir tsc-error-data-set/runs \
  --concurrency 2 \
  --timeout-ms 600000 \
  --install
```

## GitHubからの選定（方針案）

「本評価で追いたいエラーコードが実プロジェクトに出るか」を確認する用途なら、まずは以下のように **広めに集めて回し、あとでフィルタ**が現実的です（`tsconfig` が無い repo はスキャン側が基本スキップします）。

- TypeScript中心:
  - `language:TypeScript archived:false fork:false stars:>=50`
- JavaScript中心（TS導入途中も拾う）:
  - `language:JavaScript archived:false fork:false stars:>=50`

GitHub Search API から `repos.txt` を生成するスクリプト:

```bash
export GITHUB_TOKEN=xxxxxxxx
node scripts/select-github-repos.mjs \
  --query "language:TypeScript stars:>=50 archived:false fork:false" \
  --max 200 \
  --out tsc-error-data-set/sources/repos.txt
```


