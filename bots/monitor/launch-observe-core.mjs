/**
 * Pure launch-watch state machine (no RPC, no buys).
 * Track a mint from create → snapshots at 10/30/60/300s.
 */
import { getFillPct } from "../graduation-sniper/v3-parse.mjs";

export const SNAP_AGES_SEC = [10, 30, 60, 300];

export function createLaunchTracker({ mint, creator, createdAt, devBuySol = 0, fillPct = null }) {
  return {
    mint,
    creator,
    createdAt,
    devBuySol,
    fillPct,
    fillAtCreate: fillPct,
    uniqueBuyers: new Set(),
    buyCount: 0,
    sellCount: 0,
    creatorFirstSellSec: null,
    creatorSoldSol: 0,
    snapsDone: new Set(),
    lastUser: null,
  };
}

export function applyLaunchTrade(tracker, { isBuy, user, solAmount, fillPct, now }) {
  const ageSec = (now - tracker.createdAt) / 1000;
  if (fillPct != null && !Number.isNaN(fillPct)) tracker.fillPct = fillPct;
  tracker.lastUser = user;

  if (isBuy) {
    tracker.buyCount++;
    if (user) tracker.uniqueBuyers.add(user);
  } else {
    tracker.sellCount++;
    if (user && user === tracker.creator && tracker.creatorFirstSellSec == null) {
      tracker.creatorFirstSellSec = ageSec;
      tracker.creatorSoldSol += solAmount || 0;
    }
  }
  return ageSec;
}

export function dueSnapshots(tracker, now) {
  const ageSec = (now - tracker.createdAt) / 1000;
  const due = [];
  for (const t of SNAP_AGES_SEC) {
    if (ageSec >= t && !tracker.snapsDone.has(t)) {
      tracker.snapsDone.add(t);
      due.push(t);
    }
  }
  return due;
}

export function snapshotRow(tracker, ageLabelSec, now) {
  const unique = tracker.uniqueBuyers.size;
  const dump10 = tracker.creatorFirstSellSec != null && tracker.creatorFirstSellSec <= 10;
  return {
    ageSec: ageLabelSec,
    fillPct: tracker.fillPct,
    uniqueBuyers: unique,
    buyCount: tracker.buyCount,
    sellCount: tracker.sellCount,
    creatorFirstSellSec: tracker.creatorFirstSellSec,
    dumpCreator10s: dump10,
    uniquePerBuy: tracker.buyCount > 0 ? unique / tracker.buyCount : 0,
    now,
  };
}

export function fillFromReserves(virtualSolReserves) {
  if (virtualSolReserves == null) return null;
  return getFillPct(virtualSolReserves);
}
