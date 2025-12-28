#!/usr/bin/env node
/**
 * Real-project Phase2 runner (module boundary alignment):
 * - clone repo
 * - install deps (best-effort)
 * - run tsc baseline
 * - if TS2305/TS2613/TS2614 appear, apply deterministic import-shape rewrites and rerun tsc
 *
 * Phase2 transformation rules (deterministic, minimal, source-to-source):
 * - TS2613 (no default export): rewrite `import X from "m"` -> `import * as X from "m"`
 * - TS2305 / TS2614 (no exported member 'x'): remove `x` from named import of module "m"
 *   and synthesize a fallback binding:
 *     import * as __phase2_mod_<hash> from "m";
 *     const localName = (__phase2_mod_<hash> as any).exportedName;
 *
 * Notes:
 * - We only target "external-looking" specifiers by default (packages/subpaths), not relative/alias.
 * - Runner uses `tsc -p tsconfig.json` (root) for reproducibility (same Gate A as Phase1).
 */

import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const ROOT = path.resolve(process.cwd());

function parseArgs(argv) {
  const args = {
    reposFile: null,
    outDir: "evaluation/real/out/phase2",
    workDir: "evaluation/real/work/phase2",
    concurrency: 1,
    timeoutMs: 10 * 60 * 1000,
    max: Infinity,
    verbose: false,
    keepRepos: false,
    onlyExternal: true,
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
    else if (a === "--help" || a === "-h") {
      console.log(`
Usage:
  node evaluation/real/phase2-run.mjs --repos-file <FILE> [options]

Options:
  --out-dir <DIR>            Output directory (default: evaluation/real/out/phase2)
  --work-dir <DIR>           Clone workspace (default: evaluation/real/work/phase2)
  --concurrency <N>          Parallelism (default: 1)
  --timeout-ms <MS>          Per repo timeout (default: 600000)
  --max <N>                  Max repos to process
  --keep-repos               Keep cloned repos in work dir
  --verbose
  --include-non-external     Also attempt fixes for alias/relative specifiers (default: off)
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
  // Format (typical):
  // path/to/file.ts(12,34): error TS2305: Module '"x"' has no exported member 'y'.
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

function extractModuleAndMemberFromMsg(code, msg) {
  const normalizeModule = (s) => {
    if (!s) return null;
    let out = String(s).trim();
    // Some TS messages embed quotes, e.g. Module '"nuxt/kit"'
    if ((out.startsWith('"') && out.endsWith('"')) || (out.startsWith("'") && out.endsWith("'"))) {
      out = out.slice(1, -1);
    }
    return out;
  };
  // TS2613: Module '"x"' has no default export.
  if (code === "TS2613") {
    const m = msg.match(/Module\s+'([^']+)'/i) || msg.match(/Module\s+"([^"]+)"/i);
    return { module: normalizeModule(m?.[1] ?? null), member: null };
  }
  // TS2305 / TS2614: Module '"x"' has no exported member 'y'.
  if (code === "TS2305" || code === "TS2614") {
    const mm = msg.match(/Module\s+'([^']+)'/i) || msg.match(/Module\s+"([^"]+)"/i);
    // TS2614 often includes "exported member named 'x'"
    const mem =
      msg.match(/exported member(?:\s+named)?\s+'([^']+)'/i) || msg.match(/exported member(?:\s+named)?\s+"([^"]+)"/i);
    return { module: normalizeModule(mm?.[1] ?? null), member: mem?.[1] ?? null };
  }
  return { module: null, member: null };
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function modAliasFor(moduleSpecifier) {
  const h = crypto.createHash("sha1").update(moduleSpecifier).digest("hex").slice(0, 8);
  return `__phase2_mod_${h}`;
}

function removeNamedImportSpecifier(importStmt, exportedName) {
  // Very lightweight removal for common patterns inside `{ ... }`
  // Handles `x`, `type x`, `x as y`, `type x as y`, whitespace, and trailing commas.
  const nameRe = new RegExp(
    String.raw`(^|[,{]\s*)(?:type\s+)?${escapeRegExp(exportedName)}(\s+as\s+[A-Za-z_$][\\w$]*)?\s*(?=,|\\})`,
    "m",
  );
  const m = importStmt.match(nameRe);
  if (!m) return { next: importStmt, localName: null, removed: false };
  const asM = importStmt.match(
    new RegExp(String.raw`(?:type\s+)?${escapeRegExp(exportedName)}\\s+as\\s+([A-Za-z_$][\\w$]*)`),
  );
  const localName = asM?.[1] ?? exportedName;
  let next = importStmt.replace(nameRe, "$1");
  // cleanup: remove duplicate commas / `{ ,` / `, }`
  next = next.replace(/\{\s*,/g, "{ ");
  next = next.replace(/,\s*\}/g, " }");
  next = next.replace(/\{\s*\}/g, "{}");
  return { next, localName, removed: true };
}

function rewriteNamedFromModuleSingleLine(src, { mod, member }) {
  // Handle common single-line patterns:
  // - import { x, y as z } from 'm'
  // - import type { X } from "m"
  // - import A, { x } from 'm'
  // - export { x } from 'm'
  // - export type { X } from 'm'
  //
  // Strategy:
  // - find all single-line import/export statements from `mod` that contain `{ ... }`
  // - pick one that contains the missing `member`
  // - remove it; if it's an import, also inject runtime binding fallback
  const lineRe = new RegExp(
    String.raw`^(\s*(?:import|export)\s+(?:type\s+)?[^;\n]*\{[^}\n]*\}[^;\n]*from\s+(['"])${escapeRegExp(mod)}\2\s*;?\s*)$`,
    "gm",
  );
  const candidates = [];
  let m;
  while ((m = lineRe.exec(src)) !== null) {
    candidates.push({ stmt: m[1], index: m.index });
  }
  if (candidates.length === 0) return { nextSrc: src, injections: [], changed: false };

  const memberWord = new RegExp(String.raw`\b${escapeRegExp(member)}\b`);
  const hit = candidates.find((c) => memberWord.test(c.stmt));
  if (!hit) return { nextSrc: src, injections: [], changed: false };

  const { next: nextStmt, localName, removed } = removeNamedImportSpecifier(hit.stmt, member);
  if (!removed) return { nextSrc: src, injections: [], changed: false };

  let replaced = nextStmt;
  if (/\b(import|export)\s+(type\s+)?\{\s*\}\s+from\b/.test(replaced)) {
    replaced = "";
  }

  let nextSrc = src.replace(hit.stmt, replaced);

  const injections = [];
  // Only import statements need a fallback binding (exports can simply drop the missing name).
  if (/^\s*import\b/.test(hit.stmt)) {
    const alias = modAliasFor(mod);
    // Dedup handled by caller.
    injections.push(`import * as ${alias} from '${mod}';`);
    injections.push(`type ${localName ?? member} = any;`);
    injections.push(`const ${localName ?? member} = (${alias} as any).${member};`);
  }

  return { nextSrc, injections, changed: nextSrc !== src };
}

function applyPhase2EditsToSource(sourceText, edits) {
  // edits: array of { kind, module, member?, fileRel? }
  // We apply transformations by rewriting import statements and injecting helper bindings at the top.
  let src = sourceText;
  const importInjections = new Set();
  const typeInjections = new Set();
  const valueInjections = new Set();

  for (const e of edits) {
    if (e.kind === "TS2613_default_to_namespace") {
      const mod = e.module;
      if (!mod) continue;
      const re = new RegExp(
        String.raw`(^\\s*import\\s+([A-Za-z_$][\\w$]*)\\s+from\\s+(['"])${escapeRegExp(mod)}\\3\\s*;?\\s*$)`,
        "m",
      );
      const m = src.match(re);
      if (!m) continue;
      const local = m[2];
      const nextLine = `import * as ${local} from '${mod}';`;
      src = src.replace(re, nextLine);
      continue;
    }

    if (e.kind === "TS2305_or_TS2614_missing_named") {
      const mod = e.module;
      const member = e.member;
      if (!mod || !member) continue;

      // First, try robust single-line import/export rewrite.
      const r = rewriteNamedFromModuleSingleLine(src, { mod, member });
      if (r.changed) {
        src = r.nextSrc;
        for (const inj of r.injections) {
          if (inj.startsWith("import * as ")) importInjections.add(inj);
          else if (inj.startsWith("type ")) typeInjections.add(inj);
          else valueInjections.add(inj);
        }
        continue;
      }

      // Fallback: try a more permissive multi-line import match (best-effort).
      const importRe = new RegExp(
        String.raw`(^\\s*import\\s+[\\s\\S]*?\\{[\\s\\S]*?\\}[\\s\\S]*?from\\s+(['"])${escapeRegExp(mod)}\\2\\s*;?\\s*$)`,
        "m",
      );
      const m = src.match(importRe);
      if (!m) continue;
      const stmt = m[1];
      const { next: nextStmt, localName, removed } = removeNamedImportSpecifier(stmt, member);
      if (!removed || !localName) continue;
      let replaced = nextStmt;
      if (/\bimport\s*\{\s*\}\s*from\b/.test(replaced)) replaced = "";
      src = src.replace(stmt, replaced);
      const alias = modAliasFor(mod);
      importInjections.add(`import * as ${alias} from '${mod}';`);
      // Cover both type-only and value usage sites.
      typeInjections.add(`type ${localName} = any;`);
      valueInjections.add(`const ${localName} = (${alias} as any).${member};`);
      continue;
    }
  }

  const injections = [...importInjections, ...typeInjections, ...valueInjections];
  if (injections.length > 0) {
    // Place injections after shebang/comments/imports? For simplicity, we add them at the very top.
    // This is acceptable for evaluation; we log applied edits.
    src = `${injections.join("\n")}\n${src}`;
  }

  return src;
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

async function safeReadText(p) {
  return await fs.readFile(p, "utf8");
}

async function safeWriteText(p, s) {
  await fs.writeFile(p, s);
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
    phase2: {
      onlyExternal: opts.onlyExternal,
      targets: [], // extracted diagnostics summary
      changedFiles: [], // { file, appliedRulesCount }
      reduced: false,
      eliminated: false,
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

  const has2305 = Object.prototype.hasOwnProperty.call(bcounts, "TS2305");
  const has2613 = Object.prototype.hasOwnProperty.call(bcounts, "TS2613");
  const has2614 = Object.prototype.hasOwnProperty.call(bcounts, "TS2614");
  if (!(has2305 || has2613 || has2614)) {
    result.stage = "done-no-phase2";
    result.durationMs = Date.now() - startedAt;
    if (!opts.keepRepos) await rmrf(repoDir);
    await outHandle.appendFile(JSON.stringify(result) + "\n");
    return;
  }

  // Build edits from diagnostics
  const diags = parseDiagnostics(bout);
  const relevant = diags.filter((d) => d.code === "TS2305" || d.code === "TS2613" || d.code === "TS2614");
  const targetsByFile = new Map(); // file -> edits[]

  for (const d of relevant) {
    const { module, member } = extractModuleAndMemberFromMsg(d.code, d.msg);
    if (!module) continue;
    if (opts.onlyExternal && !isExternalModuleSpecifier(module)) continue;

    result.phase2.targets.push({ code: d.code, file: d.file, module, member });

    const absFile = path.isAbsolute(d.file) ? d.file : path.join(repoDir, d.file);
    const edits = targetsByFile.get(absFile) ?? [];
    if (d.code === "TS2613") edits.push({ kind: "TS2613_default_to_namespace", module });
    else edits.push({ kind: "TS2305_or_TS2614_missing_named", module, member });
    targetsByFile.set(absFile, edits);
  }

  if (targetsByFile.size === 0) {
    result.skipReason = "no-phase2-targets-after-filter";
    result.durationMs = Date.now() - startedAt;
    if (!opts.keepRepos) await rmrf(repoDir);
    await outHandle.appendFile(JSON.stringify(result) + "\n");
    return;
  }

  // Apply edits
  result.stage = "inject";
  for (const [filePath, edits] of targetsByFile.entries()) {
    if (!(await fileExists(filePath))) continue;
    const src = await safeReadText(filePath);
    const next = applyPhase2EditsToSource(src, edits);
    if (next !== src) {
      await safeWriteText(filePath, next);
      result.phase2.changedFiles.push({ file: path.relative(repoDir, filePath), appliedRulesCount: edits.length });
    }
  }

  // Rerun tsc
  const jr = await runCmd({ cwd: repoDir, cmd: "tsc", args: ["--noEmit", "--pretty", "false", "-p", "tsconfig.json"], timeoutMs: opts.timeoutMs });
  const jout = `${jr.stdout}\n${jr.stderr}`;
  const jcounts = extractTsCodes(jout);
  result.injected = {
    exitCode: jr.code,
    timedOut: jr.timedOut,
    tsErrorCounts: jcounts,
    outputSample: jout.slice(0, 2000),
  };

  const before = (bcounts.TS2305 ?? 0) + (bcounts.TS2613 ?? 0) + (bcounts.TS2614 ?? 0);
  const after = (jcounts.TS2305 ?? 0) + (jcounts.TS2613 ?? 0) + (jcounts.TS2614 ?? 0);
  result.phase2.reduced = after < before;
  result.phase2.eliminated = after === 0 && before > 0;

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
    "baselineTS2305",
    "baselineTS2613",
    "baselineTS2614",
    "injectedExit",
    "injectedTS2305",
    "injectedTS2613",
    "injectedTS2614",
    "phase2Reduced",
    "phase2Eliminated",
    "phase2Targets",
    "phase2ChangedFiles",
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
        b.TS2305 ?? 0,
        b.TS2613 ?? 0,
        b.TS2614 ?? 0,
        o.injected?.exitCode ?? "",
        j.TS2305 ?? 0,
        j.TS2613 ?? 0,
        j.TS2614 ?? 0,
        o.phase2?.reduced ? "true" : "false",
        o.phase2?.eliminated ? "true" : "false",
        (o.phase2?.targets?.length ?? 0),
        (o.phase2?.changedFiles?.length ?? 0),
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


