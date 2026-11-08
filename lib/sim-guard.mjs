/**
 * Fail-closed simulation guard.
 * Active when --dry-run, --simulate, or SIMULATION_ONLY=1.
 * Blocks any path that would sign or submit transactions.
 */
export const SIMULATION_ONLY =
  process.env.SIMULATION_ONLY === "1" ||
  process.argv.includes("--dry-run") ||
  process.argv.includes("--simulate");

export function blockLiveTransaction(operation) {
  if (SIMULATION_ONLY) {
    const err = new Error(`SIMULATION_FAIL_CLOSED: ${operation} blocked (no sign/send)`);
    err.code = "SIMULATION_FAIL_CLOSED";
    throw err;
  }
}

export function logUtcPlus3(prefix, msg) {
  const tr = new Date(Date.now() + 3 * 60 * 60 * 1000)
    .toISOString()
    .replace("Z", "+03:00");
  console.log(`[${tr}] [${prefix}] ${msg}`);
}
