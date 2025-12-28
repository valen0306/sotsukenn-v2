#!/usr/bin/env node
/**
 * Phase4 evaluation runner (fixtures):
 * - baseline: run tsc on each fixture project
 * - inject: copy project, apply a minimal strictness fix, run tsc
 *
 * Outputs:
 * - evaluation/fixtures/phase4/out/results.jsonl
 * - evaluation/fixtures/phase4/out/summary.tsv
 */

import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(process.cwd());
const FIXTURES_ROOT = path.join(ROOT, "evaluation-data-set", "fixtures", "phase4");
const EVAL_ROOT = path.join(ROOT, "evaluation", "fixtures", "phase4");
const WORK_ROOT = path.join(EVAL_ROOT, "work");
const OUT_ROOT = path.join(EVAL_ROOT, "out");

const TS_CODE_RE = /\b(TS\d{4,5})\b/g;

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function rmrf(p) {
  await fs.rm(p, { recursive: true, force: true }).catch(() => {});
}

async function mkdirp(p) {
  await fs.mkdir(p, { recursive: true });
}

function run(cmd, args, { cwd }) {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8" });
  return {
    ok: r.status === 0,
    status: r.status ?? -1,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
  };
}

function extractTsCodes(text) {
  const codes = new Set();
  let m;
  while ((m = TS_CODE_RE.exec(text)) !== null) codes.add(m[1]);
  return [...codes].sort();
}

async function copyDir(src, dst) {
  await fs.cp(src, dst, { recursive: true, force: true });
}

async function readText(p) {
  return await fs.readFile(p, "utf8");
}

async function writeText(p, s) {
  await mkdirp(path.dirname(p));
  await fs.writeFile(p, s);
}

async function listPhase4Projects() {
  const codes = ["TS7006", "TS7031", "TS18046"];
  const out = [];
  for (const code of codes) {
    const codeDir = path.join(FIXTURES_ROOT, code);
    if (!(await exists(codeDir))) continue;
    const entries = (await fs.readdir(codeDir, { withFileTypes: true }).catch(() => []))
      .filter((e) => e.isDirectory() && e.name.startsWith("test"))
      .map((e) => path.join(codeDir, e.name));
    for (const p of entries) {
      if (await exists(path.join(p, "tsconfig.json"))) out.push({ code, projectDir: p });
    }
  }
  out.sort((a, b) => (a.code + a.projectDir).localeCompare(b.code + b.projectDir));
  return out;
}

async function applyPhase4Fix({ code, projectDir }) {
  const indexPath = path.join(projectDir, "src", "index.ts");
  const src = await readText(indexPath);

  if (code === "TS7006") {
    // function f(x) -> function f(x: any)
    const next = src.replace(/function\s+f\s*\(\s*x\s*\)\s*\{/m, "function f(x: any) {");
    await writeText(indexPath, next);
    return;
  }

  if (code === "TS7031") {
    // function f({ a }) -> function f({ a }: { a: any })
    const next = src.replace(/function\s+f\s*\(\s*\{\s*a\s*\}\s*\)\s*\{/m, "function f({ a }: { a: any }) {");
    await writeText(indexPath, next);
    return;
  }

  if (code === "TS18046") {
    // unknown property access -> cast to any (minimal, strictness-sensitive fix)
    const next = src.replace(/console\.log\(\s*x\.foo\s*\);/m, "console.log((x as any).foo);");
    await writeText(indexPath, next);
    return;
  }
}

async function runOne({ code, projectDir }) {
  const rel = path.relative(ROOT, projectDir);
  const slug = rel.replace(/[\\/]/g, "__");
  const baseWork = path.join(WORK_ROOT, code, slug);
  const baselineDir = path.join(baseWork, "baseline");
  const injectDir = path.join(baseWork, "inject");

  await rmrf(baseWork);
  await mkdirp(baseWork);
  await copyDir(projectDir, baselineDir);
  await copyDir(projectDir, injectDir);

  const baseline = run("tsc", ["--noEmit", "--pretty", "false", "-p", "tsconfig.json"], { cwd: baselineDir });
  const baselineOut = `${baseline.stdout}\n${baseline.stderr}`;
  const baselineCodes = extractTsCodes(baselineOut);

  await applyPhase4Fix({ code, projectDir: injectDir });
  const injected = run("tsc", ["--noEmit", "--pretty", "false", "-p", "tsconfig.json"], { cwd: injectDir });
  const injectedOut = `${injected.stdout}\n${injected.stderr}`;
  const injectedCodes = extractTsCodes(injectedOut);

  return {
    code,
    fixtureProjectDir: projectDir,
    baseline: {
      exitCode: baseline.status,
      tsCodes: baselineCodes,
      outputSample: baselineOut.slice(0, 2000),
    },
    injected: {
      exitCode: injected.status,
      tsCodes: injectedCodes,
      outputSample: injectedOut.slice(0, 2000),
    },
  };
}

async function main() {
  const ver = run("tsc", ["--version"], { cwd: ROOT });
  if (!ver.ok) {
    console.error("tsc not available in PATH. Please install TypeScript.");
    process.exit(1);
  }

  await mkdirp(WORK_ROOT);
  await mkdirp(OUT_ROOT);

  const projects = await listPhase4Projects();
  const resultsPath = path.join(OUT_ROOT, "results.jsonl");
  const summaryPath = path.join(OUT_ROOT, "summary.tsv");
  await writeText(resultsPath, "");

  const summaryLines = [];
  summaryLines.push(
    [
      "code",
      "fixtureProjectDir",
      "baselineExit",
      "baselineCodes",
      "injectedExit",
      "injectedCodes",
      "baselineHasExpectedOnly",
      "injectedSuccess",
    ].join("\t"),
  );

  let ok = 0;
  for (const p of projects) {
    const r = await runOne(p);
    await fs.appendFile(resultsPath, JSON.stringify(r) + "\n");

    const baseExpectedOnly = r.baseline.tsCodes.length === 1 && r.baseline.tsCodes[0] === r.code;
    const injectedSuccess = r.injected.exitCode === 0 && r.injected.tsCodes.length === 0;
    if (baseExpectedOnly && injectedSuccess) ok++;

    summaryLines.push(
      [
        r.code,
        path.relative(ROOT, r.fixtureProjectDir),
        String(r.baseline.exitCode),
        r.baseline.tsCodes.join(","),
        String(r.injected.exitCode),
        r.injected.tsCodes.join(","),
        baseExpectedOnly ? "true" : "false",
        injectedSuccess ? "true" : "false",
      ].join("\t"),
    );
  }

  await writeText(summaryPath, summaryLines.join("\n") + "\n");

  console.log(`tsc_version\t${ver.stdout.trim()}`);
  console.log(`projects_total\t${projects.length}`);
  console.log(`projects_ok\t${ok}`);
  console.log(`out_results\t${path.relative(ROOT, resultsPath)}`);
  console.log(`out_summary\t${path.relative(ROOT, summaryPath)}`);
}

main().catch((e) => {
  console.error(e?.stack || String(e));
  process.exit(1);
});


