#!/usr/bin/env node
/**
 * Extract React cohort from evaluation results.
 * Week8: React層の機械的な定義に基づいてリポジトリを抽出
 *
 * React層の定義:
 * - 必須条件1: Phase3 coreでTS2339を含む
 * - 必須条件2: LocalizerのTop3モジュールに `react` が入る
 * - 推奨条件3: TS2339の対象シンボルが `React.Component` / `React.memo` / `React.createContext` 等
 *
 * Usage:
 *   node evaluation/real/extract-react-cohort.mjs --out-dir evaluation/real/out/<dir> [--output react_cohort.jsonl]
 */
import fs from "node:fs/promises";
import path from "node:path";

function parseArgs(argv) {
  const args = { outDir: "", output: "react_cohort.jsonl", topN: 3, relaxTopN: false, allowNoTS2339: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out-dir") args.outDir = String(argv[++i] ?? "");
    else if (a === "--output") args.output = String(argv[++i] ?? "react_cohort.jsonl");
    else if (a === "--top-n") args.topN = Number(argv[++i] ?? "3");
    else if (a === "--relax-top-n") args.relaxTopN = true;
    else if (a === "--allow-no-ts2339") args.allowNoTS2339 = true;
    else if (a === "-h" || a === "--help") {
      console.log("Usage: node evaluation/real/extract-react-cohort.mjs --out-dir <DIR> [--output <FILE>] [--top-n N] [--allow-no-ts2339]");
      process.exit(0);
    }
  }
  if (!args.outDir) {
    console.error("missing --out-dir");
    process.exit(2);
  }
  return args;
}

function readJsonl(txt) {
  return txt
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => JSON.parse(s));
}

function sumPhase3Core(tsCounts) {
  const PHASE3 = ["TS2339", "TS2345", "TS2322", "TS2554", "TS2769", "TS2353", "TS2741", "TS7053"];
  let n = 0;
  for (const c of PHASE3) n += Number(tsCounts?.[c] ?? 0) || 0;
  return n;
}

function hasTS2339(tsCounts) {
  return Number(tsCounts?.TS2339 ?? 0) > 0;
}

function getTopNModules(localizer, n = 3) {
  if (!localizer) return [];
  // Localizerのデータ構造: {topModuleFreq: [{module: "...", freq: ...}, ...]}
  const topModuleFreq = localizer.topModuleFreq ?? [];
  const topN = topModuleFreq.slice(0, n).map((m) => String(m?.module ?? "").toLowerCase());
  return topN;
}

function hasReactInTop3(top3Modules) {
  return top3Modules.some((m) => m === "react" || m.startsWith("react/") || m.includes("/react"));
}

function extractReactSymbols(trials) {
  // TS2339のrepair trialからReactシンボルを抽出
  const reactSymbols = new Set();
  for (const trial of trials ?? []) {
    const so = trial?.symbol_override;
    if (so?.kind === "repair-from-top1" && so.code === "TS2339" && so.module === "react") {
      const prop = String(so.prop ?? "");
      if (prop) reactSymbols.add(prop);
    }
  }
  return Array.from(reactSymbols);
}

function isReactWinSymbol(prop) {
  const winSymbols = ["Component", "memo", "createContext", "FC", "ReactNode"];
  return winSymbols.some((s) => prop.includes(s) || prop === s);
}

async function main() {
  const args = parseArgs(process.argv);
  const resultsPath = path.join(args.outDir, "results.jsonl");
  const resultsTxt = await fs.readFile(resultsPath, "utf8");
  const results = readJsonl(resultsTxt);

  const cohort = [];
  const stats = {
    total: results.length,
    hasTS2339: 0,
    hasReactInTopN: 0,
    hasReactWinSymbol: 0,
    matched: 0,
  };

  for (const r of results) {
    const baselineCounts = r.baseline?.tsErrorCounts ?? {};
    const phase3Core = sumPhase3Core(baselineCounts);
    const hasTS2339Error = hasTS2339(baselineCounts);

    // 必須条件1: Phase3 coreでTS2339を含む（緩和可能: --allow-no-ts2339）
    // Week8改善: React由来のエラーが多いという結果から、TS2339=0でも含めるオプションを追加
    if (!hasTS2339Error && !args.allowNoTS2339) continue;
    if (hasTS2339Error) stats.hasTS2339++;

    // 必須条件2: LocalizerのTopNモジュールに `react` が入る
    const localizer = r.phase3?.localizer ?? [];
    const topNModules = getTopNModules(localizer, args.topN);
    const hasReact = hasReactInTop3(topNModules);

    if (!hasReact) continue;
    stats.hasReactInTopN++;

    // 推奨条件3: TS2339の対象シンボルがReactの勝ち筋シンボル
    const trials = r.trials ?? [];
    const reactSymbols = extractReactSymbols(trials);
    const hasWinSymbol = reactSymbols.some((s) => isReactWinSymbol(s));

    // 必須条件を満たすリポジトリを追加
    const entry = {
      url: r.url ?? "",
      repo: r.repo ?? "",
      baseline_phase3_total: phase3Core,
      baseline_ts2339: Number(baselineCounts.TS2339 ?? 0),
      topN_modules: topNModules,
      react_symbols: reactSymbols,
      has_win_symbol: hasWinSymbol,
      matched_conditions: {
        has_ts2339: true,
        has_react_in_topN: true,
        has_win_symbol: hasWinSymbol,
      },
    };

    cohort.push(entry);
    stats.matched++;
    if (hasWinSymbol) stats.hasReactWinSymbol++;
  }

  // 出力
  const outputPath = path.join(args.outDir, args.output);
  const lines = cohort.map((e) => JSON.stringify(e));
  await fs.writeFile(outputPath, lines.join("\n") + "\n", "utf8");

  // 統計を出力
  console.log("React cohort extraction:");
  console.log(`  total repos: ${stats.total}`);
  console.log(`  has TS2339: ${stats.hasTS2339}`);
  console.log(`  has react in top${args.topN}: ${stats.hasReactInTopN}`);
  console.log(`  has react win symbol: ${stats.hasReactWinSymbol}`);
  console.log(`  matched (cohort size): ${stats.matched}`);
  console.log(`wrote\t${outputPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

