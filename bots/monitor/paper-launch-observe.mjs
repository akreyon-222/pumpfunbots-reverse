#!/usr/bin/env node
/**
 * Observe-only: new pump.fun creates. No buys, no wallet, no signatures.
 * SIMULATION_ONLY=1 node bots/monitor/paper-launch-observe.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import {
  PUMP_PROGRAM,
  TRADE_EVENT_PREFIX,
  BUY_INSTRUCTIONS,
  SELL_INSTRUCTIONS,
  CREATE_INSTRUCTIONS,
} from "../../lib/constants.mjs";
import { SolanaWs } from "../../lib/ws.mjs";
import { parseV3TradeEvent } from "../graduation-sniper/v3-parse.mjs";
import { logUtcPlus3 } from "../../lib/sim-guard.mjs";
import {
  createLaunchTracker,
  applyLaunchTrade,
  dueSnapshots,
  snapshotRow,
  fillFromReserves,
} from "./launch-observe-core.mjs";

const DURATION_SEC = Number(process.env.PAPER_OBSERVE_SEC || 3600);
const ARTIFACT_DIR = process.env.ARTIFACT_DIR || "/opt/cursor/artifacts";
const STAMP = process.env.PAPER_LAUNCH_STAMP || "60m-launch-observe";
const GIT_SHA = (() => {
  try {
    return execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
  } catch {
    return process.env.GIT_SHA || "unknown";
  }
})();

fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
const logPath = path.join(ARTIFACT_DIR, `launch-observe-${STAMP}.log`);
const csvPath = path.join(ARTIFACT_DIR, `launch-observe-${STAMP}.csv`);
const metaPath = path.join(ARTIFACT_DIR, `launch-observe-meta-${STAMP}.json`);

const logStream = fs.createWriteStream(logPath, { flags: "w" });
function log(msg) {
  const line = `[${new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString().replace("Z", "+03:00")}] [LAUNCH] ${msg}`;
  logStream.write(line + "\n");
  logUtcPlus3("LAUNCH", msg);
}

fs.writeFileSync(
  csvPath,
  "ts_utc_plus3,kind,mint,creator,age_sec,fill_pct,dev_buy_sol,unique_buyers,buy_count,sell_count,creator_first_sell_sec,extra\n",
);

function csvTs() {
  return new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString().replace("Z", "+03:00");
}

function appendCsv(kind, t, ageSec, extra = "") {
  const snap = snapshotRow(t, ageSec, Date.now());
  const fill = snap.fillPct != null ? snap.fillPct.toFixed(2) : "";
  const cfs = snap.creatorFirstSellSec != null ? snap.creatorFirstSellSec.toFixed(1) : "";
  const row = [
    csvTs(),
    kind,
    t.mint,
    t.creator || "",
    ageSec,
    fill,
    (t.devBuySol || 0).toFixed(4),
    snap.uniqueBuyers,
    snap.buyCount,
    snap.sellCount,
    cfs,
    extra,
  ].join(",");
  fs.appendFileSync(csvPath, row + "\n");
}

const meta = {
  mode: "LAUNCH_OBSERVE_ONLY",
  durationSec: DURATION_SEC,
  commit: GIT_SHA,
  SIMULATION_ONLY: 1,
  noBuys: true,
  startedAtUtcPlus3: csvTs(),
  artifacts: { log: logPath, csv: csvPath, meta: metaPath },
};
fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));

const trackers = new Map();
let createCount = 0;
let wsErrors = 0;
let dump10 = 0;

function parseInstr(logs) {
  let isBuy = false,
    isSell = false,
    isCreate = false;
  for (const line of logs) {
    const m = line.match(/Instruction: (\w+)/);
    if (!m) continue;
    if (BUY_INSTRUCTIONS.has(m[1])) isBuy = true;
    if (SELL_INSTRUCTIONS.has(m[1])) isSell = true;
    if (CREATE_INSTRUCTIONS.has(m[1])) isCreate = true;
  }
  return { isBuy, isSell, isCreate };
}

function tradesFromLogs(logs) {
  const { isBuy, isSell, isCreate } = parseInstr(logs);
  const trades = [];
  for (const line of logs) {
    if (!line.startsWith("Program data: ")) continue;
    const raw = Buffer.from(line.slice(14), "base64");
    if (raw.length < 129 || !raw.subarray(0, 8).equals(TRADE_EVENT_PREFIX)) continue;
    const ev = parseV3TradeEvent(raw);
    if (!ev) continue;
    trades.push({
      ...ev,
      isBuy: isBuy && !isSell,
      isSell: isSell && !isBuy,
      isCreate,
      fillPct: fillFromReserves(ev.virtualSolReserves),
    });
  }
  return { isCreate, trades };
}

const ws = new SolanaWs();
await ws.connect();

ws.subscribeLogs(PUMP_PROGRAM.toBase58(), (result) => {
  const { value } = result;
  if (!value?.logs) return;
  const last = value.logs[value.logs.length - 1] || "";
  if (!last.includes("success")) return;

  try {
    const { isCreate, trades } = tradesFromLogs(value.logs);
    const now = Date.now();

    if (isCreate && trades.length) {
      const t0 = trades[0];
      const creator = t0.user;
      const mint = t0.mint;
      if (!trackers.has(mint)) {
        const devBuy = trades.find((x) => x.isBuy && x.user === creator);
        const tr = createLaunchTracker({
          mint,
          creator,
          createdAt: now,
          devBuySol: devBuy ? devBuy.solAmount : 0,
          fillPct: t0.fillPct,
        });
        trackers.set(mint, tr);
        createCount++;
        appendCsv("CREATE", tr, 0, `dev_buy=${tr.devBuySol.toFixed(4)}`);
        log(
          `CREATE #${createCount} ${mint.slice(0, 12)} creator=${creator.slice(0, 8)} ` +
            `devBuy=${tr.devBuySol.toFixed(3)} fill=${tr.fillPct?.toFixed?.(1) ?? "?"}%`,
        );
      }
    }

    for (const ev of trades) {
      const tr = trackers.get(ev.mint);
      if (!tr) continue;
      applyLaunchTrade(tr, {
        isBuy: ev.isBuy,
        user: ev.user,
        solAmount: ev.solAmount,
        fillPct: ev.fillPct,
        now,
      });
      if (ev.isSell && ev.user === tr.creator && tr.creatorFirstSellSec != null && tr.creatorFirstSellSec <= 10) {
        if (!tr._loggedDump) {
          tr._loggedDump = true;
          dump10++;
          appendCsv("CREATOR_SELL_10S", tr, tr.creatorFirstSellSec.toFixed(1), "dump_flag=1");
          log(`DUMP? ${ev.mint.slice(0, 12)} creator sold @ ${tr.creatorFirstSellSec.toFixed(1)}s`);
        }
      }
    }
  } catch {}
});

const origOn = ws.ws?.on?.bind(ws.ws);
if (ws.ws) {
  ws.ws.on("error", () => {
    wsErrors++;
  });
}

setInterval(() => {
  const now = Date.now();
  for (const tr of trackers.values()) {
    for (const age of dueSnapshots(tr, now)) {
      const s = snapshotRow(tr, age, now);
      appendCsv(`SNAP_${age}`, tr, age, `dump10=${s.dumpCreator10s ? 1 : 0};uniq_per_buy=${s.uniquePerBuy.toFixed(3)}`);
      if (age === 60 || age === 300) {
        log(
          `SNAP ${age}s ${tr.mint.slice(0, 12)} fill=${s.fillPct?.toFixed?.(1) ?? "?"} ` +
            `uniq=${s.uniqueBuyers} buys=${s.buyCount} cSell=${s.creatorFirstSellSec?.toFixed?.(1) ?? "—"} dump10=${s.dumpCreator10s}`,
        );
      }
    }
  }
}, 1000);

log(`=== LAUNCH OBSERVE (no buys) duration=${DURATION_SEC}s commit=${GIT_SHA} ===`);
log(`CSV ${csvPath}`);

const timer = setTimeout(() => process.kill(process.pid, "SIGINT"), DURATION_SEC * 1000);

process.on("SIGINT", () => {
  clearTimeout(timer);
  log("Stopping.");
  log(`  creates=${createCount} tracked=${trackers.size} dump10s=${dump10} wsErrors=${wsErrors}`);
  meta.endedAtUtcPlus3 = csvTs();
  meta.creates = createCount;
  meta.tracked = trackers.size;
  meta.dumpCreatorWithin10s = dump10;
  meta.wsErrors = wsErrors;
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
  try {
    ws.close();
  } catch {}
  logStream.end();
  process.exit(0);
});
