#!/usr/bin/env node
/**
 * Oracle analysis:
 * Given results.jsonl with trials[], compute the upper bound if we could pick the best trial per repo.
 *
 * Usage:
 *   node evaluation/real/analyze-oracle.mjs --out-dir evaluation/real/out/<dir>
 *
 * Output: TSV-ish key/value + a short table.
 */
import fs from "node:fs/promises";
import path from "node:path";

function parseArgs(argv) {
  const args = { outDir: "", limitRepos: Infinity };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out-dir") args.outDir = String(argv[++i] ?? "");
    else if (a === "--limit-repos") args.limitRepos = Number(argv[++i] ?? "0");
    else if (a === "-h" || a === "--help") {
      console.log(`Usage: node evaluation/real/analyze-oracle.mjs --out-dir <DIR> [--limit-repos N]`);
      process.exit(0);
    }
  }
  if (!args.outDir) {
    console.error("missing --out-dir");
    process.exit(2);
  }
  if (!Number.isFinite(args.limitRepos) || args.limitRepos < 1) args.limitRepos = Infinity;
  return args;
}

function sumCounts(obj) {
  let n = 0;
  for (const v of Object.values(obj ?? {})) n += Number(v) || 0;
  return n;
}

function readJsonlLines(txt) {
  return txt
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => JSON.parse(s));
}

function getTrialTotalErrorsFromDelta(baselineCounts, deltaErrors) {
  // We don't store injected counts; reconstruct a comparable "total errors" score from baseline + delta (approx).
  // This is enough for tie-break comparisons in practice.
  if (!baselineCounts || !deltaErrors) return null;
  const keys = new Set([...Object.keys(baselineCounts), ...Object.keys(deltaErrors)]);
  let total = 0;
  for (const k of keys) {
    const b = Number(baselineCounts?.[k] ?? 0) || 0;
    const d = Number(deltaErrors?.[k] ?? 0) || 0;
    const v = b + d;
    total += v;
  }
  return total;
}

function pickBestTrial({ trials, baselineCounts }) {
  // Minimize injected_phase3; tie-break by reconstructed total errors; then by candidate_id.
  let best = null;
  for (const t of trials ?? []) {
    if (!t?.valid_injection) continue;
    const p3 = Number(t.injected_phase3 ?? NaN);
    if (!Number.isFinite(p3)) continue;
    const total = getTrialTotalErrorsFromDelta(baselineCounts, t.delta_errors);
    const key = { p3, total: total ?? Number.POSITIVE_INFINITY, id: String(t.candidate_id ?? "") };
    if (!best) best = { t, key };
    else {
      const a = best.key;
      if (key.p3 < a.p3) best = { t, key };
      else if (key.p3 === a.p3) {
        if (key.total < a.total) best = { t, key };
        else if (key.total === a.total && key.id.localeCompare(a.id) < 0) best = { t, key };
      }
    }
  }
  return best?.t ?? null;
}

function findTrialByCandidateId(trials, id) {
  return (trials ?? []).find((t) => String(t?.candidate_id ?? "") === String(id ?? ""));
}

function phase3Core(counts) {
  const PHASE3 = ["TS2339", "TS2345", "TS2322", "TS2554", "TS2769", "TS2353", "TS2741", "TS7053"];
  let n = 0;
  for (const c of PHASE3) n += Number(counts?.[c] ?? 0) || 0;
  return n;
}

async function main() {
  const args = parseArgs(process.argv);
  const outDir = path.resolve(args.outDir);
  const p = path.join(outDir, "results.jsonl");
  const raw = await fs.readFile(p, "utf8");
  const rows = readJsonlLines(raw).slice(0, args.limitRepos);

  let repos = 0;
  let reposValidCompare = 0;

  let oracleWinsVsTop1 = 0;
  let oracleTiesVsTop1 = 0;
  let oracleLossVsTop1 = 0;

  let chosenWinsVsTop1 = 0;
  let chosenTiesVsTop1 = 0;
  let chosenLossVsTop1 = 0;

  // baseline->chosen comparisons (same definition as analyze-phase3-trials uses: based on chosen_dPhase3 sign)
  let oracleWorseThanBaseline = 0;
  let oracleBetterThanBaseline = 0;
  let oracleEqualBaseline = 0;

  let chosenWorseThanBaseline = 0;
  let chosenBetterThanBaseline = 0;
  let chosenEqualBaseline = 0;

  let sumTop1P3 = 0;
  let sumOracleP3 = 0;
  let sumChosenP3 = 0;

  const examples = [];

  for (const r of rows) {
    repos++;
    const baselineCounts = r?.baseline?.tsErrorCounts ?? {};
    const baselineP3 = phase3Core(baselineCounts);
    const trials = r?.trials ?? [];
    const top1 = findTrialByCandidateId(trials, "c0_top1");
    const chosenId = r?.phase3?.trial?.chosenCandidateId ?? null;
    const chosen = chosenId ? findTrialByCandidateId(trials, chosenId) : null;
    const oracle = pickBestTrial({ trials, baselineCounts });

    if (!top1 || !chosen || !oracle) continue;
    if (!top1.valid_injection || !chosen.valid_injection || !oracle.valid_injection) continue;

    const top1P3 = Number(top1.injected_phase3 ?? NaN);
    const chosenP3 = Number(chosen.injected_phase3 ?? NaN);
    const oracleP3 = Number(oracle.injected_phase3 ?? NaN);
    if (![top1P3, chosenP3, oracleP3].every(Number.isFinite)) continue;

    reposValidCompare++;
    sumTop1P3 += top1P3;
    sumChosenP3 += chosenP3;
    sumOracleP3 += oracleP3;

    // oracle vs top1
    if (oracleP3 < top1P3) oracleWinsVsTop1++;
    else if (oracleP3 === top1P3) oracleTiesVsTop1++;
    else oracleLossVsTop1++;

    // chosen vs top1
    if (chosenP3 < top1P3) chosenWinsVsTop1++;
    else if (chosenP3 === top1P3) chosenTiesVsTop1++;
    else chosenLossVsTop1++;

    // baseline comparisons (by delta_phase3)
    const chosenDP3 = Number(chosen.delta_phase3 ?? (chosenP3 - baselineP3));
    const oracleDP3 = Number(oracle.delta_phase3 ?? (oracleP3 - baselineP3));
    if (chosenDP3 < 0) chosenBetterThanBaseline++;
    else if (chosenDP3 === 0) chosenEqualBaseline++;
    else chosenWorseThanBaseline++;

    if (oracleDP3 < 0) oracleBetterThanBaseline++;
    else if (oracleDP3 === 0) oracleEqualBaseline++;
    else oracleWorseThanBaseline++;

    if (examples.length < 8 && oracleP3 < chosenP3) {
      examples.push({
        url: r?.url ?? "",
        chosen: String(chosen.candidate_id),
        oracle: String(oracle.candidate_id),
        top1P3,
        chosenP3,
        oracleP3,
      });
    }
  }

  function rate(x) {
    return reposValidCompare ? x / reposValidCompare : 0;
  }

  console.log(["out_dir", outDir].join("\t"));
  console.log(["repos", repos].join("\t"));
  console.log(["repos_valid_oracle_compare", reposValidCompare].join("\t"));
  console.log(["avg_top1_phase3", reposValidCompare ? (sumTop1P3 / reposValidCompare).toFixed(3) : ""].join("\t"));
  console.log(["avg_chosen_phase3", reposValidCompare ? (sumChosenP3 / reposValidCompare).toFixed(3) : ""].join("\t"));
  console.log(["avg_oracle_phase3", reposValidCompare ? (sumOracleP3 / reposValidCompare).toFixed(3) : ""].join("\t"));
  console.log("");
  console.log(["chosen_win_rate_vs_top1", rate(chosenWinsVsTop1).toFixed(3)].join("\t"));
  console.log(["oracle_win_rate_vs_top1", rate(oracleWinsVsTop1).toFixed(3)].join("\t"));
  console.log(["oracle_tie_rate_vs_top1", rate(oracleTiesVsTop1).toFixed(3)].join("\t"));
  console.log(["oracle_loss_rate_vs_top1", rate(oracleLossVsTop1).toFixed(3)].join("\t"));
  console.log("");
  console.log(["chosen_worse_than_baseline_rate", rate(chosenWorseThanBaseline).toFixed(3)].join("\t"));
  console.log(["oracle_worse_than_baseline_rate", rate(oracleWorseThanBaseline).toFixed(3)].join("\t"));
  console.log(["oracle_better_than_baseline_rate", rate(oracleBetterThanBaseline).toFixed(3)].join("\t"));
  console.log(["oracle_equal_baseline_rate", rate(oracleEqualBaseline).toFixed(3)].join("\t"));

  if (examples.length) {
    console.log("\nexamples_where_oracle_beats_chosen (up to 8)");
    console.log(["url", "chosen", "oracle", "top1P3", "chosenP3", "oracleP3"].join("\t"));
    for (const e of examples) console.log([e.url, e.chosen, e.oracle, e.top1P3, e.chosenP3, e.oracleP3].join("\t"));
  }
}

main().catch((e) => {
  console.error(String(e?.stack || e));
  process.exit(1);
});


