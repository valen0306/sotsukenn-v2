#!/usr/bin/env node
/**
 * Collect a TS error-code dataset by cloning many repos and running tsc/typecheck.
 *
 * It clones into: tsc-error-data-set/work/<slug>
 * It writes run artifacts into: <out-dir>/<timestamp>/
 *
 * Usage:
 *   node scripts/collect-tsc-error-dataset.mjs \
 *     --repos-file tsc-error-data-set/sources/repos.txt \
 *     --out-dir tsc-error-data-set/runs \
 *     --concurrency 2 \
 *     --timeout-ms 600000 \
 *     --install
 */

import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

function parseArgs(argv) {
  const args = {
    reposFile: null,
    outDir: "tsc-error-data-set/runs",
    workDir: "tsc-error-data-set/work",
    runName: null,
    concurrency: 2,
    timeoutMs: 10 * 60 * 1000,
    install: true,
    maxRepos: Infinity,
    verbose: false,
    shallow: true,
    keepRepos: false,
    onlyLibraryCallLike: false,
    resume: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--repos-file") args.reposFile = argv[++i];
    else if (a === "--out-dir") args.outDir = argv[++i];
    else if (a === "--work-dir") args.workDir = argv[++i];
    else if (a === "--run-name") args.runName = argv[++i];
    else if (a === "--concurrency") args.concurrency = Number(argv[++i] ?? "2");
    else if (a === "--timeout-ms") args.timeoutMs = Number(argv[++i] ?? `${args.timeoutMs}`);
    else if (a === "--install") args.install = true;
    else if (a === "--no-install") args.install = false;
    else if (a === "--max-repos") args.maxRepos = Number(argv[++i] ?? "0");
    else if (a === "--no-shallow") args.shallow = false;
    else if (a === "--keep-repos") args.keepRepos = true;
    else if (a === "--only-library-call-like") args.onlyLibraryCallLike = true;
    else if (a === "--resume") args.resume = true;
    else if (a === "--verbose") args.verbose = true;
    else if (a === "--help" || a === "-h") {
      printHelpAndExit(0);
    } else {
      console.error(`Unknown arg: ${a}`);
      printHelpAndExit(1);
    }
  }
  if (!args.reposFile) {
    console.error("Provide --repos-file <FILE> (one URL per line)");
    printHelpAndExit(1);
  }
  if (!Number.isFinite(args.concurrency) || args.concurrency < 1) args.concurrency = 1;
  if (!Number.isFinite(args.timeoutMs) || args.timeoutMs < 1) args.timeoutMs = 10 * 60 * 1000;
  if (!Number.isFinite(args.maxRepos) || args.maxRepos < 1) args.maxRepos = Infinity;
  return args;
}

function printHelpAndExit(code) {
  console.log(`
Usage:
  node scripts/collect-tsc-error-dataset.mjs --repos-file <FILE> [options]

Options:
  --out-dir <DIR>           Output runs directory (default: tsc-error-data-set/runs)
  --work-dir <DIR>          Clone work directory (default: tsc-error-data-set/work)
  --run-name <NAME>         Run directory name under out-dir (default: timestamp)
  --concurrency <N>         Parallelism (default: 2)
  --timeout-ms <MS>         Per repo timeout (default: 600000)
  --install                 Install dependencies (default: install)
  --no-install              Do not install dependencies (default: install)
  --max-repos <N>           Limit repo count (default: unlimited)
  --no-shallow              Full clone (default: shallow)
  --keep-repos              Keep cloned repos under work dir (default: delete after scan)
  --only-library-call-like  Keep only repos that look like external-library call / typing issues
  --resume                  Resume a run directory (skip already processed repos)
  --verbose                 Log progress to stderr
`);
  process.exit(code);
}

function runCmd({ cwd, cmd, args, timeoutMs }) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      shell: process.platform === "win32",
      env: { ...process.env, CI: "1", FORCE_COLOR: "0" },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));

    let timedOut = false;
    const t = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.on("close", (code, signal) => {
      clearTimeout(t);
      resolve({ code: code ?? -1, signal: signal ?? null, timedOut, stdout, stderr });
    });
  });
}

async function rimraf(targetPath) {
  await fs.rm(targetPath, { recursive: true, force: true }).catch(() => {});
}

function slugFromUrl(url) {
  // Make a filesystem-safe slug; keep it deterministic and short-ish.
  const u = url.trim().replace(/\.git$/, "");
  const base = u.split("/").slice(-2).join("__").replace(/[^a-zA-Z0-9._-]/g, "_");
  const hash = crypto.createHash("sha1").update(u).digest("hex").slice(0, 8);
  return `${base}__${hash}`;
}

async function readRepoUrls(filePath) {
  const txt = await fs.readFile(filePath, "utf8");
  const urls = txt
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !s.startsWith("#"));
  // Deduplicate preserving order
  const seen = new Set();
  const out = [];
  for (const u of urls) {
    if (seen.has(u)) continue;
    seen.add(u);
    out.push(u);
  }
  return out;
}

function timestampDirName(d = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(
    d.getMinutes(),
  )}${pad(d.getSeconds())}`;
}

async function readProcessedSlugs(resultsJsonlPath) {
  const slugs = new Set();
  try {
    const txt = await fs.readFile(resultsJsonlPath, "utf8");
    const lines = txt.split(/\r?\n/).filter((l) => l.trim().length > 0);
    for (const l of lines) {
      try {
        const obj = JSON.parse(l);
        if (obj && typeof obj.slug === "string" && obj.slug.length > 0) slugs.add(obj.slug);
      } catch {
        // ignore
      }
    }
  } catch {
    // ignore
  }
  return slugs;
}

async function appendFile(p, data) {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.appendFile(p, data);
}

async function scanClonedRepo({ repoDir, timeoutMs, install, onlyLibraryCallLike }) {
  // Reuse existing scanning logic by invoking the scanner on the repo root itself.
  // We write to a temp file and then read the single JSON line back.
  const tmpOut = path.join(repoDir, ".tsc-scan.tmp.jsonl");
  await rimraf(tmpOut);

  const args = [
    path.resolve("scripts/scan-tsc-errors.mjs"),
    "--root",
    repoDir,
    "--out",
    tmpOut,
    "--concurrency",
    "1",
    "--timeout-ms",
    String(timeoutMs),
  ];
  if (install) args.push("--install");
  if (onlyLibraryCallLike) args.push("--only-library-call-like");

  const r = await runCmd({
    cwd: path.resolve("."),
    cmd: "node",
    args,
    timeoutMs: timeoutMs + 30_000,
  });

  let line = null;
  try {
    const txt = await fs.readFile(tmpOut, "utf8");
    line = txt.split(/\r?\n/).find((l) => l.trim().length > 0) ?? null;
  } catch {
    // ignore
  }
  await rimraf(tmpOut);

  return { scannerExit: r.code, scannerTimedOut: r.timedOut, scannerOut: `${r.stdout}\n${r.stderr}`.slice(0, 4000), line };
}

async function processOne(url, opts, runDir) {
  const startedAt = Date.now();
  const slug = slugFromUrl(url);
  const repoDir = path.resolve(opts.workDir, slug);

  const result = {
    url,
    slug,
    repoDir,
    startedAt: new Date(startedAt).toISOString(),
    durationMs: null,
    stage: null,
    git: null,
    scan: null,
  };

  // Fresh clone
  await rimraf(repoDir);
  await fs.mkdir(path.dirname(repoDir), { recursive: true });

  const cloneArgs = ["clone"];
  if (opts.shallow) cloneArgs.push("--depth", "1");
  cloneArgs.push(url, repoDir);

  result.stage = "git-clone";
  const gr = await runCmd({ cwd: path.resolve(opts.workDir), cmd: "git", args: cloneArgs, timeoutMs: opts.timeoutMs });
  result.git = { exitCode: gr.code, timedOut: gr.timedOut, outputSample: `${gr.stdout}\n${gr.stderr}`.slice(0, 4000) };
  if (gr.timedOut || gr.code !== 0) {
    result.durationMs = Date.now() - startedAt;
    if (!opts.keepRepos) await rimraf(repoDir);
    return result;
  }

  // Scan (install + typecheck)
  result.stage = "scan";
  const sr = await scanClonedRepo({
    repoDir,
    timeoutMs: opts.timeoutMs,
    install: opts.install,
    onlyLibraryCallLike: opts.onlyLibraryCallLike,
  });
  result.scan = sr;
  result.durationMs = Date.now() - startedAt;

  if (!opts.keepRepos) await rimraf(repoDir);
  return result;
}

async function main() {
  const opts = parseArgs(process.argv);
  const reposFile = path.resolve(opts.reposFile);
  const urls = (await readRepoUrls(reposFile)).slice(0, opts.maxRepos);

  const runName = opts.runName ? String(opts.runName) : timestampDirName();
  const runDir = path.resolve(opts.outDir, runName);
  await fs.mkdir(runDir, { recursive: true });

  const resultsJsonl = path.join(runDir, "results.jsonl");
  const metaJson = path.join(runDir, "meta.json");
  const aggregateTsv = path.join(runDir, "aggregate.tsv");
  const scanResultsJsonl = path.join(runDir, "scan-results.jsonl");

  const processedSlugs = opts.resume ? await readProcessedSlugs(resultsJsonl) : new Set();

  await fs.writeFile(
    metaJson,
    JSON.stringify(
      {
        runName,
        reposFile,
        repoCount: urls.length,
        options: {
          outDir: path.resolve(opts.outDir),
          workDir: path.resolve(opts.workDir),
          runName,
          concurrency: opts.concurrency,
          timeoutMs: opts.timeoutMs,
          install: opts.install,
          shallow: opts.shallow,
          keepRepos: opts.keepRepos,
          onlyLibraryCallLike: opts.onlyLibraryCallLike,
          resume: opts.resume,
        },
        startedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );

  if (opts.verbose) {
    console.error(`Repo URLs: ${urls.length}`);
    console.error(`Run dir: ${runDir}`);
  }

  // Ensure files exist even when urls is empty. (When resuming, do not truncate.)
  if (!opts.resume) {
    await fs.writeFile(resultsJsonl, "");
    await fs.writeFile(scanResultsJsonl, "");
  } else {
    await fs.mkdir(path.dirname(resultsJsonl), { recursive: true });
    await fs.open(resultsJsonl, "a").then((h) => h.close());
    await fs.open(scanResultsJsonl, "a").then((h) => h.close());
  }

  if (urls.length === 0) {
    await fs.writeFile(aggregateTsv, "scanned_repos=0 skipped=0 timed_out=0\ncode\trepos\toccurrences\n");
    return;
  }

  let idx = 0;
  async function worker() {
    while (true) {
      const i = idx++;
      if (i >= urls.length) return;
      const url = urls[i];
      if (opts.verbose) console.error(`[${i + 1}/${urls.length}] ${url}`);
      const slug = slugFromUrl(url);
      if (processedSlugs.has(slug)) {
        if (opts.verbose) console.error(`  skip(resume): ${slug}`);
        continue;
      }
      const r = await processOne(url, opts, runDir);
      processedSlugs.add(slug);
      await appendFile(resultsJsonl, JSON.stringify(r) + "\n");
    }
  }

  await Promise.all(Array.from({ length: opts.concurrency }, () => worker()));

  // Aggregate TS codes across repos by reusing the existing aggregator on results.jsonl
  // (results.jsonl here includes nested scan output lines; we prefer the scanner's JSON lines when present).
  //
  // We will also produce a "flattened" JSONL the aggregator already understands: scan-results.jsonl
  const lines = (await fs.readFile(resultsJsonl, "utf8")).split(/\r?\n/).filter((l) => l.trim().length > 0);
  const out = [];
  for (const l of lines) {
    let obj;
    try {
      obj = JSON.parse(l);
    } catch {
      continue;
    }
    const scanLine = obj?.scan?.line;
    if (typeof scanLine === "string" && scanLine.trim().startsWith("{")) {
      out.push(scanLine.trim());
    } else {
      // minimal fallback to not lose info
      out.push(
        JSON.stringify({
          repoDir: obj.repoDir,
          skipped: true,
          skipReason: "scan-line-missing",
          timedOut: Boolean(obj?.scan?.scannerTimedOut),
          tsErrorCounts: {},
          tsErrorCodes: [],
        }),
      );
    }
  }
  await fs.writeFile(scanResultsJsonl, out.join("\n") + "\n");

  const agg = await runCmd({
    cwd: path.resolve("."),
    cmd: "node",
    args: [path.resolve("scripts/aggregate-tsc-errors.mjs"), "--in", scanResultsJsonl, "--top", "200"],
    timeoutMs: 60_000,
  });
  await fs.writeFile(aggregateTsv, agg.stdout);
  if (opts.verbose && agg.code !== 0) console.error(agg.stderr);
}

main().catch((e) => {
  console.error(e?.stack || String(e));
  process.exit(1);
});


