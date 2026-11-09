#!/usr/bin/env node
/** Synthetic tiered exit math — not profit evidence */
import {
  legPnlSol,
  classifyTrade,
  createPosition,
  EPS,
} from "../exit-strategy.mjs";

const BUY = 0.1;
let failures = [];

function assert(cond, msg) {
  if (!cond) failures.push(msg);
}

// TP1 then TP2
{
  const legs = [];
  const f1 = 0.5;
  const f2 = 0.5;
  legs.push({ exitType: "tp1", pnl: legPnlSol(BUY, f1, 1.25) });
  legs.push({ exitType: "tp2", pnl: legPnlSol(BUY, f2, 1.65) });
  const total = legs.reduce((s, l) => s + l.pnl, 0);
  assert(classifyTrade(legs) === "tp1_then_tp2", "classify tp1_tp2");
  assert(Math.abs(total - 0.045) < 0.0001, `tp1+tp2 total ${total}`);
}

// SL before TP1
{
  const legs = [{ exitType: "stop_loss", pnl: legPnlSol(BUY, 1, 0.65) }];
  assert(classifyTrade(legs) === "sl_before_tp1", "sl before tp1");
  assert(Math.abs(legs[0].pnl + 0.035) < 0.0001, "full sl pnl");
}

// TP1 then SL on rest
{
  const legs = [
    { exitType: "tp1", pnl: legPnlSol(BUY, 0.5, 1.22) },
    { exitType: "stop_loss", pnl: legPnlSol(BUY, 0.5, 0.68) },
  ];
  const total = legs.reduce((s, l) => s + l.pnl, 0);
  assert(classifyTrade(legs) === "tp1_then_sl_or_timeout", "tp1 then sl");
  assert(total < 0, "tp1+sl can be net negative");
}

{
  const pos = createPosition(
    { entryPrice: 1, entryTime: Date.now(), fillAtEntry: 95, velocityAtEntry: 0.1 },
    true,
  );
  assert(pos.remainingFraction === 1 && pos.tp1Done === false, "tiered position init");
}

if (failures.length) {
  console.error("FAIL:", failures);
  process.exit(1);
}
console.log("OK tiered exit fixture tests");
