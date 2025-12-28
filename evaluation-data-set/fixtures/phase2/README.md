# Phase 2 fixtures

Phase 2（モジュール境界: export/import形の不一致）を単体エラーで再現する最小プロジェクト群です。

例:
- TS2613: default export が無いのに default import する（tsc 5.8 では TS2613 になりやすい）
- TS2305/TS2614: exported member が無いのに named import する
