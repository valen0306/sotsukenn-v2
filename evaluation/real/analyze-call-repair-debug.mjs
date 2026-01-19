#!/usr/bin/env node
/**
 * Summarize call-repair debug samples produced by phase3-run.mjs (--repair-debug-call).
 *
 * Usage:
 *   node evaluation/real/analyze-call-repair-debug.mjs --out-dir <DIR>
 */
import { promises as fs } from "node:fs";
import path from "node:path";

function parseArgs(argv) {
  const args = { outDir: null, top: 20 };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out-dir") args.outDir = argv[++i];
    else if (a === "--top") args.top = Number(argv[++i] ?? "20");
    else if (a === "--help" || a === "-h") {
      console.log("Usage: node evaluation/real/analyze-call-repair-debug.mjs --out-dir <DIR> [--top N]");
      process.exit(0);
    } else {
      console.error(`Unknown arg: ${a}`);
      process.exit(1);
    }
  }
  if (!args.outDir) {
    console.error("Provide --out-dir <DIR>");
    process.exit(1);
  }
  if (!Number.isFinite(args.top) || args.top < 1) args.top = 20;
  return args;
}

function bump(map, k, d = 1) {
  map.set(k, (map.get(k) ?? 0) + d);
}

function sorted(map) {
  return [...map.entries()].sort((a, b) => (b[1] - a[1]) || String(a[0]).localeCompare(String(b[0])));
}

function readJsonl(txt) {
  return txt
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => JSON.parse(s));
}

async function main() {
  const args = parseArgs(process.argv);
  const outDir = path.resolve(args.outDir);
  const resultsPath = path.join(outDir, "results.jsonl");
  const rows = readJsonl(await fs.readFile(resultsPath, "utf8"));

  let repos = 0;
  let reposNonSkipped = 0;
  let reposWithRepair = 0;
  let samples = 0;

  const byReason = new Map();
  const byCode = new Map();
  const byCalleeText = new Map();
  const byResolvedMod = new Map();

  for (const r of rows) {
    repos++;
    if (r?.skipReason) continue;
    reposNonSkipped++;
    const rep = r?.phase3?.repair;
    if (!rep?.enabled) continue;
    reposWithRepair++;
    for (const s of rep?.callDebugSamples ?? []) {
      samples++;
      bump(byReason, String(s?.reason ?? "resolved"));
      bump(byCode, String(s?.code ?? ""));
      if (s?.calleeText) bump(byCalleeText, String(s.calleeText));
      if (s?.rr?.mod) bump(byResolvedMod, String(s.rr.mod));
    }
  }

  console.log(["out_dir", outDir].join("\t"));
  console.log(["repos", repos].join("\t"));
  console.log(["repos_non_skipped", reposNonSkipped].join("\t"));
  console.log(["repos_with_repair", reposWithRepair].join("\t"));
  console.log(["debug_samples", samples].join("\t"));
  console.log("");

  console.log(`reasons (top ${args.top})`);
  for (const [k, c] of sorted(byReason).slice(0, args.top)) console.log([k, c].join("\t"));
  console.log("");
  console.log(`codes (top ${args.top})`);
  for (const [k, c] of sorted(byCode).slice(0, args.top)) console.log([k, c].join("\t"));
  console.log("");
  console.log(`calleeText (top ${args.top})`);
  for (const [k, c] of sorted(byCalleeText).slice(0, args.top)) console.log([k, c].join("\t"));
  console.log("");
  console.log(`resolved_mod (top ${args.top})`);
  for (const [k, c] of sorted(byResolvedMod).slice(0, args.top)) console.log([k, c].join("\t"));
}

main().catch((e) => {
  console.error(String(e?.stack || e));
  process.exit(1);
});


