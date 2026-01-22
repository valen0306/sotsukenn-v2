#!/usr/bin/env node
/**
 * Merge React cohorts from multiple evaluation results.
 * Week8: 複数の評価結果からReact層を抽出して統合
 *
 * Usage:
 *   node evaluation/real/merge-react-cohorts.mjs --dirs evaluation/real/out/phase5-*-max30 --output react_cohort_merged.jsonl
 */
import fs from "node:fs/promises";
import path from "node:path";
import { execSync } from "node:child_process";

function parseArgs(argv) {
  const args = { dirs: [], output: "react_cohort_merged.jsonl" };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dirs") {
      // Support glob pattern
      const pattern = String(argv[++i] ?? "");
      if (pattern) args.dirs.push(pattern);
    } else if (a === "--output") args.output = String(argv[++i] ?? "react_cohort_merged.jsonl");
    else if (a === "-h" || a === "--help") {
      console.log("Usage: node evaluation/real/merge-react-cohorts.mjs --dirs <PATTERN> [--output <FILE>]");
      process.exit(0);
    }
  }
  return args;
}

function readJsonl(txt) {
  return txt
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => JSON.parse(s));
}

async function findDirs(pattern) {
  const dirs = [];
  try {
    // Try using find command
    const result = execSync(`find evaluation/real/out -type d -name "${pattern}" 2>/dev/null`, { 
      encoding: "utf8", 
      cwd: process.cwd(),
      maxBuffer: 10 * 1024 * 1024 
    });
    dirs.push(...result.split("\n").filter((d) => d.trim()));
  } catch (e) {
    // Fallback: read directory and match
    try {
      const baseDir = "evaluation/real/out";
      const files = await fs.readdir(baseDir);
      const regex = new RegExp(pattern.replace(/\*/g, ".*"));
      for (const f of files) {
        if (regex.test(f)) {
          dirs.push(path.join(baseDir, f));
        }
      }
    } catch (e2) {
      // Ignore
    }
  }
  return dirs;
}

async function main() {
  const args = parseArgs(process.argv);
  
  if (args.dirs.length === 0) {
    console.error("missing --dirs");
    process.exit(2);
  }

  const allCohorts = new Map(); // url -> entry (latest)
  const sources = new Set();

  // Find all matching directories
  for (const pattern of args.dirs) {
    const dirs = await findDirs(pattern);
    for (const dir of dirs) {
      const cohortFile = path.join(dir, "react_cohort.jsonl");
      // Try both react_cohort.jsonl and react_cohort_top5.jsonl
      for (const cohortFileName of ["react_cohort.jsonl", "react_cohort_top5.jsonl"]) {
        const cohortFile = path.join(dir, cohortFileName);
        try {
          const txt = await fs.readFile(cohortFile, "utf8");
          const entries = readJsonl(txt);
          for (const entry of entries) {
            const url = entry.url;
            if (url) {
              // Keep latest entry if duplicate (prefer newer source)
              if (!allCohorts.has(url)) {
                entry.source_dir = dir;
                // Normalize field names
                if (entry.top3_modules && !entry.topN_modules) {
                  entry.topN_modules = entry.top3_modules;
                }
                allCohorts.set(url, entry);
                sources.add(dir);
              }
            }
          }
          if (entries.length > 0) {
            console.log(`  loaded ${entries.length} entries from ${dir}/${cohortFileName}`);
          }
          break; // Found file, no need to try other names
        } catch (e) {
          // File doesn't exist, continue to next name
        }
      }
    }
  }

  const merged = Array.from(allCohorts.values());
  
  // Sort by URL for consistency
  merged.sort((a, b) => String(a.url ?? "").localeCompare(String(b.url ?? "")));

  // Output
  const outputPath = path.resolve(args.output);
  const lines = merged.map((e) => {
    const { source_dir, ...entry } = e;
    return JSON.stringify(entry);
  });
  await fs.writeFile(outputPath, lines.join("\n") + "\n", "utf8");

  // Statistics
  const stats = {
    total: merged.length,
    has_win_symbol: merged.filter((e) => e.has_win_symbol).length,
    sources_count: new Set(sources).size,
  };

  console.log("\nMerged React cohort:");
  console.log(`  total repos: ${stats.total}`);
  console.log(`  has react win symbol: ${stats.has_win_symbol}`);
  console.log(`  sources: ${stats.sources_count} evaluation directories`);
  console.log(`wrote\t${outputPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

