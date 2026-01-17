#!/usr/bin/env node
/**
 * Create a "Phase3-only-ish" URL list from a previous scan run.
 *
 * Motivation:
 * - Phase3 aims to measure API alignment improvements, but Phase1/2 errors (resolution/boundary)
 *   can dominate and confound the measurement.
 * - This list tries to select repos where Phase3 evaluation is more likely to be meaningful.
 *
 * Input:
 *  - <runDir>/results.jsonl (URL + scan.line)
 *
 * Output:
 *  - a text file with one HTTPS repo URL per line
 *
 * Default filter:
 *  - scan.libraryCallLike.hasAny === true
 *  - AND scan.tsErrorCounts contains ANY Phase3 core code
 *  - AND scan.tsErrorCounts contains NONE of Phase1/2 codes:
 *      Phase1: TS2307, TS7016
 *      Phase2: TS2305, TS2613, TS2614
 *
 * Optional extra exclusions (recommended for stability):
 *  - TS17004 (JSX flag missing)
 *  - TS6142 (TSX in non-TSX project / jsx config issues)
 */

import { promises as fs } from "node:fs";
import path from "node:path";

const PHASE3_CODES = new Set(["TS2339", "TS2345", "TS2322", "TS2554", "TS2769", "TS2353", "TS2741", "TS7053"]);
const DEFAULT_EXCLUDE = new Set(["TS2307", "TS7016", "TS2305", "TS2613", "TS2614"]);
const DEFAULT_EXCLUDE_EXTRA = new Set(["TS17004", "TS6142"]);

function parseArgs(argv) {
  const args = {
    runDir: null,
    out: null,
    max: Infinity,
    includeExtraExcludes: true,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--run-dir") args.runDir = argv[++i];
    else if (a === "--out") args.out = argv[++i];
    else if (a === "--max") args.max = Number(argv[++i] ?? "0");
    else if (a === "--no-extra-excludes") args.includeExtraExcludes = false;
    else if (a === "--help" || a === "-h") {
      console.log(`
Usage:
  node evaluation/real/make-phase3-pure-list.mjs --run-dir <DIR> --out <FILE> [--max N] [--no-extra-excludes]
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
  if (!Number.isFinite(args.max) || args.max < 1) args.max = Infinity;
  return args;
}

function hasAnyCode(counts, codeSet) {
  if (!counts || typeof counts !== "object") return false;
  for (const c of Object.keys(counts)) if (codeSet.has(c)) return true;
  return false;
}

function hasAnyExcluded(counts, excludedSet) {
  if (!counts || typeof counts !== "object") return false;
  for (const c of Object.keys(counts)) if (excludedSet.has(c)) return true;
  return false;
}

async function main() {
  const args = parseArgs(process.argv);
  const runDir = path.resolve(args.runDir);
  const inPath = path.join(runDir, "results.jsonl");
  const outPath = path.resolve(args.out);

  const excluded = new Set([...DEFAULT_EXCLUDE]);
  if (args.includeExtraExcludes) {
    for (const c of DEFAULT_EXCLUDE_EXTRA) excluded.add(c);
  }

  const txt = await fs.readFile(inPath, "utf8");
  const lines = txt.split(/\r?\n/).filter((l) => l.trim().length > 0);

  const urls = [];
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
    const counts = scan?.tsErrorCounts ?? {};
    if (!libLike) continue;
    if (!hasAnyCode(counts, PHASE3_CODES)) continue;
    if (hasAnyExcluded(counts, excluded)) continue;

    seen.add(url);
    urls.push(url);
    if (urls.length >= args.max) break;
  }

  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, urls.join("\n") + "\n");
  console.error(`wrote ${urls.length} urls to ${outPath}`);
  console.error(`excluded_codes\t${[...excluded].sort().join(",")}`);
}

main().catch((e) => {
  console.error(e?.stack || String(e));
  process.exit(1);
});


