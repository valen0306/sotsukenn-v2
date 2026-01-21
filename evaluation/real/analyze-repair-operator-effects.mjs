#!/usr/bin/env node
/**
 * Analyze repair operator effects by aggregating statistics per operator.
 * Week7: Repair Operator別の効果分析
 *
 * Usage:
 *   node evaluation/real/analyze-repair-operator-effects.mjs --out-dir evaluation/real/out/<dir>
 */
import fs from "node:fs/promises";
import path from "node:path";

function parseArgs(argv) {
  const args = { outDir: "" };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out-dir") args.outDir = String(argv[++i] ?? "");
    else if (a === "-h" || a === "--help") {
      console.log("Usage: node evaluation/real/analyze-repair-operator-effects.mjs --out-dir <DIR>");
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

function findTrial(trials, id) {
  return (trials ?? []).find((t) => String(t?.candidate_id ?? "") === String(id ?? ""));
}

function isRepairTrial(t) {
  return t?.symbol_override?.kind === "repair-from-top1";
}

function getRepairKey(t) {
  const so = t?.symbol_override;
  if (!so || so.kind !== "repair-from-top1") return null;
  const code = String(so.code ?? "");
  const module = String(so.module ?? "");
  const op = String(so.op ?? "");
  const prop = String(so.prop ?? "");
  return `${code}::${module}::${op}${prop ? `::prop=${prop}` : ""}`;
}

function getRepairOperator(t) {
  const so = t?.symbol_override;
  if (!so || so.kind !== "repair-from-top1") return null;
  return String(so.op ?? "");
}

function getRepairCode(t) {
  const so = t?.symbol_override;
  if (!so || so.kind !== "repair-from-top1") return null;
  return String(so.code ?? "");
}

function getRepairModule(t) {
  const so = t?.symbol_override;
  if (!so || so.kind !== "repair-from-top1") return null;
  return String(so.module ?? "");
}

async function main() {
  const args = parseArgs(process.argv);
  const resultsPath = path.join(args.outDir, "results.jsonl");
  const resultsTxt = await fs.readFile(resultsPath, "utf8");
  const results = readJsonl(resultsTxt);

  // Aggregate statistics per repair operator
  const opStats = new Map(); // op -> { generated, chosen, wins, losses, ties, worse, better, equal }
  const codeStats = new Map(); // code -> { generated, chosen, wins, losses, ties, worse, better, equal }
  const moduleStats = new Map(); // module -> { generated, chosen, wins, losses, ties, worse, better, equal }
  const keyStats = new Map(); // key -> { generated, chosen, wins, losses, ties, worse, better, equal }

  for (const r of results) {
    const baselinePhase3 = Number(r.baseline?.tsErrorCounts?.phase3Total ?? 0);
    const top1Phase3 = Number(r.phase3?.top1?.phase3Total ?? 0);
    const chosenPhase3 = Number(r.phase3?.chosen?.phase3Total ?? 0);
    const chosenId = r.phase3?.chosen?.candidate_id ?? null;
    const trials = r.trials ?? [];

    // Count all repair candidates generated
    const repairTrials = trials.filter(isRepairTrial);
    for (const t of repairTrials) {
      const op = getRepairOperator(t);
      const code = getRepairCode(t);
      const module = getRepairModule(t);
      const key = getRepairKey(t);

      if (op) {
        const stats = opStats.get(op) ?? { generated: 0, chosen: 0, wins: 0, losses: 0, ties: 0, worse: 0, better: 0, equal: 0 };
        stats.generated++;
        opStats.set(op, stats);
      }
      if (code) {
        const stats = codeStats.get(code) ?? { generated: 0, chosen: 0, wins: 0, losses: 0, ties: 0, worse: 0, better: 0, equal: 0 };
        stats.generated++;
        codeStats.set(code, stats);
      }
      if (module) {
        const stats = moduleStats.get(module) ?? { generated: 0, chosen: 0, wins: 0, losses: 0, ties: 0, worse: 0, better: 0, equal: 0 };
        stats.generated++;
        moduleStats.set(module, stats);
      }
      if (key) {
        const stats = keyStats.get(key) ?? { generated: 0, chosen: 0, wins: 0, losses: 0, ties: 0, worse: 0, better: 0, equal: 0 };
        stats.generated++;
        keyStats.set(key, stats);
      }
    }

    // Count chosen repair candidate
    if (chosenId) {
      const chosenTrial = findTrial(trials, chosenId);
      if (isRepairTrial(chosenTrial)) {
        const op = getRepairOperator(chosenTrial);
        const code = getRepairCode(chosenTrial);
        const module = getRepairModule(chosenTrial);
        const key = getRepairKey(chosenTrial);

        const isWin = Number.isFinite(chosenPhase3) && Number.isFinite(top1Phase3) && chosenPhase3 < top1Phase3;
        const isLoss = Number.isFinite(chosenPhase3) && Number.isFinite(top1Phase3) && chosenPhase3 > top1Phase3;
        const isTie = Number.isFinite(chosenPhase3) && Number.isFinite(top1Phase3) && chosenPhase3 === top1Phase3;
        const isWorse = Number.isFinite(chosenPhase3) && Number.isFinite(baselinePhase3) && chosenPhase3 > baselinePhase3;
        const isBetter = Number.isFinite(chosenPhase3) && Number.isFinite(baselinePhase3) && chosenPhase3 < baselinePhase3;
        const isEqual = Number.isFinite(chosenPhase3) && Number.isFinite(baselinePhase3) && chosenPhase3 === baselinePhase3;

        if (op) {
          const stats = opStats.get(op) ?? { generated: 0, chosen: 0, wins: 0, losses: 0, ties: 0, worse: 0, better: 0, equal: 0 };
          stats.chosen++;
          if (isWin) stats.wins++;
          if (isLoss) stats.losses++;
          if (isTie) stats.ties++;
          if (isWorse) stats.worse++;
          if (isBetter) stats.better++;
          if (isEqual) stats.equal++;
          opStats.set(op, stats);
        }
        if (code) {
          const stats = codeStats.get(code) ?? { generated: 0, chosen: 0, wins: 0, losses: 0, ties: 0, worse: 0, better: 0, equal: 0 };
          stats.chosen++;
          if (isWin) stats.wins++;
          if (isLoss) stats.losses++;
          if (isTie) stats.ties++;
          if (isWorse) stats.worse++;
          if (isBetter) stats.better++;
          if (isEqual) stats.equal++;
          codeStats.set(code, stats);
        }
        if (module) {
          const stats = moduleStats.get(module) ?? { generated: 0, chosen: 0, wins: 0, losses: 0, ties: 0, worse: 0, better: 0, equal: 0 };
          stats.chosen++;
          if (isWin) stats.wins++;
          if (isLoss) stats.losses++;
          if (isTie) stats.ties++;
          if (isWorse) stats.worse++;
          if (isBetter) stats.better++;
          if (isEqual) stats.equal++;
          moduleStats.set(module, stats);
        }
        if (key) {
          const stats = keyStats.get(key) ?? { generated: 0, chosen: 0, wins: 0, losses: 0, ties: 0, worse: 0, better: 0, equal: 0 };
          stats.chosen++;
          if (isWin) stats.wins++;
          if (isLoss) stats.losses++;
          if (isTie) stats.ties++;
          if (isWorse) stats.worse++;
          if (isBetter) stats.better++;
          if (isEqual) stats.equal++;
          keyStats.set(key, stats);
        }
      }
    }
  }

  // Calculate rates
  function calcRates(stats) {
    return {
      ...stats,
      selectionRate: stats.generated > 0 ? (stats.chosen / stats.generated) : 0,
      winRate: stats.chosen > 0 ? (stats.wins / stats.chosen) : 0,
      worseRate: stats.chosen > 0 ? (stats.worse / stats.chosen) : 0,
      betterRate: stats.chosen > 0 ? (stats.better / stats.chosen) : 0,
    };
  }

  // Output TSV
  const outputPath = path.join(args.outDir, "repair-operator-effects.tsv");
  const lines = [];

  // Header
  lines.push("category\tkey\tgenerated\tchosen\tselection_rate\twins\tlosses\tties\twin_rate\tworse\tbetter\tequal\tworse_rate\tbetter_rate");

  // By operator
  const sortedOps = [...opStats.entries()].sort((a, b) => b[1].chosen - a[1].chosen);
  for (const [op, stats] of sortedOps) {
    const rates = calcRates(stats);
    lines.push(`operator\t${op}\t${stats.generated}\t${stats.chosen}\t${rates.selectionRate.toFixed(3)}\t${stats.wins}\t${stats.losses}\t${stats.ties}\t${rates.winRate.toFixed(3)}\t${stats.worse}\t${stats.better}\t${stats.equal}\t${rates.worseRate.toFixed(3)}\t${rates.betterRate.toFixed(3)}`);
  }

  // By error code
  const sortedCodes = [...codeStats.entries()].sort((a, b) => b[1].chosen - a[1].chosen);
  for (const [code, stats] of sortedCodes) {
    const rates = calcRates(stats);
    lines.push(`code\t${code}\t${stats.generated}\t${stats.chosen}\t${rates.selectionRate.toFixed(3)}\t${stats.wins}\t${stats.losses}\t${stats.ties}\t${rates.winRate.toFixed(3)}\t${stats.worse}\t${stats.better}\t${stats.equal}\t${rates.worseRate.toFixed(3)}\t${rates.betterRate.toFixed(3)}`);
  }

  // By module (top 20)
  const sortedModules = [...moduleStats.entries()].sort((a, b) => b[1].chosen - a[1].chosen).slice(0, 20);
  for (const [module, stats] of sortedModules) {
    const rates = calcRates(stats);
    lines.push(`module\t${module}\t${stats.generated}\t${stats.chosen}\t${rates.selectionRate.toFixed(3)}\t${stats.wins}\t${stats.losses}\t${stats.ties}\t${rates.winRate.toFixed(3)}\t${stats.worse}\t${stats.better}\t${stats.equal}\t${rates.worseRate.toFixed(3)}\t${rates.betterRate.toFixed(3)}`);
  }

  // By repair key (top 20)
  const sortedKeys = [...keyStats.entries()].sort((a, b) => b[1].chosen - a[1].chosen).slice(0, 20);
  for (const [key, stats] of sortedKeys) {
    const rates = calcRates(stats);
    lines.push(`key\t${key}\t${stats.generated}\t${stats.chosen}\t${rates.selectionRate.toFixed(3)}\t${stats.wins}\t${stats.losses}\t${stats.ties}\t${rates.winRate.toFixed(3)}\t${stats.worse}\t${stats.better}\t${stats.equal}\t${rates.worseRate.toFixed(3)}\t${rates.betterRate.toFixed(3)}`);
  }

  await fs.writeFile(outputPath, lines.join("\n") + "\n", "utf8");
  console.log(`wrote\t${outputPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

