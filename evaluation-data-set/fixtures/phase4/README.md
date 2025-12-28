# Phase 4 fixtures

Phase 4（strictness-sensitive / 運用制約）を単体エラーで再現する最小プロジェクト群です。

注記:
- 実プロジェクトの集計で見えていた `TS1804` は、実際には `TS18046`（`unknown` へのアクセス）など **5桁TSコード**が
  `TS\d{4}` の抽出で短縮されて見えている可能性があります。fixturesでは明示的に **TS18046** を扱います。
