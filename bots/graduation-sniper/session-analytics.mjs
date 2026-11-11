import fs from "node:fs";
import path from "node:path";

export class SessionAnalytics {
  constructor(csvPath) {
    this.csvPath = csvPath;
    this.rows = [];
    this.skipCounts = new Map();
    if (csvPath) {
      fs.mkdirSync(path.dirname(csvPath), { recursive: true });
      fs.writeFileSync(
        csvPath,
        "ts_utc_plus3,kind,mint,fill_pct,velocity,pnl_pct,exit_type,extra\n",
      );
    }
  }

  recordSkip(mint, fillPct, velocity, reasons) {
    const key = reasons.join("|");
    this.skipCounts.set(key, (this.skipCounts.get(key) || 0) + 1);
    this._append("SKIP", mint, fillPct, velocity, "", "", reasons.join(";"));
  }

  recordBuy(mint, fillPct, velocity, entryPrice, strategy = "") {
    const extra = strategy ? `price=${entryPrice};strategy=${strategy}` : `price=${entryPrice}`;
    this._append("BUY", mint, fillPct, velocity, "", "", extra);
  }

  recordSell(mint, fillPct, velocity, pnlPct, exitType, holdSec, extra = "", strategy = "") {
    let tail = extra ? `hold_sec=${holdSec};${extra}` : `hold_sec=${holdSec}`;
    if (strategy) tail += `;strategy=${strategy}`;
    this._append("SELL", mint, fillPct, velocity, pnlPct, exitType, tail);
  }

  recordTradeClose(mint, fillPct, tradePnlSol, tradeClass, strategy = "") {
    const extra = strategy
      ? `pnl_sol=${tradePnlSol.toFixed(6)};strategy=${strategy}`
      : `pnl_sol=${tradePnlSol.toFixed(6)}`;
    this._append(
      "TRADE",
      mint,
      fillPct,
      "",
      (tradePnlSol >= 0 ? "+" : "") + tradePnlSol.toFixed(4),
      tradeClass,
      extra,
    );
  }

  recordAbPair(mint, fillPct, pnlTiered, pnlSimple, classTiered, classSimple) {
    const delta = pnlSimple - pnlTiered;
    this._append(
      "AB_PAIR",
      mint,
      fillPct,
      "",
      (delta >= 0 ? "+" : "") + delta.toFixed(4),
      "ab_delta_simple_minus_tiered",
      `pnl_tiered=${pnlTiered.toFixed(6)};pnl_simple=${pnlSimple.toFixed(6)};class_tiered=${classTiered};class_simple=${classSimple}`,
    );
  }

  _append(kind, mint, fillPct, velocity, pnlPct, exitType, extra) {
    const ts = new Date(Date.now() + 3 * 60 * 60 * 1000)
      .toISOString()
      .replace("Z", "+03:00");
    const vel = velocity === null || velocity === undefined ? "" : Number(velocity).toFixed(4);
    const row = `${ts},${kind},${mint},${fillPct?.toFixed?.(2) ?? ""},${vel},${pnlPct},${exitType},${extra}\n`;
    this.rows.push(row);
    if (this.csvPath) fs.appendFileSync(this.csvPath, row);
  }

  summary() {
    return {
      events: this.rows.length,
      topSkips: [...this.skipCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([reason, count]) => ({ reason, count })),
    };
  }
}
