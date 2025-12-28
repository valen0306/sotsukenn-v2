#!/usr/bin/env node
/**
 * Summarize a run directory produced by scripts/collect-tsc-error-dataset.mjs
 *
 * Inputs:
 *  - <runDir>/repo-errors.csv (recommended)
 *  - <runDir>/aggregate.tsv   (optional; for quick peek)
 *
 * Output: prints key counts and proportions to stdout.
 *
 * Usage:
 *   node scripts/summarize-tsc-run.mjs --run-dir tsc-error-data-set/runs/ts200
 */

import { promises as fs } from "node:fs";
import path from "node:path";

function parseArgs(argv) {
  const args = { runDir: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--run-dir") args.runDir = argv[++i];
    else if (a === "--help" || a === "-h") {
      console.log("Usage: node scripts/summarize-tsc-run.mjs --run-dir <DIR>");
      process.exit(0);
    } else {
      console.error(`Unknown arg: ${a}`);
      process.exit(1);
    }
  }
  if (!args.runDir) {
    console.error("Provide --run-dir <DIR>");
    process.exit(1);
  }
  return args;
}

function parseCsvLine(line) {
  // Minimal CSV parser for our own generated CSVs:
  // - commas separate fields
  // - fields may be quoted with double-quotes and "" escape
  const out = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else {
      if (ch === ",") {
        out.push(cur);
        cur = "";
      } else if (ch === '"') {
        inQuotes = true;
      } else {
        cur += ch;
      }
    }
  }
  out.push(cur);
  return out;
}

async function readRepoErrorsCsv(p) {
  const txt = await fs.readFile(p, "utf8");
  const lines = txt.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return [];
  const header = parseCsvLine(lines[0]);
  const idx = Object.fromEntries(header.map((h, i) => [h, i]));
  const rows = [];
  for (const line of lines.slice(1)) {
    const cols = parseCsvLine(line);
    const get = (k) => cols[idx[k]] ?? "";
    rows.push({
      url: get("url"),
      skipped: get("skipped") === "true",
      skipReason: get("skipReason"),
      exitCode: get("exitCode"),
      timedOut: get("timedOut") === "true",
      libraryCallLike: get("libraryCallLike") === "true",
      codeCount: Number(get("codeCount") || 0),
      codes: get("codes") ? get("codes").split(";").filter(Boolean) : [],
      totalOccurrences: Number(get("totalOccurrences") || 0),
    });
  }
  return rows;
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
  const totalOccurrences = entries.reduce((acc, [, n]) => acc + n, 0);
  return { codes, codeCount: codes.length, totalOccurrences };
}

async function readRepoRowsFromResultsJsonl(resultsJsonlPath) {
  const txt = await fs.readFile(resultsJsonlPath, "utf8");
  const lines = txt.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const rows = [];
  for (const line of lines) {
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    const url = obj?.url ?? "";
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
    const counts = scan?.tsErrorCounts ?? {};
    const summary = summarizeCounts(counts);
    rows.push({
      url,
      skipped,
      skipReason,
      exitCode,
      timedOut,
      libraryCallLike,
      codeCount: summary.codeCount,
      codes: summary.codes,
      totalOccurrences: summary.totalOccurrences,
    });
  }
  return rows;
}

function pct(n, d) {
  if (!d) return "0.0%";
  return `${((n / d) * 100).toFixed(1)}%`;
}

async function main() {
  const args = parseArgs(process.argv);
  const runDir = path.resolve(args.runDir);
  const repoErrorsPath = path.join(runDir, "repo-errors.csv");
  const resultsJsonlPath = path.join(runDir, "results.jsonl");

  let rows = [];
  try {
    rows = await readRepoErrorsCsv(repoErrorsPath);
  } catch {
    // Fallback: compute from results.jsonl directly (URL exists here)
    rows = await readRepoRowsFromResultsJsonl(resultsJsonlPath);
  }
  const N = rows.length;
  if (N === 0) {
    console.log("No rows found (repo-errors.csv missing/empty and results.jsonl empty).");
    process.exit(0);
  }

  const skipped = rows.filter((r) => r.skipped).length;
  const timedOut = rows.filter((r) => r.timedOut).length;
  const withTsCodes = rows.filter((r) => r.codeCount > 0).length;
  const libLike = rows.filter((r) => r.libraryCallLike).length;
  const libLikeWithCodes = rows.filter((r) => r.libraryCallLike && r.codeCount > 0).length;

  const skipReasons = new Map();
  for (const r of rows) {
    if (!r.skipped) continue;
    const k = r.skipReason || "(unknown)";
    skipReasons.set(k, (skipReasons.get(k) ?? 0) + 1);
  }
  const skipTop = [...skipReasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);

  // Count code presence across repos
  const codePresence = new Map(); // code -> repos count
  for (const r of rows) {
    const uniq = new Set(r.codes);
    for (const c of uniq) codePresence.set(c, (codePresence.get(c) ?? 0) + 1);
  }
  const topCodes = [...codePresence.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20);

  console.log(`run_dir\t${runDir}`);
  console.log(`repos_total\t${N}`);
  console.log(`skipped\t${skipped}\t(${pct(skipped, N)})`);
  console.log(`timed_out\t${timedOut}\t(${pct(timedOut, N)})`);
  console.log(`repos_with_ts_codes(codeCount>0)\t${withTsCodes}\t(${pct(withTsCodes, N)})`);
  console.log(`repos_libraryCallLike\t${libLike}\t(${pct(libLike, N)})`);
  console.log(`repos_libraryCallLike_and_ts_codes\t${libLikeWithCodes}\t(${pct(libLikeWithCodes, N)})`);

  console.log(`\nskip_reason_top10`);
  for (const [k, v] of skipTop) console.log(`${v}\t${k}`);

  console.log(`\ncode_presence_top20 (repos_count)`);
  for (const [c, v] of topCodes) console.log(`${v}\t${c}`);
}

main().catch((e) => {
  console.error(e?.stack || String(e));
  process.exit(1);
});


