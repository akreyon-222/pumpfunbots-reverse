#!/usr/bin/env node
/**
 * SYNTHETIC FIXTURE TESTS — not evidence of profit.
 * Run: SIMULATION_ONLY=1 node bots/graduation-sniper/sim/run-fixture-tests.mjs
 */
import { Keypair } from "@solana/web3.js";
import { TRADE_EVENT_PREFIX } from "../../../lib/constants.mjs";
import { parseV3TradeEvent, getFillPct, VIRTUAL_SOL_AT_GRADUATION } from "../v3-parse.mjs";
import { blockLiveTransaction } from "../../../lib/sim-guard.mjs";
import { sendTxWithRetry } from "../../../lib/rpc.mjs";
import { calcBuyTokens, calcSellSol, getPrice } from "../../../lib/pumpfun.mjs";
import { VersionedTransaction } from "@solana/web3.js";

const COMMIT = process.env.GIT_SHA || "unknown";
const failures = [];

function assert(cond, msg) {
  if (!cond) failures.push(msg);
}

function buildSyntheticTradeEvent({
  mintSeed = 1,
  virtualSolLamports = 78_200_000_000n,
  virtualToken = 200_000_000_000_000n,
}) {
  const buf = Buffer.alloc(129);
  TRADE_EVENT_PREFIX.copy(buf, 0);
  const mint = Keypair.fromSeed(Buffer.alloc(32, mintSeed)).publicKey;
  mint.toBuffer().copy(buf, 8);
  buf.writeBigUInt64LE(100_000_000n, 40);
  buf.writeBigUInt64LE(1_000_000n, 48);
  Keypair.generate().publicKey.toBuffer().copy(buf, 57);
  buf.writeBigUInt64LE(virtualSolLamports, 97);
  buf.writeBigUInt64LE(virtualToken, 105);
  buf.writeBigUInt64LE(virtualSolLamports / 2n, 113);
  buf.writeBigUInt64LE(virtualToken / 2n, 121);
  return { buf, mint: mint.toBase58() };
}

console.log("=== GRADUATION SNIPER FIXTURE TESTS (SYNTHETIC) ===");
console.log(`commit=${COMMIT}`);
console.log("DISCLAIMER: fixtures only — not profit evidence\n");

try {
  blockLiveTransaction("self-test");
  failures.push("blockLiveTransaction should throw when SIMULATION_ONLY=1");
} catch (e) {
  assert(e.code === "SIMULATION_FAIL_CLOSED", "blockLiveTransaction code");
}

try {
  await sendTxWithRetry({});
  failures.push("sendTxWithRetry should throw under SIMULATION_ONLY");
} catch (e) {
  assert(
    e.code === "SIMULATION_FAIL_CLOSED" || String(e.message).includes("SIMULATION_FAIL_CLOSED"),
    `sendTx guard (${e.message})`,
  );
}

const { buf, mint } = buildSyntheticTradeEvent({
  virtualSolLamports: 78_200_000_000n,
});
const ev = parseV3TradeEvent(buf);
assert(ev?.mint === mint, "mint roundtrip");
const fill = getFillPct(ev.virtualSolReserves);
assert(Math.abs(fill - 92) < 0.1, `fill% ~92 got ${fill}`);

const threshold = Number(VIRTUAL_SOL_AT_GRADUATION) / 1e9;
assert(threshold === 85, "graduation threshold 85 SOL virtual");

const state = {
  virtualTokenReserves: ev.virtualTokenReserves,
  virtualSolReserves: ev.virtualSolReserves,
  realTokenReserves: ev.realTokenReserves,
  realSolReserves: ev.realSolReserves,
};
const entryPrice = getPrice(state);
const buySol = 0.1;
const tokens = calcBuyTokens(state, buySol);
const afterBuy = {
  ...state,
  virtualSolReserves: state.virtualSolReserves + BigInt(Math.floor(buySol * 1e9 * 0.99)),
  virtualTokenReserves: state.virtualTokenReserves - tokens,
};
const mult = getPrice(afterBuy) / entryPrice;
console.log(`[FIXTURE] entryPrice=${entryPrice.toExponential(4)} mult_after_0.1SOL_buy=${mult.toFixed(4)}`);
console.log(`[FIXTURE] fees: 1% buy/sell in calcBuyTokens/calcSellSol; SLIPPAGE_BPS=500 on live min-out`);
console.log(`[FIXTURE] --dry-run entry is paper; exit pricing still uses RPC getBondingCurveState`);

const sellSol = calcSellSol(afterBuy, tokens);
console.log(`[FIXTURE] round-trip sell ≈ ${(Number(sellSol) / 1e9).toFixed(6)} SOL`);

assert(parseV3TradeEvent(Buffer.alloc(50)) === null, "short buffer rejected");

const upsideToGrad = 100 - fill;
console.log(`[FIXTURE] at 92% fill, ~${upsideToGrad.toFixed(1)}% of virtual-SOL cap remains before 85 SOL threshold`);

if (failures.length) {
  console.error("\nFAILURES:", failures);
  process.exit(1);
}
console.log("\nAll fixture checks passed.");
