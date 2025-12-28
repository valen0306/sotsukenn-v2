#!/usr/bin/env node
/**
 * Fetch GitHub repository URLs via GitHub Search API and write to repos.txt.
 *
 * Requires:
 *   export GITHUB_TOKEN=...
 *
 * Usage:
 *   node scripts/select-github-repos.mjs \
 *     --query "language:TypeScript stars:>=50 archived:false fork:false" \
 *     --out tsc-error-data-set/sources/repos.txt \
 *     --max 200
 *
 * Multiple queries:
 *   node scripts/select-github-repos.mjs --queries-file queries.txt --out repos.txt --max 500
 *
 * Notes:
 * - GitHub Search API returns at most 1000 results per query (pagination limit).
 * - We dedupe by full_name; output is HTTPS clone URL (ends with .git).
 */

import { promises as fs } from "node:fs";
import path from "node:path";

function parseArgs(argv) {
  const args = {
    query: null,
    queriesFile: null,
    out: "tsc-error-data-set/sources/repos.txt",
    max: 200,
    perPage: 100,
    sort: "stars", // stars | updated | best-match
    order: "desc", // desc | asc
    verbose: false,
    tokenEnv: "GITHUB_TOKEN",
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--query") args.query = argv[++i];
    else if (a === "--queries-file") args.queriesFile = argv[++i];
    else if (a === "--out") args.out = argv[++i];
    else if (a === "--max") args.max = Number(argv[++i] ?? "200");
    else if (a === "--per-page") args.perPage = Number(argv[++i] ?? "100");
    else if (a === "--sort") args.sort = argv[++i];
    else if (a === "--order") args.order = argv[++i];
    else if (a === "--token-env") args.tokenEnv = argv[++i];
    else if (a === "--verbose") args.verbose = true;
    else if (a === "--help" || a === "-h") {
      printHelpAndExit(0);
    } else {
      console.error(`Unknown arg: ${a}`);
      printHelpAndExit(1);
    }
  }
  if (!args.query && !args.queriesFile) {
    console.error("Provide --query or --queries-file");
    printHelpAndExit(1);
  }
  if (!Number.isFinite(args.max) || args.max < 1) args.max = 200;
  if (!Number.isFinite(args.perPage) || args.perPage < 1 || args.perPage > 100) args.perPage = 100;
  return args;
}

function printHelpAndExit(code) {
  console.log(`
Usage:
  node scripts/select-github-repos.mjs --query "<q>" [options]
  node scripts/select-github-repos.mjs --queries-file <file> [options]

Options:
  --out <FILE>         Output repos.txt path (default: tsc-error-data-set/sources/repos.txt)
  --max <N>            Max number of repos to output across queries (default: 200)
  --per-page <N>       Per page (1..100, default: 100)
  --sort <stars|updated|best-match>  (default: stars)
  --order <asc|desc>   (default: desc)
  --token-env <NAME>   Env var name for token (default: GITHUB_TOKEN)
  --verbose            Log progress to stderr

Example queries:
  language:TypeScript stars:>=50 archived:false fork:false
  language:JavaScript  stars:>=50 archived:false fork:false
`);
  process.exit(code);
}

async function readQueriesFile(p) {
  const txt = await fs.readFile(p, "utf8");
  return txt
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !s.startsWith("#"));
}

async function ghSearch({ token, q, sort, order, page, perPage }) {
  const url = new URL("https://api.github.com/search/repositories");
  url.searchParams.set("q", q);
  url.searchParams.set("per_page", String(perPage));
  if (sort && sort !== "best-match") url.searchParams.set("sort", sort);
  if (order) url.searchParams.set("order", order);
  url.searchParams.set("page", String(page));

  const res = await fetch(url, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "tsc-error-dataset-collector",
    },
  });
  const remaining = res.headers.get("x-ratelimit-remaining");
  const reset = res.headers.get("x-ratelimit-reset");
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`GitHub API error: ${res.status} ${res.statusText} (remaining=${remaining} reset=${reset})\n${txt}`);
  }
  const json = await res.json();
  return { json, remaining, reset };
}

async function main() {
  const args = parseArgs(process.argv);
  const token = process.env[args.tokenEnv];
  if (!token) {
    console.error(`Missing ${args.tokenEnv}. Set it to a GitHub token with public_repo access.`);
    process.exit(1);
  }

  const queries = args.query ? [args.query] : await readQueriesFile(path.resolve(args.queriesFile));
  const outPath = path.resolve(args.out);
  await fs.mkdir(path.dirname(outPath), { recursive: true });

  const seen = new Set(); // full_name
  const urls = [];

  for (const q of queries) {
    if (urls.length >= args.max) break;
    if (args.verbose) console.error(`Query: ${q}`);

    // Up to 10 pages * 100 = 1000 results max via Search API.
    for (let page = 1; page <= 10; page++) {
      if (urls.length >= args.max) break;
      const { json, remaining, reset } = await ghSearch({
        token,
        q,
        sort: args.sort,
        order: args.order,
        page,
        perPage: args.perPage,
      });

      if (args.verbose) {
        console.error(`  page=${page} items=${json.items?.length ?? 0} remaining=${remaining ?? "?"} reset=${reset ?? "?"}`);
      }

      const items = Array.isArray(json.items) ? json.items : [];
      if (items.length === 0) break;

      for (const it of items) {
        const fullName = it?.full_name;
        const cloneUrl = it?.clone_url;
        if (typeof fullName !== "string" || typeof cloneUrl !== "string") continue;
        if (seen.has(fullName)) continue;
        seen.add(fullName);
        urls.push(cloneUrl.endsWith(".git") ? cloneUrl : `${cloneUrl}.git`);
        if (urls.length >= args.max) break;
      }

      // Stop early if we already covered all results
      const total = Number(json.total_count ?? 0);
      if (total <= page * args.perPage) break;
    }
  }

  const header = [
    "# One repo URL per line. Lines starting with # are comments.",
    `# Generated by scripts/select-github-repos.mjs at ${new Date().toISOString()}`,
    `# count=${urls.length}`,
    "",
  ].join("\n");
  await fs.writeFile(outPath, header + urls.join("\n") + "\n");

  if (args.verbose) console.error(`Wrote ${urls.length} repos to ${outPath}`);
}

main().catch((e) => {
  console.error(e?.stack || String(e));
  process.exit(1);
});


