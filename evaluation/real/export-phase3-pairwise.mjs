#!/usr/bin/env node
/**
 * Export weakly-supervised pairwise ranking dataset from Phase3 real-run outputs.
 *
 * Source signal:
 *  - trials[].delta_phase3  (lower is better)
 *  - trials[].delta_errors  (optional tie-break via total delta error sum; lower is better)
 *
 * Input:
 *  - one or more <outDir>/results.jsonl produced by evaluation/real/phase3-run.mjs
 *
 * Output:
 *  - JSONL, one line per pair: (A,B,label)
 *
 * Usage:
 *  node evaluation/real/export-phase3-pairwise.mjs \
 *    --out-dir evaluation/real/out/phase2-B1-sweep-nolocalizer-max20 \
 *    --out-dir evaluation/real/out/phase2-A1-localizer3-sweep-max20 \
 *    --out-file evaluation/real/out/phase3-pairwise-max20.jsonl
 */

import { promises as fs } from "node:fs";
import path from "node:path";

function parseArgs(argv) {
  const args = { outDirs: [], outFile: null, maxPairsPerRepo: Infinity, requireValid: true };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out-dir") args.outDirs.push(argv[++i]);
    else if (a === "--out-file") args.outFile = argv[++i];
    else if (a === "--max-pairs-per-repo") args.maxPairsPerRepo = Number(argv[++i] ?? "0");
    else if (a === "--allow-invalid") args.requireValid = false;
    else if (a === "--help" || a === "-h") {
      console.log(`
Usage:
  node evaluation/real/export-phase3-pairwise.mjs --out-dir <DIR> [--out-dir <DIR> ...] --out-file <FILE>

Options:
  --max-pairs-per-repo <N>  Cap pairs per repo (default: unlimited)
  --allow-invalid           Include invalid injections (default: exclude invalid/timeout)
`);
      process.exit(0);
    } else {
      console.error(`Unknown arg: ${a}`);
      process.exit(1);
    }
  }
  if (!args.outDirs.length) {
    console.error("Provide at least one --out-dir <DIR>");
    process.exit(1);
  }
  if (!args.outFile) {
    console.error("Provide --out-file <FILE>");
    process.exit(1);
  }
  if (!Number.isFinite(args.maxPairsPerRepo) || args.maxPairsPerRepo < 1) args.maxPairsPerRepo = Infinity;
  return args;
}

function sumObj(obj) {
  let s = 0;
  for (const v of Object.values(obj ?? {})) s += Number(v) || 0;
  return s;
}

function isTrialValid(t) {
  return Boolean(t?.valid_injection) && !Boolean(t?.injected_dts_invalid) && !Boolean(t?.injected_timed_out);
}

function better(a, b) {
  // Primary: delta_phase3 (lower is better)
  const da = Number(a?.delta_phase3 ?? 0);
  const db = Number(b?.delta_phase3 ?? 0);
  if (da !== db) return da < db;
  // Tie-break: total delta errors (lower is better)
  const ta = sumObj(a?.delta_errors);
  const tb = sumObj(b?.delta_errors);
  if (ta !== tb) return ta < tb;
  // Final tie: stable by candidate_id
  return String(a?.candidate_id ?? "") < String(b?.candidate_id ?? "");
}

async function readJsonl(p) {
  const txt = await fs.readFile(p, "utf8");
  const rows = [];
  for (const ln of txt.split(/\r?\n/)) {
    if (!ln.trim()) continue;
    try {
      rows.push(JSON.parse(ln));
    } catch {
      // ignore
    }
  }
  return rows;
}

async function main() {
  const args = parseArgs(process.argv);
  const outRows = [];

  let repos = 0;
  let reposWithPairs = 0;
  let totalPairs = 0;

  for (const od of args.outDirs) {
    const outDir = path.resolve(od);
    const resultsPath = path.join(outDir, "results.jsonl");
    const rows = await readJsonl(resultsPath);
    for (const r of rows) {
      repos++;
      if (r?.skipReason) continue;
      const trials = Array.isArray(r?.trials) ? r.trials : [];
      const usable = args.requireValid ? trials.filter(isTrialValid) : trials;
      if (usable.length < 2) continue;

      let pairsForRepo = 0;
      for (let i = 0; i < usable.length; i++) {
        for (let j = i + 1; j < usable.length; j++) {
          if (pairsForRepo >= args.maxPairsPerRepo) break;
          const A = usable[i];
          const B = usable[j];
          const label = better(A, B) ? 1 : 0; // 1 => A is better than B
          outRows.push({
            url: r.url,
            slug: r.slug,
            outDir: path.basename(outDir),
            trialStrategy: r?.phase3?.trial?.strategy ?? "",
            baseline_ts: r?.baseline?.tsErrorCounts ?? {},
            a: {
              candidate_id: A.candidate_id,
              module_override: A.module_override ?? null,
              delta_phase3: A.delta_phase3 ?? null,
              delta_errors: A.delta_errors ?? {},
              declaration_count: A.declaration_count ?? null,
            },
            b: {
              candidate_id: B.candidate_id,
              module_override: B.module_override ?? null,
              delta_phase3: B.delta_phase3 ?? null,
              delta_errors: B.delta_errors ?? {},
              declaration_count: B.declaration_count ?? null,
            },
            label,
            meta: {
              objective: "min(delta_phase3) then min(sum(delta_errors))",
            },
          });
          pairsForRepo++;
          totalPairs++;
        }
        if (pairsForRepo >= args.maxPairsPerRepo) break;
      }
      if (pairsForRepo > 0) reposWithPairs++;
    }
  }

  await fs.mkdir(path.dirname(path.resolve(args.outFile)), { recursive: true });
  await fs.writeFile(path.resolve(args.outFile), outRows.map((o) => JSON.stringify(o)).join("\n") + "\n");

  console.log(`repos_seen\t${repos}`);
  console.log(`repos_with_pairs\t${reposWithPairs}`);
  console.log(`pairs_total\t${totalPairs}`);
  console.log(`out_file\t${path.resolve(args.outFile)}`);
}

main().catch((e) => {
  console.error(e?.stack || String(e));
  process.exit(1);
});


