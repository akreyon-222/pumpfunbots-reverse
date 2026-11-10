#!/usr/bin/env node
import "../../lib/sim-guard.mjs";
// Graduation Sniper: покупает токены перед graduation (миграцией с bonding curve на PumpSwap AMM)
//
// Стратегия: мониторит bonding curve reserves из V3 trade events.
// Когда virtual_sol_reserves приближается к порогу graduation (~85 SOL),
// покупает токен. После graduation цена обычно растёт из-за:
// - Ликвидность на PumpSwap AMM
// - Листинг на Jupiter (больше видимость)
// - FOMO от статуса "graduated"
// - Fee distribution для холдеров
//
// Использование: node bots/graduation-sniper/graduation.mjs [--dry-run]
//
// Конфиг через ENV или .env:
//   GRAD_BUY_SOL=0.1              — сумма покупки
//   GRAD_MIN_FILL_PCT=92          — минимальный % заполнения для покупки
//   GRAD_TAKE_PROFIT=1.5          — продать при 1.5x (legacy single TP)
//   GRAD_TP2=1.6                  — tiered: enable partial exits + TP2
//   GRAD_TP1=1.2 / GRAD_TP1_FRACTION=0.5 — tiered first take
//   GRAD_STOP_LOSS=0.7            — стоп-лосс при 0.7x
//   GRAD_TIMEOUT_SEC=300          — таймаут позиции (5 мин)
//   GRAD_MAX_POSITIONS=3          — макс. позиций
//   GRAD_COOLDOWN_SEC=30          — пауза между покупками
//   GRAD_FILTERS=1                — watchlist momentum / re-entry filters (see entry-filters.mjs)
//   GRAD_ANALYTICS_CSV=...        — session CSV (default in --dry-run)

import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { SLIPPAGE_BPS } from "../../lib/config.mjs";
import {
  PUMP_PROGRAM,
  TOKEN_2022_PROGRAM,
  TRADE_EVENT_PREFIX,
  BUY_INSTRUCTIONS,
  SELL_INSTRUCTIONS,
  CREATE_INSTRUCTIONS,
} from "../../lib/constants.mjs";
import {
  buyIx,
  calcBuyTokens,
  calcSellSol,
  getBondingCurveState,
  getPrice,
  sellIx,
} from "../../lib/pumpfun.mjs";
import { connection, sendTxWithRetry } from "../../lib/rpc.mjs";
import { buildVersionedTx, computeBudgetIxs, jitoTipIx } from "../../lib/tx.mjs";
import { loadKeypair } from "../../lib/wallet.mjs";
import { SolanaWs } from "../../lib/ws.mjs";
import {
  parseV3TradeEvent,
  getFillPct,
  VIRTUAL_SOL_AT_GRADUATION,
} from "./v3-parse.mjs";
import { SIMULATION_ONLY, logUtcPlus3 } from "../../lib/sim-guard.mjs";
import { readFilterConfig, evaluateEntry } from "./entry-filters.mjs";
import { SessionAnalytics } from "./session-analytics.mjs";
import {
  readExitConfig,
  createPosition,
  legPnlSol,
  classifyTrade,
  decideTieredExit,
  decidePullbackFloorExit,
  decideLegacyExit,
  EPS,
} from "./exit-strategy.mjs";

const BUY_SOL = Number(process.env.GRAD_BUY_SOL || 0.1);
const MIN_FILL_PCT = Number(process.env.GRAD_MIN_FILL_PCT || 92);
const AB_COMPARE = process.env.GRAD_AB_COMPARE === "1";
const exitCfg = AB_COMPARE ? null : readExitConfig();
const abCfgTiered = AB_COMPARE
  ? readExitConfig({
      ...process.env,
      GRAD_TP2: "1.6",
      GRAD_TP1: "1.2",
      GRAD_TP1_FRACTION: "0.5",
      GRAD_STOP_LOSS: "0.7",
      GRAD_TP1_FLOOR_PROTECT: "0",
    })
  : null;
const abCfgSimple = AB_COMPARE
  ? readExitConfig({
      ...process.env,
      GRAD_TP2: "",
      GRAD_FLOOR_ARM: "",
      GRAD_TAKE_PROFIT: "1.4",
      GRAD_STOP_LOSS: "0.75",
    })
  : null;
const TAKE_PROFIT = AB_COMPARE ? abCfgSimple.takeProfit : exitCfg.takeProfit;
const STOP_LOSS = AB_COMPARE ? abCfgTiered.stopLoss : exitCfg.stopLoss;
const TIMEOUT_SEC = AB_COMPARE ? abCfgTiered.timeoutSec : exitCfg.timeoutSec;
const MAX_POSITIONS = Number(process.env.GRAD_MAX_POSITIONS || 3);
const COOLDOWN_SEC = Number(process.env.GRAD_COOLDOWN_SEC || 30);
const POLL_MS = 3000;
const DRY_RUN = process.argv.includes("--dry-run");
const filterCfg = readFilterConfig();
const analyticsCsv =
  process.env.GRAD_ANALYTICS_CSV ||
  (DRY_RUN ? "/opt/cursor/artifacts/graduation-session.csv" : "");
const analytics = analyticsCsv ? new SessionAnalytics(analyticsCsv) : null;

const wallet = loadKeypair();
const positions = new Map();
const watchlist = new Map();
const mintStats = new Map();
let lastBuyTime = 0;

function statsFor(mint) {
  if (!mintStats.has(mint)) mintStats.set(mint, { buys: 0, lastSlAt: 0 });
  return mintStats.get(mint);
}

function pushWatchSample(mint, fillPct, virtualSolReserves) {
  const now = Date.now();
  const vSol = Number(virtualSolReserves) / 1e9;
  let row = watchlist.get(mint);
  if (!row) {
    row = { fillPct, vSol, ts: now, history: [] };
    watchlist.set(mint, row);
  }
  row.fillPct = fillPct;
  row.vSol = vSol;
  row.ts = now;
  row.history.push({ fillPct, vSol, ts: now });
  if (row.history.length > 40) row.history.shift();
}
let totalPnl = 0;
let totalTrades = 0;
let wins = 0;
const abStats = AB_COMPARE
  ? {
      tiered: { pnl: 0, trades: 0, wins: 0 },
      simple: { pnl: 0, trades: 0, wins: 0 },
    }
  : null;

function createShadowPos(entry, cfg) {
  const pos = createPosition(entry, cfg);
  if (!cfg.tiered && !cfg.pullbackFloor) {
    return { ...pos, remainingFraction: 1, tradePnlSol: 0, legs: [] };
  }
  return pos;
}

function log(msg) {
  const tag = SIMULATION_ONLY ? "PAPER" : "LIVE";
  logUtcPlus3(tag, msg);
}

async function buyToken(mint, fillPct, virtualSolReserves, virtualTokenReserves, velocity = null) {
  if (positions.size >= MAX_POSITIONS) return;
  if (positions.has(mint)) return;
  if (Date.now() - lastBuyTime < COOLDOWN_SEC * 1000) return;

  const mintPk = new PublicKey(mint);
  const entryPrice = Number(virtualSolReserves) / Number(virtualTokenReserves);

  log(`*** PRE-GRADUATION BUY ***`);
  log(`  mint: ${mint}`);
  log(
    `  fill: ${fillPct.toFixed(1)}% | vel=${velocity !== null ? `${velocity.toFixed(3)}%/s` : "n/a"} | price: ${entryPrice.toFixed(12)} SOL/token`,
  );
  log(`  buying ${BUY_SOL} SOL`);

  const st = statsFor(mint);
  st.buys++;

  if (DRY_RUN) {
    const entry = {
      entryPrice,
      entryTime: Date.now(),
      fillAtEntry: fillPct,
      velocityAtEntry: velocity,
    };
    if (AB_COMPARE) {
      positions.set(mint, {
        ...entry,
        shadows: {
          tiered: createShadowPos(entry, abCfgTiered),
          simple: createShadowPos(entry, abCfgSimple),
        },
        closed: { tiered: false, simple: false },
      });
      analytics?.recordBuy(mint, fillPct, velocity, entryPrice, "ab_pair");
      log(`  [DRY RUN] AB shadow positions (tiered + simple)`);
    } else {
      positions.set(mint, createPosition(entry, exitCfg));
      analytics?.recordBuy(mint, fillPct, velocity, entryPrice);
      log(`  [DRY RUN] position tracked`);
    }
    lastBuyTime = Date.now();
    return;
  }

  try {
    const state = await getBondingCurveState(mintPk);
    if (!state || state.complete) {
      log(`  bonding curve already complete or unavailable`);
      return;
    }

    const expectedTokens = calcBuyTokens(state, BUY_SOL);
    const minTokens = (expectedTokens * BigInt(10000 - SLIPPAGE_BPS)) / 10000n;

    const ixs = [
      ...computeBudgetIxs(),
      buyIx(wallet.publicKey, mintPk, BUY_SOL, minTokens),
      jitoTipIx(wallet.publicKey),
    ];
    const tx = await buildVersionedTx(wallet, ixs);
    await sendTxWithRetry(tx, { skipPreflight: true });
    positions.set(
      mint,
      createPosition(
        {
          entryPrice,
          entryTime: Date.now(),
          fillAtEntry: fillPct,
          velocityAtEntry: velocity,
        },
        exitCfg,
      ),
    );
    analytics?.recordBuy(mint, fillPct, velocity, entryPrice);
    lastBuyTime = Date.now();
    log(`  bought!`);
  } catch (err) {
    log(`  buy failed: ${err.message}`);
  }
}

function holdSec(pos) {
  return ((Date.now() - pos.entryTime) / 1000).toFixed(1);
}

async function paperSellLeg(mint, pos, fraction, pnlMult, exitType) {
  const pnlPct = ((pnlMult - 1) * 100).toFixed(1);
  const pnlSol = legPnlSol(BUY_SOL, fraction, pnlMult);
  pos.tradePnlSol += pnlSol;
  pos.remainingFraction -= fraction;
  pos.legs.push({ exitType, pnl: pnlSol, fraction, pnlMult });
  totalPnl += pnlSol;
  analytics?.recordSell(
    mint,
    pos.fillAtEntry,
    pos.velocityAtEntry,
    pnlPct,
    exitType,
    holdSec(pos),
    `fraction=${fraction};pnl_sol=${pnlSol.toFixed(6)}`,
  );
  log(
    `  [DRY RUN] leg ${exitType}: ${fraction * 100}% @ ${pnlMult.toFixed(3)}x ` +
      `(${pnlSol >= 0 ? "+" : ""}${pnlSol.toFixed(4)} SOL)`,
  );
}

function closePaperTrade(mint, pos) {
  const tradeWin = pos.tradePnlSol > EPS;
  totalTrades++;
  if (tradeWin) wins++;
  const tradeClass = classifyTrade(pos.legs);
  analytics?.recordTradeClose(mint, pos.fillAtEntry, pos.tradePnlSol, tradeClass);
  if (
    pos.legs?.some((l) =>
      ["stop_loss", "tp1_floor", "floor_pullback"].includes(l.exitType),
    )
  ) {
    statsFor(mint).lastSlAt = Date.now();
  }
  log(
    `  [DRY RUN] trade closed: ${tradeClass} total=${pos.tradePnlSol >= 0 ? "+" : ""}${pos.tradePnlSol.toFixed(4)} SOL ` +
      `(${tradeWin ? "W" : "L"})`,
  );
  log(`  session: ${wins}W/${totalTrades - wins}L, PnL: ${totalPnl >= 0 ? "+" : ""}${totalPnl.toFixed(4)} SOL`);
  positions.delete(mint);
}

function shadowOpen(shadowPos) {
  return (shadowPos.remainingFraction ?? 1) > EPS;
}

async function paperSellLegAb(mint, parent, shadowPos, label, fraction, pnlMult, exitType, cfg) {
  const pnlPct = ((pnlMult - 1) * 100).toFixed(1);
  const pnlSol = legPnlSol(BUY_SOL, fraction, pnlMult);
  shadowPos.tradePnlSol += pnlSol;
  shadowPos.remainingFraction -= fraction;
  shadowPos.legs.push({ exitType, pnl: pnlSol, fraction, pnlMult });
  const st = abStats[label];
  st.pnl += pnlSol;
  totalPnl += pnlSol;
  analytics?.recordSell(
    mint,
    parent.fillAtEntry,
    parent.velocityAtEntry,
    pnlPct,
    exitType,
    holdSec(parent),
    `fraction=${fraction};pnl_sol=${pnlSol.toFixed(6)}`,
    label,
  );
  log(
    `  [AB/${label}] leg ${exitType}: ${fraction * 100}% @ ${pnlMult.toFixed(3)}x ` +
      `(${pnlSol >= 0 ? "+" : ""}${pnlSol.toFixed(4)} SOL)`,
  );
}

function closeShadowPaperTrade(mint, parent, label, shadowPos) {
  const tradeWin = shadowPos.tradePnlSol > EPS;
  const st = abStats[label];
  st.trades++;
  if (tradeWin) st.wins++;
  const tradeClass = classifyTrade(shadowPos.legs);
  analytics?.recordTradeClose(mint, parent.fillAtEntry, shadowPos.tradePnlSol, tradeClass, label);
  if (
    shadowPos.legs?.some((l) =>
      ["stop_loss", "tp1_floor", "floor_pullback"].includes(l.exitType),
    )
  ) {
    statsFor(mint).lastSlAt = Date.now();
  }
  log(
    `  [AB/${label}] closed ${tradeClass} total=${shadowPos.tradePnlSol >= 0 ? "+" : ""}${shadowPos.tradePnlSol.toFixed(4)} SOL (${tradeWin ? "W" : "L"})`,
  );
  log(
    `  [AB] session tiered: ${abStats.tiered.wins}W/${abStats.tiered.trades - abStats.tiered.wins}L PnL=${abStats.tiered.pnl >= 0 ? "+" : ""}${abStats.tiered.pnl.toFixed(4)} | ` +
      `simple: ${abStats.simple.wins}W/${abStats.simple.trades - abStats.simple.wins}L PnL=${abStats.simple.pnl >= 0 ? "+" : ""}${abStats.simple.pnl.toFixed(4)}`,
  );
  parent.closed[label] = true;
  if (label === "tiered") {
    parent._tieredClosePnl = shadowPos.tradePnlSol;
    parent._tieredClass = tradeClass;
  } else {
    parent._simpleClosePnl = shadowPos.tradePnlSol;
    parent._simpleClass = tradeClass;
  }
  if (parent.closed.tiered && parent.closed.simple) {
    analytics?.recordAbPair(
      mint,
      parent.fillAtEntry,
      parent._tieredClosePnl,
      parent._simpleClosePnl,
      parent._tieredClass,
      parent._simpleClass,
    );
    const delta = parent._simpleClosePnl - parent._tieredClosePnl;
    log(
      `  [AB PAIR] ${mint.slice(0, 12)} tiered=${parent._tieredClosePnl >= 0 ? "+" : ""}${parent._tieredClosePnl.toFixed(4)} ` +
        `simple=${parent._simpleClosePnl >= 0 ? "+" : ""}${parent._simpleClosePnl.toFixed(4)} ` +
        `Δ(simple−tiered)=${delta >= 0 ? "+" : ""}${delta.toFixed(4)} SOL`,
    );
    positions.delete(mint);
  }
}

async function applyShadowExit(mint, parent, label, shadowPos, cfg, pnlMult, elapsed) {
  if (!shadowOpen(shadowPos)) return;

  if (cfg.tiered) {
    const decision = decideTieredExit(shadowPos, pnlMult, elapsed, cfg);
    if (!decision) return;
    if (decision.action === "tp1") {
      log(`  [AB/${label}] ${mint.slice(0, 12)}: TP1 ${cfg.tp1}x — sell ${(decision.fraction * 100).toFixed(0)}%`);
      await paperSellLegAb(mint, parent, shadowPos, label, decision.fraction, decision.pnlMult, "tp1", cfg);
      shadowPos.tp1Done = true;
      return;
    }
    await paperSellLegAb(mint, parent, shadowPos, label, decision.fraction, decision.pnlMult, decision.exitType, cfg);
    if (decision.action === "close") closeShadowPaperTrade(mint, parent, label, shadowPos);
    return;
  }

  if (cfg.pullbackFloor) {
    const decision = decidePullbackFloorExit(shadowPos, pnlMult, elapsed, cfg);
    if (!decision) return;
    if (decision.action === "arm_only") {
      if (!shadowPos.sawAboveArm) shadowPos.sawAboveArm = true;
      return;
    }
    await paperSellLegAb(mint, parent, shadowPos, label, decision.fraction, decision.pnlMult, decision.exitType, cfg);
    closeShadowPaperTrade(mint, parent, label, shadowPos);
    return;
  }

  const decision = decideLegacyExit(shadowPos, pnlMult, elapsed, cfg);
  if (!decision) return;
  log(`  [AB/${label}] ${mint.slice(0, 12)}: ${decision.exitType} @ ${pnlMult.toFixed(3)}x`);
  await paperSellLegAb(mint, parent, shadowPos, label, decision.fraction, decision.pnlMult, decision.exitType, cfg);
  closeShadowPaperTrade(mint, parent, label, shadowPos);
}

async function checkExit(mint) {
  const pos = positions.get(mint);
  if (!pos) return;

  const mintPk = new PublicKey(mint);
  const entryPrice = pos.entryPrice;
  const elapsed = (Date.now() - pos.entryTime) / 1000;

  try {
    const state = await getBondingCurveState(mintPk);
    if (!state) {
      log(`  ${mint.slice(0, 12)}: bonding curve gone (graduated?), holding for AMM`);
      return;
    }

    if (state.complete) {
      log(`  ${mint.slice(0, 12)}: *** GRADUATED! *** holding for price pump`);
      return;
    }

    const currentPrice = getPrice(state);
    const pnlMult = currentPrice / entryPrice;
    pos.lastPnlMult = pnlMult;
    pos.lastObservedAt = Date.now();

    if (AB_COMPARE && pos.shadows) {
      if (!DRY_RUN) return;
      await applyShadowExit(mint, pos, "tiered", pos.shadows.tiered, abCfgTiered, pnlMult, elapsed);
      await applyShadowExit(mint, pos, "simple", pos.shadows.simple, abCfgSimple, pnlMult, elapsed);
      return;
    }

    if (exitCfg.tiered) {
      if (!DRY_RUN) return;
      const decision = decideTieredExit(pos, pnlMult, elapsed, {
        ...exitCfg,
        stopLoss: STOP_LOSS,
        timeoutSec: TIMEOUT_SEC,
      });
      if (!decision) return;
      if (decision.action === "tp1") {
        log(`  ${mint.slice(0, 12)}: TP1 ${exitCfg.tp1}x — sell ${(decision.fraction * 100).toFixed(0)}%`);
        await paperSellLeg(mint, pos, decision.fraction, decision.pnlMult, "tp1");
        pos.tp1Done = true;
        return;
      }
      if (decision.exitType === "tp1_floor") {
        log(
          `  ${mint.slice(0, 12)}: floor protect <${exitCfg.tp1}x — sell rest @ ${decision.pnlMult.toFixed(3)}x`,
        );
      } else if (decision.exitType === "tp2") {
        log(`  ${mint.slice(0, 12)}: TP2 ${exitCfg.tp2}x — sell rest`);
      } else if (decision.exitType === "stop_loss") {
        log(`  ${mint.slice(0, 12)}: SL ${STOP_LOSS}x${pos.tp1Done ? " on remainder" : ""}`);
      } else if (decision.exitType === "timeout") {
        log(
          `  ${mint.slice(0, 12)}: timeout ${elapsed.toFixed(0)}s, mult=${decision.pnlMult.toFixed(3)}x`,
        );
      }
      await paperSellLeg(mint, pos, decision.fraction, decision.pnlMult, decision.exitType);
      if (decision.action === "close") closePaperTrade(mint, pos);
      return;
    }

    if (exitCfg.pullbackFloor) {
      if (!DRY_RUN) return;
      const decision = decidePullbackFloorExit(pos, pnlMult, elapsed, {
        ...exitCfg,
        stopLoss: STOP_LOSS,
        timeoutSec: TIMEOUT_SEC,
      });
      if (!decision) return;
      if (decision.action === "arm_only") {
        if (!pos.sawAboveArm) {
          pos.sawAboveArm = true;
          log(`  ${mint.slice(0, 12)}: floor arm >${exitCfg.floorArmLevel}x (pullback exit<=${exitCfg.floorExitLevel}x)`);
        }
        return;
      }
      const labels = {
        take_profit: `TP ${TAKE_PROFIT}x full`,
        floor_pullback: `floor pullback @ ${decision.pnlMult.toFixed(3)}x`,
        stop_loss: `SL ${STOP_LOSS}x`,
        timeout: `timeout ${elapsed.toFixed(0)}s`,
      };
      log(`  ${mint.slice(0, 12)}: ${labels[decision.exitType] || decision.exitType}`);
      await paperSellLeg(mint, pos, decision.fraction, decision.pnlMult, decision.exitType);
      closePaperTrade(mint, pos);
      return;
    }

    if (pnlMult >= TAKE_PROFIT) {
      log(`  ${mint.slice(0, 12)}: TP hit ${((pnlMult - 1) * 100).toFixed(1)}%`);
      await sellPosition(mint, mintPk, pos, pnlMult, "take_profit");
    } else if (pnlMult <= STOP_LOSS) {
      log(`  ${mint.slice(0, 12)}: SL hit ${((pnlMult - 1) * 100).toFixed(1)}%`);
      await sellPosition(mint, mintPk, pos, pnlMult, "stop_loss");
    } else if (elapsed >= TIMEOUT_SEC) {
      log(`  ${mint.slice(0, 12)}: timeout ${elapsed.toFixed(0)}s, pnl=${((pnlMult - 1) * 100).toFixed(1)}%`);
      await sellPosition(mint, mintPk, pos, pnlMult, "timeout");
    }
  } catch {}
}

async function sellPosition(mint, mintPk, pos, pnlMult, exitType = "unknown") {
  const pnlPct = ((pnlMult - 1) * 100).toFixed(1);
  const pnlSol = BUY_SOL * (pnlMult - 1);
  const hold = holdSec(pos);

  if (DRY_RUN) {
    totalTrades++;
    totalPnl += pnlSol;
    if (pnlSol > EPS) wins++;
    if (pnlMult <= STOP_LOSS) statsFor(mint).lastSlAt = Date.now();
    analytics?.recordSell(
      mint,
      pos.fillAtEntry,
      pos.velocityAtEntry,
      pnlPct,
      exitType,
      hold,
    );
    analytics?.recordTradeClose(mint, pos.fillAtEntry, pnlSol, exitType);
    log(`  [DRY RUN] sold: ${pnlMult >= 1 ? "+" : ""}${pnlPct}% (${pnlSol >= 0 ? "+" : ""}${pnlSol.toFixed(4)} SOL)`);
    log(`  session: ${wins}W/${totalTrades - wins}L, PnL: ${totalPnl >= 0 ? "+" : ""}${totalPnl.toFixed(4)} SOL`);
    positions.delete(mint);
    return;
  }

  try {
    const ata = getAssociatedTokenAddressSync(mintPk, wallet.publicKey, false, TOKEN_2022_PROGRAM);
    const info = await connection.getTokenAccountBalance(ata);
    const total = BigInt(info.value.amount);
    if (total === 0n) { positions.delete(mint); return; }

    const state = await getBondingCurveState(mintPk);
    if (!state || state.complete) {
      log(`  cannot sell on bonding curve (graduated), need PumpSwap sell`);
      positions.delete(mint);
      return;
    }

    const expectedSol = calcSellSol(state, total);
    const minSol = (expectedSol * BigInt(10000 - SLIPPAGE_BPS)) / 10000n;

    const ixs = [
      ...computeBudgetIxs(),
      sellIx(wallet.publicKey, mintPk, total, minSol),
      jitoTipIx(wallet.publicKey),
    ];
    const tx = await buildVersionedTx(wallet, ixs);
    await sendTxWithRetry(tx, { skipPreflight: true });

    totalTrades++;
    totalPnl += pnlSol;
    if (pnlMult > 1) wins++;
    log(`  sold: ${pnlMult >= 1 ? "+" : ""}${pnlPct}% (${pnlSol >= 0 ? "+" : ""}${pnlSol.toFixed(4)} SOL)`);
    log(`  session: ${wins}W/${totalTrades - wins}L, PnL: ${totalPnl >= 0 ? "+" : ""}${totalPnl.toFixed(4)} SOL`);
    positions.delete(mint);
  } catch (err) {
    log(`  sell failed: ${err.message}`);
  }
}

// Position monitoring loop
async function monitorPositions() {
  for (const [mint] of positions) {
    await checkExit(mint);
  }
}
setInterval(monitorPositions, POLL_MS);

// Main
log("=== GRADUATION SNIPER ===");
log(`commit=${process.env.GIT_SHA || "local"} source=${process.env.RPC_URL || "https://api.mainnet-beta.solana.com"}`);
log(`Wallet: ${wallet.publicKey.toBase58()}${SIMULATION_ONLY ? " (ephemeral dummy, unfunded)" : ""}`);
if (AB_COMPARE) {
  log("MODE: AB compare — shared entries, twin paper exits");
  log(
    `  A/tiered: TP1=${abCfgTiered.tp1}x@${(abCfgTiered.tp1Fraction * 100).toFixed(0)}% TP2=${abCfgTiered.tp2}x SL=${abCfgTiered.stopLoss}x pre-TP1 floor=off`,
  );
  log(`  B/simple: TP=${abCfgSimple.takeProfit}x SL=${abCfgSimple.stopLoss}x full exit`);
  log(`  buy=${BUY_SOL} SOL, fill>=${MIN_FILL_PCT}%, timeout=${TIMEOUT_SEC}s`);
} else if (exitCfg.tiered) {
  log(
    `Config: buy=${BUY_SOL} SOL, fill>=${MIN_FILL_PCT}%, ` +
      `TP1=${exitCfg.tp1}x@${(exitCfg.tp1Fraction * 100).toFixed(0)}% TP2=${exitCfg.tp2}x rest, ` +
      `afterTP1 floor<${exitCfg.tp1}x${exitCfg.floorProtect ? " on" : " off"}, ` +
      `SL=${STOP_LOSS}x pre-TP1, timeout=${TIMEOUT_SEC}s`,
  );
} else if (exitCfg.pullbackFloor) {
  log(
    `Config: buy=${BUY_SOL} SOL, fill>=${MIN_FILL_PCT}%, ` +
      `TP=${TAKE_PROFIT}x full, arm>${exitCfg.floorArmLevel}x pullback<=${exitCfg.floorExitLevel}x, ` +
      `SL=${STOP_LOSS}x if never armed, timeout=${TIMEOUT_SEC}s`,
  );
} else {
  log(`Config: buy=${BUY_SOL} SOL, fill>=${MIN_FILL_PCT}%, TP=${TAKE_PROFIT}x, SL=${STOP_LOSS}x, timeout=${TIMEOUT_SEC}s`);
}
log(`Max positions: ${MAX_POSITIONS}, cooldown: ${COOLDOWN_SEC}s`);
if (filterCfg.enabled) {
  log(
    `Filters: maxFill=${filterCfg.maxFillPct}% minVel=${filterCfg.minFillVelocityPctPerSec}%/s ` +
      `highFill>=${filterCfg.highFillPct}% needVel=${filterCfg.highFillMinVelocity} maxBuys/mint=${filterCfg.maxBuysPerMint}`,
  );
} else log("Filters: off (GRAD_FILTERS=0)");
if (analyticsCsv) log(`Analytics CSV: ${analyticsCsv}`);
if (DRY_RUN) log("MODE: DRY RUN (no real transactions)");

const ws = new SolanaWs();
await ws.connect();

ws.subscribeLogs(PUMP_PROGRAM.toBase58(), (result) => {
  const { value } = result;
  if (!value?.logs) return;

  const lastLog = value.logs[value.logs.length - 1] || "";
  if (!lastLog.includes("success")) return;

  let isBuy = false;
  for (const l of value.logs) {
    const m = l.match(/Instruction: (\w+)/);
    if (m && BUY_INSTRUCTIONS.has(m[1])) { isBuy = true; break; }
  }
  if (!isBuy) return;

  for (const l of value.logs) {
    if (!l.startsWith("Program data: ")) continue;
    const data = Buffer.from(l.slice(14), "base64");
    if (data.length < 129 || !data.subarray(0, 8).equals(TRADE_EVENT_PREFIX)) continue;

    try {
      const ev = parseV3TradeEvent(data);
      if (!ev) continue;

      const fillPct = getFillPct(ev.virtualSolReserves);

      if (fillPct >= MIN_FILL_PCT && fillPct < 100) {
        const prev = watchlist.get(ev.mint);
        const isNewHigh = !prev || fillPct > prev.fillPct;
        pushWatchSample(ev.mint, fillPct, ev.virtualSolReserves);
        if (isNewHigh) {
          log(`WATCHLIST: ${ev.mint.slice(0, 12)} fill=${fillPct.toFixed(1)}% vSol=${(Number(ev.virtualSolReserves) / 1e9).toFixed(2)}`);
        }

        if (!positions.has(ev.mint)) {
          const row = watchlist.get(ev.mint);
          const decision = evaluateEntry(
            {
              mint: ev.mint,
              fillPct,
              history: row.history,
              mintStats: statsFor(ev.mint),
            },
            filterCfg,
          );
          if (!decision.allow) {
            if (isNewHigh) {
              log(`SKIP ${ev.mint.slice(0, 12)}: ${decision.reasons.join("; ")}`);
            }
            analytics?.recordSkip(ev.mint, fillPct, decision.velocity, decision.reasons);
          } else {
            buyToken(
              ev.mint,
              fillPct,
              ev.virtualSolReserves,
              ev.virtualTokenReserves,
              decision.velocity,
            );
          }
        }
      }
    } catch {}
    break;
  }
});

log("\nListening for near-graduation tokens...\n");

// Cleanup old watchlist entries every minute
setInterval(() => {
  const now = Date.now();
  for (const [mint, info] of watchlist) {
    if (now - info.ts > 600_000) watchlist.delete(mint);
  }
}, 60_000);

process.on("SIGINT", () => {
  log("\nStopping.");
  if (AB_COMPARE && abStats) {
    log(`  AB pairs closed: tiered ${abStats.tiered.trades} | simple ${abStats.simple.trades}`);
    log(
      `  Tiered: ${abStats.tiered.wins}W/${abStats.tiered.trades - abStats.tiered.wins}L PnL=${abStats.tiered.pnl >= 0 ? "+" : ""}${abStats.tiered.pnl.toFixed(4)} SOL`,
    );
    log(
      `  Simple: ${abStats.simple.wins}W/${abStats.simple.trades - abStats.simple.wins}L PnL=${abStats.simple.pnl >= 0 ? "+" : ""}${abStats.simple.pnl.toFixed(4)} SOL`,
    );
    log(`  Combined leg PnL (tiered+simple stacks): ${totalPnl >= 0 ? "+" : ""}${totalPnl.toFixed(4)} SOL — not one wallet; use per-strategy lines above`);
  } else {
    log(`  Session: ${totalTrades} trades, ${wins}W/${totalTrades - wins}L`);
    log(`  PnL: ${totalPnl >= 0 ? "+" : ""}${totalPnl.toFixed(4)} SOL`);
  }
  if (analytics) {
    for (const { reason, count } of analytics.summary().topSkips) {
      log(`  skip: ${count}× ${reason}`);
    }
  }
  log(`  Watchlist: ${watchlist.size} tokens tracked`);
  log(`  Open positions: ${positions.size}`);
  for (const [mint, pos] of positions) {
    const mult = pos.lastPnlMult != null ? ` last_mult=${pos.lastPnlMult.toFixed(3)}x` : "";
    log(`    ${mint.slice(0, 12)} fill@entry=${pos.fillAtEntry.toFixed(1)}%${mult}`);
  }
  ws.close();
  process.exit(0);
});
