/**
 * Exit modes:
 * - legacy: single GRAD_TAKE_PROFIT / GRAD_STOP_LOSS (default)
 * - tiered: GRAD_TP2 set
 * - pullbackFloor: GRAD_FLOOR_ARM set, no GRAD_TP2 (arm above 1.1, exit <=1.1 after arm, TP at takeProfit)
 */
export function readExitConfig(env = process.env) {
  const tiered = env.GRAD_TP2 != null && String(env.GRAD_TP2).trim() !== "";
  const floorArmRaw = env.GRAD_FLOOR_ARM;
  const floorArm =
    floorArmRaw != null && String(floorArmRaw).trim() !== "" ? Number(floorArmRaw) : null;
  const pullbackFloor = !tiered && floorArm != null;
  const floorProtect =
    tiered && (env.GRAD_TP1_FLOOR_PROTECT === "0" ? false : env.GRAD_TP1_FLOOR_PROTECT === "1" || tiered);
  return {
    tiered,
    pullbackFloor,
    floorProtect,
    takeProfit: Number(env.GRAD_TAKE_PROFIT || 1.5),
    stopLoss: Number(env.GRAD_STOP_LOSS || 0.7),
    timeoutSec: Number(env.GRAD_TIMEOUT_SEC || 300),
    tp1: Number(env.GRAD_TP1 || 1.2),
    tp1Fraction: Number(env.GRAD_TP1_FRACTION || 0.5),
    tp2: Number(env.GRAD_TP2 || 1.6),
    floorArmLevel: floorArm,
    floorExitLevel: Number(env.GRAD_FLOOR_EXIT ?? floorArm ?? 1.1),
  };
}

export function createPosition({ entryPrice, entryTime, fillAtEntry, velocityAtEntry }, exitCfg) {
  const base = {
    entryPrice,
    entryTime,
    fillAtEntry,
    velocityAtEntry,
    remainingFraction: 1,
    tradePnlSol: 0,
    legs: [],
  };
  if (exitCfg.tiered) {
    return {
      ...base,
      tp1Done: false,
    };
  }
  if (exitCfg.pullbackFloor) {
    return {
      ...base,
      sawAboveArm: false,
    };
  }
  const { remainingFraction, tradePnlSol, legs, ...legacyBase } = base;
  return legacyBase;
}

/** Kağıt PnL (SOL) for `fraction` of nominal BUY_SOL at `pnlMult`. */
export function legPnlSol(buySol, fraction, pnlMult) {
  return buySol * fraction * (pnlMult - 1);
}

export function decideTieredExit(pos, pnlMult, elapsedSec, cfg) {
  if (pos.remainingFraction <= EPS) return null;

  if (!pos.tp1Done) {
    if (pnlMult >= cfg.tp1) return { action: "tp1", fraction: cfg.tp1Fraction, exitType: "tp1", pnlMult };
    if (pnlMult <= cfg.stopLoss) {
      return { action: "close", fraction: pos.remainingFraction, exitType: "stop_loss", pnlMult };
    }
    if (elapsedSec >= cfg.timeoutSec) {
      return { action: "close", fraction: pos.remainingFraction, exitType: "timeout", pnlMult };
    }
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

/**
 * Single full-position exit with armed pullback floor.
 * Arm when pnlMult > floorArmLevel (strict). Exit floor when armed and pnlMult <= floorExitLevel.
 */
/** Legacy single full exit (GRAD_TAKE_PROFIT / GRAD_STOP_LOSS, no tiered/floor). */
export function decideLegacyExit(pos, pnlMult, elapsedSec, cfg) {
  if (pos.remainingFraction != null && pos.remainingFraction <= EPS) return null;
  if (pnlMult >= cfg.takeProfit) {
    return { action: "close", fraction: 1, exitType: "take_profit", pnlMult };
  }
  if (pnlMult <= cfg.stopLoss) {
    return { action: "close", fraction: 1, exitType: "stop_loss", pnlMult };
  }
  if (elapsedSec >= cfg.timeoutSec) {
    return { action: "close", fraction: 1, exitType: "timeout", pnlMult };
  }
  return null;
}

export function decidePullbackFloorExit(pos, pnlMult, elapsedSec, cfg) {
  if (pnlMult >= cfg.takeProfit) {
    return { action: "close", fraction: 1, exitType: "take_profit", pnlMult };
  }
  if (!pos.sawAboveArm && pnlMult > cfg.floorArmLevel) {
    return { action: "arm_only" };
  }
  if (pos.sawAboveArm && pnlMult <= cfg.floorExitLevel && pnlMult < cfg.takeProfit) {
    return { action: "close", fraction: 1, exitType: "floor_pullback", pnlMult };
  }
  if (pnlMult <= cfg.stopLoss) {
    return { action: "close", fraction: 1, exitType: "stop_loss", pnlMult };
  }
  if (elapsedSec >= cfg.timeoutSec) {
    return { action: "close", fraction: 1, exitType: "timeout", pnlMult };
  }
  return null;
}

export function classifyTrade(legs) {
  const types = new Set(legs.map((l) => l.exitType));
  if (types.has("tp2")) return "tp1_then_tp2";
  if (types.has("tp1") && types.has("tp1_floor")) return "tp1_then_floor_protect";
  if (types.has("tp1") && (types.has("stop_loss") || types.has("timeout"))) return "tp1_then_sl_or_timeout";
  if (types.has("floor_pullback")) return "floor_pullback";
  if (types.has("take_profit") && legs.length === 1) return "take_profit_full";
  if (types.has("stop_loss") && !types.has("tp1") && !types.has("floor_pullback")) return "sl_before_tp1";
  if (types.has("timeout") && !types.has("tp1") && !types.has("floor_pullback")) return "timeout_before_tp1";
  if (types.has("take_profit")) return "legacy_tp";
  return "other";
}

export const EPS = 1e-9;
