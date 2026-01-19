#!/usr/bin/env node
/**
 * Aggregate coverage stats for call-based repairs (TS2345/TS2322/TS2769/TS2554).
 *
 * Reads <outDir>/results.jsonl (phase3-run output) and summarizes:
 * - how often call resolution was attempted/resolved/externalOk/candidateAdded
 * - how often call-based repair trials exist, and which (code,module,name,op) are most common
 *
 * Usage:
 *   node evaluation/real/analyze-call-repair-coverage.mjs --out-dir <DIR>
 */
import { promises as fs } from "node:fs";
import path from "node:path";

function parseArgs(argv) {
  const args = { outDir: null, top: 30 };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out-dir") args.outDir = argv[++i];
    else if (a === "--top") args.top = Number(argv[++i] ?? "30");
    else if (a === "--help" || a === "-h") {
      console.log("Usage: node evaluation/real/analyze-call-repair-coverage.mjs --out-dir <DIR> [--top N]");
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
  if (!Number.isFinite(args.top) || args.top < 1) args.top = 30;
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

function isCallCode(code) {
  return ["TS2345", "TS2322", "TS2769", "TS2554"].includes(String(code));
}

async function main() {
  const args = parseArgs(process.argv);
  const outDir = path.resolve(args.outDir);
  const resultsPath = path.join(outDir, "results.jsonl");
  const rows = readJsonl(await fs.readFile(resultsPath, "utf8"));

  let repos = 0;
  let reposNonSkipped = 0;
  let reposWithRepair = 0;

  let sumAttempted = 0;
  let sumResolved = 0;
  let sumExternalOk = 0;
  let sumCandidateAdded = 0;

  const byTrialKey = new Map();
  let callRepairTrials = 0;

  for (const r of rows) {
    repos++;
    if (r?.skipReason) continue;
    reposNonSkipped++;

    const rep = r?.phase3?.repair ?? null;
    if (!rep?.enabled) continue;
    reposWithRepair++;

    sumAttempted += Number(rep.tsCallAttempted ?? 0) || 0;
    sumResolved += Number(rep.tsCallResolvedCount ?? 0) || 0;
    sumExternalOk += Number(rep.tsCallExternalOk ?? 0) || 0;
    sumCandidateAdded += Number(rep.tsCallCandidateAdded ?? 0) || 0;

    for (const t of r?.trials ?? []) {
      const so = t?.symbol_override;
      if (so?.kind !== "repair-from-top1") continue;
      if (!isCallCode(so.code)) continue;
      callRepairTrials++;
      const k = [
        String(so.code),
        String(so.module ?? ""),
        String(so.name ?? so.imported ?? ""),
        String(so.op ?? ""),
        String(so.via ?? ""),
        so.arity === null || so.arity === undefined ? "" : `arity=${so.arity}`,
        so.chainDepth === null || so.chainDepth === undefined ? "" : `chain=${so.chainDepth}`,
      ]
        .filter((x) => x !== "")
        .join("::");
      bump(byTrialKey, k);
    }
  }

  console.log(["out_dir", outDir].join("\t"));
  console.log(["repos", repos].join("\t"));
  console.log(["repos_non_skipped", reposNonSkipped].join("\t"));
  console.log(["repos_with_repair", reposWithRepair].join("\t"));
  console.log("");

  const avg = (n) => (reposWithRepair ? (n / reposWithRepair).toFixed(2) : "");
  console.log(["avg_tsCallAttempted_per_repo", avg(sumAttempted)].join("\t"));
  console.log(["avg_tsCallResolved_per_repo", avg(sumResolved)].join("\t"));
  console.log(["avg_tsCallExternalOk_per_repo", avg(sumExternalOk)].join("\t"));
  console.log(["avg_tsCallCandidateAdded_per_repo", avg(sumCandidateAdded)].join("\t"));
  console.log("");

  console.log(["call_repair_trials_total", callRepairTrials].join("\t"));
  console.log(`top_call_repair_trials (top ${args.top})`);
  for (const [k, c] of sorted(byTrialKey).slice(0, args.top)) console.log([k, c].join("\t"));
}

main().catch((e) => {
  console.error(String(e?.stack || e));
  process.exit(1);
});


