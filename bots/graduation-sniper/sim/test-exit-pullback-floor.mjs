#!/usr/bin/env node
import {
  readExitConfig,
  createPosition,
  decidePullbackFloorExit,
  decideTieredExit,
  EPS,
} from "../exit-strategy.mjs";

const failures = [];
const assert = (c, m) => {
  if (!c) failures.push(m);
};

const cfg = readExitConfig({
  GRAD_TAKE_PROFIT: "1.4",
  GRAD_STOP_LOSS: "0.5",
  GRAD_FLOOR_ARM: "1.1",
  GRAD_TIMEOUT_SEC: "300",
});
const pos = () =>
  createPosition(
    { entryPrice: 1, entryTime: Date.now() - 10_000, fillAtEntry: 95, velocityAtEntry: 0 },
    cfg,
  );

assert(cfg.pullbackFloor && !cfg.tiered, "pullback mode on");

assert(decidePullbackFloorExit(pos(), 0.45, 5, cfg)?.exitType === "stop_loss", "SL before arm");
assert(decidePullbackFloorExit(pos(), 0.95, 5, cfg) === null, "hold below arm");

const p1 = pos();
let d = decidePullbackFloorExit(p1, 1.12, 8, cfg);
assert(d?.action === "arm_only", "arm above 1.1");
p1.sawAboveArm = true;
assert(decidePullbackFloorExit(p1, 1.12, 8, cfg) === null, "no arm-only retrigger");
assert(decidePullbackFloorExit(p1, 1.08, 12, cfg)?.exitType === "floor_pullback", "pullback <=1.1");

const p2 = pos();
p2.sawAboveArm = true;
assert(decidePullbackFloorExit(p2, 1.45, 15, cfg)?.exitType === "take_profit", "TP 1.4");

const p3 = pos();
d = decidePullbackFloorExit(p3, 1.11, 9, cfg);
assert(d?.action === "arm_only", "same-tick arm not sell");
p3.sawAboveArm = true;
assert(decidePullbackFloorExit(p3, 1.11, 9, cfg) === null, "at 1.1 not exit until pullback");

const p4 = pos();
assert(decidePullbackFloorExit(p4, 0.35, 20, cfg)?.exitType === "stop_loss", "gap SL");

assert(decidePullbackFloorExit(pos(), 0.9, 301, cfg)?.exitType === "timeout", "timeout");

const tiered = readExitConfig({ GRAD_TP2: "1.6", GRAD_TP1: "1.2" });
assert(tiered.tiered && !tiered.pullbackFloor, "tiered regression");
const tp = createPosition({ entryPrice: 1, entryTime: Date.now(), fillAtEntry: 9, velocityAtEntry: 0 }, tiered);
assert(decideTieredExit(tp, 1.25, 10, { ...tiered, stopLoss: 0.7, timeoutSec: 300 })?.action === "tp1", "tiered tp1");

if (failures.length) {
  console.error("FAIL:", failures);
  process.exit(1);
}
console.log("OK pullback floor exit tests");
