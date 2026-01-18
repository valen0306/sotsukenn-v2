#!/usr/bin/env node
/**
 * Analyze trial effects vs top1 within results.jsonl:
 * - For each valid repo, compare each valid trial's injected_phase3 against top1.
 * - Report how many trials improve/tie/worsen vs top1.
 * - Group by operation type (module-any / any-topK / any-pair / symbol kind).
 *
 * Usage:
 *   node evaluation/real/analyze-trial-effects.mjs --out-dir evaluation/real/out/<dir>
 */
import fs from "node:fs/promises";
import path from "node:path";

function parseArgs(argv) {
  const args = { outDir: "" };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out-dir") args.outDir = String(argv[++i] ?? "");
    else if (a === "-h" || a === "--help") {
      console.log(`Usage: node evaluation/real/analyze-trial-effects.mjs --out-dir <DIR>`);
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

function opType(trial) {
  const id = String(trial?.candidate_id ?? "");
  const sym = trial?.symbol_override;
  if (sym?.kind) return `symbol:${String(sym.kind)}`;
  if (id === "c0_top1") return "top1";
  if (id.startsWith("c_anytopk_")) return "any-topk";
  if (id.startsWith("c_anypair_")) return "any-pair";
  if (id.startsWith("c_anymod_")) return "any-module";
  if (id.startsWith("c_widen_")) return "symbol:export-to-any";
  if (id.startsWith("c_tany_")) return "symbol:type-to-any";
  return "other";
}

function bump(map, k, d = 1) {
  map.set(k, (map.get(k) ?? 0) + d);
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

  let repos = 0;
  let reposWithTop1 = 0;
  let reposValidTop1 = 0;
  let validTrials = 0;

  let improve = 0;
  let tie = 0;
  let worsen = 0;

  const byOpImprove = new Map();
  const byOpTie = new Map();
  const byOpWorsen = new Map();
  const byOpSeen = new Map();

  for (const r of rows) {
    repos++;
    const trials = r?.trials ?? [];
    const top1 = trials.find((t) => String(t?.candidate_id ?? "") === "c0_top1");
    if (!top1) continue;
    reposWithTop1++;
    if (!top1.valid_injection) continue;
    const top1P3 = Number(top1.injected_phase3 ?? NaN);
    if (!Number.isFinite(top1P3)) continue;
    reposValidTop1++;

    for (const t of trials) {
      if (!t?.valid_injection) continue;
      const p3 = Number(t.injected_phase3 ?? NaN);
      if (!Number.isFinite(p3)) continue;
      validTrials++;
      const op = opType(t);
      bump(byOpSeen, op);

      if (p3 < top1P3) {
        improve++;
        bump(byOpImprove, op);
      } else if (p3 === top1P3) {
        tie++;
        bump(byOpTie, op);
      } else {
        worsen++;
        bump(byOpWorsen, op);
      }
    }
  }

  console.log(["out_dir", outDir].join("\t"));
  console.log(["repos", repos].join("\t"));
  console.log(["repos_with_top1", reposWithTop1].join("\t"));
  console.log(["repos_valid_top1", reposValidTop1].join("\t"));
  console.log(["valid_trials", validTrials].join("\t"));
  console.log("");
  console.log(["trials_improve_vs_top1", improve].join("\t"));
  console.log(["trials_tie_vs_top1", tie].join("\t"));
  console.log(["trials_worsen_vs_top1", worsen].join("\t"));
  console.log("");

  console.log("by_operation_seen (top 30)");
  for (const [k, v] of sorted(byOpSeen).slice(0, 30)) console.log([k, v].join("\t"));
  console.log("");
  console.log("by_operation_improve (top 30)");
  for (const [k, v] of sorted(byOpImprove).slice(0, 30)) console.log([k, v].join("\t"));
  console.log("");
  console.log("by_operation_worsen (top 30)");
  for (const [k, v] of sorted(byOpWorsen).slice(0, 30)) console.log([k, v].join("\t"));
}

main().catch((e) => {
  console.error(String(e?.stack || e));
  process.exit(1);
});


