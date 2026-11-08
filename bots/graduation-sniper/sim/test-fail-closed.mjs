#!/usr/bin/env node
/** Verify live send path throws when SIMULATION_ONLY=1 (no --dry-run on this process). */
import { buildVersionedTx, computeBudgetIxs } from "../../../lib/tx.mjs";
import { loadKeypair } from "../../../lib/wallet.mjs";
import { SystemProgram } from "@solana/web3.js";

const payer = loadKeypair();
try {
  await buildVersionedTx(payer, [
    ...computeBudgetIxs(),
    SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: payer.publicKey,
      lamports: 1,
    }),
  ]);
  console.error("FAIL: buildVersionedTx should not succeed");
  process.exit(1);
} catch (e) {
  if (e.code !== "SIMULATION_FAIL_CLOSED") throw e;
  console.log("OK: buildVersionedTx blocked:", e.message);
}
