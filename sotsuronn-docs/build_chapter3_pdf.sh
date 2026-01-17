#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

IN="sotsuronn-docs/chapter3_proposal.md"
OUT="sotsuronn-docs/chapter3_proposal.pdf"

if ! command -v cupsfilter >/dev/null 2>&1; then
  echo "error: cupsfilter not found." >&2
  exit 1
fi

echo "[1/1] text -> pdf"
cupsfilter -m application/pdf "$IN" > "$OUT"
echo "wrote $OUT"


