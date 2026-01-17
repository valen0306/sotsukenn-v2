#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

IN_MD="thesis/thesis.md"
OUT_PDF="thesis/thesis.pdf"

if ! command -v textutil >/dev/null 2>&1; then
  echo "error: textutil not found (macOS standard tool)." >&2
  exit 1
fi
if ! command -v cupsfilter >/dev/null 2>&1; then
  echo "error: cupsfilter not found (macOS standard tool)." >&2
  exit 1
fi

echo "[1/1] markdown(text/plain) -> pdf"
# NOTE: This uses the system text->pdf filter, so markdown formatting is not rendered.
# It is sufficient for a draft PDF. If you want a fully typeset PDF later, use LaTeX/Pandoc.
cupsfilter -m application/pdf "$IN_MD" > "$OUT_PDF"

echo "wrote $OUT_PDF"


