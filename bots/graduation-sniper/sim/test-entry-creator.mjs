#!/usr/bin/env node
import { evaluateEntry, readFilterConfig, DEFAULT_CREATOR_DENYLIST } from "../entry-filters.mjs";

const now = Date.now();
const history = [
  { fillPct: 86.0, vSol: 73.1, ts: now - 12_000 },
  { fillPct: 87.2, vSol: 74.1, ts: now - 6_000 },
  { fillPct: 88.0, vSol: 74.8, ts: now - 1_000 },
];

const cfg = readFilterConfig({
  GRAD_HARD_MAX_FILL_PCT: "97",
  GRAD_COLD_START_ALLOW: "0",
  GRAD_CREATOR_FILTER: "1",
  GRAD_CREATOR_SESSION_SL_SKIP: "2",
});

function entry(over = {}) {
  return evaluateEntry(
    {
      mint: "test",
      fillPct: 88,
      history,
      mintStats: { buys: 0 },
      creator: "SomeCreator111111111111111111111111111111111",
      creatorStats: { slTokens: 0 },
      now,
      ...over,
    },
    cfg,
  );
}

const ok = entry();
if (!ok.allow) throw new Error(`expected allow 88% vel: ${ok.reasons}`);

const hard = entry({ fillPct: 97.1 });
if (hard.allow || !hard.reasons.some((r) => r.includes("hard_max"))) {
  throw new Error(`expected hard max block: ${hard.reasons}`);
}

const deny = entry({ creator: DEFAULT_CREATOR_DENYLIST[0] });
if (deny.allow || !deny.reasons.some((r) => r.startsWith("creator_denylist"))) {
  throw new Error(`expected denylist: ${deny.reasons}`);
}

const launchDump = "4L69zf2AD3jEJVYuYrC4kbPMMVLsi9aKwBctFveiTFsp";
const fromFile = entry({ creator: launchDump });
if (fromFile.allow || !fromFile.reasons.some((r) => r.startsWith("creator_denylist"))) {
  throw new Error(`expected launch denylist file hit: ${fromFile.reasons}`);
}

const unknown = entry({ creator: null });
if (unknown.allow || !unknown.reasons.includes("creator_unknown")) {
  throw new Error("expected creator_unknown fail-closed");
}

const sessionSl = entry({ creatorStats: { slTokens: 2 } });
if (sessionSl.allow || !sessionSl.reasons.some((r) => r.startsWith("creator_session_sl"))) {
  throw new Error(`expected session sl skip: ${sessionSl.reasons}`);
}

const cold = evaluateEntry(
  {
    mint: "test",
    fillPct: 88,
    history: [{ fillPct: 88, vSol: 74.8, ts: now }],
    mintStats: { buys: 0 },
    creator: "SomeCreator111111111111111111111111111111111",
    now,
  },
  cfg,
);
if (cold.allow || !cold.reasons.includes("insufficient_watch_history")) {
  throw new Error(`expected cold start block: ${cold.reasons}`);
}

console.log("OK entry creator/fill85 tests");
