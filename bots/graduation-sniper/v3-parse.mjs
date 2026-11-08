import { PublicKey } from "@solana/web3.js";
import { GRADUATION_VIRTUAL_SOL } from "../../lib/constants.mjs";

export const VIRTUAL_SOL_AT_GRADUATION = GRADUATION_VIRTUAL_SOL;

/** V3 TradeEvent layout — see docs/article.html Offset table */
export function parseV3TradeEvent(data) {
  if (data.length < 129) return null;
  const mint = new PublicKey(data.subarray(8, 40)).toBase58();
  const solAmount = Number(data.readBigUInt64LE(40)) / 1e9;
  const tokenAmount = Number(data.readBigUInt64LE(48)) / 1e6;
  const user = new PublicKey(data.subarray(57, 89)).toBase58();
  const virtualSolReserves = data.readBigUInt64LE(97);
  const virtualTokenReserves = data.readBigUInt64LE(105);
  const realSolReserves = data.readBigUInt64LE(113);
  const realTokenReserves = data.readBigUInt64LE(121);
  return {
    mint,
    solAmount,
    tokenAmount,
    user,
    virtualSolReserves,
    virtualTokenReserves,
    realSolReserves,
    realTokenReserves,
  };
}

export function getFillPct(virtualSolReserves) {
  return (Number(virtualSolReserves) / Number(VIRTUAL_SOL_AT_GRADUATION)) * 100;
}
