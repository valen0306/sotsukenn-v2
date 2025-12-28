# Phase 1 fixtures

Phase 1（型“解決”）の評価用に、特定の `tsc` エラーコード **単体**を再現する最小プロジェクト群です。

## 目的
- **TS2307**（Cannot find module ...）や **TS7016**（Could not find a declaration file for module ...）を
  “狙って”再現し、注入した `.d.ts` で解消できるかを検証するための足場にします。

## 実行方法

- `TS2307/`:

```bash
cd evaluation-data-set/fixtures/phase1/TS2307
npm install
npm run typecheck
```

- `TS7016/`:

```bash
cd evaluation-data-set/fixtures/phase1/TS7016/downstream
npm install
npm run typecheck
```


