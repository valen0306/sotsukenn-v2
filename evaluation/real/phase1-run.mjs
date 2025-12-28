#!/usr/bin/env node
/**
 * Real-project Phase1 runner (TS2307/TS7016):
 * - clone repo
 * - install deps (best-effort)
 * - run tsc baseline
 * - if TS2307/TS7016 appear, inject declaration stubs (declare module "...") and rerun tsc
 *
 * Notes:
 * - This runner intentionally uses `tsc -p <tsconfig>` (not npm scripts) for reproducibility.
 * - Gate A: only repos with tsconfig.json at repo root are attempted.
 */

import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const ROOT = path.resolve(process.cwd());

function parseArgs(argv) {
  const args = {
    reposFile: null,
    outDir: "evaluation/real/out/phase1",
    workDir: "evaluation/real/work/phase1",
    concurrency: 1,
    timeoutMs: 10 * 60 * 1000,
    max: Infinity,
    verbose: false,
    keepRepos: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--repos-file") args.reposFile = argv[++i];
    else if (a === "--out-dir") args.outDir = argv[++i];
    else if (a === "--work-dir") args.workDir = argv[++i];
    else if (a === "--concurrency") args.concurrency = Number(argv[++i] ?? "1");
    else if (a === "--timeout-ms") args.timeoutMs = Number(argv[++i] ?? `${args.timeoutMs}`);
    else if (a === "--max") args.max = Number(argv[++i] ?? "0");
    else if (a === "--keep-repos") args.keepRepos = true;
    else if (a === "--verbose") args.verbose = true;
    else if (a === "--help" || a === "-h") {
      console.log(`
Usage:
  node evaluation/real/phase1-run.mjs --repos-file <FILE> [options]

Options:
  --out-dir <DIR>      Output directory (default: evaluation/real/out/phase1)
  --work-dir <DIR>     Clone workspace (default: evaluation/real/work/phase1)
  --concurrency <N>    Parallelism (default: 1)
  --timeout-ms <MS>    Per repo timeout (default: 600000)
  --max <N>            Max repos to process
  --keep-repos         Keep cloned repos in work dir
  --verbose
`);
      process.exit(0);
    } else {
      console.error(`Unknown arg: ${a}`);
      process.exit(1);
    }
  }
  if (!args.reposFile) {
    console.error("Provide --repos-file <FILE>");
    process.exit(1);
  }
  if (!Number.isFinite(args.concurrency) || args.concurrency < 1) args.concurrency = 1;
  if (!Number.isFinite(args.timeoutMs) || args.timeoutMs < 1) args.timeoutMs = 10 * 60 * 1000;
  if (!Number.isFinite(args.max) || args.max < 1) args.max = Infinity;
  return args;
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

async function rmrf(p) {
  await fs.rm(p, { recursive: true, force: true }).catch(() => {});
}

async function fileExists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

function slugFromUrl(url) {
  const u = url.trim().replace(/\.git$/, "");
  const base = u.split("/").slice(-2).join("__").replace(/[^a-zA-Z0-9._-]/g, "_");
  const hash = crypto.createHash("sha1").update(u).digest("hex").slice(0, 8);
  return `${base}__${hash}`;
}

async function readRepoUrls(filePath) {
  const txt = await fs.readFile(filePath, "utf8");
  return txt
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !s.startsWith("#"));
}

function extractMissingModuleSpecifiers(text) {
  const modules = new Set();
  const patterns = [
    /module\s+'([^']+)'/g,
    /module\s+"([^"]+)"/g,
    /Cannot find module\s+'([^']+)'/g,
    /Cannot find module\s+"([^"]+)"/g,
    /Could not find a declaration file for module\s+'([^']+)'/g,
    /Could not find a declaration file for module\s+"([^"]+)"/g,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(text)) !== null) modules.add(m[1]);
  }
  return [...modules].sort();
}

function isExternalModuleSpecifier(spec) {
  if (typeof spec !== "string") return false;
  const s = spec.trim();
  if (s.length === 0) return false;
  // Relative/absolute/internal aliases are not treated as external packages for Phase1.
  if (s.startsWith(".") || s.startsWith("/")) return false;
  if (s.startsWith("node:")) return false;
  if (s.startsWith("@/") || s.startsWith("~/")) return false;
  return true;
}

function extractTsCodes(text) {
  const re = /\bTS\d{4,5}\b/g;
  const counts = new Map();
  const matches = text.match(re) ?? [];
  for (const m of matches) counts.set(m, (counts.get(m) ?? 0) + 1);
  return Object.fromEntries([...counts.entries()].sort((a, b) => b[1] - a[1]));
}

async function detectInstallCommand(repoDir) {
  const hasPnpm = await fileExists(path.join(repoDir, "pnpm-lock.yaml"));
  const hasYarn = await fileExists(path.join(repoDir, "yarn.lock"));
  const hasNpmLock = await fileExists(path.join(repoDir, "package-lock.json"));
  if (hasPnpm) return { cmd: "pnpm", args: ["install", "--frozen-lockfile"] };
  if (hasYarn) return { cmd: "yarn", args: ["install", "--immutable"] };
  if (hasNpmLock) return { cmd: "npm", args: ["ci"] };
  return { cmd: "npm", args: ["install"] };
}

async function hasRootTsconfig(repoDir) {
  return await fileExists(path.join(repoDir, "tsconfig.json"));
}

function stripJsonc(s) {
  // Remove /* */ and // comments, then remove trailing commas.
  let out = s.replace(/\/\*[\s\S]*?\*\//g, "");
  out = out.replace(/(^|\s)\/\/.*$/gm, "$1");
  out = out.replace(/,\s*([}\]])/g, "$1");
  return out;
}

async function readRootTsconfigTypes(repoDir) {
  const p = path.join(repoDir, "tsconfig.json");
  try {
    const raw = await fs.readFile(p, "utf8");
    const json = JSON.parse(stripJsonc(raw));
    const types = json?.compilerOptions?.types;
    if (Array.isArray(types)) return types.filter((x) => typeof x === "string");
  } catch {
    // ignore
  }
  return null;
}

async function writePhase1StubTypeRoots(repoDir, moduleSpecifiers) {
  // Create a typeRoots directory that contains a single @types-like package with many declare module stubs.
  // This is reliable even when tsconfig includes are strict, because typeRoots is used for global type packages.
  const typeRootsDir = path.join(repoDir, ".evaluation-types", "phase1", "@types");
  const pkgDir = path.join(typeRootsDir, "__phase1_stub__");
  await fs.mkdir(pkgDir, { recursive: true });
  const stubs = moduleSpecifiers.map((s) => `declare module '${s}';\n`).join("");
  await fs.writeFile(path.join(pkgDir, "index.d.ts"), stubs);
  return typeRootsDir;
}

async function writeInjectedTsconfig(repoDir, stubTypeRootsDir) {
  // Create a derived tsconfig that ensures our stub package is included, even when compilerOptions.types is set.
  const originalTypes = await readRootTsconfigTypes(repoDir);
  const types = originalTypes ? Array.from(new Set([...originalTypes, "__phase1_stub__"])) : null;

  const cfg = {
    extends: "./tsconfig.json",
    compilerOptions: {
      // Ensure default @types remain visible as well.
      typeRoots: ["./.evaluation-types/phase1/@types", "./node_modules/@types"],
      ...(types ? { types } : {}),
    },
  };
  const p = path.join(repoDir, "tsconfig.__phase1__.json");
  await fs.writeFile(p, JSON.stringify(cfg, null, 2) + "\n");
  return { tsconfigPath: p, originalTypesCount: originalTypes?.length ?? 0, injectedTypesCount: types?.length ?? 0 };
}

async function processOne(url, opts, outHandle) {
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
    skipped: false,
    skipReason: null,
    timedOut: false,
    install: null,
    baseline: null,
    injected: null,
    phase1: {
      moduleSpecifiers: [],
      improved: false,
    },
  };

  await rmrf(repoDir);
  await fs.mkdir(path.dirname(repoDir), { recursive: true });

  // clone
  result.stage = "git-clone";
  const gr = await runCmd({ cwd: path.resolve(opts.workDir), cmd: "git", args: ["clone", "--depth", "1", url, repoDir], timeoutMs: opts.timeoutMs });
  if (gr.timedOut || gr.code !== 0) {
    result.timedOut = gr.timedOut;
    result.skipReason = "git-clone-failed";
    result.durationMs = Date.now() - startedAt;
    if (!opts.keepRepos) await rmrf(repoDir);
    await outHandle.appendFile(JSON.stringify(result) + "\n");
    return;
  }

  // Gate A: root tsconfig
  if (!(await hasRootTsconfig(repoDir))) {
    result.skipped = true;
    result.skipReason = "no tsconfig in repo root";
    result.durationMs = Date.now() - startedAt;
    if (!opts.keepRepos) await rmrf(repoDir);
    await outHandle.appendFile(JSON.stringify(result) + "\n");
    return;
  }

  // install
  result.stage = "install";
  const ic = await detectInstallCommand(repoDir);
  result.install = ic;
  const ir = await runCmd({ cwd: repoDir, cmd: ic.cmd, args: ic.args, timeoutMs: opts.timeoutMs });
  if (ir.timedOut || ir.code !== 0) {
    result.timedOut = ir.timedOut;
    result.skipReason = ir.timedOut ? "install-timeout" : "install-failed";
    result.durationMs = Date.now() - startedAt;
    if (!opts.keepRepos) await rmrf(repoDir);
    await outHandle.appendFile(JSON.stringify(result) + "\n");
    return;
  }

  // baseline tsc
  result.stage = "baseline";
  const br = await runCmd({ cwd: repoDir, cmd: "tsc", args: ["--noEmit", "--pretty", "false", "-p", "tsconfig.json"], timeoutMs: opts.timeoutMs });
  const bout = `${br.stdout}\n${br.stderr}`;
  const bcounts = extractTsCodes(bout);
  result.baseline = {
    exitCode: br.code,
    timedOut: br.timedOut,
    tsErrorCounts: bcounts,
    outputSample: bout.slice(0, 2000),
  };
  if (br.timedOut) {
    result.timedOut = true;
    result.skipReason = "baseline-timeout";
    result.durationMs = Date.now() - startedAt;
    if (!opts.keepRepos) await rmrf(repoDir);
    await outHandle.appendFile(JSON.stringify(result) + "\n");
    return;
  }

  // Only attempt Phase1 injection if TS2307/TS7016 appear
  const has2307 = Object.prototype.hasOwnProperty.call(bcounts, "TS2307");
  const has7016 = Object.prototype.hasOwnProperty.call(bcounts, "TS7016");
  if (!(has2307 || has7016)) {
    result.stage = "done-no-phase1";
    result.durationMs = Date.now() - startedAt;
    if (!opts.keepRepos) await rmrf(repoDir);
    await outHandle.appendFile(JSON.stringify(result) + "\n");
    return;
  }

  // inject stubs
  result.stage = "inject";
  const allSpecs = extractMissingModuleSpecifiers(bout);
  const specs = allSpecs.filter(isExternalModuleSpecifier);
  result.phase1.moduleSpecifiers = specs;
  if (specs.length === 0) {
    result.skipReason = "no-external-module-specifiers";
    result.durationMs = Date.now() - startedAt;
    if (!opts.keepRepos) await rmrf(repoDir);
    await outHandle.appendFile(JSON.stringify(result) + "\n");
    return;
  }
  const stubTypeRootsDir = await writePhase1StubTypeRoots(repoDir, specs);
  const injectedCfg = await writeInjectedTsconfig(repoDir, stubTypeRootsDir);
  const jr = await runCmd({
    cwd: repoDir,
    cmd: "tsc",
    args: [
      "--noEmit",
      "--pretty",
      "false",
      "-p",
      path.basename(injectedCfg.tsconfigPath),
    ],
    timeoutMs: opts.timeoutMs,
  });
  const jout = `${jr.stdout}\n${jr.stderr}`;
  const jcounts = extractTsCodes(jout);
  result.injected = {
    exitCode: jr.code,
    timedOut: jr.timedOut,
    tsErrorCounts: jcounts,
    outputSample: jout.slice(0, 2000),
  };

  // simple improvement signal: TS2307/TS7016 decreased
  const before = (bcounts.TS2307 ?? 0) + (bcounts.TS7016 ?? 0);
  const after = (jcounts.TS2307 ?? 0) + (jcounts.TS7016 ?? 0);
  result.phase1.improved = after < before;
  result.phase1.reduced = after < before;
  result.phase1.eliminated = after === 0 && before > 0;
  result.phase1.originalTypesCount = injectedCfg.originalTypesCount;
  result.phase1.injectedTypesCount = injectedCfg.injectedTypesCount;

  result.durationMs = Date.now() - startedAt;
  if (!opts.keepRepos) await rmrf(repoDir);
  await outHandle.appendFile(JSON.stringify(result) + "\n");
}

async function main() {
  const opts = parseArgs(process.argv);
  const urls = (await readRepoUrls(path.resolve(opts.reposFile))).slice(0, opts.max);

  const outDir = path.resolve(opts.outDir);
  const workDir = path.resolve(opts.workDir);
  await fs.mkdir(outDir, { recursive: true });
  await fs.mkdir(workDir, { recursive: true });

  const resultsPath = path.join(outDir, "results.jsonl");
  const summaryPath = path.join(outDir, "summary.tsv");
  const outHandle = await fs.open(resultsPath, "w");

  let idx = 0;
  async function worker() {
    while (true) {
      const i = idx++;
      if (i >= urls.length) return;
      const url = urls[i];
      if (opts.verbose) console.error(`[${i + 1}/${urls.length}] ${url}`);
      await processOne(url, { ...opts, workDir }, outHandle);
    }
  }

  try {
    await Promise.all(Array.from({ length: opts.concurrency }, () => worker()));
  } finally {
    await outHandle.close();
  }

  // Write a TSV summary
  const txt = await fs.readFile(resultsPath, "utf8");
  const lines = txt.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const header = [
    "url",
    "skipped",
    "skipReason",
    "baselineExit",
    "baselineTS2307",
    "baselineTS7016",
    "injectedExit",
    "injectedTS2307",
    "injectedTS7016",
    "phase1Reduced",
    "phase1Eliminated",
    "phase1StubSpecifiers",
    "phase1OriginalTypesCount",
    "phase1InjectedTypesCount",
  ].join("\t");
  const rows = [header];
  for (const line of lines) {
    const o = JSON.parse(line);
    const b = o.baseline?.tsErrorCounts ?? {};
    const j = o.injected?.tsErrorCounts ?? {};
    rows.push(
      [
        o.url,
        o.skipped ? "true" : "false",
        o.skipReason ?? "",
        o.baseline?.exitCode ?? "",
        b.TS2307 ?? 0,
        b.TS7016 ?? 0,
        o.injected?.exitCode ?? "",
        j.TS2307 ?? 0,
        j.TS7016 ?? 0,
        o.phase1?.reduced ? "true" : "false",
        o.phase1?.eliminated ? "true" : "false",
        (o.phase1?.moduleSpecifiers?.length ?? 0),
        o.phase1?.originalTypesCount ?? "",
        o.phase1?.injectedTypesCount ?? "",
      ].join("\t"),
    );
  }
  await fs.writeFile(summaryPath, rows.join("\n") + "\n");
  console.log(`wrote_results\t${path.relative(ROOT, resultsPath)}`);
  console.log(`wrote_summary\t${path.relative(ROOT, summaryPath)}`);
}

main().catch((e) => {
  console.error(e?.stack || String(e));
  process.exit(1);
});


