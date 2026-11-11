#!/usr/bin/env node
import { decideLegacyExit, readExitConfig, createPosition, EPS } from "../exit-strategy.mjs";

const cfg = readExitConfig({ GRAD_TAKE_PROFIT: "1.4", GRAD_STOP_LOSS: "0.75", GRAD_TIMEOUT_SEC: "300" });
const pos = createPosition(
  { entryPrice: 1, entryTime: Date.now(), fillAtEntry: 95, velocityAtEntry: 0.1 },
  cfg,
);
const withFrac = { ...pos, remainingFraction: 1, tradePnlSol: 0, legs: [] };

let d = decideLegacyExit(withFrac, 1.5, 10, cfg);
if (d?.exitType !== "take_profit") throw new Error("expect TP");
d = decideLegacyExit(withFrac, 0.5, 10, { ...cfg, stopLoss: 0.75 });
if (d?.exitType !== "stop_loss") throw new Error("expect SL");
d = decideLegacyExit(withFrac, 1.0, 400, cfg);
if (d?.exitType !== "timeout") throw new Error("expect timeout");

withFrac.remainingFraction = EPS;
if (decideLegacyExit(withFrac, 2, 10, cfg)) throw new Error("closed pos");

console.log("OK legacy exit tests");
