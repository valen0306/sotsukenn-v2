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
 *  - JSONL, one line per pair: (A,B,label,features)
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

function sumPhase3Core(tsCounts) {
  const PHASE3 = ["TS2339", "TS2345", "TS2322", "TS2554", "TS2769", "TS2353", "TS2741", "TS7053"];
  let n = 0;
  for (const c of PHASE3) n += Number(tsCounts?.[c] ?? 0) || 0;
  return n;
}

function getCount(tsCounts, code) {
  return Number(tsCounts?.[code] ?? 0) || 0;
}

function extractModuleMentionsFromDiagnostics(diags) {
  // Extract `"module"` or 'module' mentions from TS messages like:
  // Module '"lucide-react"' has no exported member ...
  const out = new Map(); // module -> count
  const re = /['"]([^'"]+)['"]/g;
  for (const d of diags ?? []) {
    const msg = String(d?.msg ?? "");
    let m;
    while ((m = re.exec(msg)) !== null) {
      const s = (m[1] ?? "").trim();
      if (!s) continue;
      out.set(s, (out.get(s) ?? 0) + 1);
    }
  }
  return out;
}

function findLocalizerFreq(r, mod) {
  const arr = r?.phase3?.localizer?.topModuleFreq ?? [];
  for (const x of arr) {
    if (x?.module === mod) return Number(x?.freq ?? 0) || 0;
  }
  return 0;
}

function findLocalizerRank(r, mod) {
  const arr = r?.phase3?.localizer?.topModuleFreq ?? [];
  for (let i = 0; i < arr.length; i++) {
    if (arr[i]?.module === mod) return i + 1; // 1-based
  }
  return 0;
}

function extractModuleMentionsByCode(diags) {
  const out = new Map(); // code -> Map(module->count)
  const re = /['"]([^'"]+)['"]/g;
  for (const d of diags ?? []) {
    const code = String(d?.code ?? "");
    if (!code) continue;
    const msg = String(d?.msg ?? "");
    let m;
    while ((m = re.exec(msg)) !== null) {
      const s = (m[1] ?? "").trim();
      if (!s) continue;
      const mm = out.get(code) ?? new Map();
      mm.set(s, (mm.get(s) ?? 0) + 1);
      out.set(code, mm);
    }
  }
  return out;
}

function buildCandidateFeatures({ repoRow, trial }) {
  const moduleOverride = trial?.module_override ?? null;
  const hasOverride = moduleOverride ? 1 : 0;
  const baselineCounts = repoRow?.baseline?.tsErrorCounts ?? {};
  const baselineDiags = repoRow?.baseline?.diagnostics ?? [];
  const mentionMap = extractModuleMentionsFromDiagnostics(baselineDiags);
  const mentionByCode = extractModuleMentionsByCode(baselineDiags);
  const mentionCount = moduleOverride ? (mentionMap.get(moduleOverride) ?? 0) : 0;

  return {
    // Candidate-side features (available BEFORE running the candidate `tsc`):
    has_override: hasOverride,
    override_mention_count: mentionCount,
    override_localizer_freq: moduleOverride ? findLocalizerFreq(repoRow, moduleOverride) : 0,
    override_localizer_rank: moduleOverride ? findLocalizerRank(repoRow, moduleOverride) : 0,
    override_is_top1_localizer: moduleOverride ? (findLocalizerRank(repoRow, moduleOverride) === 1 ? 1 : 0) : 0,
    override_mention_ts2307: moduleOverride ? (mentionByCode.get("TS2307")?.get(moduleOverride) ?? 0) : 0,
    override_mention_ts2614: moduleOverride ? (mentionByCode.get("TS2614")?.get(moduleOverride) ?? 0) : 0,
    declaration_count: Number(trial?.declaration_count ?? 0) || 0,
    // Context features (same across candidates for a repo; useful for later richer models):
    baseline_phase3_core: sumPhase3Core(baselineCounts),
    baseline_total_errors: sumObj(baselineCounts),
    baseline_ts2307: getCount(baselineCounts, "TS2307"),
    baseline_ts2614: getCount(baselineCounts, "TS2614"),
    baseline_ts2339: getCount(baselineCounts, "TS2339"),
    baseline_ts2345: getCount(baselineCounts, "TS2345"),
    baseline_ts2322: getCount(baselineCounts, "TS2322"),
    baseline_ts2554: getCount(baselineCounts, "TS2554"),
    baseline_ts2769: getCount(baselineCounts, "TS2769"),
    baseline_ts7053: getCount(baselineCounts, "TS7053"),
  };
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
          const aFeat = buildCandidateFeatures({ repoRow: r, trial: A });
          const bFeat = buildCandidateFeatures({ repoRow: r, trial: B });
          outRows.push({
            url: r.url,
            slug: r.slug,
            outDir: path.basename(outDir),
            trialStrategy: r?.phase3?.trial?.strategy ?? "",
            a: {
              candidate_id: A.candidate_id,
              module_override: A.module_override ?? null,
              declaration_count: A.declaration_count ?? null,
            },
            b: {
              candidate_id: B.candidate_id,
              module_override: B.module_override ?? null,
              declaration_count: B.declaration_count ?? null,
            },
            label,
            // Features for learning (no outcome leakage)
            features: {
              a: aFeat,
              b: bFeat,
            },
            // Debug-only outcomes (NOT for training input)
            meta: {
              objective: "min(delta_phase3) then min(sum(delta_errors))",
              debug_outcome: {
                a_delta_phase3: A.delta_phase3 ?? null,
                b_delta_phase3: B.delta_phase3 ?? null,
              },
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


