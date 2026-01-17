#!/usr/bin/env node
/**
 * Compare two Phase3 out dirs produced by evaluation/real/phase3-run.mjs.
 *
 * Focus:
 * - Phase3 totals
 * - TS2339 deltas
 * - validity (skipReason / injectedDtsInvalid)
 *
 * Usage:
 *  node evaluation/real/compare-phase3-outs.mjs --a <outDirA> --b <outDirB>
 */

import { promises as fs } from "node:fs";
import path from "node:path";

function parseArgs(argv) {
  const args = { a: null, b: null };
  for (let i = 2; i < argv.length; i++) {
    const t = argv[i];
    if (t === "--a") args.a = argv[++i];
    else if (t === "--b") args.b = argv[++i];
    else if (t === "--help" || t === "-h") {
      console.log(`
Usage:
  node evaluation/real/compare-phase3-outs.mjs --a <outDirA> --b <outDirB>
`);
      process.exit(0);
    } else {
      console.error(`Unknown arg: ${t}`);
      process.exit(1);
    }
  }
  if (!args.a || !args.b) {
    console.error("Provide --a and --b");
    process.exit(1);
  }
  return args;
}

function toInt(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
}

async function readSummary(outDir) {
  const p = path.join(outDir, "summary.tsv");
  const txt = await fs.readFile(p, "utf8");
  const lines = txt.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const header = lines[0].split("\t");
  const idx = new Map(header.map((h, i) => [h, i]));
  const rows = [];
  for (const ln of lines.slice(1)) {
    const cols = ln.split("\t");
    const get = (k) => cols[idx.get(k)] ?? "";
    rows.push({
      url: get("url"),
      skipReason: get("skipReason"),
      baselinePhase3: toInt(get("baselinePhase3")),
      injectedPhase3: toInt(get("injectedPhase3")),
      baselineTS2339: toInt(get("baselineTS2339")),
      injectedTS2339: toInt(get("injectedTS2339")),
      injectedDtsInvalid: get("phase3InjectedDtsInvalid") === "true",
    });
  }
  return rows;
}

async function main() {
  const args = parseArgs(process.argv);
  const aDir = path.resolve(args.a);
  const bDir = path.resolve(args.b);
  const a = await readSummary(aDir);
  const b = await readSummary(bDir);

  const aBy = new Map(a.map((r) => [r.url, r]));
  const bBy = new Map(b.map((r) => [r.url, r]));
  const urls = [...new Set([...aBy.keys(), ...bBy.keys()])].sort();

  console.log(["url", "A_skip", "B_skip", "A_invalid", "B_invalid", "A_TS2339", "B_TS2339", "delta_TS2339", "A_Ph3", "B_Ph3", "delta_Ph3"].join("\t"));
  for (const url of urls) {
    const ra = aBy.get(url);
    const rb = bBy.get(url);
    if (!ra || !rb) continue;
    const d2339 = rb.injectedTS2339 - ra.injectedTS2339;
    const dph3 = rb.injectedPhase3 - ra.injectedPhase3;
    console.log(
      [
        url,
        ra.skipReason || "",
        rb.skipReason || "",
        ra.injectedDtsInvalid ? "true" : "false",
        rb.injectedDtsInvalid ? "true" : "false",
        ra.injectedTS2339,
        rb.injectedTS2339,
        d2339,
        ra.injectedPhase3,
        rb.injectedPhase3,
        dph3,
      ].join("\t"),
    );
  }
}

main().catch((e) => {
  console.error(e?.stack || String(e));
  process.exit(1);
});


