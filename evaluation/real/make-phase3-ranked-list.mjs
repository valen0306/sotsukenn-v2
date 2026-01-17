#!/usr/bin/env node
/**
 * Create a Phase3 URL list that can reach N by *ranking* candidates by how "Phase3-clean" they look,
 * instead of hard-excluding Phase1/2 errors (which often yields too few repos).
 *
 * Ranking idea:
 *  1) Must be S_lib-like: scan.libraryCallLike.hasAny === true
 *  2) Must have ANY Phase3 core code
 *  3) Sort by:
 *     - fewer Phase1+Phase2 noise counts first
 *     - fewer config-noise (optional) next
 *     - larger Phase3 total next (so we still have signal)
 *
 * Output: one HTTPS repo URL per line.
 */

import { promises as fs } from "node:fs";
import path from "node:path";

const PHASE3_CODES = ["TS2339", "TS2345", "TS2322", "TS2554", "TS2769", "TS2353", "TS2741", "TS7053"];
const PHASE1_CODES = ["TS2307", "TS7016"];
const PHASE2_CODES = ["TS2305", "TS2613", "TS2614"];
const EXTRA_NOISE_CODES = ["TS17004", "TS6142"];

function parseArgs(argv) {
  const args = {
    runDir: null,
    out: null,
    max: 100,
    includeExtraNoise: true,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--run-dir") args.runDir = argv[++i];
    else if (a === "--out") args.out = argv[++i];
    else if (a === "--max") args.max = Number(argv[++i] ?? "0");
    else if (a === "--no-extra-noise") args.includeExtraNoise = false;
    else if (a === "--help" || a === "-h") {
      console.log(`
Usage:
  node evaluation/real/make-phase3-ranked-list.mjs --run-dir <DIR> --out <FILE> [--max N] [--no-extra-noise]
`);
      process.exit(0);
    } else {
      console.error(`Unknown arg: ${a}`);
      process.exit(1);
    }
  }
  if (!args.runDir || !args.out) {
    console.error("Provide --run-dir and --out");
    process.exit(1);
  }
  if (!Number.isFinite(args.max) || args.max < 1) args.max = 100;
  return args;
}

function sumCodes(counts, codes) {
  let n = 0;
  for (const c of codes) n += counts?.[c] ?? 0;
  return n;
}

async function main() {
  const args = parseArgs(process.argv);
  const runDir = path.resolve(args.runDir);
  const inPath = path.join(runDir, "results.jsonl");
  const outPath = path.resolve(args.out);

  const txt = await fs.readFile(inPath, "utf8");
  const lines = txt.split(/\r?\n/).filter((l) => l.trim().length > 0);

  const rows = [];
  const seen = new Set();

  for (const line of lines) {
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    const url = obj?.url;
    const scanLine = obj?.scan?.line;
    if (typeof url !== "string" || url.length === 0) continue;
    if (seen.has(url)) continue;
    if (typeof scanLine !== "string" || !scanLine.trim().startsWith("{")) continue;

    let scan;
    try {
      scan = JSON.parse(scanLine);
    } catch {
      continue;
    }

    const libLike = Boolean(scan?.libraryCallLike?.hasAny);
    if (!libLike) continue;

    const counts = scan?.tsErrorCounts ?? {};
    const phase3 = sumCodes(counts, PHASE3_CODES);
    if (phase3 <= 0) continue;

    const ph1 = sumCodes(counts, PHASE1_CODES);
    const ph2 = sumCodes(counts, PHASE2_CODES);
    const extra = args.includeExtraNoise ? sumCodes(counts, EXTRA_NOISE_CODES) : 0;

    seen.add(url);
    rows.push({ url, phase3, ph1, ph2, extra });
  }

  rows.sort((a, b) => {
    const aNoise = a.ph1 + a.ph2;
    const bNoise = b.ph1 + b.ph2;
    if (aNoise !== bNoise) return aNoise - bNoise; // less noise first
    if (a.extra !== b.extra) return a.extra - b.extra; // less config noise
    if (a.phase3 !== b.phase3) return b.phase3 - a.phase3; // more signal
    return a.url.localeCompare(b.url);
  });

  const selected = rows.slice(0, args.max);

  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, selected.map((r) => r.url).join("\n") + "\n");

  const stats = {
    total_candidates: rows.length,
    selected: selected.length,
    selected_noise0: selected.filter((r) => r.ph1 + r.ph2 === 0).length,
    selected_noise_le_5: selected.filter((r) => r.ph1 + r.ph2 <= 5).length,
  };
  console.error(`wrote ${selected.length} urls to ${outPath}`);
  console.error(`candidates\t${rows.length}`);
  console.error(`selected_noise0\t${stats.selected_noise0}`);
  console.error(`selected_noise_le_5\t${stats.selected_noise_le_5}`);
}

main().catch((e) => {
  console.error(e?.stack || String(e));
  process.exit(1);
});


