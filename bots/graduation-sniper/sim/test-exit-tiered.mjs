#!/usr/bin/env node
/** Synthetic tiered + floor protect — not profit evidence */
import {
  legPnlSol,
  classifyTrade,
  createPosition,
  decideTieredExit,
  readExitConfig,
  EPS,
} from "../exit-strategy.mjs";

const BUY = 0.1;
const cfg = {
  ...readExitConfig({
    GRAD_TP2: "1.6",
    GRAD_TP1: "1.2",
    GRAD_TP1_FRACTION: "0.5",
    GRAD_STOP_LOSS: "0.7",
    GRAD_TIMEOUT_SEC: "300",
  }),
  stopLoss: 0.7,
  timeoutSec: 300,
};
const failures = [];

function assert(cond, msg) {
  if (!cond) failures.push(msg);
}

const tieredCfg = readExitConfig({
  GRAD_TP2: "1.6",
  GRAD_TP1: "1.2",
  GRAD_TP1_FRACTION: "0.5",
});

function posTiered() {
  return createPosition(
    { entryPrice: 1, entryTime: Date.now(), fillAtEntry: 95, velocityAtEntry: 0.05 },
    tieredCfg,
  );
}

// Exact 1.2 at TP1 — no same-tick floor (tp1 first)
{
  const p = posTiered();
  const d = decideTieredExit(p, 1.2, 10, cfg);
  assert(d?.action === "tp1", "at 1.2x trigger tp1");
  assert(d?.exitType !== "tp1_floor", "1.2 is tp1 not floor");
}

// After TP1, 1.2 exactly — no floor (strict <)
{
  const p = posTiered();
  p.tp1Done = true;
  p.remainingFraction = 0.5;
  assert(decideTieredExit(p, 1.2, 20, cfg) === null, "at exactly 1.2 after tp1 hold");
}

// After TP1, below 1.2 — floor at observed
{
  const p = posTiered();
  p.tp1Done = true;
  p.remainingFraction = 0.5;
  const d = decideTieredExit(p, 1.15, 25, cfg);
  assert(d?.exitType === "tp1_floor" && d.pnlMult === 1.15, "floor uses observed 1.15");
}

// Gap down after TP1
{
  const p = posTiered();
  p.tp1Done = true;
  p.remainingFraction = 0.5;
  const d = decideTieredExit(p, 0.85, 30, cfg);
  assert(d?.exitType === "tp1_floor", "gap below 1.2 uses floor not pre-sl 0.7");
}

// TP2 path
{
  const p = posTiered();
  p.tp1Done = true;
  p.remainingFraction = 0.5;
  const d = decideTieredExit(p, 1.65, 40, cfg);
  assert(d?.exitType === "tp2", "tp2 at 1.65");
}

// SL before TP1
{
  const p = posTiered();
  const d = decideTieredExit(p, 0.65, 5, cfg);
  assert(d?.exitType === "stop_loss" && d.fraction === 1, "full sl before tp1");
}

// Timeout before TP1
{
  const p = posTiered();
  const d = decideTieredExit(p, 0.95, 301, cfg);
  assert(d?.exitType === "timeout", "timeout before tp1");
}

// Double-count: one decision per call
{
  const p = posTiered();
  const d = decideTieredExit(p, 1.25, 10, cfg);
  assert(d && !d.exitType.includes(","), "single action");
}

// Classify floor protect
{
  const legs = [
    { exitType: "tp1", pnl: legPnlSol(BUY, 0.5, 1.22) },
    { exitType: "tp1_floor", pnl: legPnlSol(BUY, 0.5, 1.1) },
  ];
  assert(classifyTrade(legs) === "tp1_then_floor_protect", "classify floor");
}

// TP1+tp2 classify unchanged
{
  const legs = [
    { exitType: "tp1", pnl: 1 },
    { exitType: "tp2", pnl: 1 },
  ];
  assert(classifyTrade(legs) === "tp1_then_tp2", "tp2 class");
}

if (failures.length) {
  console.error("FAIL:", failures);
  process.exit(1);
}
console.log("OK tiered floor exit tests");
