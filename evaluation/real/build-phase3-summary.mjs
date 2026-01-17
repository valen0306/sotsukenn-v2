#!/usr/bin/env node
/**
 * Build <outDir>/summary.tsv from <outDir>/results.jsonl.
 *
 * This is useful when results.jsonl was created by a merge tool and summary.tsv is missing.
 *
 * Usage:
 *   node evaluation/real/build-phase3-summary.mjs --out-dir <DIR>
 */
import { promises as fs } from "node:fs";
import path from "node:path";

const PHASE3_CODES = new Set(["TS2339", "TS2345", "TS2322", "TS2554", "TS2769", "TS2353", "TS2741", "TS7053"]);

function parseArgs(argv) {
  const args = { outDir: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out-dir") args.outDir = argv[++i];
    else if (a === "--help" || a === "-h") {
      console.log(`Usage:
  node evaluation/real/build-phase3-summary.mjs --out-dir <DIR>
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
  return args;
}

function sumPhase3(counts) {
  let n = 0;
  for (const c of PHASE3_CODES) n += counts?.[c] ?? 0;
  return n;
}

async function main() {
  const args = parseArgs(process.argv);
  const outDir = path.resolve(args.outDir);
  const resultsPath = path.join(outDir, "results.jsonl");
  const summaryPath = path.join(outDir, "summary.tsv");
  const txt = await fs.readFile(resultsPath, "utf8");
  const lines = txt.split(/\r?\n/).filter((l) => l.trim().length > 0);

  const header = [
    "url",
    "skipped",
    "skipReason",
    "baselineExit",
    "baselinePhase3",
    "baselineTS2339",
    "baselineTS2345",
    "baselineTS2322",
    "baselineTS2554",
    "baselineTS2769",
    "baselineTS2353",
    "baselineTS2741",
    "baselineTS7053",
    "injectedExit",
    "injectedPhase3",
    "injectedTS2339",
    "injectedTS2345",
    "injectedTS2322",
    "injectedTS2554",
    "injectedTS2769",
    "injectedTS2353",
    "injectedTS2741",
    "injectedTS7053",
    "phase3Reduced",
    "phase3Eliminated",
    "phase3DiagFiles",
    "phase3StubModules",
    "phase3OriginalTypesCount",
    "phase3InjectedTypesCount",
    "phase3InjectedDtsInvalid",
    "phase3InjectedDtsSyntaxCodes",
    "trialStrategy",
    "trialMax",
    "trialsRun",
    "chosenCandidateId",
  ].join("\t");

  const rows = [header];
  for (const line of lines) {
    const o = JSON.parse(line);
    const b = o.baseline?.tsErrorCounts ?? {};
    const j = o.injected?.tsErrorCounts ?? {};
    const bPhase3 = sumPhase3(b);
    const jPhase3 = sumPhase3(j);
    rows.push(
      [
        o.url,
        o.skipped ? "true" : "false",
        o.skipReason ?? "",
        o.baseline?.exitCode ?? "",
        bPhase3,
        b.TS2339 ?? 0,
        b.TS2345 ?? 0,
        b.TS2322 ?? 0,
        b.TS2554 ?? 0,
        b.TS2769 ?? 0,
        b.TS2353 ?? 0,
        b.TS2741 ?? 0,
        b.TS7053 ?? 0,
        o.injected?.exitCode ?? "",
        jPhase3,
        j.TS2339 ?? 0,
        j.TS2345 ?? 0,
        j.TS2322 ?? 0,
        j.TS2554 ?? 0,
        j.TS2769 ?? 0,
        j.TS2353 ?? 0,
        j.TS2741 ?? 0,
        j.TS7053 ?? 0,
        o.phase3?.reduced ? "true" : "false",
        o.phase3?.eliminated ? "true" : "false",
        o.phase3?.diagFiles?.length ?? 0,
        o.phase3?.stubModulesCount ?? 0,
        o.phase3?.originalTypesCount ?? "",
        o.phase3?.injectedTypesCount ?? "",
        o.phase3?.injectedDtsInvalid ? "true" : "false",
        (o.phase3?.injectedDtsSyntaxCodes ?? []).join(","),
        o.phase3?.trial?.strategy ?? "",
        o.phase3?.trial?.max ?? "",
        o.phase3?.trial?.trialsRun ?? "",
        o.phase3?.trial?.chosenCandidateId ?? "",
      ].join("\t"),
    );
  }
  await fs.writeFile(summaryPath, rows.join("\n") + "\n");
  console.log(`wrote_summary\t${summaryPath}`);
}

main().catch((e) => {
  console.error(e?.stack || String(e));
  process.exit(1);
});


