/**
 * Optional pre-buy filters from watchlist history (V3 event stream).
 * Tune via ENV; disable all with GRAD_FILTERS=0.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dir = path.dirname(fileURLToPath(import.meta.url));

/** Serial dumpers from AB paper batch (100% SL, n>=3). Not a live blacklist guarantee. */
export const DEFAULT_CREATOR_DENYLIST = [
  "DwmFSKoZnK2zT7upEF9eJL1Gx2ZMpypGGvb7t1dBj1oB",
  "DHvDE4oWxWFbEWyCSZ9BkYbjCmoL5dF71BuVyJqkBeL5",
  "BSmRWzv96QAswJaTqcmJmk5o7UsCeSsdtzDH4DbfMLct",
  "AmjvT9vh3m9VNFkqzUqNsJvxxAaQMq9dHKWB8MPepraL",
];

function parsePubkeySet(raw, extras = []) {
  const fromEnv = String(raw || "")
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return new Set([...extras, ...fromEnv]);
}

export function loadCreatorDenylistFile(filePath) {
  if (!filePath) return [];
  if (!fs.existsSync(filePath)) return [];
  const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
  const list = Array.isArray(raw) ? raw : raw.creators;
  return (list || []).filter((s) => typeof s === "string" && s.length >= 32);
}

export function readFilterConfig(env = process.env) {
  const enabled = env.GRAD_FILTERS !== "0";
  const creatorFilter = env.GRAD_CREATOR_FILTER === "1";
  const defaultFile = path.join(__dir, "config/launch-creator-denylist.json");
  const denyFile = env.GRAD_CREATOR_DENYLIST_FILE || (creatorFilter ? defaultFile : "");
  const seedDeny = creatorFilter
    ? [...DEFAULT_CREATOR_DENYLIST, ...loadCreatorDenylistFile(denyFile)]
    : [];
  return {
    enabled,
    maxFillPct: Number(env.GRAD_MAX_FILL_PCT ?? 98.5),
    hardMaxFillPct: env.GRAD_HARD_MAX_FILL_PCT != null && String(env.GRAD_HARD_MAX_FILL_PCT).trim() !== ""
      ? Number(env.GRAD_HARD_MAX_FILL_PCT)
      : null,
    minFillVelocityPctPerSec: Number(env.GRAD_MIN_FILL_VELOCITY ?? 0.02),
    velocityWindowSec: Number(env.GRAD_VELOCITY_WINDOW_SEC ?? 15),
    requireUptrendSamples: Number(env.GRAD_REQUIRE_UPTREND_SAMPLES ?? 0),
    maxBuysPerMint: Number(env.GRAD_MAX_BUYS_PER_MINT ?? 1),
    mintCooldownAfterSlSec: Number(env.GRAD_MINT_COOLDOWN_AFTER_SL_SEC ?? 600),
    highFillPct: Number(env.GRAD_HIGH_FILL_PCT ?? 98),
    highFillMinVelocity: Number(env.GRAD_HIGH_FILL_MIN_VELOCITY ?? 0.08),
    coldStartAllow: env.GRAD_COLD_START_ALLOW !== "0",
    minSamplesForVelocity: Number(env.GRAD_MIN_SAMPLES_FOR_VELOCITY ?? 2),
    creatorFilter,
    creatorDenylist: parsePubkeySet(env.GRAD_CREATOR_DENYLIST, seedDeny),
    creatorDenylistFile: denyFile || null,
    creatorSessionSlSkip: Number(env.GRAD_CREATOR_SESSION_SL_SKIP ?? 2),
  };
}

function samplesInWindow(history, windowSec, now = Date.now()) {
  const cutoff = now - windowSec * 1000;
  return history.filter((h) => h.ts >= cutoff);
}

/** fill % change per second between oldest and newest sample in window */
export function fillVelocityPctPerSec(history, windowSec, now = Date.now()) {
  const samples = samplesInWindow(history, windowSec, now);
  if (samples.length < 2) return null;
  const first = samples[0];
  const last = samples[samples.length - 1];
  const dt = (last.ts - first.ts) / 1000;
  if (dt < 0.05) return null;
  return (last.fillPct - first.fillPct) / dt;
}

export function hasUptrend(history, n) {
  if (n <= 0 || history.length < n) return true;
  const tail = history.slice(-n);
  for (let i = 1; i < tail.length; i++) {
    if (tail[i].fillPct <= tail[i - 1].fillPct) return false;
  }
  return true;
}

/**
 * @param {object} ctx
 * @param {string} ctx.mint
 * @param {number} ctx.fillPct
 * @param {{ fillPct: number, vSol: number, ts: number }[]} ctx.history
 * @param {{ buys: number, lastSlAt?: number }} ctx.mintStats
 * @param {ReturnType<typeof readFilterConfig>} cfg
 */
export function evaluateEntry(ctx, cfg) {
  const now = ctx.now ?? Date.now();
  if (!cfg.enabled) {
    return {
      allow: true,
      velocity: fillVelocityPctPerSec(ctx.history, cfg.velocityWindowSec, now),
      reasons: [],
    };
  }

  const reasons = [];
  const velocity = fillVelocityPctPerSec(ctx.history, cfg.velocityWindowSec, now);

  if (cfg.hardMaxFillPct != null && ctx.fillPct >= cfg.hardMaxFillPct) {
    reasons.push(`fill>=${cfg.hardMaxFillPct}% hard_max`);
  }

  if (ctx.mintStats.buys >= cfg.maxBuysPerMint) {
    reasons.push(`max_buys_per_mint=${cfg.maxBuysPerMint}`);
  }

  if (ctx.mintStats.lastSlAt && Date.now() - ctx.mintStats.lastSlAt < cfg.mintCooldownAfterSlSec * 1000) {
    reasons.push(`mint_cooldown_after_sl=${cfg.mintCooldownAfterSlSec}s`);
  }

  const windowSamples = samplesInWindow(ctx.history, cfg.velocityWindowSec, now);
  const velocityReady = windowSamples.length >= cfg.minSamplesForVelocity && velocity !== null;

  if (ctx.fillPct > cfg.maxFillPct && velocityReady && velocity < cfg.highFillMinVelocity) {
    reasons.push(`fill>${cfg.maxFillPct}% low momentum vel=${velocity.toFixed(3)}`);
  }

  if (
    ctx.fillPct >= cfg.highFillPct &&
    velocityReady &&
    velocity < cfg.highFillMinVelocity
  ) {
    reasons.push(`high_fill_slow_ramp vel=${velocity.toFixed(3)}<%${cfg.highFillMinVelocity}`);
  }

  if (cfg.minFillVelocityPctPerSec > 0) {
    if (velocityReady && velocity < cfg.minFillVelocityPctPerSec) {
      reasons.push(`fill_velocity=${velocity.toFixed(3)} < ${cfg.minFillVelocityPctPerSec}`);
    } else if (!velocityReady && cfg.coldStartAllow === false) {
      reasons.push("insufficient_watch_history");
    }
  }

  if (cfg.requireUptrendSamples > 0 && !hasUptrend(ctx.history, cfg.requireUptrendSamples)) {
    reasons.push(`uptrend_last_${cfg.requireUptrendSamples}_samples`);
  }

  if (cfg.creatorFilter) {
    const creator = ctx.creator;
    if (!creator) {
      reasons.push("creator_unknown");
    } else if (cfg.creatorDenylist.has(creator)) {
      reasons.push(`creator_denylist=${creator.slice(0, 8)}`);
    } else {
      const cst = ctx.creatorStats;
      const slN = cst?.slTokens ?? 0;
      if (cfg.creatorSessionSlSkip > 0 && slN >= cfg.creatorSessionSlSkip) {
        reasons.push(`creator_session_sl=${slN}>=${cfg.creatorSessionSlSkip}`);
      }
    }
  }

  return { allow: reasons.length === 0, velocity, reasons };
}
