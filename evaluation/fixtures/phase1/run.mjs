#!/usr/bin/env node
/**
 * Phase1 evaluation runner:
 * - baseline: run tsc on each fixture project
 * - inject: copy project, inject minimal .d.ts to resolve TS2307/TS7016, run tsc
 *
 * Outputs:
 * - evaluation/fixtures/phase1/out/results.jsonl
 * - evaluation/fixtures/phase1/out/summary.tsv
 */

import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(process.cwd());
const FIXTURES_ROOT = path.join(ROOT, "evaluation-data-set", "fixtures", "phase1");
const EVAL_ROOT = path.join(ROOT, "evaluation", "fixtures", "phase1");
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

async function listPhase1Projects() {
  const out = [];

  // TS2307: include root + test dirs
  {
    const codeDir = path.join(FIXTURES_ROOT, "TS2307");
    if (await exists(path.join(codeDir, "tsconfig.json"))) {
      out.push({ code: "TS2307", projectDir: codeDir });
    }
    const entries = (await fs.readdir(codeDir, { withFileTypes: true }).catch(() => []))
      .filter((e) => e.isDirectory() && e.name.startsWith("test"))
      .map((e) => path.join(codeDir, e.name));
    for (const p of entries) out.push({ code: "TS2307", projectDir: p });
  }

  // TS7016: include downstream + test dirs
  {
    const codeDir = path.join(FIXTURES_ROOT, "TS7016");
    const downstream = path.join(codeDir, "downstream");
    if (await exists(path.join(downstream, "tsconfig.json"))) {
      out.push({ code: "TS7016", projectDir: downstream, ts7016LibDir: path.join(codeDir, "fixture-lib-no-types") });
    }
    const entries = (await fs.readdir(codeDir, { withFileTypes: true }).catch(() => []))
      .filter((e) => e.isDirectory() && e.name.startsWith("test"))
      .map((e) => path.join(codeDir, e.name));
    for (const p of entries) out.push({ code: "TS7016", projectDir: p, ts7016LibDir: path.join(codeDir, "fixture-lib-no-types") });
  }

  // stable order
  out.sort((a, b) => (a.code + a.projectDir).localeCompare(b.code + b.projectDir));
  return out;
}

async function copyDir(src, dst) {
  // Node 20+: fs.cp
  await fs.cp(src, dst, { recursive: true, force: true });
}

async function ensureTs7016NodeModules({ projectDir, ts7016LibDir }) {
  // Do NOT commit node_modules in fixtures. For evaluation we materialize the minimal JS lib
  // so that TS7016 triggers (JS module exists, but no .d.ts).
  const nm = path.join(projectDir, "node_modules", "fixture-lib-no-types");
  await mkdirp(nm);
  await fs.copyFile(path.join(ts7016LibDir, "package.json"), path.join(nm, "package.json"));
  await fs.copyFile(path.join(ts7016LibDir, "index.js"), path.join(nm, "index.js"));
}

async function readText(p) {
  return await fs.readFile(p, "utf8");
}

async function writeText(p, s) {
  await mkdirp(path.dirname(p));
  await fs.writeFile(p, s);
}

async function injectDts({ code, projectDir }) {
  // Ensure types are included
  const tsconfigPath = path.join(projectDir, "tsconfig.json");
  const tsconfig = JSON.parse(await readText(tsconfigPath));
  const include = Array.isArray(tsconfig.include) ? tsconfig.include.slice() : ["src/**/*.ts"];
  if (!include.includes("types/**/*.d.ts")) include.push("types/**/*.d.ts");
  tsconfig.include = include;
  await writeText(tsconfigPath, JSON.stringify(tsconfig, null, 2) + "\n");

  if (code === "TS2307") {
    // Extract missing module specifier(s) from src/index.ts and declare them.
    const src = await readText(path.join(projectDir, "src", "index.ts"));
    const specs = [];
    for (const m of src.matchAll(/from\s+\"([^\"]+)\"/g)) specs.push(m[1]);
    const uniq = [...new Set(specs)];
    const lines = uniq
      .map(
        (s) => `declare module "${s}" {\n  const v: any;\n  export default v;\n}\n`,
      )
      .join("\n");
    await writeText(path.join(projectDir, "types", "stubs.d.ts"), lines);
    return;
  }

  if (code === "TS7016") {
    const dts = `declare module "fixture-lib-no-types" {\n  const greet: (name: string) => string;\n  export default greet;\n}\n`;
    await writeText(path.join(projectDir, "types", "fixture-lib-no-types.d.ts"), dts);
    return;
  }
}

async function runOne({ code, projectDir, ts7016LibDir }) {
  const rel = path.relative(ROOT, projectDir);
  const slug = rel.replace(/[\\/]/g, "__");
  const baseWork = path.join(WORK_ROOT, code, slug);
  const baselineDir = path.join(baseWork, "baseline");
  const injectDir = path.join(baseWork, "inject");

  await rmrf(baseWork);
  await mkdirp(baseWork);

  // baseline copy
  await copyDir(projectDir, baselineDir);
  // inject copy
  await copyDir(projectDir, injectDir);

  if (code === "TS7016") {
    await ensureTs7016NodeModules({ projectDir: baselineDir, ts7016LibDir });
    await ensureTs7016NodeModules({ projectDir: injectDir, ts7016LibDir });
  }

  const baseline = run("tsc", ["--noEmit", "--pretty", "false", "-p", "tsconfig.json"], { cwd: baselineDir });
  const baselineOut = `${baseline.stdout}\n${baseline.stderr}`;
  const baselineCodes = extractTsCodes(baselineOut);

  await injectDts({ code, projectDir: injectDir });
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
  // Preconditions
  const ver = run("tsc", ["--version"], { cwd: ROOT });
  if (!ver.ok) {
    console.error("tsc not available in PATH. Please install TypeScript.");
    process.exit(1);
  }

  await mkdirp(WORK_ROOT);
  await mkdirp(OUT_ROOT);

  const projects = await listPhase1Projects();
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


