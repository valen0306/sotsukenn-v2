# evaluation/model

Phase3 の **DTS_MODEL** 用（TypeBERTアダプタ）です。

このプロジェクトでは、Node runner（`evaluation/real/phase3-run.mjs`）が repo から
`(module specifier → importされた名前)` を抽出し、Pythonアダプタ（`typebert_infer.py`）に渡して
**1本の `.d.ts`** を生成・注入します。

## 1) 実行環境の整備（ローカル）

### Python仮想環境

```bash
cd /Users/takeuchitaichi/Desktop/sotsukenn-v2
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -U pip
```

### 依存のインストール

`torch` は **CPU/CUDA/MPS** で入れ方が変わるので、まず公式手順でインストールしてください。
その後、本リポジトリの要件を入れます:

```bash
pip install -r evaluation/model/requirements.txt
```

## 2) モデル（checkpoint）の用意

このアダプタは `--model` に **ローカルのHuggingFace互換checkpointディレクトリ**を指定する想定です。

### 推奨（小さめのコード生成モデル）

Phase3は「`.d.ts`を生成して注入」なので、BERT(encoder-only)よりも **コード生成モデル（CausalLM）**が相性が良いです。
Mac（MPS）で動かしやすい“比較的小さめ”候補:
- `Qwen/Qwen2.5-Coder-1.5B-Instruct`（まずはこれを推奨）
- `bigcode/starcoder2-3b`
- `deepseek-ai/deepseek-coder-1.3b-instruct`

※ モデルのダウンロードは各自の環境で行い、ローカルパスを `--model` に渡してください（評価時の再現性も上がります）。

### Phase3の回帰対策（force-any）

Phase3のDTS_MODELは「型が厳密になることで、別のエラー（特に `TS2339`）が顕在化して増える」ことがあります。
実験の安定性を優先する場合、頻出の“回帰原因モジュール”を **強制的に stub(any)** に落とす運用が有効です。

推奨の初期 denylist（CSV）例:

```bash
export TYPEBERT_FORCE_ANY_MODULES="lodash,zod,zustand,globby,@neondatabase/serverless"
```

または CLI で渡す:

```bash
python evaluation/model/typebert_infer.py \
  --backend typebert \
  --model "$TYPEBERT_MODEL" \
  --force-any-modules "lodash,zod,zustand,globby,@neondatabase/serverless"
```

## 2.5) HuggingFaceのIDからモデルを落とす（推奨）

### 事前準備（トークン）

一部モデルは規約同意やトークンが必要です。HuggingFaceのアクセストークンを用意して:

```bash
export HF_TOKEN="hf_...your_token..."
```

### ダウンロード先（キャッシュ）を固定したい場合

大量の容量を使うので、保存先を明示するのがおすすめです:

```bash
export HF_HOME="/path/to/hf-cache"
```

### ダウンロード（huggingface-cli）

モデルID（例: `Qwen/Qwen2.5-Coder-1.5B-Instruct`）を指定して、ローカルに落とします:

```bash
source .venv/bin/activate
pip install -r evaluation/model/requirements.txt

# Login (pick ONE)
huggingface-cli login --token "$HF_TOKEN"
# or:
hf auth login --token "$HF_TOKEN"

MODEL_ID="Qwen/Qwen2.5-Coder-1.5B-Instruct"
LOCAL_DIR="$HF_HOME/qwen2_5_coder_1_5b_instruct"

# Download (pick ONE)
huggingface-cli download "$MODEL_ID" \
  --local-dir "$LOCAL_DIR" \
  --local-dir-use-symlinks False
# or:
hf download "$MODEL_ID" --local-dir "$LOCAL_DIR"
```

ダウンロード後は、この `LOCAL_DIR` を `--model`（または `TYPEBERT_MODEL`）に渡します。
（※ `LOCAL_DIR` の作り方は簡易的です。運用としては `--local-dir` に任意の固定ディレクトリを指定してOKです。）

例:

```bash
export TYPEBERT_MODEL="/path/to/local/checkpoint"
```

または Phase3 runner 実行時に `--model` で渡します（CLIが優先）。

## 3) アダプタ単体の動作確認（フォールバックしてないか）

以下で `backend` が `"hf_causal_lm"`（または互換の `"typebert"`）になれば、モデル推論が走っています。
`"stub"` になった場合は、依存不足 or `--model` 未設定などでフォールバックしています。

```bash
echo '{"repo":{"url":"x","slug":"y"},"modules":{"lodash":{"defaultImport":false,"named":["map"],"typeNamed":["LoDashStatic"]}}}' \
  | python evaluation/model/typebert_infer.py \
    --backend hf_causal_lm \
    --model "$TYPEBERT_MODEL" \
    --device mps \
    --torch-dtype float16 \
    --cache-dir evaluation/real/cache/typebert
```

## 4) Phase3 runner で実行（DTS_MODEL）

```bash
node evaluation/real/phase3-run.mjs \
  --mode model \
  --model-backend hf_causal_lm \
  --model "$TYPEBERT_MODEL" \
  --repos-file evaluation/real/inputs/phase3_ts1000.txt \
  --out-dir evaluation/real/out/phase3-ts1000-20-model \
  --max 20 --concurrency 1 --timeout-ms 600000 --model-timeout-ms 120000 --verbose
```

## 注意（重要）

- `typebert_infer.py` の `hf_causal_lm` backend は **TransformersのCausalLM生成**で実装しています。
  以前の実験用に `typebert` という backend 名も残していますが、**中身は同じ（alias）**です。
  もし encoder-only 等の “生成モデルではない” 方式を試す場合でも、**stdin/outのJSON契約を維持**すれば差し替え可能です。

