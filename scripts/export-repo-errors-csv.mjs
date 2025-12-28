#!/usr/bin/env node
/**
 * Export "this repo had these TS error codes" as a repo-level CSV.
 *
 * Input: results.jsonl produced by scripts/collect-tsc-error-dataset.mjs
 * Output: one row per repo:
 *   url,slug,repoDir,skipped,skipReason,exitCode,timedOut,libraryCallLike,codeCount,codes,topCode,topCodeOccurrences,totalOccurrences
 *
 * Usage:
 *   node scripts/export-repo-errors-csv.mjs --run-dir tsc-error-data-set/runs/ts200
 *   node scripts/export-repo-errors-csv.mjs --in tsc-error-data-set/runs/ts200/results.jsonl --out repo-errors.csv
 */

import { promises as fs } from "node:fs";
import path from "node:path";

function parseArgs(argv) {
  const args = {
    runDir: null,
    inFile: null,
    outFile: null,
    onlyWithErrors: false,
    onlyLibraryCallLike: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--run-dir") args.runDir = argv[++i];
    else if (a === "--in") args.inFile = argv[++i];
    else if (a === "--out") args.outFile = argv[++i];
    else if (a === "--only-with-errors") args.onlyWithErrors = true;
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
  if (args.runDir && !args.inFile) args.inFile = path.join(args.runDir, "results.jsonl");
  if (args.runDir && !args.outFile) args.outFile = path.join(args.runDir, "repo-errors.csv");
  if (!args.outFile) args.outFile = "repo-errors.csv";
  return args;
}

function printHelpAndExit(code) {
  console.log(`
Usage:
  node scripts/export-repo-errors-csv.mjs --run-dir <DIR> [options]
  node scripts/export-repo-errors-csv.mjs --in <results.jsonl> --out <csv> [options]

Options:
  --only-with-errors         Keep only repos with at least one TS error code
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

function summarizeCounts(counts) {
  const entries = Object.entries(counts ?? {})
    .map(([k, v]) => [normalizeCode(k), Number(v) || 0])
    .filter(([k]) => Boolean(k));

  entries.sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])));

  const codes = entries.map(([k]) => k);
  const top = entries[0] ?? [null, 0];
  const totalOccurrences = entries.reduce((acc, [, n]) => acc + n, 0);
  return {
    codeCount: codes.length,
    codes,
    topCode: top[0],
    topCodeOccurrences: top[1],
    totalOccurrences,
  };
}

async function main() {
  const args = parseArgs(process.argv);
  const inPath = path.resolve(args.inFile);
  const outPath = path.resolve(args.outFile);

  const txt = await fs.readFile(inPath, "utf8");
  const lines = txt.split(/\r?\n/).filter((l) => l.trim().length > 0);

  const header = [
    "url",
    "slug",
    "repoDir",
    "skipped",
    "skipReason",
    "exitCode",
    "timedOut",
    "libraryCallLike",
    "codeCount",
    "codes",
    "topCode",
    "topCodeOccurrences",
    "totalOccurrences",
  ].join(",");

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
    let scan = null;
    if (typeof scanLine === "string" && scanLine.trim().startsWith("{")) {
      try {
        scan = JSON.parse(scanLine);
      } catch {
        scan = null;
      }
    }

    const skipped = Boolean(scan?.skipped);
    const skipReason = scan?.skipReason ?? "";
    const exitCode = scan?.exitCode ?? "";
    const timedOut = Boolean(scan?.timedOut);
    const libraryCallLike = Boolean(scan?.libraryCallLike?.hasAny);
    if (args.onlyLibraryCallLike && !libraryCallLike) continue;

    const counts = scan?.tsErrorCounts ?? {};
    const summary = summarizeCounts(counts);
    if (args.onlyWithErrors && summary.codeCount === 0) continue;

    out.push(
      [
        csvEscape(url),
        csvEscape(slug),
        csvEscape(repoDir),
        csvEscape(skipped ? "true" : "false"),
        csvEscape(skipReason),
        csvEscape(exitCode),
        csvEscape(timedOut ? "true" : "false"),
        csvEscape(libraryCallLike ? "true" : "false"),
        csvEscape(summary.codeCount),
        csvEscape(summary.codes.join(";")),
        csvEscape(summary.topCode ?? ""),
        csvEscape(summary.topCodeOccurrences),
        csvEscape(summary.totalOccurrences),
      ].join(","),
    );
  }

  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, out.join("\n") + "\n");
  console.error(`Wrote ${out.length - 1} repos to ${outPath}`);
}

main().catch((e) => {
  console.error(e?.stack || String(e));
  process.exit(1);
});


