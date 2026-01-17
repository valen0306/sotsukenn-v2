#!/usr/bin/env node
/**
 * Merge two Phase3 out dirs produced by phase3-run.mjs.
 *
 * Use-case:
 * - You ran a base experiment (A) and then re-ran only a subset (B) with better settings.
 * - This script replaces rows in A by URL with rows from B, and writes a merged out dir.
 *
 * Usage:
 *  node evaluation/real/merge-phase3-outs.mjs --base <outDirA> --override <outDirB> --out <outDirOut>
 */
import { promises as fs } from "node:fs";
import path from "node:path";

function parseArgs(argv) {
  const args = { base: null, override: null, out: null };
  for (let i = 2; i < argv.length; i++) {
    const t = argv[i];
    if (t === "--base") args.base = argv[++i];
    else if (t === "--override") args.override = argv[++i];
    else if (t === "--out") args.out = argv[++i];
    else if (t === "--help" || t === "-h") {
      console.log(`Usage:
  node evaluation/real/merge-phase3-outs.mjs --base <outDirA> --override <outDirB> --out <outDirOut>
`);
      process.exit(0);
    } else {
      console.error(`Unknown arg: ${t}`);
      process.exit(1);
    }
  }
  if (!args.base || !args.override || !args.out) {
    console.error("Provide --base, --override, --out");
    process.exit(1);
  }
  return args;
}

async function readJsonl(p) {
  const txt = await fs.readFile(p, "utf8");
  const lines = txt.split(/\r?\n/).filter((l) => l.trim().length > 0);
  return lines.map((l) => JSON.parse(l));
}

async function main() {
  const args = parseArgs(process.argv);
  const baseDir = path.resolve(args.base);
  const ovDir = path.resolve(args.override);
  const outDir = path.resolve(args.out);
  await fs.mkdir(outDir, { recursive: true });

  const baseRows = await readJsonl(path.join(baseDir, "results.jsonl"));
  const ovRows = await readJsonl(path.join(ovDir, "results.jsonl"));
  const ovByUrl = new Map(ovRows.map((r) => [r.url, r]));

  let replaced = 0;
  const merged = baseRows.map((r) => {
    const o = ovByUrl.get(r.url);
    if (!o) return r;
    replaced++;
    return o;
  });
  // Also include override rows whose URL is not in base (rare)
  const baseUrls = new Set(baseRows.map((r) => r.url));
  for (const r of ovRows) {
    if (!baseUrls.has(r.url)) merged.push(r);
  }

  await fs.writeFile(path.join(outDir, "results.jsonl"), merged.map((r) => JSON.stringify(r)).join("\n") + "\n");
  // Rebuild summary.tsv by calling phase3-run's built-in summary is not available here;
  // downstream tools (analyze-phase3-results.mjs) only need results.jsonl.
  console.log(`merged_total\t${merged.length}`);
  console.log(`replaced\t${replaced}`);
  console.log(`wrote_results\t${path.join(outDir, "results.jsonl")}`);
}

main().catch((e) => {
  console.error(e?.stack || String(e));
  process.exit(1);
});


