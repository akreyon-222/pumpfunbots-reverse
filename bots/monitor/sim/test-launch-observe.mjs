#!/usr/bin/env node
import {
  createLaunchTracker,
  applyLaunchTrade,
  dueSnapshots,
  snapshotRow,
} from "../launch-observe-core.mjs";

const t0 = 1_000_000;
const tr = createLaunchTracker({
  mint: "Mint111",
  creator: "Creator111",
  createdAt: t0,
  devBuySol: 2.5,
  fillPct: 4,
});

applyLaunchTrade(tr, { isBuy: true, user: "Creator111", solAmount: 2.5, fillPct: 4, now: t0 });
applyLaunchTrade(tr, { isBuy: true, user: "BotA", solAmount: 0.1, fillPct: 5, now: t0 + 2000 });
applyLaunchTrade(tr, { isBuy: true, user: "BotB", solAmount: 0.1, fillPct: 6, now: t0 + 3000 });
applyLaunchTrade(tr, {
  isBuy: false,
  user: "Creator111",
  solAmount: 1.2,
  fillPct: 3,
  now: t0 + 4500,
});

if (tr.creatorFirstSellSec == null || tr.creatorFirstSellSec < 4 || tr.creatorFirstSellSec > 5) {
  throw new Error(`expected creator sell ~4.5s, got ${tr.creatorFirstSellSec}`);
}

const due10 = dueSnapshots(tr, t0 + 11_000);
if (!due10.includes(10)) throw new Error("expected 10s snap");
const snap = snapshotRow(tr, 10, t0 + 11_000);
if (!snap.dumpCreator10s) throw new Error("expected dump10");
if (snap.uniqueBuyers !== 3) throw new Error(`unique ${snap.uniqueBuyers}`);

const dueAgain = dueSnapshots(tr, t0 + 12_000);
if (dueAgain.includes(10)) throw new Error("10s snap should not repeat");

const clean = createLaunchTracker({ mint: "M2", creator: "C2", createdAt: t0, devBuySol: 0.2 });
applyLaunchTrade(clean, { isBuy: true, user: "C2", solAmount: 0.2, fillPct: 2, now: t0 });
dueSnapshots(clean, t0 + 11_000);
const s2 = snapshotRow(clean, 10, t0 + 11_000);
if (s2.dumpCreator10s) throw new Error("clean launch should not dump-flag");

console.log("OK launch observe core");
