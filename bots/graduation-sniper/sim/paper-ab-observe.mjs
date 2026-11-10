#!/usr/bin/env node
/**
 * 30m (default) paper A/B: same entries, tiered vs simple exits in one WS feed.
 * GRAD_AB_COMPARE=1 on graduation.mjs --dry-run
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dir, "../../..");
const DURATION_SEC = Number(process.env.PAPER_OBSERVE_SEC || 1800);
const ARTIFACT_DIR = process.env.ARTIFACT_DIR || "/opt/cursor/artifacts";
const GIT_SHA = (() => {
  try {
    return execSync("git rev-parse HEAD", { cwd: ROOT, encoding: "utf8" }).trim();
  } catch {
    return process.env.GIT_SHA || "unknown";
  }
})();

const runIndex = Number(process.env.PAPER_AB_RUN || 0);
const stamp =
  process.env.PAPER_AB_STAMP ||
  (runIndex >= 1
    ? `30m-ab-tiered-vs-tp1.4-run${String(runIndex).padStart(2, "0")}`
    : "30m-ab-tiered-vs-tp1.4");
const logPath = path.join(ARTIFACT_DIR, `graduation-paper-observe-${stamp}.log`);
const csvPath = path.join(ARTIFACT_DIR, `graduation-session-${stamp}.csv`);
const metaPath = path.join(ARTIFACT_DIR, `graduation-paper-meta-${stamp}.json`);

fs.mkdirSync(ARTIFACT_DIR, { recursive: true });

const meta = {
  mode: "PAPER_AB_COMPARE",
  batchRunIndex: runIndex >= 1 ? runIndex : 1,
  batchId: process.env.PAPER_AB_BATCH_ID || "ab-tiered-vs-tp14-batch1",
  durationSec: DURATION_SEC,
  commit: GIT_SHA,
  strategies: {
    tiered: { GRAD_TP1: 1.2, GRAD_TP1_FRACTION: 0.5, GRAD_TP2: 1.6, GRAD_STOP_LOSS: 0.7, GRAD_TP1_FLOOR_PROTECT: 0 },
    simple: { GRAD_TAKE_PROFIT: 1.4, GRAD_STOP_LOSS: 0.75 },
  },
  shared: {
    SIMULATION_ONLY: 1,
    fillMin: Number(process.env.GRAD_MIN_FILL_PCT || 92),
    hardMaxFillPct: process.env.GRAD_HARD_MAX_FILL_PCT || null,
    coldStartAllow: process.env.GRAD_COLD_START_ALLOW !== "0",
    creatorFilter: process.env.GRAD_CREATOR_FILTER === "1",
    timeout: 300,
    positionSol: 0.1,
    maxPositions: 3,
  },
  startedAtUtcPlus3: new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString().replace("Z", "+03:00"),
  artifacts: { log: logPath, csv: csvPath, meta: metaPath },
};
fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));

const out = fs.createWriteStream(logPath, { flags: "w" });
out.write(`--- AB compare session commit=${GIT_SHA} duration=${DURATION_SEC}s ---\n`);

const child = spawn(process.execPath, ["bots/graduation-sniper/graduation.mjs", "--dry-run"], {
  cwd: ROOT,
  env: {
    ...process.env,
    SIMULATION_ONLY: "1",
    GRAD_AB_COMPARE: "1",
    GRAD_FILTERS: process.env.GRAD_FILTERS ?? "1",
    GRAD_ANALYTICS_CSV: csvPath,
    GIT_SHA,
  },
  stdio: ["ignore", "pipe", "pipe"],
});

child.stdout.pipe(out, { end: false });
child.stderr.pipe(out, { end: false });
child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);

const timer = setTimeout(() => child.kill("SIGINT"), DURATION_SEC * 1000);

child.on("exit", (code, signal) => {
  clearTimeout(timer);
  meta.endedAtUtcPlus3 = new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString().replace("Z", "+03:00");
  meta.exitCode = code;
  meta.signal = signal;
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
  out.end();
  process.exit(0);
});
