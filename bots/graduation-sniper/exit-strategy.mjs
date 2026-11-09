/**
 * Single full exit (legacy) or tiered partial exits via ENV.
 * Tiered when GRAD_TP2 is set (non-empty).
 */
export function readExitConfig(env = process.env) {
  const tiered = env.GRAD_TP2 != null && String(env.GRAD_TP2).trim() !== "";
  const floorProtect =
    tiered && (env.GRAD_TP1_FLOOR_PROTECT === "0" ? false : env.GRAD_TP1_FLOOR_PROTECT === "1" || tiered);
  return {
    tiered,
    floorProtect,
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

/**
 * Pure tiered exit decision (one step). Returns action or null.
 * `pnlMult` = observed RPC price / entry (first observed fill at leg — no fake 1.2x).
 */
export function decideTieredExit(pos, pnlMult, elapsedSec, cfg) {
  if (pos.remainingFraction <= EPS) return null;

  if (!pos.tp1Done) {
    if (pnlMult >= cfg.tp1) return { action: "tp1", fraction: cfg.tp1Fraction, exitType: "tp1", pnlMult };
    if (pnlMult <= cfg.stopLoss) return { action: "close", fraction: pos.remainingFraction, exitType: "stop_loss", pnlMult };
    if (elapsedSec >= cfg.timeoutSec) return { action: "close", fraction: pos.remainingFraction, exitType: "timeout", pnlMult };
    return null;
  }

  if (pnlMult >= cfg.tp2) {
    return { action: "close", fraction: pos.remainingFraction, exitType: "tp2", pnlMult };
  }
  if (cfg.floorProtect && pnlMult < cfg.tp1) {
    return { action: "close", fraction: pos.remainingFraction, exitType: "tp1_floor", pnlMult };
  }
  if (elapsedSec >= cfg.timeoutSec) {
    return { action: "close", fraction: pos.remainingFraction, exitType: "timeout", pnlMult };
  }
  return null;
}

export function classifyTrade(legs) {
  const types = new Set(legs.map((l) => l.exitType));
  if (types.has("tp2")) return "tp1_then_tp2";
  if (types.has("tp1") && types.has("tp1_floor")) return "tp1_then_floor_protect";
  if (types.has("tp1") && (types.has("stop_loss") || types.has("timeout"))) return "tp1_then_sl_or_timeout";
  if (types.has("stop_loss") && !types.has("tp1")) return "sl_before_tp1";
  if (types.has("timeout") && !types.has("tp1")) return "timeout_before_tp1";
  if (types.has("take_profit")) return "legacy_tp";
  return "other";
}

export const EPS = 1e-9;
