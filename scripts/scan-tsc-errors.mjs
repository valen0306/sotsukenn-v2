#!/usr/bin/env node
/**
 * Scan many JS/TS repos by running TypeScript typecheck and extracting TS error codes.
 *
 * Output: JSON Lines (one JSON object per repo)
 *
 * Typical usage:
 *   node scripts/scan-tsc-errors.mjs --root /path/to/repos --out results.jsonl
 *   node scripts/scan-tsc-errors.mjs --roots-file repos.txt --install --out results.jsonl
 *   node scripts/scan-tsc-errors.mjs --root /path/to/repos --only-library-call-like --out results.jsonl
 *
 * Notes:
 * - By default, this does NOT install dependencies. Use --install if needed.
 * - Many repos vary; we try `npm run typecheck` if present, otherwise `tsc --noEmit`.
 */

import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

function parseArgs(argv) {
  const args = {
    roots: [],
    rootsFile: null,
    out: "tsc-scan-results.jsonl",
    install: false,
    concurrency: 2,
    timeoutMs: 10 * 60 * 1000,
    maxRepos: Infinity,
    requireTsconfig: true,
    onlyLibraryCallLike: false,
    verbose: false,
  };

  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--root") args.roots.push(argv[++i]);
    else if (a === "--roots-file") args.rootsFile = argv[++i];
    else if (a === "--out") args.out = argv[++i];
    else if (a === "--install") args.install = true;
    else if (a === "--concurrency") args.concurrency = Number(argv[++i] ?? "2");
    else if (a === "--timeout-ms") args.timeoutMs = Number(argv[++i] ?? `${args.timeoutMs}`);
    else if (a === "--max-repos") args.maxRepos = Number(argv[++i] ?? "0");
    else if (a === "--allow-no-tsconfig") args.requireTsconfig = false;
    else if (a === "--only-library-call-like") args.onlyLibraryCallLike = true;
    else if (a === "--verbose") args.verbose = true;
    else if (a === "--help" || a === "-h") {
      printHelpAndExit(0);
    } else {
      console.error(`Unknown arg: ${a}`);
      printHelpAndExit(1);
    }
  }
  if (args.roots.length === 0 && !args.rootsFile) {
    console.error("Provide --root and/or --roots-file.");
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
  node scripts/scan-tsc-errors.mjs --root <DIR> [--root <DIR> ...] [options]
  node scripts/scan-tsc-errors.mjs --roots-file <FILE> [options]

Options:
  --out <FILE>              Output JSONL file (default: tsc-scan-results.jsonl)
  --install                 Install deps before typecheck (default: false)
  --concurrency <N>         Parallelism (default: 2)
  --timeout-ms <MS>         Per-repo timeout (default: 600000)
  --max-repos <N>           Stop after N repos (default: unlimited)
  --allow-no-tsconfig       Also run repos without tsconfig.json (default: require tsconfig)
  --only-library-call-like  Only emit results that look like external-library call / typing issues
  --verbose                 Log progress to stderr
`);
  process.exit(code);
}

async function fileExists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

function shouldSkipDir(name) {
  return (
    name === "node_modules" ||
    name === ".git" ||
    name === ".hg" ||
    name === ".svn" ||
    name === "dist" ||
    name === "build" ||
    name === "out" ||
    name === "coverage"
  );
}

async function discoverRepos(rootDir, { maxRepos }) {
  const repos = [];
  const queue = [path.resolve(rootDir)];

  while (queue.length > 0 && repos.length < maxRepos) {
    const dir = queue.pop();
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    // If this dir is a repo root (has package.json), record and don't descend further.
    if (entries.some((e) => e.isFile() && e.name === "package.json")) {
      repos.push(dir);
      continue;
    }

    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (shouldSkipDir(e.name)) continue;
      queue.push(path.join(dir, e.name));
    }
  }

  return repos;
}

function runCmd({ cwd, cmd, args, timeoutMs }) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      shell: process.platform === "win32",
      env: {
        ...process.env,
        CI: "1",
        FORCE_COLOR: "0",
      },
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

function extractTsCodes(text) {
  const re = /TS\d{4}/g;
  const counts = new Map();
  const matches = text.match(re) ?? [];
  for (const m of matches) counts.set(m, (counts.get(m) ?? 0) + 1);
  return Object.fromEntries([...counts.entries()].sort((a, b) => b[1] - a[1]));
}

function extractDiagnostics(text) {
  // tsc --pretty false typically uses:
  //   path/to/file.ts(12,34): error TS2339: ...
  // sometimes (other tools) use:
  //   path/to/file.ts:12:34 - error TS2339: ...
  const diags = [];

  const reParen = /^(.+)\((\d+),(\d+)\):\s+error\s+(TS\d{4}):\s+(.*)$/gm;
  let m;
  while ((m = reParen.exec(text)) !== null) {
    diags.push({
      file: m[1],
      line: Number(m[2]),
      col: Number(m[3]),
      code: m[4],
      message: m[5],
    });
  }

  const reColon = /^(.+):(\d+):(\d+)\s+-\s+error\s+(TS\d{4}):\s+(.*)$/gm;
  while ((m = reColon.exec(text)) !== null) {
    diags.push({
      file: m[1],
      line: Number(m[2]),
      col: Number(m[3]),
      code: m[4],
      message: m[5],
    });
  }

  // De-duplicate (some outputs match both patterns in rare cases)
  const key = (d) => `${d.file}#${d.line}#${d.col}#${d.code}#${d.message}`;
  const seen = new Set();
  return diags.filter((d) => {
    const k = key(d);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function extractMissingModuleSpecifiers(text) {
  // Typical strings:
  // - Cannot find module 'foo' or its corresponding type declarations.
  // - Could not find a declaration file for module 'foo'.
  const modules = new Set();
  const re = /module\s+'([^']+)'/g;
  let m;
  while ((m = re.exec(text)) !== null) modules.add(m[1]);
  return [...modules].sort();
}

async function getExternalImportsForFile(filePath) {
  // Heuristic: consider non-relative, non-absolute specifiers as "external"
  // - import ... from 'pkg'
  // - require('pkg')
  // - import('pkg')
  // We cap output size to keep JSONL small.
  let txt;
  try {
    txt = await fs.readFile(filePath, "utf8");
  } catch {
    return [];
  }

  const imports = new Set();
  const add = (s) => {
    if (typeof s !== "string") return;
    const spec = s.trim();
    if (!spec) return;
    if (spec.startsWith(".") || spec.startsWith("/") || spec.startsWith("node:")) return;
    imports.add(spec);
  };

  // import ... from 'x'
  const reImportFrom = /\bfrom\s+['"]([^'"]+)['"]/g;
  let m;
  while ((m = reImportFrom.exec(txt)) !== null) add(m[1]);

  // import 'x'
  const reImportBare = /\bimport\s+['"]([^'"]+)['"]/g;
  while ((m = reImportBare.exec(txt)) !== null) add(m[1]);

  // require('x')
  const reRequire = /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((m = reRequire.exec(txt)) !== null) add(m[1]);

  // import('x')
  const reDynImport = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((m = reDynImport.exec(txt)) !== null) add(m[1]);

  return [...imports].slice(0, 50);
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

async function detectTypecheckCommand(repoDir, pkg) {
  const scripts = pkg?.scripts ?? {};
  if (typeof scripts.typecheck === "string") {
    return { cmd: "npm", args: ["run", "-s", "typecheck"], kind: "npm-script:typecheck" };
  }

  const localTsc = path.join(repoDir, "node_modules", ".bin", process.platform === "win32" ? "tsc.cmd" : "tsc");
  if (await fileExists(localTsc)) {
    return { cmd: localTsc, args: ["--noEmit", "--pretty", "false"], kind: "local-tsc" };
  }

  // Avoid downloading in CI/offline environments.
  return { cmd: "npx", args: ["--no-install", "tsc", "--noEmit", "--pretty", "false"], kind: "npx-no-install-tsc" };
}

async function hasAnyTsconfig(repoDir) {
  const p = path.join(repoDir, "tsconfig.json");
  if (await fileExists(p)) return true;
  // Lightweight check for common variants in root.
  const entries = await fs.readdir(repoDir, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    if (!e.isFile()) continue;
    if (e.name.startsWith("tsconfig.") && e.name.endsWith(".json")) return true;
  }
  return false;
}

async function scanOneRepo(repoDir, opts) {
  const startedAt = Date.now();
  const res = {
    repoDir,
    startedAt: new Date(startedAt).toISOString(),
    durationMs: null,
    skipped: false,
    skipReason: null,
    install: null,
    typecheck: null,
    exitCode: null,
    timedOut: false,
    tsErrorCounts: {},
    tsErrorCodes: [],
    diagnostics: [],
    errorFilesExternalImports: {},
    libraryCallLike: {
      hasAny: false,
      missingModuleSpecifiers: [],
      diagnosticCount: 0,
    },
    outputSample: null,
  };

  const pkgPath = path.join(repoDir, "package.json");
  let pkg;
  try {
    pkg = JSON.parse(await fs.readFile(pkgPath, "utf8"));
  } catch (e) {
    res.skipped = true;
    res.skipReason = "package.json unreadable";
    res.durationMs = Date.now() - startedAt;
    return res;
  }

  if (opts.requireTsconfig) {
    const ok = await hasAnyTsconfig(repoDir);
    if (!ok) {
      res.skipped = true;
      res.skipReason = "no tsconfig in repo root";
      res.durationMs = Date.now() - startedAt;
      return res;
    }
  }

  if (opts.install) {
    const ic = await detectInstallCommand(repoDir);
    res.install = { cmd: ic.cmd, args: ic.args };
    const ir = await runCmd({ cwd: repoDir, cmd: ic.cmd, args: ic.args, timeoutMs: opts.timeoutMs });
    if (ir.timedOut) {
      res.timedOut = true;
      res.exitCode = -1;
      res.outputSample = (ir.stderr || ir.stdout || "").slice(0, 4000);
      res.durationMs = Date.now() - startedAt;
      return res;
    }
    if (ir.code !== 0) {
      res.exitCode = ir.code;
      const out = `${ir.stdout}\n${ir.stderr}`;
      res.tsErrorCounts = extractTsCodes(out);
      res.tsErrorCodes = Object.keys(res.tsErrorCounts);
      res.outputSample = out.slice(0, 4000);
      res.durationMs = Date.now() - startedAt;
      return res;
    }
  }

  const tc = await detectTypecheckCommand(repoDir, pkg);
  res.typecheck = { cmd: tc.cmd, args: tc.args, kind: tc.kind };
  const tr = await runCmd({ cwd: repoDir, cmd: tc.cmd, args: tc.args, timeoutMs: opts.timeoutMs });

  res.timedOut = tr.timedOut;
  res.exitCode = tr.timedOut ? -1 : tr.code;
  const out = `${tr.stdout}\n${tr.stderr}`;
  res.tsErrorCounts = extractTsCodes(out);
  res.tsErrorCodes = Object.keys(res.tsErrorCounts);
  res.diagnostics = extractDiagnostics(out);

  // "Library-call-like" heuristic:
  // - missing type declarations / module resolution issues referencing a module specifier
  // - or errors located in a source file that imports at least one external module
  const missingMods = extractMissingModuleSpecifiers(out);
  res.libraryCallLike.missingModuleSpecifiers = missingMods;

  const files = [...new Set(res.diagnostics.map((d) => d.file).filter((f) => typeof f === "string" && f.length > 0))];
  for (const f of files) {
    const abs = path.isAbsolute(f) ? f : path.join(repoDir, f);
    // ignore errors originating inside node_modules; those are not "downstream calling library"
    if (abs.includes(`${path.sep}node_modules${path.sep}`)) continue;
    const imports = await getExternalImportsForFile(abs);
    if (imports.length > 0) res.errorFilesExternalImports[f] = imports;
  }
  const diagCount = res.diagnostics.filter((d) => {
    const imports = res.errorFilesExternalImports[d.file];
    return Array.isArray(imports) && imports.length > 0;
  }).length;

  res.libraryCallLike.diagnosticCount = diagCount;
  res.libraryCallLike.hasAny = missingMods.length > 0 || diagCount > 0;

  res.outputSample = out.slice(0, 4000);
  res.durationMs = Date.now() - startedAt;
  return res;
}

async function readRootsFromFile(p) {
  const txt = await fs.readFile(p, "utf8");
  return txt
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !s.startsWith("#"));
}

async function main() {
  const opts = parseArgs(process.argv);

  const roots = [
    ...(opts.roots ?? []),
    ...(opts.rootsFile ? await readRootsFromFile(opts.rootsFile) : []),
  ].map((r) => path.resolve(r));

  const outPath = path.resolve(opts.out);
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  const outHandle = await fs.open(outPath, "w");

  try {
    let repoDirs = [];
    for (const r of roots) {
      const found = await discoverRepos(r, { maxRepos: opts.maxRepos - repoDirs.length });
      repoDirs.push(...found);
      if (repoDirs.length >= opts.maxRepos) break;
    }
    repoDirs = repoDirs.slice(0, opts.maxRepos);

    if (opts.verbose) {
      console.error(`Discovered ${repoDirs.length} repos.`);
      console.error(`Writing results to ${outPath}`);
    }

    let idx = 0;
    const results = [];

    async function worker() {
      while (true) {
        const i = idx++;
        if (i >= repoDirs.length) return;
        const repoDir = repoDirs[i];
        if (opts.verbose) console.error(`[${i + 1}/${repoDirs.length}] ${repoDir}`);
        const r = await scanOneRepo(repoDir, opts);
        if (!opts.onlyLibraryCallLike || r.libraryCallLike?.hasAny) {
          results.push(r);
          await outHandle.appendFile(JSON.stringify(r) + "\n");
        }
      }
    }

    const workers = Array.from({ length: opts.concurrency }, () => worker());
    await Promise.all(workers);
  } finally {
    await outHandle.close();
  }
}

main().catch((e) => {
  console.error(e?.stack || String(e));
  process.exit(1);
});


