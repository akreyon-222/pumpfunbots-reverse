#!/usr/bin/env node
/**
 * Compare closed-trade profiles from session CSVs (read-only). No causal claims.
 * Usage: node analyze-sl-patterns.mjs file1.csv [file2.csv ...] --out /path/sl-analysis.csv
 */
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const outIdx = args.indexOf("--out");
const outPath = outIdx >= 0 ? args[outIdx + 1] : "/opt/cursor/artifacts/sl-pattern-analysis.csv";
const files = args.filter((a, i) => a !== "--out" && i !== outIdx + 1);

function loadTrades(csvPath) {
  const lines = fs.readFileSync(csvPath, "utf8").trim().split("\n");
  const header = lines[0].split(",");
  const trades = new Map();
  const buys = new Map();
  for (const line of lines.slice(1)) {
    const cols = line.split(",");
    const row = Object.fromEntries(header.map((h, i) => [h, cols[i] ?? ""]));
    if (row.kind === "BUY") buys.set(row.mint, row);
    if (row.kind === "TRADE") {
      trades.set(row.mint, { ...row, source: path.basename(csvPath) });
    }
  }
  for (const [mint, t] of trades) {
    const b = buys.get(mint);
    t.fill_pct = b?.fill_pct ?? t.fill_pct;
    t.velocity = b?.velocity ?? "";
  }
  return [...trades.values()];
}

function bucket(className) {
  if (className === "sl_before_tp1") return "SL";
  if (className.includes("floor")) return "floor_after_tp1";
  if (className === "tp1_then_sl_or_timeout") return "after_tp1_sl_timeout";
  if (className === "tp1_then_tp2") return "WIN_tp2";
  if (className === "timeout_before_tp1") return "timeout_pre_tp1";
  return "other";
}

const all = files.flatMap(loadTrades);
if (!all.length) {
  console.error("No TRADE rows");
  process.exit(1);
}

const rows = [];
for (const t of all) {
  const pnl = parseFloat((t.pnl_pct || "0").replace("+", ""));
  const isWin = pnl > 0;
  const b = bucket(t.exit_type);
  rows.push({
    source: t.source,
    mint: t.mint.slice(0, 12),
    class: t.exit_type,
    bucket: b,
    win: isWin,
    fill_pct: t.fill_pct,
    velocity: t.velocity,
    trade_pnl_pct: pnl,
  });
}

const slRows = rows.filter((r) => r.bucket === "SL");
const winRows = rows.filter((r) => r.win);
const fields = "source,bucket,win,count_note,fill_avg,vel_median_sample\n";

function avg(nums) {
  return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null;
}

const summary = [
  `all_trades,all,,${rows.length},${avg(rows.map((r) => Number(r.fill_pct)))},`,
  `sl_before_tp1,SL,,${slRows.length},${avg(slRows.map((r) => Number(r.fill_pct)))},${slRows.filter((r) => r.velocity).length}`,
  `wins,WIN,,${winRows.length},${avg(winRows.map((r) => Number(r.fill_pct)))},`,
  `losses,LOSS,,${rows.length - winRows.length},,,`,
];

fs.writeFileSync(outPath, fields + summary.join("\n") + "\n");
console.log("written", outPath);
console.log("SL count", slRows.length, "of", rows.length);
console.log("SL avg fill", avg(slRows.map((r) => Number(r.fill_pct))));
console.log("WIN avg fill", avg(winRows.map((r) => Number(r.fill_pct))));
