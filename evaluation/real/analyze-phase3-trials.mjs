#!/usr/bin/env node
/**
 * Analyze Phase3 trial exploration stats (Policy A / Phase2).
 *
 * Input:
 *  - <outDir>/results.jsonl
 *
 * Output:
 *  - per-repo trial stats
 *  - aggregate avg tsc calls (baseline + trialsRun), avg trialsRun, and win-rate vs top1
 *
 * Usage:
 *  node evaluation/real/analyze-phase3-trials.mjs --out-dir <DIR>
 */

import { promises as fs } from "node:fs";
import path from "node:path";

function parseArgs(argv) {
  const args = { outDir: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out-dir") args.outDir = argv[++i];
    else if (a === "--help" || a === "-h") {
      console.log(`
Usage:
  node evaluation/real/analyze-phase3-trials.mjs --out-dir <DIR>
`);
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
  return args;
}

function sumCounts(counts) {
  let n = 0;
  for (const v of Object.values(counts ?? {})) n += Number(v) || 0;
  return n;
}

async function main() {
  const args = parseArgs(process.argv);
  const outDir = path.resolve(args.outDir);
  const resultsPath = path.join(outDir, "results.jsonl");
  const txt = await fs.readFile(resultsPath, "utf8");
  const lines = txt.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const rows = [];
  for (const l of lines) {
    try {
      rows.push(JSON.parse(l));
    } catch {
      // ignore
    }
  }

  let nValid = 0;
  let sumTrials = 0;
  let sumTscCalls = 0;
  let nImprovedVsTop1 = 0;
  let nChosenWorseThanBaseline = 0;
  let nChosenBetterThanBaseline = 0;

  for (const r of rows) {
    const sr = r?.skipReason;
    if (sr) continue;
    const trials = r?.trials ?? [];
    const meta = r?.phase3?.trial ?? {};
    const trialsRun = Number(meta?.trialsRun ?? trials.length ?? 0) || 0;
    const chosen = meta?.chosenCandidateId ?? "";
    const top1 = trials.find((t) => t?.candidate_id === "c0_top1") ?? null;
    const chosenTrial = trials.find((t) => t?.candidate_id === chosen) ?? null;
    if (!top1 || !chosenTrial) continue;
    if (!top1.valid_injection || !chosenTrial.valid_injection) continue;

    nValid++;
    sumTrials += trialsRun;
    sumTscCalls += 1 + trialsRun; // baseline + trial tsc runs
    if ((chosenTrial.delta_phase3 ?? 0) < (top1.delta_phase3 ?? 0)) nImprovedVsTop1++;
    if ((chosenTrial.delta_phase3 ?? 0) > 0) nChosenWorseThanBaseline++;
    if ((chosenTrial.delta_phase3 ?? 0) < 0) nChosenBetterThanBaseline++;

    const bTotal = sumCounts(r?.baseline?.tsErrorCounts ?? {});
    const jTotal = sumCounts(r?.injected?.tsErrorCounts ?? {});
    console.log(
      [
        "repo",
        r.url,
        "strategy",
        meta?.strategy ?? "",
        "trialsRun",
        String(trialsRun),
        "chosen",
        chosen,
        "top1_dPhase3",
        String(top1.delta_phase3 ?? ""),
        "chosen_dPhase3",
        String(chosenTrial.delta_phase3 ?? ""),
        "bTotal",
        String(bTotal),
        "jTotal",
        String(jTotal),
      ].join("\t"),
    );
  }

  console.log("\naggregate");
  console.log(`repos_valid_trial_compare\t${nValid}`);
  console.log(`avg_trialsRun\t${nValid ? (sumTrials / nValid).toFixed(2) : ""}`);
  console.log(`avg_tsc_calls\t${nValid ? (sumTscCalls / nValid).toFixed(2) : ""}`);
  console.log(`win_rate_vs_top1\t${nValid ? (nImprovedVsTop1 / nValid).toFixed(3) : ""}`);
  console.log(`chosen_worse_than_baseline_rate\t${nValid ? (nChosenWorseThanBaseline / nValid).toFixed(3) : ""}`);
  console.log(`chosen_better_than_baseline_rate\t${nValid ? (nChosenBetterThanBaseline / nValid).toFixed(3) : ""}`);
}

main().catch((e) => {
  console.error(e?.stack || String(e));
  process.exit(1);
});


