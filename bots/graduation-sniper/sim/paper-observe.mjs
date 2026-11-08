#!/usr/bin/env node
/**
 * Bounded paper observation wrapper (default 12 min). Logs to artifacts.
 * Spawns graduation.mjs --dry-run with SIMULATION_ONLY=1.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dir, "../../..");
const DURATION_SEC = Number(process.env.PAPER_OBSERVE_SEC || 720);
const ARTIFACT_DIR = process.env.ARTIFACT_DIR || "/opt/cursor/artifacts";
const COMMIT = process.env.GIT_SHA || "unknown";

fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
const logPath = path.join(ARTIFACT_DIR, "graduation-paper-observe.log");
const metaPath = path.join(ARTIFACT_DIR, "graduation-paper-meta.json");

const meta = {
  mode: "PAPER_OBSERVE",
  commit: COMMIT,
  durationSec: DURATION_SEC,
  config: {
    GRAD_BUY_SOL: 0.1,
    GRAD_MIN_FILL_PCT: 92,
    GRAD_TAKE_PROFIT: 1.5,
    GRAD_STOP_LOSS: 0.7,
    GRAD_TIMEOUT_SEC: 300,
    GRAD_MAX_POSITIONS: 3,
    GRAD_COOLDOWN_SEC: 30,
    RPC: process.env.RPC_URL || "https://api.mainnet-beta.solana.com",
  },
  disclaimer: "Paper observation — not profit evidence",
  startedAtUtcPlus3: new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString().replace("Z", "+03:00"),
};
fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));

const out = fs.createWriteStream(logPath, { flags: "a" });
out.write(`\n--- session commit=${COMMIT} duration=${DURATION_SEC}s ---\n`);

const child = spawn(
  process.execPath,
  ["bots/graduation-sniper/graduation.mjs", "--dry-run"],
  {
    cwd: ROOT,
    env: {
      ...process.env,
      SIMULATION_ONLY: "1",
      GIT_SHA: COMMIT,
    },
    stdio: ["ignore", "pipe", "pipe"],
  },
);

child.stdout.pipe(out, { end: false });
child.stderr.pipe(out, { end: false });
child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);

const timer = setTimeout(() => {
  child.kill("SIGINT");
}, DURATION_SEC * 1000);

child.on("exit", (code, signal) => {
  clearTimeout(timer);
  meta.endedAtUtcPlus3 = new Date(Date.now() + 3 * 60 * 60 * 1000)
    .toISOString()
    .replace("Z", "+03:00");
  meta.exitCode = code;
  meta.signal = signal;
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
  out.end();
  process.exit(0);
});
