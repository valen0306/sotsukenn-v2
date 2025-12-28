#!/usr/bin/env node
/**
 * Aggregate JSONL produced by scripts/scan-tsc-errors.mjs
 *
 * Usage:
 *   node scripts/aggregate-tsc-errors.mjs --in results.jsonl
 *   node scripts/aggregate-tsc-errors.mjs --in results.jsonl --top 30
 */

import { promises as fs } from "node:fs";
import path from "node:path";

function parseArgs(argv) {
  const args = { inFile: null, top: 50, minRepos: 1 };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--in") args.inFile = argv[++i];
    else if (a === "--top") args.top = Number(argv[++i] ?? "50");
    else if (a === "--min-repos") args.minRepos = Number(argv[++i] ?? "1");
    else if (a === "--help" || a === "-h") {
      console.log(`
Usage:
  node scripts/aggregate-tsc-errors.mjs --in <results.jsonl> [--top N] [--min-repos N]
`);
      process.exit(0);
    } else {
      console.error(`Unknown arg: ${a}`);
      process.exit(1);
    }
  }
  if (!args.inFile) {
    console.error("Provide --in <results.jsonl>");
    process.exit(1);
  }
  if (!Number.isFinite(args.top) || args.top < 1) args.top = 50;
  if (!Number.isFinite(args.minRepos) || args.minRepos < 1) args.minRepos = 1;
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  const p = path.resolve(args.inFile);
  const txt = await fs.readFile(p, "utf8");
  const lines = txt.split(/\r?\n/).filter((l) => l.trim().length > 0);

  const totalCounts = new Map(); // TSxxxx -> occurrences
  const repoPresence = new Map(); // TSxxxx -> repos containing it
  let scanned = 0;
  let skipped = 0;
  let timedOut = 0;

  for (const line of lines) {
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    scanned++;
    if (obj.skipped) skipped++;
    if (obj.timedOut) timedOut++;

    const codes = obj.tsErrorCounts ?? {};
    for (const [code, count] of Object.entries(codes)) {
      totalCounts.set(code, (totalCounts.get(code) ?? 0) + (Number(count) || 0));
      repoPresence.set(code, (repoPresence.get(code) ?? 0) + 1);
    }
  }

  const rows = [...totalCounts.entries()]
    .map(([code, count]) => ({
      code,
      occurrences: count,
      repos: repoPresence.get(code) ?? 0,
    }))
    .filter((r) => r.repos >= args.minRepos)
    .sort((a, b) => b.repos - a.repos || b.occurrences - a.occurrences || a.code.localeCompare(b.code));

  console.log(`scanned_repos=${scanned} skipped=${skipped} timed_out=${timedOut}`);
  console.log(`code\trepos\toccurrences`);
  for (const r of rows.slice(0, args.top)) {
    console.log(`${r.code}\t${r.repos}\t${r.occurrences}`);
  }
}

main().catch((e) => {
  console.error(e?.stack || String(e));
  process.exit(1);
});


