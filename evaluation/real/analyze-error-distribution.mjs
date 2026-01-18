#!/usr/bin/env node
/**
 * Aggregate baseline tsc error-code distribution from results.jsonl.
 *
 * Usage:
 *   node evaluation/real/analyze-error-distribution.mjs --out-dir evaluation/real/out/<dir>
 */
import fs from "node:fs/promises";
import path from "node:path";

const PHASE3 = new Set(["TS2339", "TS2345", "TS2322", "TS2554", "TS2769", "TS2353", "TS2741", "TS7053"]);

function parseArgs(argv) {
  const args = { outDir: "", top: 30 };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out-dir") args.outDir = String(argv[++i] ?? "");
    else if (a === "--top") args.top = Number(argv[++i] ?? "30");
    else if (a === "-h" || a === "--help") {
      console.log(`Usage: node evaluation/real/analyze-error-distribution.mjs --out-dir <DIR> [--top N]`);
      process.exit(0);
    }
  }
  if (!args.outDir) {
    console.error("missing --out-dir");
    process.exit(2);
  }
  if (!Number.isFinite(args.top) || args.top < 1) args.top = 30;
  return args;
}

function readJsonl(txt) {
  return txt
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => JSON.parse(s));
}

function addCounts(dst, src) {
  for (const [k, v] of Object.entries(src ?? {})) {
    dst.set(k, (dst.get(k) ?? 0) + (Number(v) || 0));
  }
}

function sorted(map) {
  return [...map.entries()].sort((a, b) => (b[1] - a[1]) || String(a[0]).localeCompare(String(b[0])));
}

async function main() {
  const args = parseArgs(process.argv);
  const outDir = path.resolve(args.outDir);
  const p = path.join(outDir, "results.jsonl");
  const raw = await fs.readFile(p, "utf8");
  const rows = readJsonl(raw);

  const all = new Map();
  const phase3 = new Map();
  let repos = 0;
  let reposWithBaseline = 0;
  let reposWithPhase3 = 0;

  for (const r of rows) {
    repos++;
    const counts = r?.baseline?.tsErrorCounts;
    if (!counts) continue;
    reposWithBaseline++;
    addCounts(all, counts);
    let hasP3 = false;
    for (const [k, v] of Object.entries(counts)) {
      if (!PHASE3.has(k)) continue;
      phase3.set(k, (phase3.get(k) ?? 0) + (Number(v) || 0));
      if ((Number(v) || 0) > 0) hasP3 = true;
    }
    if (hasP3) reposWithPhase3++;
  }

  console.log(["out_dir", outDir].join("\t"));
  console.log(["repos", repos].join("\t"));
  console.log(["repos_with_baseline_counts", reposWithBaseline].join("\t"));
  console.log(["repos_with_phase3_core", reposWithPhase3].join("\t"));
  console.log("");

  console.log(`top_baseline_error_codes (top ${args.top})`);
  for (const [k, c] of sorted(all).slice(0, args.top)) console.log([k, c].join("\t"));
  console.log("");

  console.log("phase3_core_totals");
  for (const [k, c] of sorted(phase3)) console.log([k, c].join("\t"));
}

main().catch((e) => {
  console.error(String(e?.stack || e));
  process.exit(1);
});


