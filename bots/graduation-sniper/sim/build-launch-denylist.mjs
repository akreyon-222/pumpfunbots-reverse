#!/usr/bin/env node
/**
 * Build creator denylist from launch-observe CSV.
 * Rule: n>=3 mints AND >=3 real dump10 (SNAP_60 buys>0 AND creator sell <=10s) AND dump rate >=50%.
 */
import fs from "node:fs";
import path from "node:path";

const csvPath = process.argv[2] || "/opt/cursor/artifacts/launch-observe-60m-launch-observe-1.csv";
const outPath =
  process.argv[3] ||
  path.resolve("bots/graduation-sniper/config/launch-creator-denylist.json");

const lines = fs.readFileSync(csvPath, "utf8").trim().split("\n").slice(1);
function parse(l) {
  const p = [];
  let c = "";
  for (const ch of l) {
    if (ch === ",") {
      p.push(c);
      c = "";
    } else c += ch;
  }
  p.push(c);
  return {
    kind: p[1],
    mint: p[2],
    creator: p[3],
    buys: Number(p[8]),
    cSell: p[10] === "" ? null : Number(p[10]),
    extra: p[11] || "",
  };
}

const rows = lines.map(parse);
const creates = rows.filter((r) => r.kind === "CREATE");
const s60 = rows.filter((r) => r.kind === "SNAP_60");

const byC = new Map();
for (const r of creates) {
  if (!byC.has(r.creator)) byC.set(r.creator, { n: 0, dump: 0, mints: [] });
  byC.get(r.creator).n++;
  byC.get(r.creator).mints.push(r.mint);
}

for (const r of s60) {
  if (r.buys < 1) continue;
  const dump = r.cSell != null && r.cSell <= 10;
  if (!dump) continue;
  const st = byC.get(r.creator);
  if (st) st.dump++;
}

const picked = [];
for (const [creator, st] of byC) {
  const rate = st.n ? st.dump / st.n : 0;
  if (st.n >= 3 && st.dump >= 3 && rate >= 0.5) {
    picked.push({ creator, n: st.n, dump10: st.dump, rate: Number(rate.toFixed(3)) });
  }
}
picked.sort((a, b) => b.dump10 - a.dump10 || b.n - a.n);

const payload = {
  sourceCsv: csvPath,
  rule: "n>=3 AND dump10>=3 AND dumpRate>=0.5 (SNAP_60 buys>0, creator sell<=10s)",
  generatedAtUtcPlus3: new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString().replace("Z", "+03:00"),
  creators: picked.map((p) => p.creator),
  detail: picked,
};

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(payload, null, 2));
console.log(`wrote ${picked.length} creators → ${outPath}`);
