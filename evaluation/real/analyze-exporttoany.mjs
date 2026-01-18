#!/usr/bin/env node
/**
 * Analyze export-to-any trials inside results.jsonl produced by phase3-run.mjs.
 *
 * Usage:
 *   node evaluation/real/analyze-exporttoany.mjs --out-dir evaluation/real/out/<dir>
 */
import fs from "node:fs/promises";
import path from "node:path";

function parseArgs(argv) {
  const args = { outDir: "" };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out-dir") args.outDir = String(argv[++i] ?? "");
    else if (a === "-h" || a === "--help") {
      console.log(`Usage: node evaluation/real/analyze-exporttoany.mjs --out-dir <DIR>`);
      process.exit(0);
    }
  }
  if (!args.outDir) {
    console.error("missing --out-dir");
    process.exit(2);
  }
  return args;
}

function sumCounts(counts) {
  let n = 0;
  for (const v of Object.values(counts ?? {})) n += Number(v) || 0;
  return n;
}

function readJsonlLines(txt) {
  return txt
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => JSON.parse(s));
}

function keyForSym(sym) {
  const mod = sym?.module ?? "";
  const name = sym?.name ?? "";
  const target = sym?.target ?? "";
  return `${mod}::${name}::${target}`;
}

function topN(map, n = 20) {
  return [...map.entries()].sort((a, b) => (b[1] - a[1]) || String(a[0]).localeCompare(String(b[0]))).slice(0, n);
}

async function main() {
  const args = parseArgs(process.argv);
  const outDir = path.resolve(args.outDir);
  const p = path.join(outDir, "results.jsonl");
  const raw = await fs.readFile(p, "utf8");
  const rows = readJsonlLines(raw);

  let repos = 0;
  let reposWithAnyExportToAny = 0;
  let exportToAnyTrials = 0;
  let exportToAnyValid = 0;
  let winsVsTop1 = 0;
  let tiesVsTop1 = 0;
  let lossesVsTop1 = 0;

  const byKeySeen = new Map(); // key -> count
  const byKeyWin = new Map();
  const byKeyLoss = new Map();
  const byKeyAvgDelta = new Map(); // key -> {sum, n}

  for (const r of rows) {
    repos++;
    const trials = r?.trials ?? [];
    const top1 = trials.find((t) => t?.candidate_id === "c0_top1");
    if (!top1) continue;
    const top1Phase3 = Number(top1.injected_phase3 ?? NaN);
    const top1Total = sumCounts(top1?.delta_errors ? Object.fromEntries(Object.entries(top1.delta_errors).map(([k, v]) => [k, (Number(r?.baseline?.tsErrorCounts?.[k] ?? 0) || 0) + (Number(v) || 0)])) : null);

    let hasAny = false;
    for (const t of trials) {
      const sym = t?.symbol_override;
      if (!sym || sym.kind !== "export-to-any") continue;
      hasAny = true;
      exportToAnyTrials++;
      if (!t.valid_injection) continue;
      exportToAnyValid++;
      const key = keyForSym(sym);
      byKeySeen.set(key, (byKeySeen.get(key) ?? 0) + 1);
      const d = Number(t.delta_phase3 ?? 0) || 0;
      const agg = byKeyAvgDelta.get(key) ?? { sum: 0, n: 0 };
      agg.sum += d;
      agg.n += 1;
      byKeyAvgDelta.set(key, agg);

      const tp = Number(t.injected_phase3 ?? NaN);
      if (!Number.isFinite(tp) || !Number.isFinite(top1Phase3)) continue;
      if (tp < top1Phase3) {
        winsVsTop1++;
        byKeyWin.set(key, (byKeyWin.get(key) ?? 0) + 1);
      } else if (tp === top1Phase3) {
        tiesVsTop1++;
      } else {
        lossesVsTop1++;
        byKeyLoss.set(key, (byKeyLoss.get(key) ?? 0) + 1);
      }
    }
    if (hasAny) reposWithAnyExportToAny++;
  }

  console.log(["out_dir", outDir].join("\t"));
  console.log(["repos", repos].join("\t"));
  console.log(["repos_with_exporttoany", reposWithAnyExportToAny].join("\t"));
  console.log(["exporttoany_trials", exportToAnyTrials].join("\t"));
  console.log(["exporttoany_valid_trials", exportToAnyValid].join("\t"));
  console.log(["wins_vs_top1", winsVsTop1].join("\t"));
  console.log(["ties_vs_top1", tiesVsTop1].join("\t"));
  console.log(["losses_vs_top1", lossesVsTop1].join("\t"));

  const avgDeltaList = [...byKeyAvgDelta.entries()].map(([k, v]) => [k, v.n ? v.sum / v.n : 0, v.n]);
  avgDeltaList.sort((a, b) => (a[1] - b[1]) || (b[2] - a[2]) || String(a[0]).localeCompare(String(b[0])));
  console.log("\nmost_helpful_by_avg_delta_phase3 (top 15)");
  for (const [k, avg, n] of avgDeltaList.slice(0, 15)) {
    console.log([k, `avg_delta_phase3=${avg.toFixed(3)}`, `n=${n}`, `wins=${byKeyWin.get(k) ?? 0}`, `losses=${byKeyLoss.get(k) ?? 0}`].join("\t"));
  }
  console.log("\nmost_harmful_by_avg_delta_phase3 (top 15)");
  for (const [k, avg, n] of avgDeltaList.slice(-15).reverse()) {
    console.log([k, `avg_delta_phase3=${avg.toFixed(3)}`, `n=${n}`, `wins=${byKeyWin.get(k) ?? 0}`, `losses=${byKeyLoss.get(k) ?? 0}`].join("\t"));
  }
  console.log("\nmost_common_keys (top 15)");
  for (const [k, c] of topN(byKeySeen, 15)) console.log([k, c].join("\t"));
}

main().catch((e) => {
  console.error(String(e?.stack || e));
  process.exit(1);
});


