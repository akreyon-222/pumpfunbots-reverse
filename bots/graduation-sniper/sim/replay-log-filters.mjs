#!/usr/bin/env node
import fs from "node:fs";
import { readFilterConfig, evaluateEntry } from "../entry-filters.mjs";

const logPath = process.argv[2] || "/opt/cursor/artifacts/graduation-paper-observe.log";
const cfg = readFilterConfig();
const minFill = Number(process.env.GRAD_MIN_FILL_PCT || 92);

const watchHistory = new Map();
const mintStats = new Map();
const wouldBuy = new Set();
const actualBuy = new Set();

function stats(short) {
  if (!mintStats.has(short)) mintStats.set(short, { buys: 0, lastSlAt: 0 });
  return mintStats.get(short);
}

const tsRe = /\[(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}\+\d{2}:\d{2})\]/;

for (const line of fs.readFileSync(logPath, "utf8").split("\n")) {
  const tsM = line.match(tsRe);
  const ts = tsM ? Date.parse(tsM[1]) : Date.now();

  const wl = line.match(/WATCHLIST: (\S+) fill=([\d.]+)% vSol=([\d.]+)/);
  if (wl) {
    const [, short, fillPctS] = wl;
    const fillPct = Number(fillPctS);
    if (!watchHistory.has(short)) watchHistory.set(short, []);
    const hist = watchHistory.get(short);
    hist.push({ fillPct, vSol: Number(wl[3]), ts });
    if (hist.length > 40) hist.shift();

    if (fillPct >= minFill) {
      const { allow, reasons } = evaluateEntry(
        { mint: short, fillPct, history: hist, mintStats: stats(short) },
        cfg,
      );
      const st = stats(short);
      if (allow && st.buys < cfg.maxBuysPerMint) {
        wouldBuy.add(short);
        st.buys++;
      } else if (process.env.REPLAY_VERBOSE === "1" && !allow) {
        console.log("skip", short, fillPct, reasons.join(","));
      }
    }
    continue;
  }

  if (line.includes("mint:") && line.includes("pump")) {
    const m = line.match(/mint: (\S+)/);
    if (m) actualBuy.add(m[1].slice(0, 12));
  }

  const sl = line.match(/\[PAPER\]\s+(\w+): SL hit/);
  if (sl) stats(sl[1]).lastSlAt = ts;
}

const blockedWins = [];
const blockedLosses = [];
const winShort = new Set(["B54P9YpQpa1z", "BF6CWcBuZ6BQ"]);
for (const m of actualBuy) {
  if (!wouldBuy.has(m)) {
    (winShort.has(m) ? blockedWins : blockedLosses).push(m);
  }
}

console.log("=== REPLAY FILTER SIMULATION (mint-level, first allowed touch) ===");
console.log("log:", logPath);
console.log("filters:", cfg);
console.log("actual_entries:", actualBuy.size, [...actualBuy].sort().join(", "));
console.log("filter_would_enter:", wouldBuy.size, [...wouldBuy].sort().join(", "));
console.log("blocked_actual_wins:", blockedWins.join(", ") || "(none)");
console.log("blocked_actual_losses:", blockedLosses.join(", ") || "(none)");
console.log(
  "net:",
  `fewer_entries=${actualBuy.size - [...actualBuy].filter((m) => wouldBuy.has(m)).length}`,
);
