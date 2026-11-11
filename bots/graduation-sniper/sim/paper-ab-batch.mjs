#!/usr/bin/env node
/**
 * Consecutive AB paper sessions (default runs 2–6). Run 1 uses legacy artifact names if already captured.
 * PAPER_AB_FIRST_RUN=2 PAPER_AB_LAST_RUN=6 node sim/paper-ab-batch.mjs
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dir, "../../..");
const ARTIFACT_DIR = process.env.ARTIFACT_DIR || "/opt/cursor/artifacts";
const FIRST = Number(process.env.PAPER_AB_FIRST_RUN || 2);
const LAST = Number(process.env.PAPER_AB_LAST_RUN || 6);
const BATCH_ID = process.env.PAPER_AB_BATCH_ID || "ab-tiered-vs-tp14-batch1";
const manifestPath = path.join(ARTIFACT_DIR, `graduation-paper-meta-${BATCH_ID}.json`);

const GIT_SHA = (() => {
  try {
    return execSync("git rev-parse HEAD", { cwd: ROOT, encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
})();

function stampForRun(i) {
  const prefix = process.env.PAPER_AB_STAMP_PREFIX;
  if (prefix) return `${prefix}-run${String(i).padStart(2, "0")}`;
  return i === 1 && !fs.existsSync(path.join(ARTIFACT_DIR, "graduation-paper-meta-30m-ab-tiered-vs-tp1.4-run01.json"))
    ? "30m-ab-tiered-vs-tp1.4"
    : `30m-ab-tiered-vs-tp1.4-run${String(i).padStart(2, "0")}`;
}

function loadManifest() {
  if (fs.existsSync(manifestPath)) return JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  return {
    batchId: BATCH_ID,
    commit: GIT_SHA,
    runs: [],
    note: "Run 1 legacy files: graduation-*-30m-ab-tiered-vs-tp1.4.* (no -run01)",
  };
}

function runObserve(runIndex) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["bots/graduation-sniper/sim/paper-ab-observe.mjs"], {
      cwd: ROOT,
      env: {
        ...process.env,
        PAPER_AB_RUN: String(runIndex),
        PAPER_AB_BATCH_ID: BATCH_ID,
        PAPER_OBSERVE_SEC: process.env.PAPER_OBSERVE_SEC || "1800",
      },
      stdio: "inherit",
    });
    child.on("exit", (code) => {
      if (code !== 0) reject(new Error(`run ${runIndex} exit ${code}`));
      else resolve();
    });
  });
}

function parseRunSummary(runIndex) {
  const stamp = stampForRun(runIndex);
  const metaPath = path.join(ARTIFACT_DIR, `graduation-paper-meta-${stamp}.json`);
  const logPath = path.join(ARTIFACT_DIR, `graduation-paper-observe-${stamp}.log`);
  if (!fs.existsSync(metaPath)) return { runIndex, stamp, error: "missing meta" };
  const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
  let tiered = meta.winsLosses?.tiered;
  let simple = meta.winsLosses?.simple;
  if (!tiered && fs.existsSync(logPath)) {
    const tail = fs.readFileSync(logPath, "utf8").split("\n").slice(-30).join("\n");
    const tm = tail.match(/Tiered: (\d+)W\/(\d+)L PnL=([+-]?[\d.]+) SOL/);
    const sm = tail.match(/Simple: (\d+)W\/(\d+)L PnL=([+-]?[\d.]+) SOL/);
    if (tm)
      tiered = { wins: +tm[1], losses: +tm[2], pnlSol: +tm[3] };
    if (sm)
      simple = { wins: +sm[1], losses: +sm[2], pnlSol: +sm[3] };
  }
  return {
    runIndex,
    stamp,
    startedAtUtcPlus3: meta.startedAtUtcPlus3,
    endedAtUtcPlus3: meta.endedAtUtcPlus3,
    tiered,
    simple,
    metaPath,
    logPath,
    csvPath: path.join(ARTIFACT_DIR, `graduation-session-${stamp}.csv`),
  };
}

const manifest = loadManifest();
manifest.commit = GIT_SHA;
manifest.batchStartedAtUtcPlus3 = new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString().replace("Z", "+03:00");
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

// Register run 1 if present
const run1 = parseRunSummary(1);
if (!run1.error) {
  const has1 = manifest.runs.some((r) => r.runIndex === 1);
  if (!has1) manifest.runs.push(run1);
}

for (let i = FIRST; i <= LAST; i++) {
  console.log(`\n=== AB batch run ${i}/${LAST} (${BATCH_ID}) ===\n`);
  await runObserve(i);
  manifest.runs = manifest.runs.filter((r) => r.runIndex !== i);
  manifest.runs.push(parseRunSummary(i));
  manifest.runs.sort((a, b) => a.runIndex - b.runIndex);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
}

manifest.batchEndedAtUtcPlus3 = new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString().replace("Z", "+03:00");
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
console.log(`\nBatch done. Manifest: ${manifestPath}`);
