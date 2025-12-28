#!/usr/bin/env node
/**
 * Create an S_lib URL list from a previous scan run.
 *
 * Input:
 *  - <runDir>/results.jsonl (URL + scan.line)
 *
 * Output:
 *  - a text file with one HTTPS repo URL per line
 *
 * S_lib definition (current):
 *  - scan.libraryCallLike.hasAny === true
 *  - AND scan.tsErrorCounts has at least one TS code (codeCount > 0)
 */

import { promises as fs } from "node:fs";
import path from "node:path";

function parseArgs(argv) {
  const args = {
    runDir: null,
    out: null,
    max: Infinity,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--run-dir") args.runDir = argv[++i];
    else if (a === "--out") args.out = argv[++i];
    else if (a === "--max") args.max = Number(argv[++i] ?? "0");
    else if (a === "--help" || a === "-h") {
      console.log(`
Usage:
  node evaluation/real/make-slib-list.mjs --run-dir <DIR> --out <FILE> [--max N]
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

async function main() {
  const args = parseArgs(process.argv);
  const runDir = path.resolve(args.runDir);
  const inPath = path.join(runDir, "results.jsonl");
  const outPath = path.resolve(args.out);

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
    const codeCount = counts && typeof counts === "object" ? Object.keys(counts).length : 0;
    if (!libLike || codeCount === 0) continue;

    seen.add(url);
    urls.push(url);
    if (urls.length >= args.max) break;
  }

  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, urls.join("\n") + "\n");
  console.error(`wrote ${urls.length} urls to ${outPath}`);
}

main().catch((e) => {
  console.error(e?.stack || String(e));
  process.exit(1);
});


