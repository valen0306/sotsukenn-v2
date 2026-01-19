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
import { builtinModules, createRequire } from "node:module";

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
    // Localizer scoring mode:
    // - per-file: count each imported module once per diag file (current behavior)
    // - per-error: weight modules by number of Phase3 diagnostics in files that import them (error-location→module signal)
    localizerMode: "per-file", // per-file | per-error
    // Phase1: trial exploration strategy (Policy A / Phase1)
    // - top1: current behavior (single candidate)
    // - module-any-sweep: try candidates by forcing ONE module to any-stub at a time (localizer-controlled)
    trialStrategy: "top1", // top1 | module-any-sweep | reranker-v0
    trialMax: 1, // max number of candidates to run per repo (including top1)
    sweepAnyK: 1, // Candidate Generator v1: how many modules to override with any-stub per candidate (1 or 2)
    sweepAnyTopK: 0, // Candidate Generator v2: add one candidate that overrides the first K modules at once (0=off)
    symbolWidenMode: "off", // off | interface-indexer | namespace-members | function-any-overload | missing-exports | export-to-any | type-to-any
    symbolWidenMax: 0, // max number of symbol-level candidates to add (0=off)
    repairFromTop1: false, // Candidate Generator v3 (Repair Operator): generate targeted candidates from top1 injected diagnostics
    repairMax: 0, // max number of repair candidates to add (0=off)
    earlyStopAfterImprove: false, // Week3 safeguard: stop after first improvement vs top1
    earlyStopTieStreak: 0, // Week3 safeguard: stop after N consecutive ties vs top1
    rerankerModel: "", // path to reranker-v0 JSON (Phase4 output)
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
    else if (a === "--localizer-mode") args.localizerMode = String(argv[++i] ?? "per-file");
    else if (a === "--trial-strategy") args.trialStrategy = String(argv[++i] ?? "top1");
    else if (a === "--trial-max") args.trialMax = Number(argv[++i] ?? "1");
    else if (a === "--sweep-any-k") args.sweepAnyK = Number(argv[++i] ?? "1");
    else if (a === "--sweep-any-topk") args.sweepAnyTopK = Number(argv[++i] ?? "0");
    else if (a === "--symbol-widen-mode") args.symbolWidenMode = String(argv[++i] ?? "off");
    else if (a === "--symbol-widen-max") args.symbolWidenMax = Number(argv[++i] ?? "0");
    else if (a === "--repair-from-top1") args.repairFromTop1 = true;
    else if (a === "--repair-max") args.repairMax = Number(argv[++i] ?? "0");
    else if (a === "--early-stop-after-improve") args.earlyStopAfterImprove = true;
    else if (a === "--early-stop-tie-streak") args.earlyStopTieStreak = Number(argv[++i] ?? "0");
    else if (a === "--reranker-model") args.rerankerModel = String(argv[++i] ?? "");
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
  --localizer-mode <per-file|per-error> (M2) Module ranking mode for Localizer (default: per-file)
  --trial-strategy <top1|module-any-sweep|reranker-v0>  (Phase1/5) Candidate trial strategy (default: top1)
  --trial-max <N>                    (Phase1) Max candidates per repo including top1 (default: 1)
  --sweep-any-k <1|2>                (M1/Candidate v1) In module-any-sweep, override K modules per candidate (default: 1)
  --sweep-any-topk <N>               (M1/Candidate v2) Add one candidate that overrides the first N stub modules at once (default: 0/off)
  --symbol-widen-mode <off|interface-indexer|namespace-members|function-any-overload|missing-exports|export-to-any|type-to-any> (M1/Candidate v3) Add symbol-level candidates (default: off)
  --symbol-widen-max <N>             (M1/Candidate v3) Max symbol-level candidates to add (default: 0/off)
  --repair-from-top1                (M1/Candidate v3) Generate targeted repair candidates from top1 injected diagnostics
  --repair-max <N>                  (M1/Candidate v3) Max repair candidates to add (default: 0/off)
  --early-stop-after-improve        (Week3) Stop trials once a candidate improves vs top1 (reduces tsc calls)
  --early-stop-tie-streak <N>       (Week3) Stop after N consecutive ties vs top1 (default: 0/off)
  --reranker-model <PATH>            (Phase4/5) Reranker v0 model JSON (required for reranker-v0)
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
  if (!["per-file", "per-error"].includes(String(args.localizerMode))) args.localizerMode = "per-file";
  if (!["top1", "module-any-sweep", "reranker-v0"].includes(String(args.trialStrategy))) args.trialStrategy = "top1";
  if (!Number.isFinite(args.trialMax) || args.trialMax < 1) args.trialMax = 1;
  if (![1, 2].includes(Number(args.sweepAnyK))) args.sweepAnyK = 1;
  if (!Number.isFinite(args.sweepAnyTopK) || args.sweepAnyTopK < 0) args.sweepAnyTopK = 0;
  if (!["off", "interface-indexer", "namespace-members", "function-any-overload", "missing-exports", "export-to-any", "type-to-any"].includes(String(args.symbolWidenMode))) args.symbolWidenMode = "off";
  if (!Number.isFinite(args.symbolWidenMax) || args.symbolWidenMax < 0) args.symbolWidenMax = 0;
  if (!Number.isFinite(args.repairMax) || args.repairMax < 0) args.repairMax = 0;
  if (!Number.isFinite(args.earlyStopTieStreak) || args.earlyStopTieStreak < 0) args.earlyStopTieStreak = 0;
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

function sha1Hex(s) {
  return crypto.createHash("sha1").update(String(s ?? ""), "utf8").digest("hex");
}

function buildDeltaErrors({ baselineCounts, injectedCounts }) {
  const keys = new Set([...Object.keys(baselineCounts ?? {}), ...Object.keys(injectedCounts ?? {})]);
  const out = {};
  for (const k of [...keys].sort()) {
    const b = baselineCounts?.[k] ?? 0;
    const j = injectedCounts?.[k] ?? 0;
    out[k] = j - b;
  }
  return out;
}

function extractDeclarationsFromDts(dtsText) {
  // Best-effort extraction of "exported declaration units" from `.d.ts`.
  // This is intentionally shallow (regex-based) but stable enough for logging/tracking.
  const txt = String(dtsText ?? "");
  const decls = [];

  // Match `declare module 'x' { ... }` blocks to associate declarations with a module.
  const modRe = /declare\s+module\s+['"]([^'"]+)['"]\s*\{([\s\S]*?)\n\}/g;
  let m;
  while ((m = modRe.exec(txt)) !== null) {
    const mod = m[1];
    const body = m[2] ?? "";
    const lines = body.split(/\r?\n/);
    for (const ln of lines) {
      const s = ln.trim();
      if (!s.startsWith("export ")) continue;
      // Capture the "kind" and "name" for common exports.
      const mm =
        s.match(/^export\s+(const|type|interface|function|class|enum|namespace)\s+([A-Za-z0-9_$]+)/) ??
        s.match(/^export\s+default\b/);
      let kind = "";
      let name = "";
      if (!mm) continue;
      if (mm[0].startsWith("export default")) {
        kind = "default";
        name = "__default";
      } else {
        kind = mm[1];
        name = mm[2];
      }
      const declKey = `${mod}::${kind}::${name}::${s}`;
      decls.push({
        declaration_id: `decl_${sha1Hex(declKey).slice(0, 12)}`,
        module: mod,
        kind,
        name,
      });
    }
  }

  // De-dup (stable order)
  const seen = new Set();
  const uniq = [];
  for (const d of decls) {
    const k = `${d.declaration_id}`;
    if (seen.has(k)) continue;
    seen.add(k);
    uniq.push(d);
  }
  return uniq;
}

function extractExportedInterfacesByModule(dtsText) {
  const txt = String(dtsText ?? "");
  const out = new Map(); // mod -> Set(names)
  const modRe = /declare\s+module\s+['"]([^'"]+)['"]\s*\{([\s\S]*?)\n\}/g;
  let m;
  while ((m = modRe.exec(txt)) !== null) {
    const mod = m[1];
    const body = m[2] ?? "";
    const set = out.get(mod) ?? new Set();
    const re = /export\s+interface\s+([A-Za-z0-9_$]+)/g;
    let mm;
    while ((mm = re.exec(body)) !== null) set.add(mm[1]);
    out.set(mod, set);
  }
  return out;
}

function buildInterfaceIndexerAugmentation(mod, name) {
  return [
    `declare module '${esc(mod)}' {`,
    `  export interface ${name} {`,
    `    [key: string]: any;`,
    `  }`,
    `}`,
    ``,
    ``,
  ].join("\n");
}

function extractExportedMergeableValuesByModule(dtsText) {
  // Names that can legally merge with a namespace declaration (function/class/namespace/enum).
  const txt = String(dtsText ?? "");
  const out = new Map(); // mod -> Set(names)
  const modRe = /declare\s+module\s+['"]([^'"]+)['"]\s*\{([\s\S]*?)\n\}/g;
  let m;
  while ((m = modRe.exec(txt)) !== null) {
    const mod = m[1];
    const body = m[2] ?? "";
    const set = out.get(mod) ?? new Set();
    const re = /export\s+(function|class|namespace|enum)\s+([A-Za-z0-9_$]+)/g;
    let mm;
    while ((mm = re.exec(body)) !== null) set.add(mm[2]);
    out.set(mod, set);
  }
  return out;
}

function buildNamespaceMembersAugmentation(mod, name, members) {
  const uniq = [...new Set(members ?? [])].filter((x) => typeof x === "string" && /^[A-Za-z_$][\w$]*$/.test(x)).sort();
  const chunks = [];
  chunks.push(`declare module '${esc(mod)}' {`);
  chunks.push(`  export namespace ${name} {`);
  for (const mem of uniq) chunks.push(`    export const ${mem}: any;`);
  chunks.push(`  }`);
  chunks.push(`}`);
  chunks.push("");
  chunks.push("");
  return chunks.join("\n");
}

function extractExportedFunctionsByModule(dtsText) {
  const txt = String(dtsText ?? "");
  const out = new Map(); // mod -> Set(names)
  const modRe = /declare\s+module\s+['"]([^'"]+)['"]\s*\{([\s\S]*?)\n\}/g;
  let m;
  while ((m = modRe.exec(txt)) !== null) {
    const mod = m[1];
    const body = m[2] ?? "";
    const set = out.get(mod) ?? new Set();
    const re = /export\s+function\s+([A-Za-z0-9_$]+)\s*\(/g;
    let mm;
    while ((mm = re.exec(body)) !== null) set.add(mm[1]);
    out.set(mod, set);
  }
  return out;
}

function buildFunctionAnyOverloadAugmentation(mod, name) {
  return [
    `declare module '${esc(mod)}' {`,
    `  export function ${name}(...args: any[]): any;`,
    `}`,
    ``,
    ``,
  ].join("\n");
}

function buildFunctionAnyArityOverloadAugmentation(mod, name, arity) {
  const n = Number(arity);
  if (!Number.isFinite(n) || n < 0 || n > 12) return null;
  const args = Array.from({ length: n }, (_, i) => `a${i}: any`).join(", ");
  return [
    `declare module '${esc(mod)}' {`,
    `  export function ${name}(${args}): any;`,
    `}`,
    ``,
    ``,
  ].join("\n");
}

function extractExportedNamesByModule(dtsText) {
  const txt = String(dtsText ?? "");
  const out = new Map(); // mod -> Set(names)
  const modRe = /declare\s+module\s+['"]([^'"]+)['"]\s*\{([\s\S]*?)\n\}/g;
  let m;
  while ((m = modRe.exec(txt)) !== null) {
    const mod = m[1];
    const body = m[2] ?? "";
    const set = out.get(mod) ?? new Set();
    const re = /export\s+(?:const|type|interface|function|class|enum|namespace)\s+([A-Za-z0-9_$]+)/g;
    let mm;
    while ((mm = re.exec(body)) !== null) set.add(mm[1]);
    out.set(mod, set);
  }
  return out;
}

function buildMissingExportsAugmentation(mod, missingValueNames, missingTypeNames) {
  const val = [...new Set(missingValueNames ?? [])].filter((x) => typeof x === "string" && /^[A-Za-z_$][\w$]*$/.test(x)).sort();
  const typ = [...new Set(missingTypeNames ?? [])].filter((x) => typeof x === "string" && /^[A-Za-z_$][\w$]*$/.test(x)).sort();
  if (!val.length && !typ.length) return null;
  const chunks = [];
  chunks.push(`declare module '${esc(mod)}' {`);
  for (const n of val) chunks.push(`  export const ${n}: any;`);
  for (const t of typ) chunks.push(`  export type ${t} = any;`);
  chunks.push(`}`);
  chunks.push("");
  chunks.push("");
  return chunks.join("\n");
}

function sigmoid(z) {
  if (z >= 0) {
    const ez = Math.exp(-z);
    return 1 / (1 + ez);
  }
  const ez = Math.exp(z);
  return ez / (1 + ez);
}

function getRerankerFeatureKeys() {
  return [
    "has_override",
    "override_mention_count",
    "override_localizer_freq",
    "override_localizer_rank",
    "override_is_top1_localizer",
    "override_mention_ts2307",
    "override_mention_ts2614",
    "declaration_count",
    "baseline_phase3_core",
    "baseline_total_errors",
    "baseline_ts2307",
    "baseline_ts2614",
    "baseline_ts2339",
    "baseline_ts2345",
    "baseline_ts2322",
    "baseline_ts2554",
    "baseline_ts2769",
    "baseline_ts7053",
  ];
}

function sumCounts(counts) {
  let n = 0;
  for (const v of Object.values(counts ?? {})) n += Number(v) || 0;
  return n;
}

function sumPhase3Core(tsCounts) {
  const PHASE3 = ["TS2339", "TS2345", "TS2322", "TS2554", "TS2769", "TS2353", "TS2741", "TS7053"];
  let n = 0;
  for (const c of PHASE3) n += Number(tsCounts?.[c] ?? 0) || 0;
  return n;
}

function extractModuleMentionsFromDiagnostics(diags) {
  const out = new Map();
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

function localizerFreqFromTopList(topModuleFreq, mod) {
  for (const x of topModuleFreq ?? []) {
    if (x?.module === mod) return Number(x?.freq ?? 0) || 0;
  }
  return 0;
}

function localizerRankFromTopList(topModuleFreq, mod) {
  for (let i = 0; i < (topModuleFreq ?? []).length; i++) {
    if (topModuleFreq[i]?.module === mod) return i + 1;
  }
  return 0;
}

function buildRerankerCandidateFeatures({ baselineCounts, baselineDiagnostics, topModuleFreq, moduleOverride, declarationCount }) {
  const mentionMap = extractModuleMentionsFromDiagnostics(baselineDiagnostics);
  const mentionByCode = extractModuleMentionsByCode(baselineDiagnostics);
  const overrides = Array.isArray(moduleOverride)
    ? moduleOverride.filter((x) => typeof x === "string" && x.trim() !== "")
    : (moduleOverride ? [String(moduleOverride)] : []);
  const uniq = [...new Set(overrides)];
  const rank = uniq.length ? Math.min(...uniq.map((m) => localizerRankFromTopList(topModuleFreq, m)).filter((n) => n > 0), 0) : 0;
  const mentionSum = uniq.reduce((a, m) => a + Number(mentionMap.get(m) ?? 0), 0);
  const localizerFreqSum = uniq.reduce((a, m) => a + localizerFreqFromTopList(topModuleFreq, m), 0);
  return {
    has_override: uniq.length ? 1 : 0,
    override_mention_count: mentionSum,
    override_localizer_freq: localizerFreqSum,
    override_localizer_rank: rank,
    override_is_top1_localizer: uniq.length ? (rank === 1 ? 1 : 0) : 0,
    override_mention_ts2307: uniq.reduce((a, m) => a + Number(mentionByCode.get("TS2307")?.get(m) ?? 0), 0),
    override_mention_ts2614: uniq.reduce((a, m) => a + Number(mentionByCode.get("TS2614")?.get(m) ?? 0), 0),
    declaration_count: Number(declarationCount ?? 0) || 0,
    baseline_phase3_core: sumPhase3Core(baselineCounts),
    baseline_total_errors: sumCounts(baselineCounts),
    baseline_ts2307: Number(baselineCounts?.TS2307 ?? 0) || 0,
    baseline_ts2614: Number(baselineCounts?.TS2614 ?? 0) || 0,
    baseline_ts2339: Number(baselineCounts?.TS2339 ?? 0) || 0,
    baseline_ts2345: Number(baselineCounts?.TS2345 ?? 0) || 0,
    baseline_ts2322: Number(baselineCounts?.TS2322 ?? 0) || 0,
    baseline_ts2554: Number(baselineCounts?.TS2554 ?? 0) || 0,
    baseline_ts2769: Number(baselineCounts?.TS2769 ?? 0) || 0,
    baseline_ts7053: Number(baselineCounts?.TS7053 ?? 0) || 0,
  };
}

function vecFrom(feat, keys) {
  return keys.map((k) => Number(feat?.[k] ?? 0) || 0);
}

function scoreCandidateVsTop1({ model, candidateFeat, top1Feat }) {
  // model is trained on x = feat(a) - feat(b), predict P(a better than b)
  const keys = model?.feature_keys ?? getRerankerFeatureKeys();
  const w = model?.weights;
  const bias = Number(w?.bias ?? 0) || 0;
  const wMap = w?.w ?? {};
  const wc = keys.map((k) => Number(wMap?.[k] ?? 0) || 0);
  const xa = vecFrom(candidateFeat, keys);
  const xb = vecFrom(top1Feat, keys);
  let z = bias;
  for (let i = 0; i < keys.length; i++) z += wc[i] * (xa[i] - xb[i]);
  return { z, p: sigmoid(z) };
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

function capDiagnostics(diags, max) {
  const n = Number.isFinite(max) ? max : 0;
  if (!n || n < 1) return [];
  return (diags ?? []).slice(0, n);
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

function buildPhase3StubModuleBlock(mod, info) {
  const named = [...(info.named ?? new Set())].sort();
  const typeNamed = [...(info.typeNamed ?? new Set())].sort();
  const hasDefault = Boolean(info.defaultImport);
  const chunks = [];
  chunks.push(`declare module '${esc(mod)}' {\n`);
  if (hasDefault) chunks.push(`  const __default: any;\n  export default __default;\n`);
  chunks.push(`  export const __any: any;\n`);
  for (const n of named) chunks.push(`  export const ${n}: any;\n`);
  for (const t of typeNamed) chunks.push(`  export type ${t} = any;\n`);
  chunks.push("}\n\n");
  return chunks.join("");
}

function escapeRegex(s) {
  return String(s ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function replaceDeclareModuleBlock(dtsText, mod, newBlockText) {
  const txt = String(dtsText ?? "");
  const re = new RegExp(`declare\\s+module\\s+['"]${escapeRegex(mod)}['"]\\s*\\{`, "g");
  const m = re.exec(txt);
  if (!m) return null;
  const start = m.index;
  // Heuristic: ReportLab/our generator tends to end blocks with `}\n\n`. Find the next `\n}\n` after the start.
  const closeIdx = txt.indexOf("\n}\n", m.index);
  if (closeIdx < 0) return null;
  const end = closeIdx + "\n}\n".length;
  return txt.slice(0, start) + newBlockText + txt.slice(end);
}

function getDeclareModuleBlockRange(dtsText, mod) {
  const txt = String(dtsText ?? "");
  const re = new RegExp(`declare\\s+module\\s+['"]${escapeRegex(mod)}['"]\\s*\\{`, "g");
  const m = re.exec(txt);
  if (!m) return null;
  const start = m.index;
  const closeIdx = txt.indexOf("\n}\n", m.index);
  if (closeIdx < 0) return null;
  const end = closeIdx + "\n}\n".length;
  return { start, end, text: txt.slice(start, end) };
}

function replaceExportsInDeclareModuleBlock(dtsText, mod, replacements) {
  // replacements: Map<name, { kind, line }>
  const rng = getDeclareModuleBlockRange(dtsText, mod);
  if (!rng) return null;
  const block = rng.text;
  const lines = block.split(/\r?\n/);
  let changed = false;
  const out = lines.map((ln) => {
    for (const [name, rep] of replacements.entries()) {
      const n = escapeRegex(name);
      if (rep.kind === "const") {
        const re = new RegExp(`^\\s*export\\s+const\\s+${n}\\b`);
        if (re.test(ln)) {
          changed = true;
          return `  export const ${name}: any;`;
        }
      } else if (rep.kind === "function") {
        const re = new RegExp(`^\\s*export\\s+function\\s+${n}\\s*\\(`);
        if (re.test(ln)) {
          changed = true;
          return `  export function ${name}(...args: any[]): any;`;
        }
      } else if (rep.kind === "class") {
        const re = new RegExp(`^\\s*export\\s+class\\s+${n}\\b`);
        if (re.test(ln)) {
          changed = true;
          // Value-as-any is the most permissive for member accesses, but may break `new`.
          // Keep it conservative: do not rewrite classes by default.
          return ln;
        }
      }
    }
    return ln;
  });
  if (!changed) return null;
  const newBlock = out.join("\n");
  const txt = String(dtsText ?? "");
  return txt.slice(0, rng.start) + newBlock + txt.slice(rng.end);
}

function replaceTypeDeclToAnyInDeclareModuleBlock(dtsText, mod, name) {
  const rng = getDeclareModuleBlockRange(dtsText, mod);
  if (!rng) return null;
  const block = rng.text;
  const n = escapeRegex(name);
  let newBlock = block;
  // Replace `export type Name = ...;` (including multiline) with `export type Name = any;`
  const typeRe = new RegExp(`(^|\\n)\\s*export\\s+type\\s+${n}\\s*=([\\s\\S]*?);`, "m");
  if (typeRe.test(newBlock)) {
    newBlock = newBlock.replace(typeRe, `$1  export type ${name} = any;`);
  } else {
    // Replace `export interface Name { ... }` block with `export type Name = any;`
    const ifaceRe = new RegExp(`(^|\\n)\\s*export\\s+interface\\s+${n}\\s*\\{[\\s\\S]*?\\n\\s*\\}`, "m");
    if (ifaceRe.test(newBlock)) {
      newBlock = newBlock.replace(ifaceRe, `$1  export type ${name} = any;`);
    } else {
      return null;
    }
  }
  const txt = String(dtsText ?? "");
  return txt.slice(0, rng.start) + newBlock + txt.slice(rng.end);
}

function addPropertyToExportedInterfaceInDeclareModuleBlock(dtsText, mod, ifaceName, propName) {
  const rng = getDeclareModuleBlockRange(dtsText, mod);
  if (!rng) return null;
  const block = rng.text;
  const iface = escapeRegex(ifaceName);
  const prop = escapeRegex(propName);
  const ifaceRe = new RegExp(`(^|\\n)(\\s*export\\s+interface\\s+${iface}\\s*\\{)([\\s\\S]*?)(\\n\\s*\\})`, "m");
  const m = block.match(ifaceRe);
  if (!m) return null;
  const body = m[3] ?? "";
  // already present?
  const propRe = new RegExp(`\\b${prop}\\s*[:?]`, "m");
  if (propRe.test(body)) return null;
  const injectedLine = `\n    ${propName}?: any;`;
  const newBlock = block.replace(ifaceRe, `$1$2$3${injectedLine}$4`);
  const txt = String(dtsText ?? "");
  return txt.slice(0, rng.start) + newBlock + txt.slice(rng.end);
}

function addExportConstToDeclareModuleBlock(dtsText, mod, exportName) {
  const rng = getDeclareModuleBlockRange(dtsText, mod);
  if (!rng) return null;
  const block = rng.text;
  const n = escapeRegex(exportName);
  const exists = new RegExp(`\\bexport\\s+const\\s+${n}\\b`).test(block);
  if (exists) return null;
  // Insert before closing brace line.
  const closeRe = /\n\s*\}\n$/m;
  if (!closeRe.test(block)) return null;
  const newBlock = block.replace(closeRe, `\n  export const ${exportName}: any;\n}\n`);
  const txt = String(dtsText ?? "");
  return txt.slice(0, rng.start) + newBlock + txt.slice(rng.end);
}

function buildMinimalDeclareModule(mod, bodyLines) {
  const lines = (bodyLines ?? []).filter((x) => typeof x === "string" && x.trim() !== "");
  if (!lines.length) return null;
  return [
    `declare module '${esc(mod)}' {`,
    ...lines.map((l) => `  ${l}`),
    `}`,
    ``,
    ``,
  ].join("\n");
}

async function readLineFromRepoFile(repoDir, relOrAbsPath, oneBasedLine) {
  try {
    const abs = path.isAbsolute(relOrAbsPath) ? relOrAbsPath : path.join(repoDir, relOrAbsPath);
    const src = await fs.readFile(abs, "utf8");
    const lines = src.split(/\r?\n/);
    const idx = Math.max(0, (Number(oneBasedLine) || 1) - 1);
    return lines[idx] ?? "";
  } catch {
    return "";
  }
}

function findImportForLocalName(imports, local) {
  for (const imp of imports ?? []) {
    if (!imp?.mod) continue;
    if (imp.namespaceName === local) return { mod: imp.mod, kind: "namespace", imported: "*" };
    if (imp.defaultName === local) return { mod: imp.mod, kind: "default", imported: "default" };
    for (const n of imp.named ?? []) {
      if (n.local === local) return { mod: imp.mod, kind: "named", imported: n.imported };
    }
  }
  return null;
}

function collectRequiresFromSource(src) {
  const out = [];
  const lines = (src ?? "").split(/\r?\n/);
  // const X = require('m')
  const reqDefaultRe = /^\s*const\s+([A-Za-z_$][\w$]*)\s*=\s*require\(\s*['"]([^'"]+)['"]\s*\)\s*;?\s*$/;
  // const { A, B: C } = require('m')
  const reqDestructRe = /^\s*const\s+\{\s*([^}]+)\s*\}\s*=\s*require\(\s*['"]([^'"]+)['"]\s*\)\s*;?\s*$/;
  for (const ln of lines) {
    const m1 = ln.match(reqDefaultRe);
    if (m1) {
      out.push({ mod: m1[2], defaultName: m1[1], named: [] });
      continue;
    }
    const m2 = ln.match(reqDestructRe);
    if (m2) {
      const mod = m2[2];
      const inside = m2[1] ?? "";
      const named = [];
      for (const seg of inside.split(",")) {
        const s = seg.trim();
        if (!s) continue;
        const mm = s.match(/^([A-Za-z_$][\w$]*)(?:\s*:\s*([A-Za-z_$][\w$]*))?$/);
        if (!mm) continue;
        const imported = mm[1];
        const local = mm[2] ?? imported;
        named.push({ imported, local, isType: false });
      }
      out.push({ mod, named });
    }
  }
  return out;
}

function loadTypeScriptFromRepo(repoDir) {
  try {
    const req = createRequire(path.join(repoDir, "__require__.js"));
    const tsPath = req.resolve("typescript");
    // eslint-disable-next-line global-require, import/no-dynamic-require
    return req(tsPath);
  } catch {
    return null;
  }
}

function buildTsProgram(ts, tsconfigPath) {
  try {
    const configFile = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
    if (configFile.error) return null;
    const config = ts.parseJsonConfigFileContent(configFile.config, ts.sys, path.dirname(tsconfigPath));
    const program = ts.createProgram({ rootNames: config.fileNames, options: config.options });
    const checker = program.getTypeChecker();
    return { program, checker };
  } catch {
    return null;
  }
}

function findNodeAtLineCol(ts, sourceFile, oneBasedLine, oneBasedCol) {
  const line = Math.max(0, (Number(oneBasedLine) || 1) - 1);
  const col = Math.max(0, (Number(oneBasedCol) || 1) - 1);
  const pos = ts.getPositionOfLineAndCharacter(sourceFile, line, col);
  let best = sourceFile;
  function walk(n) {
    if (pos < n.getStart(sourceFile, false) || pos > n.getEnd()) return;
    best = n;
    n.forEachChild(walk);
  }
  walk(sourceFile);
  return best;
}

function closest(node, pred) {
  let cur = node;
  while (cur) {
    if (pred(cur)) return cur;
    cur = cur.parent;
  }
  return null;
}

function resolveSymbolToImport(ts, checker, sym) {
  if (!sym) return null;
  const decls = sym.declarations ?? [];
  for (const d of decls) {
    // import { X as Y } from 'm'
    if (ts.isImportSpecifier(d) && ts.isNamedImports(d.parent) && ts.isImportClause(d.parent.parent) && ts.isImportDeclaration(d.parent.parent.parent)) {
      const mod = String(d.parent.parent.parent.moduleSpecifier.text ?? "");
      const imported = d.propertyName ? String(d.propertyName.text) : String(d.name.text);
      const local = String(d.name.text);
      return { mod, kind: "named", imported, local };
    }
    // import * as NS from 'm'
    if (ts.isNamespaceImport(d) && ts.isImportClause(d.parent) && ts.isImportDeclaration(d.parent.parent)) {
      const mod = String(d.parent.parent.moduleSpecifier.text ?? "");
      return { mod, kind: "namespace", imported: "*", local: String(d.name.text) };
    }
    // import Default from 'm'
    if (ts.isImportClause(d) && d.name && ts.isImportDeclaration(d.parent)) {
      const mod = String(d.parent.moduleSpecifier.text ?? "");
      return { mod, kind: "default", imported: "default", local: String(d.name.text) };
    }
    // const X = require('m')
    if (ts.isVariableDeclaration(d) && d.initializer && ts.isCallExpression(d.initializer) && ts.isIdentifier(d.initializer.expression) && d.initializer.expression.text === "require") {
      const arg0 = d.initializer.arguments?.[0];
      if (arg0 && ts.isStringLiteral(arg0)) return { mod: String(arg0.text), kind: "require", imported: "*", local: String(d.name.getText()) };
    }
  }
  // Follow alias symbols
  if (checker.getAliasedSymbol && (sym.flags & ts.SymbolFlags.Alias)) {
    const aliased = checker.getAliasedSymbol(sym);
    if (aliased && aliased !== sym) return resolveSymbolToImport(ts, checker, aliased);
  }
  return null;
}

function tryResolveVariableInitializerToImport(ts, checker, sym) {
  // If `sym` is a local variable initialized by calling an imported function/namespace member,
  // return {mod, imported} for that callee.
  if (!sym) return null;
  const decls = sym.declarations ?? [];
  for (const d of decls) {
    if (!ts.isVariableDeclaration(d) || !d.initializer) continue;
    const init = d.initializer;
    if (!ts.isCallExpression(init)) continue;
    const callee = init.expression;
    if (ts.isIdentifier(callee)) {
      const cs = checker.getSymbolAtLocation(callee);
      const imp = resolveSymbolToImport(ts, checker, cs);
      if (imp?.mod) return { mod: imp.mod, imported: imp.imported || callee.text, importKind: imp.kind };
    }
    if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)) {
      // ns.foo(...)
      const nsSym = checker.getSymbolAtLocation(callee.expression);
      const imp = resolveSymbolToImport(ts, checker, nsSym);
      if (imp?.mod && (imp.kind === "namespace" || imp.kind === "require")) {
        return { mod: imp.mod, imported: String(callee.name.text), importKind: "namespace-member" };
      }
    }
  }
  return null;
}

async function resolveCallCalleeViaTs({ ts, program, checker, repoDir, file, line, col }) {
  // Resolve the nearest call expression's callee to an imported symbol (module + export name).
  // Used for TS2345/TS2322 repair: widen callee or add any-overload.
  try {
    const abs = path.isAbsolute(file) ? file : path.join(repoDir, file);
    let sf = program.getSourceFile(abs);
    if (!sf) {
      const suffix = path.normalize(file).replaceAll("\\", "/");
      sf = program.getSourceFiles().find((f) => String(f.fileName ?? "").replaceAll("\\", "/").endsWith(suffix)) ?? null;
    }
    if (!sf) return null;
    const node = findNodeAtLineCol(ts, sf, line, col);
    const call = closest(node, (n) => n && (ts.isCallExpression?.(n) || n.kind === ts.SyntaxKind.CallExpression));
    if (!call) return null;
    let callee = call.expression;

    // unwrap (foo as any)(...), foo!(...), (foo)(...)
    while (
      callee &&
      (callee.kind === ts.SyntaxKind.ParenthesizedExpression ||
        callee.kind === ts.SyntaxKind.AsExpression ||
        callee.kind === ts.SyntaxKind.TypeAssertionExpression ||
        callee.kind === ts.SyntaxKind.NonNullExpression)
    ) {
      callee = callee.expression ?? callee.expression?.expression ?? callee.expression;
    }

    const args = Array.from(call.arguments ?? []);
    const hasSpread = args.some((a) => a && (a.kind === ts.SyntaxKind.SpreadElement || ts.isSpreadElement?.(a)));
    const arity = hasSpread ? null : args.length;

    // f(...)
    if (ts.isIdentifier(callee)) {
      const sym = checker.getSymbolAtLocation(callee);
      const imp = resolveSymbolToImport(ts, checker, sym);
      if (!imp?.mod) return null;
      const exportName = imp.kind === "default" ? "__default" : String(imp.imported ?? callee.text);
      return { mod: imp.mod, importKind: imp.kind, imported: String(imp.imported ?? ""), exportName, via: "call", arity };
    }

    // ns.f(...) or deeper chain (e.g., React.Children.toArray(...))
    if (ts.isPropertyAccessExpression?.(callee)) {
      const chain = [];
      let cur = callee;
      while (ts.isPropertyAccessExpression?.(cur)) {
        const mem = cur.name?.text ? String(cur.name.text) : "";
        if (mem) chain.unshift(mem);
        cur = cur.expression;
      }
      if (!ts.isIdentifier(cur)) return null;
      const root = cur;
      const rootSym = checker.getSymbolAtLocation(root);
      const imp = resolveSymbolToImport(ts, checker, rootSym);
      if (!imp?.mod) return null;

      // If imported as namespace/require: prefer the first member in chain as the exported "object",
      // and widen that (e.g., React.Children) to absorb deeper .toArray calls.
      if (imp.kind === "namespace" || imp.kind === "require") {
        const first = chain[0] ?? "";
        if (!first) return null;
        return { mod: imp.mod, importKind: "namespace-member", imported: first, exportName: first, via: "call", arity, chainDepth: chain.length };
      }

      // If root is a named/default import (value object), widening the root export usually helps (foo.bar()).
      const exportName = imp.kind === "default" ? "__default" : String(imp.imported ?? root.text);
      return { mod: imp.mod, importKind: imp.kind, imported: String(imp.imported ?? ""), exportName, via: "call", arity, chainDepth: chain.length };
    }

    return null;
  } catch {
    return null;
  }
}

async function resolveTs2339ViaTs({ ts, program, checker, repoDir, file, line, col }) {
  try {
    const abs = path.isAbsolute(file) ? file : path.join(repoDir, file);
    let sf = program.getSourceFile(abs);
    if (!sf) {
      const suffix = path.normalize(file).replaceAll("\\", "/");
      sf = program.getSourceFiles().find((f) => String(f.fileName ?? "").replaceAll("\\", "/").endsWith(suffix)) ?? null;
    }
    if (!sf) return null;
    const node = findNodeAtLineCol(ts, sf, line, col);
    const pa = closest(
      node,
      (n) =>
        n &&
        (n.kind === ts.SyntaxKind.PropertyAccessExpression ||
          n.kind === ts.SyntaxKind.PropertyAccessChain ||
          ts.isPropertyAccessExpression?.(n)),
    );
    if (!pa) return null;
    const obj = pa.expression;
    const prop = pa.name?.text ? String(pa.name.text) : null;
    if (!prop) return null;
    if (!ts.isIdentifier(obj)) return null;
    const sym = checker.getSymbolAtLocation(obj);
    // 1) Direct import/require mapping
    const imp = resolveSymbolToImport(ts, checker, sym);
    if (imp?.mod) return { mod: imp.mod, importKind: imp.kind, imported: imp.imported, local: obj.text, prop, via: "direct" };
    // 2) Local var initialized by calling imported function: widen that callee instead.
    const viaCall = tryResolveVariableInitializerToImport(ts, checker, sym);
    if (viaCall?.mod) {
      return { mod: viaCall.mod, importKind: viaCall.importKind, imported: viaCall.imported, local: obj.text, prop, via: "call-return" };
    }
    return null;
  } catch {
    return null;
  }
}

async function debugResolveTs2339ViaTs({ ts, program, checker, repoDir, file, line, col }) {
  const dbg = { file, line, col, abs: "", sourceFileFound: false, propertyAccessFound: false, objText: null, viaDirect: null, viaCall: null };
  try {
    dbg.abs = path.isAbsolute(file) ? file : path.join(repoDir, file);
    let sf = program.getSourceFile(dbg.abs);
    if (!sf) {
      const suffix = path.normalize(file).replaceAll("\\", "/");
      sf = program.getSourceFiles().find((f) => String(f.fileName ?? "").replaceAll("\\", "/").endsWith(suffix)) ?? null;
    }
    dbg.sourceFileFound = Boolean(sf);
    if (!sf) return dbg;
    const node = findNodeAtLineCol(ts, sf, line, col);
    const pa = closest(
      node,
      (n) =>
        n &&
        (n.kind === ts.SyntaxKind.PropertyAccessExpression ||
          n.kind === ts.SyntaxKind.PropertyAccessChain ||
          ts.isPropertyAccessExpression?.(n)),
    );
    dbg.propertyAccessFound = Boolean(pa);
    if (!pa) return dbg;
    const obj = pa.expression;
    if (!ts.isIdentifier(obj)) return dbg;
    dbg.objText = obj.text;
    const sym = checker.getSymbolAtLocation(obj);
    const imp = resolveSymbolToImport(ts, checker, sym);
    dbg.viaDirect = imp;
    const viaCall = tryResolveVariableInitializerToImport(ts, checker, sym);
    dbg.viaCall = viaCall;
    return dbg;
  } catch (e) {
    return { ...dbg, error: String(e?.message || e) };
  }
}

function widenExportToAnyInModuleBlock(dtsText, mod, exportName) {
  const hasBlock = Boolean(getDeclareModuleBlockRange(dtsText, mod));
  if (hasBlock) {
    // Try const first, then function.
    const reps = new Map();
    reps.set(exportName, { kind: "const" });
    let out = replaceExportsInDeclareModuleBlock(dtsText, mod, reps);
    if (out) return out;
    const reps2 = new Map();
    reps2.set(exportName, { kind: "function" });
    out = replaceExportsInDeclareModuleBlock(dtsText, mod, reps2);
    if (out) return out;
  }
  const blk = buildMinimalDeclareModule(mod, [`export const ${exportName}: any;`]);
  return blk ? `${dtsText}\n${blk}` : null;
}

function extractImportTypeRefs(msg) {
  // import("mod").Name
  const out = [];
  const re = /import\(\"([^\"]+)\"\)\.([A-Za-z_$][\w$]*)/g;
  let m;
  while ((m = re.exec(String(msg ?? ""))) !== null) {
    out.push({ module: m[1], name: m[2] });
  }
  return out;
}

function extractTs2339Prop(msg) {
  const m = String(msg ?? "").match(/Property\s+'([^']+)'\s+does\s+not\s+exist\s+on\s+type/i);
  return m ? m[1] : null;
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
    // Trial-level tracking (Policy A / Phase0):
    // even when we only run a single injection today, keep the schema "Top-k ready".
    trials: [],
    phase3: {
      onlyExternal: opts.onlyExternal,
      mode: opts.mode,
      localizer: {
        topModules: Number.isFinite(opts.localizerTopModules) ? opts.localizerTopModules : null,
        mode: opts.localizerMode ?? "per-file",
        beforeTopModulesCount: null,
        afterTopModulesCount: null,
        topModuleFreq: [],
      },
      trial: {
        strategy: opts.trialStrategy,
        max: opts.trialMax,
        chosenCandidateId: null,
        trialsRun: 0,
      },
      repair: opts.repairFromTop1
        ? {
            enabled: true,
            max: Number(opts.repairMax ?? 0) || 0,
            candidatesAdded: 0,
            tsLoaded: false,
            tsProgramBuilt: false,
            tsResolvedCount: 0,
            tsCallResolvedCount: 0,
            ts2339Seen: 0,
            ts2345Seen: 0,
            ts2322Seen: 0,
            ts2769Seen: 0,
            ts2554Seen: 0,
            ts2339LocalFound: 0,
            ts2339ImportMapped: 0,
            safeguard: {
              earlyStopAfterImprove: Boolean(opts.earlyStopAfterImprove),
              earlyStopTieStreak: Number(opts.earlyStopTieStreak ?? 0) || 0,
              stoppedReason: null,
              tiesInARow: 0,
            },
          }
        : null,
      reranker: opts.trialStrategy === "reranker-v0" ? { modelPath: opts.rerankerModel || "", loaded: false, error: null } : null,
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
  const bdiags = parseDiagnostics(bout);
  result.baseline = {
    exitCode: br.code,
    timedOut: br.timedOut,
    tsErrorCounts: bcounts,
    diagnostics: capDiagnostics(bdiags, 2000),
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
  const moduleFreq = new Map(); // module -> count (frequency in diag files, used by per-file mode)
  const moduleScore = new Map(); // module -> score (used by per-error mode)
  const fileImportCache = new Map(); // absFile -> Array<ImportInfo> (filtered & externalized)
  for (const f of diagFiles) {
    const abs = path.isAbsolute(f) ? f : path.join(repoDir, f);
    if (!(await fileExists(abs))) continue;
    const src = await fs.readFile(abs, "utf8").catch(() => "");
    const imports = collectImportsFromSource(src);
    const keptImports = [];
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
      keptImports.push(imp);
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
    fileImportCache.set(abs, keptImports);
  }

  // Localizer (Top-M):
  // - per-file: keep modules ranked by how often they appear in imports across diag files
  // - per-error: weight modules by number of Phase3 diagnostics in files that import them (error-location→module binding)
  if (opts.localizerMode === "per-error") {
    for (const d of diags) {
      const f = d.file;
      const abs = path.isAbsolute(f) ? f : path.join(repoDir, f);
      const imports = fileImportCache.get(abs);
      if (!imports) continue;
      const seen = new Set();
      for (const imp of imports) {
        const mod = imp?.mod;
        if (!mod || seen.has(mod)) continue;
        seen.add(mod);
        moduleScore.set(mod, (moduleScore.get(mod) ?? 0) + 1);
      }
    }
  }

  result.phase3.localizer.beforeTopModulesCount = moduleToStub.size;
  if (Number.isFinite(opts.localizerTopModules) && moduleToStub.size > opts.localizerTopModules) {
    const rankedSource = opts.localizerMode === "per-error" ? moduleScore : moduleFreq;
    const ranked = [...rankedSource.entries()].sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]));
    const kept = new Set(ranked.slice(0, opts.localizerTopModules).map(([m]) => m));
    for (const k of [...moduleToStub.keys()]) {
      if (!kept.has(k)) moduleToStub.delete(k);
    }
    result.phase3.localizer.topModuleFreq = ranked.slice(0, Math.min(50, opts.localizerTopModules)).map(([m, c]) => ({
      module: m,
      freq: c,
    }));
  } else {
    const rankedSource = opts.localizerMode === "per-error" ? moduleScore : moduleFreq;
    result.phase3.localizer.topModuleFreq = [...rankedSource.entries()]
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

  // 1) Build base candidate d.ts (top1)
  let baseDts = "";
  const baseCandidateId = "c0_top1";
  if (opts.mode === "stub") {
    baseDts = buildPhase3StubDts(moduleToStub);
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
    result.phase3.modelOutput = {
      backend: obj.backend ?? null,
      cacheKey: obj.cache_key ?? null,
      adapterVersion: obj.meta?.adapter_version ?? null,
      fallbackReason: obj.meta?.fallback_reason ?? null,
      missingModulesFilledWithAny: obj.meta?.missing_modules_filled_with_any ?? null,
    };
    baseDts = obj.dts;
  }

  // 2) Prepare injected tsconfig once; for each trial we only rewrite index.d.ts and rerun `tsc`.
  const injectedCfg = await writeInjectedTsconfig(repoDir);
  result.phase3.originalTypesCount = injectedCfg.originalTypesCount;
  result.phase3.injectedTypesCount = injectedCfg.injectedTypesCount;

  async function runTrial({ candidateId, dtsText, moduleOverride, symbolOverride }) {
    await writePhase3InjectedTypeRoots(repoDir, { packageName: "__phase3_injected__", dtsText });
    const jr = await runCmd({
      cwd: repoDir,
      cmd: "tsc",
      args: ["--noEmit", "--pretty", "false", "-p", path.basename(injectedCfg.tsconfigPath)],
      timeoutMs: opts.timeoutMs,
    });
    const jout = `${jr.stdout}\n${jr.stderr}`;
    const jcounts = extractTsCodes(jout);
    const jPhase3 = sumPhase3(jcounts);
    const injectedSyntaxCodes = getInjectedDtsSyntaxErrorCodes(jcounts);
    const injectedDtsInvalid = injectedSyntaxCodes.length > 0;
    const injectionValid = !injectedDtsInvalid && !jr.timedOut;
    const dtsSha1 = sha1Hex(dtsText);
    const decls = extractDeclarationsFromDts(dtsText);
    const moduleOverrides = Array.isArray(moduleOverride)
      ? moduleOverride.filter((x) => typeof x === "string" && x.trim() !== "")
      : (moduleOverride ? [String(moduleOverride)] : []);
    const trial = {
      trial_id: `trial_${sha1Hex(`${result.url}::${candidateId}::${dtsSha1}`).slice(0, 12)}`,
      candidate_id: candidateId,
      module_override: (moduleOverrides.length === 1 ? moduleOverrides[0] : null),
      module_overrides: moduleOverrides.length ? moduleOverrides : null,
      symbol_override: symbolOverride ?? null,
      injected_dts_sha1: dtsSha1,
      declaration_count: decls.length,
      declarations: decls.slice(0, 5000),
      injected_exit: jr.code,
      injected_timed_out: jr.timedOut,
      injected_dts_invalid: injectedDtsInvalid,
      injected_dts_syntax_codes: injectedSyntaxCodes,
      injected_phase3: jPhase3,
      delta_errors: buildDeltaErrors({ baselineCounts: result.baseline?.tsErrorCounts ?? {}, injectedCounts: jcounts }),
      delta_phase3: jPhase3 - baselinePhase3,
      valid_injection: injectionValid,
    };
    return { trial, jcounts, jout };
  }

  // 3) Build trial candidate list (Phase1)
  let candidates = [{ candidateId: baseCandidateId, dtsText: baseDts, moduleOverride: null, symbolOverride: null }];
  const wantsSweep = opts.mode === "model" && (opts.trialStrategy === "module-any-sweep" || opts.trialStrategy === "reranker-v0") && opts.trialMax > 1;
  if (wantsSweep) {
    const mods = [...moduleToStub.keys()];
    const cap = Math.max(0, opts.trialMax - 1);
    function applyAnyOverrides(dtsText, overrideMods) {
      let cur = dtsText;
      for (const mod of overrideMods) {
        const info = moduleToStub.get(mod);
        if (!info) return null;
        const stubBlock = buildPhase3StubModuleBlock(mod, info);
        const next = replaceDeclareModuleBlock(cur, mod, stubBlock);
        if (!next) return null;
        cur = next;
      }
      return cur;
    }

    // Candidate Generator v1:
    // - Always include single-module overrides first (compat + interpretability)
    // - Optionally include pair overrides when --sweep-any-k=2, until cap is reached
    let remaining = cap;

    // Candidate Generator v2: one "override first K modules at once" candidate.
    // This keeps candidate count low while allowing multi-module interactions.
    if (remaining > 0 && Number(opts.sweepAnyTopK) > 1) {
      const k = Math.min(Number(opts.sweepAnyTopK) || 0, mods.length);
      if (k > 1) {
        const picked = mods.slice(0, k);
        const key = picked.join("::");
        const replaced = applyAnyOverrides(baseDts, picked);
        if (replaced) {
          candidates.push({
            candidateId: `c_anytopk_${k}_${sha1Hex(key).slice(0, 8)}`,
            dtsText: replaced,
            moduleOverride: picked,
            symbolOverride: null,
          });
          remaining--;
        }
      }
    }

    // Candidate Generator v3: symbol-level widening.
    if (remaining > 0 && Number(opts.symbolWidenMax) > 0) {
      const maxAdd = Math.min(Number(opts.symbolWidenMax) || 0, remaining);
      if (maxAdd > 0 && opts.symbolWidenMode === "interface-indexer") {
        // v1: interface-indexer augmentation for exported interfaces in top modules.
        const ifaceByMod = extractExportedInterfacesByModule(baseDts);
        let added = 0;
        for (const mod of mods) {
          if (added >= maxAdd || remaining <= 0) break;
          const names = [...(ifaceByMod.get(mod) ?? new Set())].sort();
          for (const name of names) {
            if (added >= maxAdd || remaining <= 0) break;
            const aug = buildInterfaceIndexerAugmentation(mod, name);
            const dtsText = `${baseDts}\n${aug}`;
            candidates.push({
              candidateId: `c_idx_${sha1Hex(`${mod}::${name}`).slice(0, 8)}`,
              dtsText,
              moduleOverride: null,
              symbolOverride: { kind: "interface-indexer", module: mod, name },
            });
            added++;
            remaining--;
          }
        }
      } else if (maxAdd > 0 && opts.symbolWidenMode === "namespace-members") {
        // v2: namespace-members augmentation for `Foo.bar`-style static member accesses.
        // Uses valueMembers collected from consumer code; only apply when Foo is mergeable (function/class/namespace/enum).
        const mergeableByMod = extractExportedMergeableValuesByModule(baseDts);
        let added = 0;
        for (const mod of mods) {
          if (added >= maxAdd || remaining <= 0) break;
          const info = moduleToStub.get(mod);
          const vm = info?.valueMembers;
          if (!vm || !(vm instanceof Map)) continue;
          const mergeable = mergeableByMod.get(mod) ?? new Set();
          const exportNames = [...vm.keys()].sort();
          for (const name of exportNames) {
            if (added >= maxAdd || remaining <= 0) break;
            if (!mergeable.has(name)) continue;
            const members = [...(vm.get(name) ?? new Set())].sort().slice(0, 50);
            if (!members.length) continue;
            const aug = buildNamespaceMembersAugmentation(mod, name, members);
            const dtsText = `${baseDts}\n${aug}`;
            candidates.push({
              candidateId: `c_ns_${sha1Hex(`${mod}::${name}::${members.join(",")}`).slice(0, 8)}`,
              dtsText,
              moduleOverride: null,
              symbolOverride: { kind: "namespace-members", module: mod, name, members: members.slice(0, 20), membersCount: members.length },
            });
            added++;
            remaining--;
          }
        }
      } else if (maxAdd > 0 && opts.symbolWidenMode === "function-any-overload") {
        // v3: exported function overload widening to accept any args / return any.
        const fnByMod = extractExportedFunctionsByModule(baseDts);
        let added = 0;
        for (const mod of mods) {
          if (added >= maxAdd || remaining <= 0) break;
          const names = [...(fnByMod.get(mod) ?? new Set())].sort();
          for (const name of names) {
            if (added >= maxAdd || remaining <= 0) break;
            const aug = buildFunctionAnyOverloadAugmentation(mod, name);
            const dtsText = `${baseDts}\n${aug}`;
            candidates.push({
              candidateId: `c_fnany_${sha1Hex(`${mod}::${name}`).slice(0, 8)}`,
              dtsText,
              moduleOverride: null,
              symbolOverride: { kind: "function-any-overload", module: mod, name },
            });
            added++;
            remaining--;
          }
        }
      } else if (maxAdd > 0 && opts.symbolWidenMode === "missing-exports") {
        // v4: add missing exports (based on consumer imports) as any, only when not already exported in baseDts.
        const exportedByMod = extractExportedNamesByModule(baseDts);
        let added = 0;
        for (const mod of mods) {
          if (added >= maxAdd || remaining <= 0) break;
          const info = moduleToStub.get(mod);
          if (!info) continue;
          const exported = exportedByMod.get(mod) ?? new Set();
          const missingVals = [...(info.named ?? new Set())].filter((n) => !exported.has(n));
          const missingTypes = [...(info.typeNamed ?? new Set())].filter((n) => !exported.has(n));
          const aug = buildMissingExportsAugmentation(mod, missingVals, missingTypes);
          if (!aug) continue;
          const dtsText = `${baseDts}\n${aug}`;
          candidates.push({
            candidateId: `c_miss_${sha1Hex(`${mod}::${missingVals.sort().join(",")}::${missingTypes.sort().join(",")}`).slice(0, 8)}`,
            dtsText,
            moduleOverride: null,
            symbolOverride: { kind: "missing-exports", module: mod, missingValues: missingVals.slice(0, 20), missingTypes: missingTypes.slice(0, 20) },
          });
          added++;
          remaining--;
        }
      } else if (maxAdd > 0 && opts.symbolWidenMode === "export-to-any") {
        // v5: partial replacement inside existing declare module blocks:
        // rewrite specific `export const Foo: ...` / `export function Foo(...)` lines to any.
        // This avoids module augmentation limitations and directly edits the model output block.
        let added = 0;
        for (const mod of mods) {
          if (added >= maxAdd || remaining <= 0) break;
          const info = moduleToStub.get(mod);
          if (!info) continue;
          const vm = info?.valueMembers;
          const vmKeys = (vm && vm instanceof Map) ? [...vm.keys()] : [];
          // Prefer symbols with observed member-access first (Foo.bar), then general named imports.
          const exportNames = [...new Set([
            ...vmKeys,
            ...[...(info.named ?? new Set())],
          ])]
            .filter((x) => typeof x === "string" && /^[A-Za-z_$][\w$]*$/.test(x))
            .sort();
          for (const name of exportNames) {
            if (added >= maxAdd || remaining <= 0) break;
            // try const rewrite first, then function rewrite (based on presence in base text)
            const reps = new Map();
            reps.set(name, { kind: "const" });
            let dtsText = replaceExportsInDeclareModuleBlock(baseDts, mod, reps);
            let kind = "const";
            if (!dtsText) {
              const reps2 = new Map();
              reps2.set(name, { kind: "function" });
              dtsText = replaceExportsInDeclareModuleBlock(baseDts, mod, reps2);
              kind = "function";
            }
            if (!dtsText) continue;
            candidates.push({
              candidateId: `c_widen_${sha1Hex(`${mod}::${name}::${kind}`).slice(0, 8)}`,
              dtsText,
              moduleOverride: null,
              symbolOverride: { kind: "export-to-any", module: mod, name, target: kind },
            });
            added++;
            remaining--;
          }
        }
      } else if (maxAdd > 0 && opts.symbolWidenMode === "type-to-any") {
        // v6: replace exported type alias/interface declarations to `any` for imported type names.
        let added = 0;
        for (const mod of mods) {
          if (added >= maxAdd || remaining <= 0) break;
          const info = moduleToStub.get(mod);
          if (!info) continue;
          const names = [...new Set([...(info.typeNamed ?? new Set())])]
            .filter((x) => typeof x === "string" && /^[A-Za-z_$][\w$]*$/.test(x))
            .sort();
          for (const name of names) {
            if (added >= maxAdd || remaining <= 0) break;
            const dtsText = replaceTypeDeclToAnyInDeclareModuleBlock(baseDts, mod, name);
            if (!dtsText) continue;
            candidates.push({
              candidateId: `c_tany_${sha1Hex(`${mod}::${name}`).slice(0, 8)}`,
              dtsText,
              moduleOverride: null,
              symbolOverride: { kind: "type-to-any", module: mod, name },
            });
            added++;
            remaining--;
          }
        }
      }
    }

    // singles
    for (const mod of mods) {
      if (remaining <= 0) break;
      const replaced = applyAnyOverrides(baseDts, [mod]);
      if (!replaced) continue;
      candidates.push({ candidateId: `c_anymod_${sha1Hex(mod).slice(0, 8)}`, dtsText: replaced, moduleOverride: mod, symbolOverride: null });
      remaining--;
    }

    // pairs
    if (opts.sweepAnyK === 2 && remaining > 0) {
      for (let i = 0; i < mods.length && remaining > 0; i++) {
        for (let j = i + 1; j < mods.length && remaining > 0; j++) {
          const a = mods[i];
          const b = mods[j];
          const key = `${a}::${b}`;
          const replaced = applyAnyOverrides(baseDts, [a, b]);
          if (!replaced) continue;
          candidates.push({
            candidateId: `c_anypair_${sha1Hex(key).slice(0, 8)}`,
            dtsText: replaced,
            moduleOverride: [a, b],
            symbolOverride: null,
          });
          remaining--;
        }
      }
    }
  }

  // 3.5) Phase5: reranker-v0 ordering (keep c0_top1 first, then rank other candidates)
  if (opts.trialStrategy === "reranker-v0") {
    if (!opts.rerankerModel) {
      result.skipReason = "reranker-model-missing";
      result.durationMs = Date.now() - startedAt;
      if (!opts.keepRepos) await rmrf(repoDir);
      await outHandle.appendFile(JSON.stringify(result) + "\n");
      return;
    }
    try {
      const raw = await fs.readFile(path.resolve(opts.rerankerModel), "utf8");
      const model = JSON.parse(raw);
      result.phase3.reranker.loaded = true;
      const baselineCounts = result.baseline?.tsErrorCounts ?? {};
      const baselineDiagnostics = result.baseline?.diagnostics ?? [];
      const topModuleFreq = result.phase3?.localizer?.topModuleFreq ?? [];

      const top1 = candidates.find((c) => c.candidateId === baseCandidateId) ?? candidates[0];
      const top1DeclCount = extractDeclarationsFromDts(top1.dtsText).length;
      const top1Feat = buildRerankerCandidateFeatures({
        baselineCounts,
        baselineDiagnostics,
        topModuleFreq,
        moduleOverride: null,
        declarationCount: top1DeclCount,
      });

      const rest = candidates
        .filter((c) => c.candidateId !== baseCandidateId)
        .map((c) => {
          const declCount = extractDeclarationsFromDts(c.dtsText).length;
          const feat = buildRerankerCandidateFeatures({
            baselineCounts,
            baselineDiagnostics,
            topModuleFreq,
            moduleOverride: c.moduleOverride,
            declarationCount: declCount,
          });
          const sc = scoreCandidateVsTop1({ model, candidateFeat: feat, top1Feat });
          return { ...c, reranker: { z: sc.z, p: sc.p } };
        })
        .sort((a, b) => (b.reranker.z - a.reranker.z) || String(a.candidateId).localeCompare(String(b.candidateId)));

      // keep top1 first to preserve compatibility (analyze scripts assume it exists)
      candidates = [top1, ...rest];
      // record a small debug trace
      result.phase3.reranker.topCandidates = rest.slice(0, 10).map((x) => ({
        candidate_id: x.candidateId,
        module_override: x.moduleOverride ?? null,
        z: x.reranker.z,
        p: x.reranker.p,
      }));
    } catch (e) {
      result.phase3.reranker.error = String(e?.message || e);
      result.skipReason = "reranker-model-invalid";
      result.durationMs = Date.now() - startedAt;
      if (!opts.keepRepos) await rmrf(repoDir);
      await outHandle.appendFile(JSON.stringify(result) + "\n");
      return;
    }
  }

  // 4) Run trials and choose best (min Phase3 core; tie-break by total errors)
  // Always run top1 first; optionally generate Repair Operator candidates from its injected diagnostics.
  let best = null;
  let bestCounts = null;
  let bestOut = "";

  function considerCandidate({ trial, jcounts, jout }) {
    const totalErr = Object.values(jcounts ?? {}).reduce((a, b) => a + (Number(b) || 0), 0);
    const key = {
      valid: trial.valid_injection ? 1 : 0,
      phase3: trial.injected_phase3,
      total: totalErr,
    };
    if (!best) {
      best = { trial, key };
      bestCounts = jcounts;
      bestOut = jout;
      return;
    }
    const better =
      key.valid > best.key.valid ||
      (key.valid === best.key.valid && (key.phase3 < best.key.phase3 || (key.phase3 === best.key.phase3 && key.total < best.key.total)));
    if (better) {
      best = { trial, key };
      bestCounts = jcounts;
      bestOut = jout;
    }
  }

  const top1Cand = candidates.find((x) => x.candidateId === baseCandidateId) ?? candidates[0];
  const top1Res = await runTrial(top1Cand);
  result.trials.push(top1Res.trial);
  result.phase3.trial.trialsRun++;
  considerCandidate(top1Res);
  const top1Phase3 = Number(top1Res.trial?.injected_phase3 ?? NaN);
  let tieStreak = 0;

  if (opts.repairFromTop1 && Number(opts.repairMax) > 0 && opts.trialMax > 1) {
    // Best-effort tsserver-like resolution (uses repo's own typescript if present)
    const ts = loadTypeScriptFromRepo(repoDir);
    const tsProg = ts ? buildTsProgram(ts, injectedCfg.tsconfigPath) : null;
    if (result.phase3.repair) {
      result.phase3.repair.tsLoaded = Boolean(ts);
      result.phase3.repair.tsProgramBuilt = Boolean(tsProg?.program && tsProg?.checker);
    }
    const diags = parseDiagnostics(top1Res.jout).filter((d) => ["TS2339", "TS2345", "TS2322", "TS2769", "TS2554"].includes(String(d.code)));
    const fnByMod = extractExportedFunctionsByModule(baseDts);
    const repairs = [];
    const seen = new Set();
    for (const d of diags) {
      if (repairs.length >= Number(opts.repairMax)) break;
      const msg = d.msg ?? "";
      const prop = String(d.code) === "TS2339" ? extractTs2339Prop(msg) : null;
      if (result.phase3.repair && String(d.code) === "TS2339") result.phase3.repair.ts2339Seen++;
      if (result.phase3.repair && String(d.code) === "TS2345") result.phase3.repair.ts2345Seen++;
      if (result.phase3.repair && String(d.code) === "TS2322") result.phase3.repair.ts2322Seen++;
      if (result.phase3.repair && String(d.code) === "TS2769") result.phase3.repair.ts2769Seen++;
      if (result.phase3.repair && String(d.code) === "TS2554") result.phase3.repair.ts2554Seen++;

      // TS2339: try to recover (localIdentifier.prop) from source line and map to import module.
      if (String(d.code) === "TS2339" && prop && d.file && d.line) {
        // First: try TS Program-based resolution to module import
        if (tsProg?.program && tsProg?.checker) {
          if (result.phase3.repair && !result.phase3.repair.debugTs2339) {
            result.phase3.repair.debugTs2339 = await debugResolveTs2339ViaTs({ ts, program: tsProg.program, checker: tsProg.checker, repoDir, file: d.file, line: d.line, col: d.col ?? 1 });
          }
          const rr = await resolveTs2339ViaTs({ ts, program: tsProg.program, checker: tsProg.checker, repoDir, file: d.file, line: d.line, col: d.col ?? 1 });
          if (rr?.mod) {
            if (result.phase3.repair) result.phase3.repair.tsResolvedCount++;
            const mod = rr.mod;
            let dtsText = null;
            let op = "";
            if (rr.via === "call-return") {
              // obj is local var; widen the imported callee return/source symbol.
              dtsText = widenExportToAnyInModuleBlock(baseDts, mod, rr.imported);
              op = "widen-callee-to-any";
            } else if (rr.importKind === "namespace" || rr.importKind === "require" || rr.importKind === "namespace-member") {
              dtsText = addExportConstToDeclareModuleBlock(baseDts, mod, rr.prop) ?? (buildMinimalDeclareModule(mod, [`export const ${rr.prop}: any;`]) ? `${baseDts}\n${buildMinimalDeclareModule(mod, [`export const ${rr.prop}: any;`])}` : null);
              op = "add-export-const";
            } else if (rr.importKind === "named" || rr.importKind === "default") {
              const exportName = rr.importKind === "default" ? "__default" : rr.imported;
              dtsText = widenExportToAnyInModuleBlock(baseDts, mod, exportName);
              op = "widen-imported-to-any";
            }
            if (dtsText) {
              const key =
                rr.via === "call-return"
                  ? `rep::TS2339::ts::${mod}::callee::${rr.imported}::${rr.via}::${op}`
                  : `rep::TS2339::ts::${mod}::${rr.importKind}::${rr.imported}::${rr.prop}::${rr.via}::${op}`;
              if (!seen.has(key)) {
                seen.add(key);
                repairs.push({
                  candidateId: `c_rep_${sha1Hex(key).slice(0, 8)}`,
                  dtsText,
                  moduleOverride: null,
                  symbolOverride: { kind: "repair-from-top1", code: "TS2339", module: mod, local: rr.local, imported: rr.imported, prop: rr.prop, op, via: `ts:${rr.via}` },
                });
                if (result.phase3.repair) result.phase3.repair.candidatesAdded++;
                continue;
              }
            }
          }
        }

        const srcLine = await readLineFromRepoFile(repoDir, d.file, d.line);
        const m = srcLine.match(new RegExp(`\\b([A-Za-z_$][\\w$]*)\\s*\\.\\s*${escapeRegex(prop)}\\b`));
        const localObj = m ? m[1] : null;
        if (!localObj) continue;
        if (result.phase3.repair) result.phase3.repair.ts2339LocalFound++;

        const abs = path.isAbsolute(d.file) ? d.file : path.join(repoDir, d.file);
        const src = await fs.readFile(abs, "utf8").catch(() => "");
        const imports = [...collectImportsFromSource(src), ...collectRequiresFromSource(src)];
        const im = findImportForLocalName(imports, localObj);
        if (!im) continue;
        if (result.phase3.repair) result.phase3.repair.ts2339ImportMapped++;
        const mod = im.mod;
        const hasBlock = Boolean(getDeclareModuleBlockRange(baseDts, mod));

        let dtsText = null;
        let op = "";
        // If namespace import: ns.Prop => module export Prop
        if (im.kind === "namespace") {
          if (hasBlock) {
            dtsText = addExportConstToDeclareModuleBlock(baseDts, mod, prop);
            op = "add-export-const";
          } else {
            const blk = buildMinimalDeclareModule(mod, [`export const ${prop}: any;`]);
            dtsText = blk ? `${baseDts}\n${blk}` : null;
            op = "append-module-export-const";
          }
        } else if (im.kind === "named") {
          // Named import Foo.Prop => make Foo permissive (export-to-any) or try interface prop add.
          if (hasBlock) {
            const reps = new Map();
            reps.set(im.imported, { kind: "const" });
            dtsText = replaceExportsInDeclareModuleBlock(baseDts, mod, reps);
            op = "export-to-any";
          } else {
            const blk = buildMinimalDeclareModule(mod, [`export const ${im.imported}: any;`]);
            dtsText = blk ? `${baseDts}\n${blk}` : null;
            op = "append-module-export-const";
          }
          if (!dtsText) {
            dtsText = addPropertyToExportedInterfaceInDeclareModuleBlock(baseDts, mod, im.imported, prop);
            op = "iface-add-prop";
          }
          if (!dtsText) {
            dtsText = replaceTypeDeclToAnyInDeclareModuleBlock(baseDts, mod, im.imported);
            op = "type-to-any";
          }
        }
        if (!dtsText) continue;
        const key = `rep::TS2339::${mod}::${localObj}::${prop}::${im.kind}::${im.imported}::${op}`;
        if (seen.has(key)) continue;
        seen.add(key);
        repairs.push({
          candidateId: `c_rep_${sha1Hex(key).slice(0, 8)}`,
          dtsText,
          moduleOverride: null,
          symbolOverride: { kind: "repair-from-top1", code: "TS2339", module: mod, local: localObj, imported: im.imported, prop, op },
        });
        if (result.phase3.repair) result.phase3.repair.candidatesAdded++;
        continue;
      }

      // TS2345/TS2322/TS2769/TS2554: prefer TS Program-based call-callee resolution.
      if ((["TS2345", "TS2322", "TS2769", "TS2554"].includes(String(d.code))) && d.file && d.line && tsProg?.program && tsProg?.checker) {
        const rr = await resolveCallCalleeViaTs({ ts, program: tsProg.program, checker: tsProg.checker, repoDir, file: d.file, line: d.line, col: d.col ?? 1 });
        const externalOk =
          rr?.mod &&
          rr.exportName &&
          (opts.onlyExternal
            ? (opts.externalFilter === "deps" ? isExternalByDeps(rr.mod, opts) : isExternalModuleSpecifier(rr.mod, opts))
            : true);
        if (externalOk) {
          if (result.phase3.repair) result.phase3.repair.tsCallResolvedCount++;
          const mod = rr.mod;
          const exportName = rr.exportName;
          let dtsText = null;
          let op = "";

          // Only add function overload when the base block already exports it as a function.
          // Avoid __default because base stubs usually declare it as `const __default`.
          const isValidFnName = exportName !== "__default" && /^[A-Za-z_$][\w$]*$/.test(exportName);
          const exportedAsFunction = (fnByMod.get(mod)?.has(exportName) ?? false);
          // If we don't have a base block for this module, we may still add an overload as a best-effort repair
          // (bounded by repairMax). Prefer direct calls (chainDepth<=1).
          const bestEffortFnOverload = isValidFnName && !exportedAsFunction && Number(rr.chainDepth ?? 0) <= 1;
          const isSafeFnOverload = isValidFnName && (exportedAsFunction || bestEffortFnOverload);
          if (isSafeFnOverload) {
            const aug =
              Number.isFinite(rr.arity) && rr.arity !== null
                ? buildFunctionAnyArityOverloadAugmentation(mod, exportName, rr.arity)
                : buildFunctionAnyOverloadAugmentation(mod, exportName);
            if (aug) {
              dtsText = `${baseDts}\n${aug}`;
              op = Number.isFinite(rr.arity) && rr.arity !== null ? `add-any-overload$arity=${rr.arity}` : "add-any-overload";
            }
          } else {
            dtsText = widenExportToAnyInModuleBlock(baseDts, mod, exportName);
            op = "widen-callee-to-any";
          }

          if (dtsText) {
            const key = `rep::${String(d.code)}::ts::${mod}::${exportName}::${rr.importKind}::${rr.via}::${op}`;
            if (!seen.has(key)) {
              seen.add(key);
              repairs.push({
                candidateId: `c_rep_${sha1Hex(key).slice(0, 8)}`,
                dtsText,
                moduleOverride: null,
                symbolOverride: {
                  kind: "repair-from-top1",
                  code: String(d.code),
                  module: mod,
                  imported: String(rr.imported ?? ""),
                  name: exportName,
                  op,
                  via: `ts:${rr.via}`,
                  arity: rr.arity ?? null,
                  chainDepth: rr.chainDepth ?? null,
                },
              });
              if (result.phase3.repair) result.phase3.repair.candidatesAdded++;
              continue;
            }
          }
        }
      }

      // TS2345/TS2322: fall back to import("m").Type references when present.
      const refs = extractImportTypeRefs(msg);
      for (const ref of refs) {
        if (repairs.length >= Number(opts.repairMax)) break;
        const mod = ref.module;
        const name = ref.name;
        if (!mod || !name) continue;
        if (!moduleToStub.has(mod)) continue;
        const dtsText = replaceTypeDeclToAnyInDeclareModuleBlock(baseDts, mod, name);
        if (!dtsText) continue;
        const key = `rep::${String(d.code)}::${mod}::${name}::type-to-any`;
        if (seen.has(key)) continue;
        seen.add(key);
        repairs.push({
          candidateId: `c_rep_${sha1Hex(key).slice(0, 8)}`,
          dtsText,
          moduleOverride: null,
          symbolOverride: { kind: "repair-from-top1", code: String(d.code), module: mod, name, op: "type-to-any" },
        });
        if (result.phase3.repair) result.phase3.repair.candidatesAdded++;
      }
    }
    // Put repairs early so trial budget is spent on targeted candidates.
    candidates = [top1Cand, ...repairs, ...candidates.filter((c) => c.candidateId !== top1Cand.candidateId)];
  } else {
    candidates = [top1Cand, ...candidates.filter((c) => c.candidateId !== top1Cand.candidateId)];
  }

  for (const c of candidates.slice(1, opts.trialMax)) {
    const res = await runTrial(c);
    result.trials.push(res.trial);
    result.phase3.trial.trialsRun++;
    considerCandidate(res);

    // Week3 safeguards: reduce wasted exploration in a tie-heavy regime
    if (Number.isFinite(top1Phase3) && res.trial?.valid_injection) {
      const p3 = Number(res.trial?.injected_phase3 ?? NaN);
      if (Number.isFinite(p3)) {
        if (p3 < top1Phase3 && opts.earlyStopAfterImprove) {
          if (result.phase3.repair?.safeguard) result.phase3.repair.safeguard.stoppedReason = "improve_vs_top1";
          break;
        }
        if (p3 === top1Phase3) {
          tieStreak++;
          if (result.phase3.repair?.safeguard) result.phase3.repair.safeguard.tiesInARow = tieStreak;
          if (Number(opts.earlyStopTieStreak) > 0 && tieStreak >= Number(opts.earlyStopTieStreak)) {
            if (result.phase3.repair?.safeguard) result.phase3.repair.safeguard.stoppedReason = "tie_streak";
            break;
          }
        } else {
          tieStreak = 0;
          if (result.phase3.repair?.safeguard) result.phase3.repair.safeguard.tiesInARow = tieStreak;
        }
      }
    }
  }

  // 5) Populate "injected" fields using the chosen candidate (keeps existing summary compatible)
  const chosenCounts = bestCounts ?? {};
  const chosenDiags = parseDiagnostics(bestOut);
  result.injected = {
    exitCode: best?.trial?.injected_exit ?? "",
    timedOut: best?.trial?.injected_timed_out ?? false,
    tsErrorCounts: chosenCounts,
    diagnostics: capDiagnostics(chosenDiags, 2000),
    outputSample: String(bestOut ?? "").slice(0, 2000),
  };

  const afterPhase3 = sumPhase3(chosenCounts);
  const injectedSyntaxCodes = best?.trial?.injected_dts_syntax_codes ?? getInjectedDtsSyntaxErrorCodes(chosenCounts);
  result.phase3.injectedDtsSyntaxCodes = injectedSyntaxCodes;
  result.phase3.injectedDtsInvalid = Boolean(best?.trial?.injected_dts_invalid) || injectedSyntaxCodes.length > 0;
  const injectionValid = Boolean(best?.trial?.valid_injection);
  result.phase3.reduced = injectionValid ? afterPhase3 < baselinePhase3 : false;
  result.phase3.eliminated = injectionValid ? afterPhase3 === 0 && baselinePhase3 > 0 : false;
  result.phase3.trial.chosenCandidateId = best?.trial?.candidate_id ?? baseCandidateId;

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
    "trialStrategy",
    "trialMax",
    "trialsRun",
    "chosenCandidateId",
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
        o.phase3?.trial?.strategy ?? "",
        o.phase3?.trial?.max ?? "",
        o.phase3?.trial?.trialsRun ?? "",
        o.phase3?.trial?.chosenCandidateId ?? "",
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


