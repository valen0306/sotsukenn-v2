# 卒論ドラフト（生成）

## 生成物
- `thesis.md`: 卒論ドラフト本文（Markdown）
- `thesis.pdf`: `thesis.md` から生成したPDF（Macの `textutil` + `cupsfilter` を使用）

## PDF生成（Mac）

```bash
cd /Users/takeuchitaichi/Desktop/sotsukenn-v2
bash thesis/build_pdf.sh
open thesis/thesis.pdf
```

## メモ
- `cupsfilter` は macOS 標準の印刷系コマンドで、text/plain → PDF 変換に利用しています。
- 現状は「ドラフトPDF」を優先し、Markdownの装飾（見出しなど）はレンダリングしていません。


