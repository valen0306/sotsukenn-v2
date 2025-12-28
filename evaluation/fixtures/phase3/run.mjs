#!/usr/bin/env node
/**
 * Phase3 evaluation runner (DTS_STUB):
 * - baseline: materialize a JS library package into node_modules from fixture's fixture-lib/,
 *             run tsc and confirm the expected TS code appears (single-code fixtures).
 * - inject:   overwrite the library's index.d.ts in node_modules with an improved declaration,
 *             run tsc and confirm it passes.
 */

import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(process.cwd());
const FIXTURES_ROOT = path.join(ROOT, "evaluation-data-set", "fixtures", "phase3");
const EVAL_ROOT = path.join(ROOT, "evaluation", "fixtures", "phase3");
const WORK_ROOT = path.join(EVAL_ROOT, "work");
const OUT_ROOT = path.join(EVAL_ROOT, "out");

const TS_CODE_RE = /\b(TS\d{4})\b/g;

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

async function listPhase3Projects() {
  const out = [];
  const entries = await fs.readdir(FIXTURES_ROOT, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const code = e.name;
    if (!/^TS\d{4}$/.test(code)) continue;
    const codeDir = path.join(FIXTURES_ROOT, code);
    const tests = (await fs.readdir(codeDir, { withFileTypes: true }).catch(() => []))
      .filter((d) => d.isDirectory() && d.name.startsWith("test"))
      .map((d) => path.join(codeDir, d.name));
    for (const p of tests) {
      if (await exists(path.join(p, "tsconfig.json"))) out.push({ code, projectDir: p });
    }
  }
  out.sort((a, b) => (a.code + a.projectDir).localeCompare(b.code + b.projectDir));
  return out;
}

async function materializeFixtureLibIntoNodeModules(projectDir) {
  const libDir = path.join(projectDir, "fixture-lib");
  const pkg = JSON.parse(await readText(path.join(libDir, "package.json")));
  const name = pkg.name;
  if (typeof name !== "string" || name.length === 0) throw new Error(`fixture-lib/package.json missing name: ${libDir}`);

  const nm = path.join(projectDir, "node_modules", name);
  await mkdirp(nm);
  await fs.copyFile(path.join(libDir, "package.json"), path.join(nm, "package.json"));
  await fs.copyFile(path.join(libDir, "index.js"), path.join(nm, "index.js"));
  await fs.copyFile(path.join(libDir, "index.d.ts"), path.join(nm, "index.d.ts"));
  return { moduleName: name, nodeModulesPath: nm };
}

function injectedDtsFor(code) {
  switch (code) {
    case "TS2339":
      return `export function make(): { a: number; b: number };\n`;
    case "TS2322":
      return `export function getValue(): string;\n`;
    case "TS2345":
      return `export function f(x: string): void;\n`;
    case "TS2554":
      return `export function add(a: number, b?: number): number;\n`;
    case "TS2769":
      return `export function g(x: number): number;\nexport function g(x: string): string;\nexport function g(x: boolean): boolean;\n`;
    case "TS2353":
      return `export function take(x: { a: number; b?: number }): number;\n`;
    case "TS2741":
      return `export type T = { a: number; b?: number };\n`;
    case "TS7053":
      return `export function getObj(): Record<string, number>;\n`;
    default:
      throw new Error(`No injected DTS template for ${code}`);
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

  // Baseline: materialize JS lib + baseline d.ts
  await materializeFixtureLibIntoNodeModules(baselineDir);
  const baseline = run("tsc", ["--noEmit", "--pretty", "false", "-p", "tsconfig.json"], { cwd: baselineDir });
  const baselineOut = `${baseline.stdout}\n${baseline.stderr}`;
  const baselineCodes = extractTsCodes(baselineOut);

  // Inject: materialize JS lib + overwrite its d.ts with improved version
  const { nodeModulesPath } = await materializeFixtureLibIntoNodeModules(injectDir);
  await writeText(path.join(nodeModulesPath, "index.d.ts"), injectedDtsFor(code));
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

  const projects = await listPhase3Projects();
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


