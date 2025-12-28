#!/usr/bin/env node
/**
 * Export "which repos had which TS error codes" to a CSV (URL included).
 *
 * Input: results.jsonl produced by scripts/collect-tsc-error-dataset.mjs
 * Each line includes { url, slug, repoDir, scan: { line: "<scanner-json>" }, ... }
 *
 * Output: long-form CSV rows:
 *   code,url,slug,repoDir,occurrences,libraryCallLike
 *
 * Usage:
 *   node scripts/export-code-repos-csv.mjs --run-dir tsc-error-data-set/runs/ts200
 *   node scripts/export-code-repos-csv.mjs --in tsc-error-data-set/runs/ts200/results.jsonl --out codes.csv
 *   node scripts/export-code-repos-csv.mjs --run-dir ... --code TS2339
 */

import { promises as fs } from "node:fs";
import path from "node:path";

function parseArgs(argv) {
  const args = {
    runDir: null,
    inFile: null,
    outFile: null,
    code: null,
    onlyLibraryCallLike: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--run-dir") args.runDir = argv[++i];
    else if (a === "--in") args.inFile = argv[++i];
    else if (a === "--out") args.outFile = argv[++i];
    else if (a === "--code") args.code = argv[++i];
    else if (a === "--only-library-call-like") args.onlyLibraryCallLike = true;
    else if (a === "--help" || a === "-h") {
      printHelpAndExit(0);
    } else {
      console.error(`Unknown arg: ${a}`);
      printHelpAndExit(1);
    }
  }

  if (!args.inFile && !args.runDir) {
    console.error("Provide --run-dir <DIR> or --in <results.jsonl>");
    printHelpAndExit(1);
  }
  if (args.runDir && !args.inFile) {
    args.inFile = path.join(args.runDir, "results.jsonl");
  }
  if (args.runDir && !args.outFile) {
    args.outFile = path.join(args.runDir, "code-repos.csv");
  }
  if (!args.outFile) args.outFile = "code-repos.csv";
  return args;
}

function printHelpAndExit(code) {
  console.log(`
Usage:
  node scripts/export-code-repos-csv.mjs --run-dir <DIR> [options]
  node scripts/export-code-repos-csv.mjs --in <results.jsonl> --out <csv> [options]

Options:
  --code TS1234              Filter to a single TS error code
  --only-library-call-like   Keep only repos where scanner said libraryCallLike=true
`);
  process.exit(code);
}

function csvEscape(v) {
  const s = String(v ?? "");
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function normalizeCode(code) {
  if (!code) return null;
  const c = String(code).trim().toUpperCase();
  if (!/^TS\d{4}$/.test(c)) return null;
  return c;
}

async function main() {
  const args = parseArgs(process.argv);
  const inPath = path.resolve(args.inFile);
  const outPath = path.resolve(args.outFile);
  const filterCode = normalizeCode(args.code);
  if (args.code && !filterCode) {
    console.error(`Invalid --code: ${args.code} (expected TS1234)`);
    process.exit(1);
  }

  const txt = await fs.readFile(inPath, "utf8");
  const lines = txt.split(/\r?\n/).filter((l) => l.trim().length > 0);

  const header = ["code", "url", "slug", "repoDir", "occurrences", "libraryCallLike"].join(",");
  const out = [header];

  for (const line of lines) {
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }

    const url = obj?.url ?? "";
    const slug = obj?.slug ?? "";
    const repoDir = obj?.repoDir ?? "";
    const scanLine = obj?.scan?.line;
    if (typeof scanLine !== "string" || !scanLine.trim().startsWith("{")) continue;

    let scan;
    try {
      scan = JSON.parse(scanLine);
    } catch {
      continue;
    }

    const libraryCallLike = Boolean(scan?.libraryCallLike?.hasAny);
    if (args.onlyLibraryCallLike && !libraryCallLike) continue;

    const counts = scan?.tsErrorCounts ?? {};
    if (!counts || typeof counts !== "object") continue;

    for (const [code, occurrences] of Object.entries(counts)) {
      const c = normalizeCode(code);
      if (!c) continue;
      if (filterCode && c !== filterCode) continue;
      const n = Number(occurrences) || 0;
      out.push(
        [
          csvEscape(c),
          csvEscape(url),
          csvEscape(slug),
          csvEscape(repoDir),
          csvEscape(n),
          csvEscape(libraryCallLike ? "true" : "false"),
        ].join(","),
      );
    }
  }

  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, out.join("\n") + "\n");
  console.error(`Wrote ${out.length - 1} rows to ${outPath}`);
}

main().catch((e) => {
  console.error(e?.stack || String(e));
  process.exit(1);
});


