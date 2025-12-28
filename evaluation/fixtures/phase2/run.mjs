#!/usr/bin/env node
/**
 * Phase2 evaluation runner:
 * - baseline: run tsc on each fixture project
 * - inject: copy project, apply module-boundary fix, run tsc
 *
 * We treat Phase2 as "export/import shape alignment", so injection is a deterministic
 * source-to-source transform on the importing file (src/index.ts) to make it consistent
 * with the provider module (src/lib.ts).
 *
 * Outputs:
 * - evaluation/fixtures/phase2/out/results.jsonl
 * - evaluation/fixtures/phase2/out/summary.tsv
 */

import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(process.cwd());
const FIXTURES_ROOT = path.join(ROOT, "evaluation-data-set", "fixtures", "phase2");
const EVAL_ROOT = path.join(ROOT, "evaluation", "fixtures", "phase2");
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

async function listPhase2Projects() {
  const codes = ["TS2305", "TS2613", "TS2614"];
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

async function applyPhase2Fix({ code, projectDir }) {
  const indexPath = path.join(projectDir, "src", "index.ts");
  const src = await readText(indexPath);

  if (code === "TS2613") {
    // "has no default export" -> switch to named import { x }
    const next = src.replace(/^import\s+\w+\s+from\s+(['"]\.\/lib['"]);\s*$/m, "import { x } from $1;");
    await writeText(indexPath, next);
    return;
  }

  if (code === "TS2614") {
    // "has no exported member" when importing named from default-only module -> switch to default import
    const next = src.replace(/^import\s+\{\s*greet\s*\}\s+from\s+(['"]\.\/lib['"]);\s*$/m, "import greet from $1;");
    await writeText(indexPath, next);
    return;
  }

  if (code === "TS2305") {
    // importing missing named export { b } when lib exports { a } -> import { a as b }
    const next = src.replace(/^import\s+\{\s*b\s*\}\s+from\s+(['"]\.\/lib['"]);\s*$/m, "import { a as b } from $1;");
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

  await applyPhase2Fix({ code, projectDir: injectDir });
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

  const projects = await listPhase2Projects();
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


