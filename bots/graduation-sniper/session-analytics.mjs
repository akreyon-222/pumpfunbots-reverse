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

  recordBuy(mint, fillPct, velocity, entryPrice) {
    this._append("BUY", mint, fillPct, velocity, "", "", `price=${entryPrice}`);
  }

  recordSell(mint, fillPct, velocity, pnlPct, exitType, holdSec, extra = "") {
    const tail = extra ? `hold_sec=${holdSec};${extra}` : `hold_sec=${holdSec}`;
    this._append("SELL", mint, fillPct, velocity, pnlPct, exitType, tail);
  }

  recordTradeClose(mint, fillPct, tradePnlSol, tradeClass) {
    this._append(
      "TRADE",
      mint,
      fillPct,
      "",
      (tradePnlSol >= 0 ? "+" : "") + tradePnlSol.toFixed(4),
      tradeClass,
      `pnl_sol=${tradePnlSol.toFixed(6)}`,
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
