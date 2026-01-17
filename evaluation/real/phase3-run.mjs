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
import { builtinModules } from "node:module";

const ROOT = path.resolve(process.cwd());

const PHASE3_CODES = new Set(["TS2339", "TS2345", "TS2322", "TS2554", "TS2769", "TS2353", "TS2741", "TS7053"]);

const NODE_BUILTINS = new Set(
  builtinModules.map((m) => (m.startsWith("node:") ? m.slice("node:".length) : m)),
);

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
    modelBackend: "typebert", // passed to adapter
    modelNameOrPath: "", // passed to adapter (--model). Prefer env TYPEBERT_MODEL if set.
    modelDevice: "auto",
    modelMaxNewTokens: 800,
    modelTemperature: 0.0,
    modelSeed: 0,
    modelTorchDtype: "auto", // auto|float16|bfloat16|float32
    modelLowCpuMemUsage: "1", // "1"|"0"
    modelTrustRemoteCode: "0", // "1"|"0"
    maxStubModules: Infinity, // safety cap for model runs
    resume: false,
    memberAccessScope: "repo", // diag | repo
    memberAccessMaxFiles: 800,
    memberAccessMaxBytesPerFile: 512 * 1024,
    memberAccessMaxMembersPerImport: 200,
    modelForceAnyModules: "",
    excludeNodeBuiltins: false,
    externalFilter: "heuristic", // heuristic | deps
    // Localizer (Plan A / M2): limit how many external modules to stub (Top-M).
    // Default: unlimited (= current behavior).
    localizerTopModules: Infinity,
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
    else if (a === "--model-backend") args.modelBackend = String(argv[++i] ?? "typebert");
    else if (a === "--model") args.modelNameOrPath = String(argv[++i] ?? "");
    else if (a === "--model-device") args.modelDevice = String(argv[++i] ?? "auto");
    else if (a === "--model-max-new-tokens") args.modelMaxNewTokens = Number(argv[++i] ?? `${args.modelMaxNewTokens}`);
    else if (a === "--model-temperature") args.modelTemperature = Number(argv[++i] ?? `${args.modelTemperature}`);
    else if (a === "--model-seed") args.modelSeed = Number(argv[++i] ?? `${args.modelSeed}`);
    else if (a === "--model-torch-dtype") args.modelTorchDtype = String(argv[++i] ?? "auto");
    else if (a === "--model-low-cpu-mem-usage") args.modelLowCpuMemUsage = String(argv[++i] ?? "1");
    else if (a === "--model-trust-remote-code") args.modelTrustRemoteCode = String(argv[++i] ?? "0");
    else if (a === "--max-stub-modules") args.maxStubModules = Number(argv[++i] ?? "0");
    else if (a === "--resume") args.resume = true;
    else if (a === "--member-access-scope") args.memberAccessScope = String(argv[++i] ?? "repo");
    else if (a === "--member-access-max-files") args.memberAccessMaxFiles = Number(argv[++i] ?? `${args.memberAccessMaxFiles}`);
    else if (a === "--member-access-max-bytes-per-file") args.memberAccessMaxBytesPerFile = Number(argv[++i] ?? `${args.memberAccessMaxBytesPerFile}`);
    else if (a === "--member-access-max-members-per-import") args.memberAccessMaxMembersPerImport = Number(argv[++i] ?? `${args.memberAccessMaxMembersPerImport}`);
    else if (a === "--model-force-any-modules") args.modelForceAnyModules = String(argv[++i] ?? "");
    else if (a === "--exclude-node-builtins") args.excludeNodeBuiltins = true;
    else if (a === "--external-filter") args.externalFilter = String(argv[++i] ?? "heuristic");
    else if (a === "--localizer-top-modules") args.localizerTopModules = Number(argv[++i] ?? "0");
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
  --model-backend <NAME>     Adapter backend (default: typebert)
  --model <PATH>             Local checkpoint path or model id (recommended: local path; else set TYPEBERT_MODEL env)
  --model-device <DEV>       cpu|cuda|mps|auto (default: auto)
  --model-max-new-tokens <N> Max new tokens for generation (default: 800)
  --model-temperature <T>    Temperature (0.0 = deterministic, default: 0.0)
  --model-seed <N>           Random seed (default: 0)
  --model-torch-dtype <D>    auto|float16|bfloat16|float32 (default: auto)
  --model-low-cpu-mem-usage <0|1>  transformers low_cpu_mem_usage (default: 1)
  --model-trust-remote-code <0|1>  transformers trust_remote_code (default: 0)
  --max-stub-modules <N>     Skip repo if extracted external modules exceed N (default: unlimited)
  --resume                   Append to existing <out-dir>/results.jsonl and skip already-processed URLs
  --member-access-scope <diag|repo>  Where to collect ns/default member access (default: repo)
  --member-access-max-files <N>      Max files to scan when scope=repo (default: 800)
  --member-access-max-bytes-per-file <N>  Skip big files (default: 524288)
  --member-access-max-members-per-import <N>  Cap extracted `.foo` members per import (default: 200)
  --model-force-any-modules <CSV>    Comma-separated modules to force stub(any) even in model mode
  --exclude-node-builtins            Exclude Node.js built-in modules (e.g. 'path', 'crypto') from stub/module list (default: off)
  --external-filter <heuristic|deps> How to decide "external" module specifiers when onlyExternal=true (default: heuristic)
  --localizer-top-modules <N>        (M2) Stub only Top-N external modules (ranked by frequency in Phase3 diagnostic files). Default: unlimited
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
  if (!Number.isFinite(args.modelMaxNewTokens) || args.modelMaxNewTokens < 1) args.modelMaxNewTokens = 800;
  if (!Number.isFinite(args.modelTemperature) || args.modelTemperature < 0) args.modelTemperature = 0.0;
  if (!Number.isFinite(args.modelSeed) || args.modelSeed < 0) args.modelSeed = 0;
  if (!["auto", "float16", "bfloat16", "float32"].includes(String(args.modelTorchDtype))) args.modelTorchDtype = "auto";
  if (!["0", "1"].includes(String(args.modelLowCpuMemUsage))) args.modelLowCpuMemUsage = "1";
  if (!["0", "1"].includes(String(args.modelTrustRemoteCode))) args.modelTrustRemoteCode = "0";
  if (!Number.isFinite(args.maxStubModules) || args.maxStubModules < 1) args.maxStubModules = Infinity;
  if (!["diag", "repo"].includes(String(args.memberAccessScope))) args.memberAccessScope = "repo";
  if (!Number.isFinite(args.memberAccessMaxFiles) || args.memberAccessMaxFiles < 1) args.memberAccessMaxFiles = 800;
  if (!Number.isFinite(args.memberAccessMaxBytesPerFile) || args.memberAccessMaxBytesPerFile < 1) args.memberAccessMaxBytesPerFile = 512 * 1024;
  if (!Number.isFinite(args.memberAccessMaxMembersPerImport) || args.memberAccessMaxMembersPerImport < 1) args.memberAccessMaxMembersPerImport = 200;
  if (!["heuristic", "deps"].includes(String(args.externalFilter))) args.externalFilter = "heuristic";
  if (!Number.isFinite(args.localizerTopModules) || args.localizerTopModules < 1) args.localizerTopModules = Infinity;
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

function isExternalModuleSpecifier(spec, opts) {
  if (typeof spec !== "string") return false;
  const s = spec.trim();
  if (s.length === 0) return false;
  if (s.startsWith(".") || s.startsWith("/")) return false;
  if (s.startsWith("node:")) return false;
  if (s.startsWith("@/") || s.startsWith("~/") || s.startsWith("#")) return false;
  // Optional: exclude Node.js built-in modules like 'path'/'crypto'.
  // NOTE: excluding them changes the model prompt (because the module list changes),
  // so keep it opt-in to avoid accidental behavior changes in experiments.
  if (opts?.excludeNodeBuiltins && NODE_BUILTINS.has(s)) return false;
  return true;
}

function isExternalByDeps(spec, opts) {
  if (!isExternalModuleSpecifier(spec, opts)) return false;
  const pkg = packageNameFromSpecifier(spec);
  if (!pkg) return false;
  if (opts?.excludeNodeBuiltins && NODE_BUILTINS.has(pkg)) return false;
  const deps = opts?.dependencyNames;
  if (!deps) return false;
  return deps.has(pkg);
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

function packageNameFromSpecifier(spec) {
  const s = (spec || "").trim();
  if (!s) return "";
  if (s.startsWith("node:")) return "";
  if (s.startsWith("@")) {
    const parts = s.split("/");
    if (parts.length >= 2) return `${parts[0]}/${parts[1]}`;
    return s;
  }
  return s.split("/")[0] ?? "";
}

async function readRootDependencyNames(repoDir) {
  // Best-effort: parse package.json at repo root. If missing or invalid, return null.
  const p = path.join(repoDir, "package.json");
  try {
    const raw = await fs.readFile(p, "utf8");
    const json = JSON.parse(raw);
    const keys = [
      ...Object.keys(json?.dependencies ?? {}),
      ...Object.keys(json?.devDependencies ?? {}),
      ...Object.keys(json?.peerDependencies ?? {}),
      ...Object.keys(json?.optionalDependencies ?? {}),
    ].filter((x) => typeof x === "string" && x.length > 0);
    return new Set(keys);
  } catch {
    return null;
  }
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
          members: Object.fromEntries(
            [...(v.valueMembers ?? new Map()).entries()].map(([exportName, members]) => [
              exportName,
              [...members].sort(),
            ]),
          ),
        },
      ]),
    ),
  };
  const input = JSON.stringify(req);

  if (opts.modelCacheDir) {
    await fs.mkdir(path.resolve(opts.modelCacheDir), { recursive: true }).catch(() => {});
  }

  const modelPath = opts.modelNameOrPath || process.env.TYPEBERT_MODEL || "";
  const torchDtype = opts.modelTorchDtype || process.env.TYPEBERT_TORCH_DTYPE || "auto";
  const lowCpuMemUsage = opts.modelLowCpuMemUsage || process.env.TYPEBERT_LOW_CPU_MEM_USAGE || "1";
  const trustRemoteCode = opts.modelTrustRemoteCode || process.env.TYPEBERT_TRUST_REMOTE_CODE || "0";
  const forceAnyModules = opts.modelForceAnyModules || process.env.TYPEBERT_FORCE_ANY_MODULES || "";

  return await new Promise((resolve) => {
    const child = spawn(
      opts.modelCmd,
      [
        opts.modelScript,
        "--cache-dir",
        opts.modelCacheDir ?? "",
        "--backend",
        opts.modelBackend ?? "typebert",
        "--model",
        modelPath,
        "--device",
        opts.modelDevice ?? "auto",
        "--max-new-tokens",
        String(opts.modelMaxNewTokens ?? 800),
        "--temperature",
        String(opts.modelTemperature ?? 0.0),
        "--seed",
        String(opts.modelSeed ?? 0),
        "--torch-dtype",
        String(torchDtype),
        "--low-cpu-mem-usage",
        String(lowCpuMemUsage),
        "--trust-remote-code",
        String(trustRemoteCode),
        "--force-any-modules",
        String(forceAnyModules),
      ],
      {
      cwd: ROOT,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, CI: "1" },
      },
    );
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

function collectMemberAccesses(src, localName) {
  // Best-effort: collect `localName.<ident>` accesses.
  // This helps when code does `import * as ns from 'm'` then uses `ns.foo` without named imports.
  if (!src || !localName) return [];
  const re = new RegExp(`\\b${localName.replace(/[$]/g, "\\$") }\\.([A-Za-z_$][\\w$]*)\\b`, "g");
  const out = new Set();
  let m;
  while ((m = re.exec(src)) !== null) out.add(m[1]);
  return [...out];
}

function ensureModuleEntry(moduleToStub, mod) {
  const cur = moduleToStub.get(mod) ?? {
    defaultImport: false,
    namespaceImport: false,
    named: new Set(),
    typeNamed: new Set(),
    // For named imports, capture member access like `Foo.bar` and emit `export namespace Foo { const bar:any }`.
    valueMembers: new Map(), // exportName -> Set(memberName)
  };
  moduleToStub.set(mod, cur);
  return cur;
}

async function listSourceFilesForMemberScan(repoDir, maxFiles) {
  // Best-effort: scan TS/TSX/MTS/CTS files under repo (excluding node_modules and .git).
  // Keep it conservative to avoid huge IO.
  const exDirs = new Set(["node_modules", ".git", ".turbo", ".next", "dist", "build", "out"]);
  const exPrefix = [".evaluation-types"];
  const exFiles = new Set(["package-lock.json", "pnpm-lock.yaml", "yarn.lock"]);
  const exExt = new Set([".ts", ".tsx", ".mts", ".cts"]);

  const out = [];
  async function walk(dir) {
    if (out.length >= maxFiles) return;
    let entries = [];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= maxFiles) return;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (exDirs.has(e.name)) continue;
        if (exPrefix.some((pref) => p.includes(`${path.sep}${pref}${path.sep}`))) continue;
        await walk(p);
      } else if (e.isFile()) {
        if (exFiles.has(e.name)) continue;
        const ext = path.extname(e.name);
        if (!exExt.has(ext)) continue;
        out.push(p);
      }
    }
  }
  await walk(repoDir);
  return out;
}

async function enrichModuleToStubWithMemberAccess({ repoDir, moduleToStub, opts }) {
  // Scan scope=repo: find more member accesses for ns/default imports to avoid TS2339 regressions
  // that appear outside initial diagFiles.
  const files = await listSourceFilesForMemberScan(repoDir, opts.memberAccessMaxFiles);
  for (const abs of files) {
    let st;
    try {
      st = await fs.stat(abs);
    } catch {
      continue;
    }
    if (st.size > opts.memberAccessMaxBytesPerFile) continue;
    const src = await fs.readFile(abs, "utf8").catch(() => "");
    if (!src) continue;
    const imports = collectImportsFromSource(src);
    for (const imp of imports) {
      const mod = imp.mod;
      if (!mod) continue;
      if (!moduleToStub.has(mod)) continue;
      if (imp.sideEffect) continue;
      const cur = moduleToStub.get(mod);
      if (!cur) continue;
      if (imp.namespaceName) {
        const mem = collectMemberAccesses(src, imp.namespaceName).slice(0, opts.memberAccessMaxMembersPerImport);
        for (const m of mem) {
          cur.named.add(m);
          cur.typeNamed.add(m);
        }
      }
      if (imp.defaultName) {
        const mem = collectMemberAccesses(src, imp.defaultName).slice(0, opts.memberAccessMaxMembersPerImport);
        for (const m of mem) {
          cur.named.add(m);
          cur.typeNamed.add(m);
        }
      }
    }
  }
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

function getInjectedDtsSyntaxErrorCodes(tsErrorCounts) {
  // If the injected d.ts is syntactically invalid, tsc may fail before reporting Phase3 codes,
  // making Phase3 "eliminated" look falsely great.
  const counts = tsErrorCounts ?? {};
  const bad = ["TS1005", "TS1109", "TS1128", "TS1131", "TS1160", "TS1434"];
  const out = [];
  for (const c of bad) if ((counts?.[c] ?? 0) > 0) out.push(c);
  return out;
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
      localizer: {
        topModules: Number.isFinite(opts.localizerTopModules) ? opts.localizerTopModules : null,
        beforeTopModulesCount: null,
        afterTopModulesCount: null,
        topModuleFreq: [],
      },
      model:
        opts.mode === "model"
          ? {
              cmd: opts.modelCmd,
              script: opts.modelScript,
              backend: opts.modelBackend,
              model: opts.modelNameOrPath || process.env.TYPEBERT_MODEL || "",
              device: opts.modelDevice,
              maxNewTokens: opts.modelMaxNewTokens,
              temperature: opts.modelTemperature,
              seed: opts.modelSeed,
              torchDtype: opts.modelTorchDtype || process.env.TYPEBERT_TORCH_DTYPE || "auto",
              lowCpuMemUsage: opts.modelLowCpuMemUsage || process.env.TYPEBERT_LOW_CPU_MEM_USAGE || "1",
              trustRemoteCode: opts.modelTrustRemoteCode || process.env.TYPEBERT_TRUST_REMOTE_CODE || "0",
            }
          : null,
      modelCacheDir: opts.mode === "model" ? (opts.modelCacheDir ?? "") : "",
      diagFiles: [],
      stubModules: [],
      stubModulesCount: 0,
      reduced: false,
      eliminated: false,
      injectedDtsInvalid: false,
      injectedDtsSyntaxCodes: [],
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

  // Optional: for externalFilter=deps, load root dependency list once per repo.
  if (opts.externalFilter === "deps") {
    opts.dependencyNames = await readRootDependencyNames(repoDir);
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
  const moduleFreq = new Map(); // module -> count (frequency in diag files)
  for (const f of diagFiles) {
    const abs = path.isAbsolute(f) ? f : path.join(repoDir, f);
    if (!(await fileExists(abs))) continue;
    const src = await fs.readFile(abs, "utf8").catch(() => "");
    const imports = collectImportsFromSource(src);
    for (const imp of imports) {
      const mod = imp.mod;
      if (!mod) continue;
      if (opts.onlyExternal) {
        const okExternal =
          opts.externalFilter === "deps" ? isExternalByDeps(mod, opts) : isExternalModuleSpecifier(mod, opts);
        if (!okExternal) continue;
      }
      if (imp.sideEffect) continue;

      moduleFreq.set(mod, (moduleFreq.get(mod) ?? 0) + 1);
      const cur = ensureModuleEntry(moduleToStub, mod);
      if (imp.defaultName) cur.defaultImport = true;
      if (imp.namespaceName) cur.namespaceImport = true;
      for (const n of imp.named ?? []) {
        if (n.isType) cur.typeNamed.add(n.imported);
        else cur.named.add(n.imported);
      }

      // Heuristic: if code uses namespace/default import and then accesses `.foo`,
      // add those member names as exports too, to avoid TS2339/TS2694 regressions.
      // (We add to BOTH value + type namespaces for safety; TS allows both.)
      const MAX_MEMBERS = opts.memberAccessMaxMembersPerImport ?? 200;
      if (imp.namespaceName) {
        const mem = collectMemberAccesses(src, imp.namespaceName).slice(0, MAX_MEMBERS);
        for (const m of mem) {
          cur.named.add(m);
          cur.typeNamed.add(m);
        }
      }
      if (imp.defaultName) {
        const mem = collectMemberAccesses(src, imp.defaultName).slice(0, MAX_MEMBERS);
        for (const m of mem) {
          // default import is typically a value, but adding exported members doesn't hurt,
          // and can fix cases where default import is actually a namespace-like import under the hood.
          cur.named.add(m);
          cur.typeNamed.add(m);
        }
      }

      // Named imports: `import { Foo } from 'm'` then `Foo.bar`.
      // We cannot add `bar` as a module export; instead we record it so the adapter can emit
      // `export namespace Foo { export const bar: any; }` to satisfy static-like accesses.
      for (const n of imp.named ?? []) {
        if (n.isType) continue;
        const mem = collectMemberAccesses(src, n.local).slice(0, MAX_MEMBERS);
        if (!mem.length) continue;
        const key = n.imported;
        const set = cur.valueMembers.get(key) ?? new Set();
        for (const m of mem) set.add(m);
        cur.valueMembers.set(key, set);
      }

    }
  }

  // Localizer (Top-M): keep only the most frequently referenced modules in Phase3 diagnostic files.
  result.phase3.localizer.beforeTopModulesCount = moduleToStub.size;
  if (Number.isFinite(opts.localizerTopModules) && moduleToStub.size > opts.localizerTopModules) {
    const ranked = [...moduleFreq.entries()].sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]));
    const kept = new Set(ranked.slice(0, opts.localizerTopModules).map(([m]) => m));
    for (const k of [...moduleToStub.keys()]) {
      if (!kept.has(k)) moduleToStub.delete(k);
    }
    result.phase3.localizer.topModuleFreq = ranked.slice(0, Math.min(50, opts.localizerTopModules)).map(([m, c]) => ({
      module: m,
      freq: c,
    }));
  } else {
    result.phase3.localizer.topModuleFreq = [...moduleFreq.entries()]
      .sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]))
      .slice(0, 50)
      .map(([m, c]) => ({ module: m, freq: c }));
  }
  result.phase3.localizer.afterTopModulesCount = moduleToStub.size;

  if (opts.memberAccessScope === "repo") {
    await enrichModuleToStubWithMemberAccess({ repoDir, moduleToStub, opts });
  }

  if (moduleToStub.size === 0) {
    result.skipReason = "no-stub-modules-found";
    result.durationMs = Date.now() - startedAt;
    if (!opts.keepRepos) await rmrf(repoDir);
    await outHandle.appendFile(JSON.stringify(result) + "\n");
    return;
  }

  if (Number.isFinite(opts.maxStubModules) && moduleToStub.size > opts.maxStubModules) {
    result.skipReason = "too-many-stub-modules";
    result.phase3.stubModulesCount = moduleToStub.size;
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
    // Keep a small pointer to the model output for later failure analysis
    // without bloating results.jsonl with full d.ts text.
    result.phase3.modelOutput = {
      backend: obj.backend ?? null,
      cacheKey: obj.cache_key ?? null,
      adapterVersion: obj.meta?.adapter_version ?? null,
      fallbackReason: obj.meta?.fallback_reason ?? null,
      missingModulesFilledWithAny: obj.meta?.missing_modules_filled_with_any ?? null,
    };
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
  const injectedSyntaxCodes = getInjectedDtsSyntaxErrorCodes(jcounts);
  result.phase3.injectedDtsSyntaxCodes = injectedSyntaxCodes;
  // Conservative: treat as invalid if TS parser errors exist after injection.
  result.phase3.injectedDtsInvalid = injectedSyntaxCodes.length > 0;

  const injectionValid = !result.phase3.injectedDtsInvalid && !jr.timedOut;
  result.phase3.reduced = injectionValid ? afterPhase3 < baselinePhase3 : false;
  result.phase3.eliminated = injectionValid ? afterPhase3 === 0 && baselinePhase3 > 0 : false;

  result.durationMs = Date.now() - startedAt;
  if (!opts.keepRepos) await rmrf(repoDir);
  await outHandle.appendFile(JSON.stringify(result) + "\n");
}

async function main() {
  const opts = parseArgs(process.argv);
  const allUrls = (await readRepoUrls(path.resolve(opts.reposFile))).slice(0, opts.max);

  const outDir = path.resolve(opts.outDir);
  const workDir = path.resolve(opts.workDir);
  await fs.mkdir(outDir, { recursive: true });
  await fs.mkdir(workDir, { recursive: true });

  const resultsPath = path.join(outDir, "results.jsonl");
  const summaryPath = path.join(outDir, "summary.tsv");

  // resume: read existing results.jsonl and skip processed URLs
  const processed = new Set();
  if (opts.resume && (await fileExists(resultsPath))) {
    const prev = await fs.readFile(resultsPath, "utf8").catch(() => "");
    for (const ln of prev.split(/\r?\n/)) {
      if (!ln.trim()) continue;
      try {
        const o = JSON.parse(ln);
        if (typeof o?.url === "string" && o.url.length > 0) processed.add(o.url);
      } catch {
        // ignore bad lines
      }
    }
  }

  const urls = opts.resume ? allUrls.filter((u) => !processed.has(u)) : allUrls;
  const outHandle = await fs.open(resultsPath, opts.resume ? "a" : "w");

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
    "phase3InjectedDtsInvalid",
    "phase3InjectedDtsSyntaxCodes",
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
        o.phase3?.injectedDtsInvalid ? "true" : "false",
        (o.phase3?.injectedDtsSyntaxCodes ?? []).join(","),
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


