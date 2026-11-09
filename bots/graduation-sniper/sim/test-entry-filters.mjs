#!/usr/bin/env node
import { evaluateEntry, fillVelocityPctPerSec } from "../entry-filters.mjs";

const now = Date.now();
const history = [
  { fillPct: 92.0, vSol: 78.2, ts: now - 12_000 },
  { fillPct: 92.4, vSol: 78.5, ts: now - 6_000 },
  { fillPct: 92.8, vSol: 78.9, ts: now - 1_000 },
];

import { readFilterConfig } from "../entry-filters.mjs";
const cfg = { ...readFilterConfig({ GRAD_REQUIRE_UPTREND_SAMPLES: "2" }), requireUptrendSamples: 2 };

const vel = fillVelocityPctPerSec(history, 15, now);
const ok = evaluateEntry(
  { mint: "test", fillPct: 92.8, history, mintStats: { buys: 0 }, now },
  cfg,
);
const bad = evaluateEntry(
  { mint: "test", fillPct: 99.6, history, mintStats: { buys: 0 }, now },
  cfg,
);

console.log("velocity", vel?.toFixed(3), "allow_momentum", ok.allow, ok.reasons);
console.log("block_top", bad.allow, bad.reasons);
if (!ok.allow || bad.allow) process.exit(1);
console.log("OK");
