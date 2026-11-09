/**
 * Single full exit (legacy) or tiered partial exits via ENV.
 * Tiered when GRAD_TP2 is set (non-empty).
 */
export function readExitConfig(env = process.env) {
  const tiered = env.GRAD_TP2 != null && String(env.GRAD_TP2).trim() !== "";
  return {
    tiered,
    takeProfit: Number(env.GRAD_TAKE_PROFIT || 1.5),
    stopLoss: Number(env.GRAD_STOP_LOSS || 0.7),
    timeoutSec: Number(env.GRAD_TIMEOUT_SEC || 300),
    tp1: Number(env.GRAD_TP1 || 1.2),
    tp1Fraction: Number(env.GRAD_TP1_FRACTION || 0.5),
    tp2: Number(env.GRAD_TP2 || 1.6),
  };
}

export function createPosition({ entryPrice, entryTime, fillAtEntry, velocityAtEntry }, tiered) {
  const base = {
    entryPrice,
    entryTime,
    fillAtEntry,
    velocityAtEntry,
  };
  if (!tiered) return base;
  return {
    ...base,
    remainingFraction: 1,
    tp1Done: false,
    tradePnlSol: 0,
    legs: [],
  };
}

/** Kağıt PnL (SOL) for `fraction` of nominal BUY_SOL at `pnlMult`. */
export function legPnlSol(buySol, fraction, pnlMult) {
  return buySol * fraction * (pnlMult - 1);
}

export function classifyTrade(legs) {
  const types = new Set(legs.map((l) => l.exitType));
  if (types.has("tp2")) return "tp1_then_tp2";
  if (types.has("tp1") && (types.has("stop_loss") || types.has("timeout"))) return "tp1_then_sl_or_timeout";
  if (types.has("stop_loss") && !types.has("tp1")) return "sl_before_tp1";
  if (types.has("timeout") && !types.has("tp1")) return "timeout_before_tp1";
  if (types.has("take_profit")) return "legacy_tp";
  return "other";
}

export const EPS = 1e-9;
