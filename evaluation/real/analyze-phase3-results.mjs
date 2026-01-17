#!/usr/bin/env node
/**
 * Analyze Phase3 real-run output directory produced by phase3-run.mjs.
 *
 * Input:
 *  - <outDir>/results.jsonl
 *
 * Output (stdout):
 *  - aggregate stats (skip reasons, invalid injections, reduced/eliminated counts)
 *  - Phase3 core totals (baseline vs injected) for VALID injections only
 *
 * This is intentionally "Phase3-core focused" and excludes invalid injections and model-timeout.
 */

import { promises as fs } from "node:fs";
import path from "node:path";

const PHASE3 = ["TS2339", "TS2345", "TS2322", "TS2554", "TS2769", "TS2353", "TS2741", "TS7053"];
const SYNTAX_BAD = ["TS1005", "TS1109", "TS1128", "TS1131", "TS1160", "TS1434"];

function parseArgs(argv) {
  const args = { outDir: null, top: 10 };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out-dir") args.outDir = argv[++i];
    else if (a === "--top") args.top = Number(argv[++i] ?? "10");
    else if (a === "--help" || a === "-h") {
      console.log(`
Usage:
  node evaluation/real/analyze-phase3-results.mjs --out-dir <DIR> [--top N]
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
  if (!Number.isFinite(args.top) || args.top < 1) args.top = 10;
  return args;
}

function sumPhase3(counts) {
  let n = 0;
  for (const c of PHASE3) n += counts?.[c] ?? 0;
  return n;
}

function hasAny(counts, codes) {
  for (const c of codes) if ((counts?.[c] ?? 0) > 0) return true;
  return false;
}

function inc(map, key) {
  map.set(key, (map.get(key) ?? 0) + 1);
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

  const skipReasons = new Map();
  const baselineExit = new Map();
  const injectedExit = new Map();

  let invalid = 0;
  let valid = 0;
  let modelTimeout = 0;
  let reduced = 0;
  let eliminated = 0;

  let baselineTotal = 0;
  let injectedTotal = 0;
  const baselineByCode = Object.fromEntries(PHASE3.map((c) => [c, 0]));
  const injectedByCode = Object.fromEntries(PHASE3.map((c) => [c, 0]));

  const improvements = [];

  for (const r of rows) {
    const sr = r?.skipReason ?? "";
    if (sr) inc(skipReasons, sr);
    inc(baselineExit, String(r?.baseline?.exitCode ?? ""));
    inc(injectedExit, String(r?.injected?.exitCode ?? ""));

    if (sr === "model-timeout") modelTimeout++;

    const bCounts = r?.baseline?.tsErrorCounts ?? {};
    const jCounts = r?.injected?.tsErrorCounts ?? {};
    const bPh3 = sumPhase3(bCounts);
    const jPh3 = sumPhase3(jCounts);

    const injectedDtsInvalid = Boolean(r?.phase3?.injectedDtsInvalid) || hasAny(jCounts, SYNTAX_BAD);
    const isValid = !sr && !injectedDtsInvalid && r?.injected && r?.injected?.timedOut !== true;

    if (injectedDtsInvalid) invalid++;
    if (isValid) {
      valid++;
      baselineTotal += bPh3;
      injectedTotal += jPh3;
      for (const c of PHASE3) {
        baselineByCode[c] += bCounts?.[c] ?? 0;
        injectedByCode[c] += jCounts?.[c] ?? 0;
      }
      if (jPh3 < bPh3) reduced++;
      if (bPh3 > 0 && jPh3 === 0) eliminated++;
      improvements.push({ url: r.url, baselinePhase3: bPh3, injectedPhase3: jPh3, delta: jPh3 - bPh3 });
    }
  }

  improvements.sort((a, b) => (a.delta - b.delta) || (b.baselinePhase3 - a.baselinePhase3));

  console.log(`repos_total\t${rows.length}`);
  console.log(`repos_valid_injection\t${valid}`);
  console.log(`repos_invalid_dts\t${invalid}`);
  console.log(`repos_model_timeout\t${modelTimeout}`);
  console.log(`phase3Reduced_valid\t${reduced}`);
  console.log(`phase3Eliminated_valid\t${eliminated}`);
  console.log(`phase3Total_valid_baseline\t${baselineTotal}`);
  console.log(`phase3Total_valid_injected\t${injectedTotal}`);
  console.log(`phase3Total_valid_delta\t${injectedTotal - baselineTotal}`);

  console.log(`\nby_code_valid\tbaseline\tinjected\tdelta`);
  for (const c of PHASE3) {
    const b = baselineByCode[c];
    const j = injectedByCode[c];
    console.log(`${c}\t${b}\t${j}\t${j - b}`);
  }

  console.log(`\nskip_reasons`);
  for (const [k, v] of [...skipReasons.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`${k}\t${v}`);
  }

  console.log(`\nmost_improved_valid (top ${args.top})`);
  for (const r of improvements.slice(0, args.top)) {
    console.log(`${r.baselinePhase3}\t${r.injectedPhase3}\t${r.delta}\t${r.url}`);
  }
}

main().catch((e) => {
  console.error(e?.stack || String(e));
  process.exit(1);
});


