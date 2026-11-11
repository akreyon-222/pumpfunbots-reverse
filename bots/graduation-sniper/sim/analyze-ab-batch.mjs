#!/usr/bin/env node
/** Summarize 6-run AB batch from manifest + CSV AB_PAIR rows */
import fs from "node:fs";
import path from "node:path";

const ARTIFACT_DIR = process.env.ARTIFACT_DIR || "/opt/cursor/artifacts";
const BATCH_ID = process.env.PAPER_AB_BATCH_ID || "ab-tiered-vs-tp14-batch1";
const manifestPath = path.join(ARTIFACT_DIR, `graduation-paper-meta-${BATCH_ID}.json`);
const outPath = path.join(ARTIFACT_DIR, `graduation-ab-batch-compare-${BATCH_ID}.md`);

if (!fs.existsSync(manifestPath)) {
  console.error("Missing manifest:", manifestPath);
  process.exit(1);
}
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

function abPairsFromCsv(csvPath) {
  if (!fs.existsSync(csvPath)) return null;
  const lines = fs.readFileSync(csvPath, "utf8").trim().split("\n").slice(1);
  let pairs = 0,
    simpleW = 0,
    tieredW = 0,
    tie = 0,
    deltaSum = 0;
  for (const l of lines) {
    if (!l.includes(",AB_PAIR,")) continue;
    pairs++;
    const mt = l.match(/pnl_tiered=([+-]?[\d.]+)/);
    const ms = l.match(/pnl_simple=([+-]?[\d.]+)/);
    if (!mt || !ms) continue;
    const d = +ms[1] - +mt[1];
    deltaSum += d;
    if (d > 1e-6) simpleW++;
    else if (d < -1e-6) tieredW++;
    else tie++;
  }
  return { pairs, simpleW, tieredW, tie, deltaSum, avgDelta: pairs ? deltaSum / pairs : 0 };
}

const rows = [];
for (const run of manifest.runs.sort((a, b) => a.runIndex - b.runIndex)) {
  const ab = run.csvPath ? abPairsFromCsv(run.csvPath) : null;
  rows.push({ ...run, ab });
}

let md = `# AB batch karşılaştırma — ${BATCH_ID}\n\n`;
md += `Commit: ${manifest.commit}\n\n`;
md += `| Run | Başlangıç (UTC+3) | Tiered PnL | Simple PnL | Δ oturum (S−T) | AB çift | Simple önde / Tiered / berabere |\n`;
md += `|-----|-------------------|------------|------------|------------------|---------|----------------------------------|\n`;

let sumT = 0,
  sumS = 0,
  n = 0;
for (const r of rows) {
  const t = r.tiered?.pnlSol;
  const s = r.simple?.pnlSol;
  if (t != null && s != null) {
    sumT += t;
    sumS += s;
    n++;
  }
  const delta = t != null && s != null ? s - t : null;
  const ab = r.ab;
  md += `| ${r.runIndex} | ${(r.startedAtUtcPlus3 || "").slice(0, 19)} | ${fmt(t)} | ${fmt(s)} | ${fmt(delta)} | ${ab?.pairs ?? "—"} | ${ab ? `${ab.simpleW}/${ab.tieredW}/${ab.tie}` : "—"} |\n`;
}
md += `\n**Toplam kapanmış PnL (${n} oturum):** tiered ${fmt(sumT)} · simple ${fmt(sumS)} · toplam Δ ${fmt(sumS - sumT)}\n`;
md += `\n*Kağıt A/B; farklı saat pencereleri — nedensel sonuç iddiası yok.*\n`;

fs.writeFileSync(outPath, md);
console.log("Wrote", outPath);
console.log(md);

function fmt(x) {
  if (x == null || Number.isNaN(x)) return "—";
  return (x >= 0 ? "+" : "") + x.toFixed(4);
}
