#!/usr/bin/env node
/**
 * Attribute "improvements vs top1" to repair-from-top1 candidates.
 *
 * Usage:
 *   node evaluation/real/analyze-repair-causes.mjs --out-dir evaluation/real/out/<dir>
 */
import fs from "node:fs/promises";
import path from "node:path";

function parseArgs(argv) {
  const args = { outDir: "", top: 25 };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out-dir") args.outDir = String(argv[++i] ?? "");
    else if (a === "--top") args.top = Number(argv[++i] ?? "25");
    else if (a === "-h" || a === "--help") {
      console.log("Usage: node evaluation/real/analyze-repair-causes.mjs --out-dir <DIR> [--top N]");
      process.exit(0);
    }
  }
  if (!args.outDir) {
    console.error("missing --out-dir");
    process.exit(2);
  }
  if (!Number.isFinite(args.top) || args.top < 1) args.top = 25;
  return args;
}

function readJsonl(txt) {
  return txt
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => JSON.parse(s));
}

function bump(map, k, d = 1) {
  map.set(k, (map.get(k) ?? 0) + d);
}

function sorted(map) {
  return [...map.entries()].sort((a, b) => (b[1] - a[1]) || String(a[0]).localeCompare(String(b[0])));
}

function findTrial(trials, id) {
  return (trials ?? []).find((t) => String(t?.candidate_id ?? "") === String(id ?? ""));
}

function isRepairTrial(t) {
  return t?.symbol_override?.kind === "repair-from-top1";
}

function keyFromRepair(sym) {
  const code = String(sym?.code ?? "");
  const mod = String(sym?.module ?? "");
  const imported = String(sym?.imported ?? "");
  const op = String(sym?.op ?? "");
  const prop = sym?.prop ? String(sym.prop) : "";
  if (code === "TS2339") return `${code}::${mod}::${imported}::${op}::prop=${prop}`;
  const name = sym?.name ? String(sym.name) : "";
  return `${code}::${mod}::${name || imported}::${op}`;
}

async function main() {
  const args = parseArgs(process.argv);
  const outDir = path.resolve(args.outDir);
  const p = path.join(outDir, "results.jsonl");
  const raw = await fs.readFile(p, "utf8");
  const rows = readJsonl(raw);

  let repos = 0;
  let reposValidTop1 = 0;
  let reposChosenBeatsTop1 = 0;
  let reposChosenIsRepair = 0;
  let reposChosenRepairBeatsTop1 = 0;

  const byKey = new Map(); // key -> count (chosen repair beats top1)
  const byModule = new Map();
  const byOp = new Map();
  const byProp = new Map();

  const examples = [];

  for (const r of rows) {
    repos++;
    const trials = r?.trials ?? [];
    const top1 = findTrial(trials, "c0_top1");
    const chosenId = r?.phase3?.trial?.chosenCandidateId ?? null;
    const chosen = chosenId ? findTrial(trials, chosenId) : null;
    if (!top1 || !chosen) continue;
    if (!top1.valid_injection || !chosen.valid_injection) continue;

    const top1P3 = Number(top1.injected_phase3 ?? NaN);
    const chosenP3 = Number(chosen.injected_phase3 ?? NaN);
    if (![top1P3, chosenP3].every(Number.isFinite)) continue;
    reposValidTop1++;

    const chosenBeats = chosenP3 < top1P3;
    if (chosenBeats) reposChosenBeatsTop1++;

    if (isRepairTrial(chosen)) {
      reposChosenIsRepair++;
      if (chosenBeats) {
        reposChosenRepairBeatsTop1++;
        const sym = chosen.symbol_override;
        const k = keyFromRepair(sym);
        bump(byKey, k);
        bump(byModule, String(sym?.module ?? ""));
        bump(byOp, String(sym?.op ?? ""));
        if (sym?.prop) bump(byProp, String(sym.prop));

        if (examples.length < 10) {
          examples.push({
            url: r?.url ?? "",
            chosen: String(chosen.candidate_id),
            top1P3,
            chosenP3,
            sym,
          });
        }
      }
    }
  }

  console.log(["out_dir", outDir].join("\t"));
  console.log(["repos", repos].join("\t"));
  console.log(["repos_valid_top1", reposValidTop1].join("\t"));
  console.log(["repos_chosen_beats_top1", reposChosenBeatsTop1].join("\t"));
  console.log(["repos_chosen_is_repair", reposChosenIsRepair].join("\t"));
  console.log(["repos_chosen_repair_beats_top1", reposChosenRepairBeatsTop1].join("\t"));
  console.log("");

  console.log(`top_repair_keys (top ${args.top})`);
  for (const [k, c] of sorted(byKey).slice(0, args.top)) console.log([k, c].join("\t"));
  console.log("");
  console.log(`top_modules (top ${args.top})`);
  for (const [k, c] of sorted(byModule).slice(0, args.top)) console.log([k, c].join("\t"));
  console.log("");
  console.log(`top_ops (top ${args.top})`);
  for (const [k, c] of sorted(byOp).slice(0, args.top)) console.log([k, c].join("\t"));
  console.log("");
  console.log(`top_props (top ${Math.min(args.top, 25)})`);
  for (const [k, c] of sorted(byProp).slice(0, Math.min(args.top, 25))) console.log([k, c].join("\t"));

  if (examples.length) {
    console.log("\nexamples (up to 10)");
    for (const e of examples) {
      console.log([e.url, `top1=${e.top1P3}`, `chosen=${e.chosenP3}`, JSON.stringify(e.sym)].join("\t"));
    }
  }
}

main().catch((e) => {
  console.error(String(e?.stack || e));
  process.exit(1);
});


