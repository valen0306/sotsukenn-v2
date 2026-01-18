#!/usr/bin/env node
/**
 * Phase4: Train a lightweight pairwise reranker (logistic regression via SGD).
 * No external deps (Node only).
 *
 * Input:
 *  - pairwise JSONL from export-phase3-pairwise.mjs (with features.a/features.b + label)
 *
 * Output:
 *  - prints metrics
 *  - writes model JSON with weights
 *
 * Usage:
 *  node evaluation/real/train-reranker-v0.mjs \
 *    --pairwise evaluation/real/out/phase3-pairwise-max20.jsonl \
 *    --out-model evaluation/real/out/reranker-v0-max20.json
 */

import { promises as fs } from "node:fs";
import path from "node:path";

function parseArgs(argv) {
  const args = {
    pairwise: null,
    outModel: null,
    epochs: 30,
    lr: 0.05,
    l2: 1e-4,
    seed: 0,
    testFrac: 0.2,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--pairwise") args.pairwise = argv[++i];
    else if (a === "--out-model") args.outModel = argv[++i];
    else if (a === "--epochs") args.epochs = Number(argv[++i] ?? "30");
    else if (a === "--lr") args.lr = Number(argv[++i] ?? "0.05");
    else if (a === "--l2") args.l2 = Number(argv[++i] ?? "0.0001");
    else if (a === "--seed") args.seed = Number(argv[++i] ?? "0");
    else if (a === "--test-frac") args.testFrac = Number(argv[++i] ?? "0.2");
    else if (a === "--help" || a === "-h") {
      console.log(`
Usage:
  node evaluation/real/train-reranker-v0.mjs --pairwise <FILE> --out-model <FILE> [options]

Options:
  --epochs <N>
  --lr <F>
  --l2 <F>
  --seed <N>
  --test-frac <F>
`);
      process.exit(0);
    } else {
      console.error(`Unknown arg: ${a}`);
      process.exit(1);
    }
  }
  if (!args.pairwise) {
    console.error("Provide --pairwise <FILE>");
    process.exit(1);
  }
  if (!args.outModel) {
    console.error("Provide --out-model <FILE>");
    process.exit(1);
  }
  return args;
}

function mulberry32(seed) {
  let t = seed >>> 0;
  return function () {
    t += 0x6d2b79f5;
    let x = t;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

function sigmoid(z) {
  if (z >= 0) {
    const ez = Math.exp(-z);
    return 1 / (1 + ez);
  }
  const ez = Math.exp(z);
  return ez / (1 + ez);
}

function collectFeatureKeys(rows, limit = 200) {
  // Auto-detect numeric feature keys from dataset to stay in sync with exporter/runner.
  const keys = new Set();
  for (const r of rows.slice(0, limit)) {
    for (const side of ["a", "b"]) {
      const f = r?.features?.[side] ?? {};
      for (const [k, v] of Object.entries(f)) {
        if (typeof v === "number" || (typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v)))) keys.add(k);
      }
    }
  }
  return [...keys].sort();
}

function vecFrom(feat, keys) {
  return keys.map((k) => Number(feat?.[k] ?? 0) || 0);
}

function dot(w, x) {
  let s = w[0]; // bias
  for (let i = 0; i < x.length; i++) s += w[i + 1] * x[i];
  return s;
}

async function readJsonl(p) {
  const txt = await fs.readFile(p, "utf8");
  const rows = [];
  for (const ln of txt.split(/\r?\n/)) {
    if (!ln.trim()) continue;
    try {
      rows.push(JSON.parse(ln));
    } catch {
      // ignore
    }
  }
  return rows;
}

function splitByRepo(rows, testFrac, seed) {
  const rnd = mulberry32(seed);
  const seen = new Map(); // url -> isTest
  const train = [];
  const test = [];
  for (const r of rows) {
    const url = r?.url ?? "";
    if (!seen.has(url)) {
      seen.set(url, rnd() < testFrac);
    }
    (seen.get(url) ? test : train).push(r);
  }
  return { train, test };
}

function evalAcc(rows, w, keys) {
  let n = 0;
  let ok = 0;
  for (const r of rows) {
    const label = Number(r?.label ?? 0) || 0;
    const a = r?.features?.a ?? {};
    const b = r?.features?.b ?? {};
    const xa = vecFrom(a, keys);
    const xb = vecFrom(b, keys);
    // pairwise: score(a) - score(b)
    const x = xa.map((v, i) => v - xb[i]);
    const p = sigmoid(dot(w, x));
    const pred = p >= 0.5 ? 1 : 0;
    n++;
    if (pred === label) ok++;
  }
  return { n, acc: n ? ok / n : 0 };
}

async function main() {
  const args = parseArgs(process.argv);
  const rows = await readJsonl(path.resolve(args.pairwise));
  const keys = collectFeatureKeys(rows);

  const usable = rows.filter((r) => r?.features?.a && r?.features?.b && (r?.label === 0 || r?.label === 1));
  const { train, test } = splitByRepo(usable, args.testFrac, args.seed);

  // weights: [bias, w1..wd]
  const d = keys.length;
  const w = new Array(d + 1).fill(0);
  const rnd = mulberry32(args.seed);

  for (let epoch = 0; epoch < args.epochs; epoch++) {
    // shuffle train
    const idx = [...Array(train.length).keys()];
    for (let i = idx.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [idx[i], idx[j]] = [idx[j], idx[i]];
    }
    for (const ii of idx) {
      const r = train[ii];
      const y = Number(r?.label ?? 0) || 0;
      const a = r?.features?.a ?? {};
      const b = r?.features?.b ?? {};
      const xa = vecFrom(a, keys);
      const xb = vecFrom(b, keys);
      const x = xa.map((v, i) => v - xb[i]);

      const z = dot(w, x);
      const p = sigmoid(z);
      const g = p - y; // gradient for logistic loss

      // bias
      w[0] -= args.lr * (g + args.l2 * w[0]);
      for (let k = 0; k < d; k++) {
        w[k + 1] -= args.lr * (g * x[k] + args.l2 * w[k + 1]);
      }
    }
  }

  const tr = evalAcc(train, w, keys);
  const te = evalAcc(test, w, keys);

  console.log(`pairs_total\t${usable.length}`);
  console.log(`pairs_train\t${tr.n}`);
  console.log(`pairs_test\t${te.n}`);
  console.log(`train_acc\t${tr.acc.toFixed(3)}`);
  console.log(`test_acc\t${te.acc.toFixed(3)}`);

  const model = {
    version: "reranker_v0_logreg_sgd",
    feature_keys: keys,
    weights: { bias: w[0], w: Object.fromEntries(keys.map((k, i) => [k, w[i + 1]])) },
    hyperparams: { epochs: args.epochs, lr: args.lr, l2: args.l2, seed: args.seed, testFrac: args.testFrac },
  };
  await fs.mkdir(path.dirname(path.resolve(args.outModel)), { recursive: true });
  await fs.writeFile(path.resolve(args.outModel), JSON.stringify(model, null, 2) + "\n");
  console.log(`out_model\t${path.resolve(args.outModel)}`);
}

main().catch((e) => {
  console.error(e?.stack || String(e));
  process.exit(1);
});


