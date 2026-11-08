#!/usr/bin/env node
/**
 * Bounded live RPC check: compare V3 event reserves vs on-chain bonding curve account.
 * Read-only — no keys, no transactions.
 */
import { PublicKey } from "@solana/web3.js";
import {
  PUMP_PROGRAM,
  TRADE_EVENT_PREFIX,
  BUY_INSTRUCTIONS,
} from "../../../lib/constants.mjs";
import { connection } from "../../../lib/rpc.mjs";
import { parseV3TradeEvent, getFillPct } from "../v3-parse.mjs";
import { getBondingCurveState } from "../../../lib/pumpfun.mjs";
import { logUtcPlus3 } from "../../../lib/sim-guard.mjs";

const COMMIT = process.env.GIT_SHA || "unknown";
const MAX_TX = Number(process.env.V3_VALIDATE_MAX || 8);

function extractTradeEventFromTx(tx) {
  const logs = tx.meta?.logMessages || [];
  let isBuy = false;
  for (const l of logs) {
    const m = l.match(/Instruction: (\w+)/);
    if (m && BUY_INSTRUCTIONS.has(m[1])) {
      isBuy = true;
      break;
    }
  }
  if (!isBuy) return null;
  for (const l of logs) {
    if (!l.startsWith("Program data: ")) continue;
    const data = Buffer.from(l.slice(14), "base64");
    if (data.length < 129 || !data.subarray(0, 8).equals(TRADE_EVENT_PREFIX)) continue;
    return parseV3TradeEvent(data);
  }
  return null;
}

console.log(`=== V3 LIVE VALIDATION (read-only) commit=${COMMIT} max=${MAX_TX} ===`);

const sigs = await connection.getSignaturesForAddress(PUMP_PROGRAM, { limit: 40 });
let checked = 0;
let matched = 0;
const rows = [];

for (const { signature } of sigs) {
  if (checked >= MAX_TX) break;
  let tx;
  try {
    tx = await connection.getTransaction(signature, {
      maxSupportedTransactionVersion: 0,
      commitment: "confirmed",
    });
  } catch {
    continue;
  }
  if (!tx?.meta) continue;
  const ev = extractTradeEventFromTx(tx);
  if (!ev) continue;
  checked++;
  const mintPk = new PublicKey(ev.mint);
  const state = await getBondingCurveState(mintPk);
  if (!state || state.complete) {
    rows.push({ signature, mint: ev.mint, note: "no_active_curve" });
    continue;
  }
  const evSol = ev.virtualSolReserves;
  const acSol = state.virtualSolReserves;
  const delta = evSol > acSol ? evSol - acSol : acSol - evSol;
  const ok = delta <= 5_000_000_000n;
  if (ok) matched++;
  const fill = getFillPct(evSol);
  rows.push({
    signature: signature.slice(0, 20),
    mint: ev.mint.slice(0, 12),
    fillPct: fill.toFixed(2),
    eventVSol: (Number(evSol) / 1e9).toFixed(4),
    accountVSol: (Number(acSol) / 1e9).toFixed(4),
    lamportDelta: String(delta),
    match: ok ? "OK" : "DRIFT",
  });
  logUtcPlus3("V3-LIVE", JSON.stringify(rows[rows.length - 1]));
}

console.log(`\nCompared ${checked} trade events; reserve agreement (≤5 SOL drift): ${matched}/${checked}`);
if (checked === 0) {
  console.log("No parseable V3 buy events in sample (RPC sampling — not a code failure).");
}
process.exit(0);
