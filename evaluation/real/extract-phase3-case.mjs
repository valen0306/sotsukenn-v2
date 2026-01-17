#!/usr/bin/env node
/**
 * Extract a single Phase3 case (one repo) from an out-dir produced by phase3-run.mjs.
 *
 * Usage:
 *   node evaluation/real/extract-phase3-case.mjs --out-dir <DIR> --url <REPO_URL>
 *   node evaluation/real/extract-phase3-case.mjs --out-dir <DIR> --slug <SLUG>
 *
 * If the run was executed in --mode model and the adapter returned cache_key,
 * this script can print the path to the cached adapter JSON and show a small d.ts excerpt.
 */
import { promises as fs } from "node:fs";
import path from "node:path";

function parseArgs(argv) {
  const args = { outDir: null, url: null, slug: null, dtsHead: 120 };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out-dir") args.outDir = argv[++i];
    else if (a === "--url") args.url = argv[++i];
    else if (a === "--slug") args.slug = argv[++i];
    else if (a === "--dts-head") args.dtsHead = Number(argv[++i] ?? "120");
    else if (a === "--help" || a === "-h") {
      console.log(`Usage:
  node evaluation/real/extract-phase3-case.mjs --out-dir <DIR> (--url <URL> | --slug <SLUG>) [--dts-head <N>]
`);
      process.exit(0);
    } else {
      console.error(`Unknown arg: ${a}`);
      process.exit(1);
    }
  }
  if (!args.outDir) throw new Error("missing --out-dir");
  if (!args.url && !args.slug) throw new Error("missing --url or --slug");
  if (!Number.isFinite(args.dtsHead) || args.dtsHead < 0) args.dtsHead = 120;
  return args;
}

const CORE = ["TS2339", "TS2345", "TS2322", "TS2554", "TS2769", "TS2353", "TS2741", "TS7053"];
function coreTotal(counts) {
  let n = 0;
  for (const c of CORE) n += counts?.[c] ?? 0;
  return n;
}

async function main() {
  const args = parseArgs(process.argv);
  const outDir = path.resolve(args.outDir);
  const resultsPath = path.join(outDir, "results.jsonl");
  const txt = await fs.readFile(resultsPath, "utf8");
  const lines = txt.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const rows = lines.map((l) => JSON.parse(l));

  const row = rows.find((r) => (args.url ? r.url === args.url : r.slug === args.slug));
  if (!row) {
    console.error("not found");
    process.exit(2);
  }

  const baseCounts = row.baseline?.tsErrorCounts ?? {};
  const injCounts = row.injected?.tsErrorCounts ?? {};
  const baseCore = coreTotal(baseCounts);
  const injCore = coreTotal(injCounts);

  console.log("url", row.url);
  console.log("slug", row.slug);
  console.log("skipped", row.skipped, row.skipReason ?? "");
  console.log("baseline_exit", row.baseline?.exitCode);
  console.log("injected_exit", row.injected?.exitCode);
  console.log("core_total", `${baseCore} -> ${injCore} (delta ${injCore - baseCore})`);
  console.log(
    "core_by_code",
    CORE.map((c) => `${c}:${baseCounts[c] ?? 0}->${injCounts[c] ?? 0}`).join(" "),
  );

  const mo = row.phase3?.modelOutput ?? null;
  if (mo?.cacheKey) {
    const cacheDir = row.phase3?.modelCacheDir || "evaluation/real/cache/typebert";
    const cachePath = path.resolve(cacheDir, `${mo.cacheKey}.json`);
    console.log("model_output_cache", cachePath);
    const cacheTxt = await fs.readFile(cachePath, "utf8").catch(() => null);
    if (cacheTxt) {
      const cacheObj = JSON.parse(cacheTxt);
      const dts = String(cacheObj?.dts ?? "");
      const meta = cacheObj?.meta ?? null;
      if (meta) {
        console.log("model_meta", JSON.stringify(meta, null, 2));
      }
      if (args.dtsHead > 0 && dts) {
        console.log("\n--- dts_head ---");
        console.log(dts.split(/\r?\n/).slice(0, args.dtsHead).join("\n"));
      }
    } else {
      console.log("model_output_cache_read_failed");
    }
  } else {
    console.log("model_output_cache", "(missing cache_key; re-run with updated adapter to enable)");
  }
}

main().catch((e) => {
  console.error(e?.stack || String(e));
  process.exit(1);
});


