#!/usr/bin/env node
/**
 * Real-project Phase3 runner (API alignment, DTS_STUB baseline):
 * - clone repo
 * - install deps (best-effort)
 * - run tsc baseline
 * - if Phase3 core codes appear, generate "any-typed" module declaration stubs for external imports
 *   in the files that produced Phase3 diagnostics, then rerun tsc using a derived tsconfig.
 *
 * Phase3 core codes:
 *   TS2339, TS2345, TS2322, TS2554, TS2769, TS2353, TS2741, TS7053
 *
 * Notes:
 * - This is NOT the final (TypeBERT) intervention. This is a lower baseline (DTS_STUB)
 *   used to quantify how far a trivial boundary-any strategy can go.
 * - Gate A: only repos with tsconfig.json at repo root are attempted.
 * - By default, only "external-looking" specifiers are stubbed (packages/subpaths).
 */

import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const ROOT = path.resolve(process.cwd());

const PHASE3_CODES = new Set(["TS2339", "TS2345", "TS2322", "TS2554", "TS2769", "TS2353", "TS2741", "TS7053"]);

function parseArgs(argv) {
  const args = {
    reposFile: null,
    outDir: "evaluation/real/out/phase3",
    workDir: "evaluation/real/work/phase3",
    concurrency: 1,
    timeoutMs: 10 * 60 * 1000,
    max: Infinity,
    verbose: false,
    keepRepos: false,
    onlyExternal: true,
    mode: "stub", // stub | model
    modelCmd: "python3",
    modelScript: "evaluation/model/typebert_infer.py",
    modelCacheDir: "evaluation/real/cache/typebert",
    modelTimeoutMs: 2 * 60 * 1000,
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
    else if (a === "--include-non-external") args.onlyExternal = false;
    else if (a === "--mode") args.mode = String(argv[++i] ?? "stub");
    else if (a === "--model-cmd") args.modelCmd = argv[++i];
    else if (a === "--model-script") args.modelScript = argv[++i];
    else if (a === "--model-cache-dir") args.modelCacheDir = argv[++i];
    else if (a === "--model-timeout-ms") args.modelTimeoutMs = Number(argv[++i] ?? `${args.modelTimeoutMs}`);
    else if (a === "--help" || a === "-h") {
      console.log(`
Usage:
  node evaluation/real/phase3-run.mjs --repos-file <FILE> [options]

Options:
  --out-dir <DIR>            Output directory (default: evaluation/real/out/phase3)
  --work-dir <DIR>           Clone workspace (default: evaluation/real/work/phase3)
  --concurrency <N>          Parallelism (default: 1)
  --timeout-ms <MS>          Per repo timeout (default: 600000)
  --max <N>                  Max repos to process
  --keep-repos               Keep cloned repos in work dir
  --verbose
  --include-non-external     Also stub alias/relative specifiers (default: off)
  --mode <stub|model>        Injection mode (default: stub)
  --model-cmd <CMD>          Model adapter command (default: python3)
  --model-script <PATH>      Model adapter script (default: evaluation/model/typebert_infer.py)
  --model-cache-dir <DIR>    Cache dir for model outputs (default: evaluation/real/cache/typebert)
  --model-timeout-ms <MS>    Per-adapter-call timeout (default: 120000)
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
  if (!["stub", "model"].includes(args.mode)) {
    console.error(`Unknown --mode ${args.mode} (use stub|model)`);
    process.exit(1);
  }
  if (!Number.isFinite(args.modelTimeoutMs) || args.modelTimeoutMs < 1) args.modelTimeoutMs = 2 * 60 * 1000;
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

function isExternalModuleSpecifier(spec) {
  if (typeof spec !== "string") return false;
  const s = spec.trim();
  if (s.length === 0) return false;
  if (s.startsWith(".") || s.startsWith("/")) return false;
  if (s.startsWith("node:")) return false;
  if (s.startsWith("@/") || s.startsWith("~/") || s.startsWith("#")) return false;
  return true;
}

function extractTsCodes(text) {
  const re = /\bTS\d{4,5}\b/g;
  const counts = new Map();
  const matches = text.match(re) ?? [];
  for (const m of matches) counts.set(m, (counts.get(m) ?? 0) + 1);
  return Object.fromEntries([...counts.entries()].sort((a, b) => b[1] - a[1]));
}

function parseDiagnostics(text) {
  const out = [];
  const lines = (text ?? "").split(/\r?\n/);
  const headRe = /^(.*)\((\d+),(\d+)\):\s+error\s+(TS\d{4,5}):\s+(.*)$/;
  for (const ln of lines) {
    const m = ln.match(headRe);
    if (!m) continue;
    const [, file, line, col, code, msg] = m;
    out.push({ file, line: Number(line), col: Number(col), code, msg });
  }
  return out;
}

function stripJsonc(s) {
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

async function writePhase3InjectedTypeRoots(repoDir, { packageName, dtsText }) {
  const typeRootsDir = path.join(repoDir, ".evaluation-types", "phase3", "@types");
  const pkgDir = path.join(typeRootsDir, packageName);
  await fs.mkdir(pkgDir, { recursive: true });
  await fs.writeFile(path.join(pkgDir, "index.d.ts"), dtsText);
  return typeRootsDir;
}

async function writeInjectedTsconfig(repoDir) {
  const originalTypes = await readRootTsconfigTypes(repoDir);
  const types = originalTypes ? Array.from(new Set([...originalTypes, "__phase3_injected__"])) : null;
  const cfg = {
    extends: "./tsconfig.json",
    compilerOptions: {
      typeRoots: ["./.evaluation-types/phase3/@types", "./node_modules/@types"],
      ...(types ? { types } : {}),
    },
  };
  const p = path.join(repoDir, "tsconfig.__phase3__.json");
  await fs.writeFile(p, JSON.stringify(cfg, null, 2) + "\n");
  return { tsconfigPath: p, originalTypesCount: originalTypes?.length ?? 0, injectedTypesCount: types?.length ?? 0 };
}

function esc(s) {
  return s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function buildPhase3StubDts(moduleToStub) {
  // moduleToStub: Map<string, { defaultImport:boolean, namespaceImport:boolean, named:Set, typeNamed:Set }>
  const chunks = [];
  chunks.push("// Auto-generated by evaluation/real/phase3-run.mjs (DTS_STUB)\n");
  for (const [mod, info] of moduleToStub.entries()) {
    const named = [...(info.named ?? new Set())].sort();
    const typeNamed = [...(info.typeNamed ?? new Set())].sort();
    const hasDefault = Boolean(info.defaultImport);
    chunks.push(`declare module '${esc(mod)}' {\n`);
    if (hasDefault) chunks.push(`  const __default: any;\n  export default __default;\n`);
    // Provide a generic any export to make `import * as ns` usable and allow value access.
    chunks.push(`  export const __any: any;\n`);
    for (const n of named) chunks.push(`  export const ${n}: any;\n`);
    for (const t of typeNamed) chunks.push(`  export type ${t} = any;\n`);
    chunks.push("}\n\n");
  }
  return chunks.join("");
}

async function runModelAdapter({ repo, moduleToStub, opts }) {
  const req = {
    repo,
    modules: Object.fromEntries(
      [...moduleToStub.entries()].map(([k, v]) => [
        k,
        {
          defaultImport: Boolean(v.defaultImport),
          named: [...(v.named ?? new Set())].sort(),
          typeNamed: [...(v.typeNamed ?? new Set())].sort(),
        },
      ]),
    ),
  };
  const input = JSON.stringify(req);

  if (opts.modelCacheDir) {
    await fs.mkdir(path.resolve(opts.modelCacheDir), { recursive: true }).catch(() => {});
  }

  return await new Promise((resolve) => {
    const child = spawn(opts.modelCmd, [opts.modelScript, "--cache-dir", opts.modelCacheDir ?? ""], {
      cwd: ROOT,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, CI: "1" },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.stdin.end(input);
    let timedOut = false;
    const t = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, opts.modelTimeoutMs);
    child.on("close", (code) => {
      clearTimeout(t);
      resolve({ code: code ?? -1, timedOut, stdout, stderr });
    });
  });
}

function collectImportsFromSource(src) {
  // Best-effort single-line import parsing.
  // Returns array of { mod, defaultName?, namespaceName?, named:[{imported, local, isType}] }
  const out = [];
  const lines = (src ?? "").split(/\r?\n/);
  const importRe = /^\s*import\s+(.*?)\s+from\s+['"]([^'"]+)['"]\s*;?\s*$/;
  const sideEffectRe = /^\s*import\s+['"]([^'"]+)['"]\s*;?\s*$/;
  for (const ln of lines) {
    const m0 = ln.match(sideEffectRe);
    if (m0) {
      out.push({ mod: m0[1], sideEffect: true });
      continue;
    }
    const m = ln.match(importRe);
    if (!m) continue;
    const clause = m[1];
    const mod = m[2];
    // import type { X } from 'm'
    const isTypeOnly = /^\s*type\s+/.test(clause);
    const c = clause.replace(/^\s*type\s+/, "").trim();
    // namespace
    const ns = c.match(/^\*\s+as\s+([A-Za-z_$][\w$]*)$/);
    if (ns) {
      out.push({ mod, namespaceName: ns[1], named: [] });
      continue;
    }
    // default + named OR default only
    const parts = c.split(/\s*,\s*/);
    let defaultName = null;
    let namedPart = null;
    if (parts.length === 1) {
      if (/^\{/.test(parts[0])) namedPart = parts[0];
      else defaultName = parts[0];
    } else if (parts.length >= 2) {
      defaultName = parts[0];
      namedPart = parts.slice(1).join(","); // in case commas inside braces (rare)
    }
    const named = [];
    if (namedPart && /\{/.test(namedPart)) {
      const inside = namedPart.replace(/^[^{]*\{/, "").replace(/\}[^}]*$/, "");
      for (const seg of inside.split(",")) {
        const s = seg.trim();
        if (!s) continue;
        const typePrefix = s.startsWith("type ");
        const s2 = s.replace(/^type\s+/, "").trim();
        const mm = s2.match(/^([A-Za-z_$][\w$]*)(\s+as\s+([A-Za-z_$][\w$]*))?$/);
        if (!mm) continue;
        const imported = mm[1];
        const local = mm[3] ?? imported;
        named.push({ imported, local, isType: isTypeOnly || typePrefix });
      }
    }
    out.push({ mod, defaultName: defaultName?.trim() || null, named });
  }
  return out;
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

function sumPhase3(counts) {
  let n = 0;
  for (const c of PHASE3_CODES) n += counts?.[c] ?? 0;
  return n;
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
    phase3: {
      onlyExternal: opts.onlyExternal,
      mode: opts.mode,
      model: opts.mode === "model" ? { cmd: opts.modelCmd, script: opts.modelScript } : null,
      diagFiles: [],
      stubModules: [],
      stubModulesCount: 0,
      reduced: false,
      eliminated: false,
      originalTypesCount: 0,
      injectedTypesCount: 0,
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

  // Gate A
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

  const baselinePhase3 = sumPhase3(bcounts);
  if (baselinePhase3 === 0) {
    result.stage = "done-no-phase3";
    result.durationMs = Date.now() - startedAt;
    if (!opts.keepRepos) await rmrf(repoDir);
    await outHandle.appendFile(JSON.stringify(result) + "\n");
    return;
  }

  // collect diagnostics and import specifiers for stub generation
  const diags = parseDiagnostics(bout).filter((d) => PHASE3_CODES.has(d.code));
  const diagFiles = [...new Set(diags.map((d) => d.file))];
  result.phase3.diagFiles = diagFiles.slice(0, 200); // cap

  const moduleToStub = new Map();
  for (const f of diagFiles) {
    const abs = path.isAbsolute(f) ? f : path.join(repoDir, f);
    if (!(await fileExists(abs))) continue;
    const src = await fs.readFile(abs, "utf8").catch(() => "");
    const imports = collectImportsFromSource(src);
    for (const imp of imports) {
      const mod = imp.mod;
      if (!mod) continue;
      if (opts.onlyExternal && !isExternalModuleSpecifier(mod)) continue;
      if (imp.sideEffect) continue;
      const cur = moduleToStub.get(mod) ?? {
        defaultImport: false,
        namespaceImport: false,
        named: new Set(),
        typeNamed: new Set(),
      };
      if (imp.defaultName) cur.defaultImport = true;
      if (imp.namespaceName) cur.namespaceImport = true;
      for (const n of imp.named ?? []) {
        if (n.isType) cur.typeNamed.add(n.imported);
        else cur.named.add(n.imported);
      }
      moduleToStub.set(mod, cur);
    }
  }

  if (moduleToStub.size === 0) {
    result.skipReason = "no-stub-modules-found";
    result.durationMs = Date.now() - startedAt;
    if (!opts.keepRepos) await rmrf(repoDir);
    await outHandle.appendFile(JSON.stringify(result) + "\n");
    return;
  }

  result.stage = "inject";
  result.phase3.stubModules = [...moduleToStub.keys()].sort().slice(0, 500);
  result.phase3.stubModulesCount = moduleToStub.size;

  let injectedDts = "";
  if (opts.mode === "stub") {
    injectedDts = buildPhase3StubDts(moduleToStub);
  } else {
    const mr = await runModelAdapter({
      repo: { url: result.url, slug: result.slug },
      moduleToStub,
      opts,
    });
    if (mr.timedOut || mr.code !== 0) {
      result.skipReason = mr.timedOut ? "model-timeout" : "model-failed";
      result.phase3.modelError = { code: mr.code, timedOut: mr.timedOut, stderr: mr.stderr.slice(0, 2000) };
      result.durationMs = Date.now() - startedAt;
      if (!opts.keepRepos) await rmrf(repoDir);
      await outHandle.appendFile(JSON.stringify(result) + "\n");
      return;
    }
    let obj;
    try {
      obj = JSON.parse(mr.stdout.trim() || "{}");
    } catch {
      obj = null;
    }
    if (!obj || obj.ok !== true || typeof obj.dts !== "string") {
      result.skipReason = "model-invalid-output";
      result.phase3.modelError = { stdout: mr.stdout.slice(0, 2000), stderr: mr.stderr.slice(0, 2000) };
      result.durationMs = Date.now() - startedAt;
      if (!opts.keepRepos) await rmrf(repoDir);
      await outHandle.appendFile(JSON.stringify(result) + "\n");
      return;
    }
    injectedDts = obj.dts;
  }

  await writePhase3InjectedTypeRoots(repoDir, { packageName: "__phase3_injected__", dtsText: injectedDts });
  const injectedCfg = await writeInjectedTsconfig(repoDir);
  result.phase3.originalTypesCount = injectedCfg.originalTypesCount;
  result.phase3.injectedTypesCount = injectedCfg.injectedTypesCount;

  const jr = await runCmd({
    cwd: repoDir,
    cmd: "tsc",
    args: ["--noEmit", "--pretty", "false", "-p", path.basename(injectedCfg.tsconfigPath)],
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

  const afterPhase3 = sumPhase3(jcounts);
  result.phase3.reduced = afterPhase3 < baselinePhase3;
  result.phase3.eliminated = afterPhase3 === 0 && baselinePhase3 > 0;

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

  // summary
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
        (o.phase3?.diagFiles?.length ?? 0),
        o.phase3?.stubModulesCount ?? 0,
        o.phase3?.originalTypesCount ?? "",
        o.phase3?.injectedTypesCount ?? "",
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


