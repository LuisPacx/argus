#!/usr/bin/env node
// Read-only: parse "[worker] tick <ISO>" lines of .data/run/worker.log from T0 and report
// gaps over 10 min, downtime, uptime and End = T0 + 48h + downtime.
// Usage: node scripts/tick-gaps.mjs <T0 ISO> [log path]
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const GAP_MS = 10 * 60 * 1000;
const RUN_MS = 48 * 3600 * 1000;
const TICK = /^\[worker\] tick (\d{4}-\d{2}-\d{2}T[\d:.]+Z)\s*$/;

export function parseTicks(text, t0Ms) {
  const ticks = [];
  for (const line of text.split("\n")) {
    const m = TICK.exec(line);
    if (!m) continue;
    const t = Date.parse(m[1]);
    if (t >= t0Ms) ticks.push(t);
  }
  return ticks;
}

export function analyze(text, t0Iso) {
  const t0 = Date.parse(t0Iso);
  if (Number.isNaN(t0)) throw new Error(`bad T0: ${t0Iso}`);
  const ticks = parseTicks(text, t0);
  if (ticks.length === 0) throw new Error("no ticks at or after T0");
  const gaps = [];
  for (let i = 1; i < ticks.length; i++) {
    const len = ticks[i] - ticks[i - 1];
    if (len > GAP_MS) gaps.push({ start: ticks[i - 1], end: ticks[i], ms: len });
  }
  const last = ticks[ticks.length - 1];
  const wall = last - t0;
  const downtime = gaps.reduce((s, g) => s + g.ms, 0);
  return { t0, last, wall, gaps, downtime, uptime: wall - downtime, end: t0 + RUN_MS + downtime };
}

export function fmtDuration(ms) {
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h}h${String(m).padStart(2, "0")}m${String(s % 60).padStart(2, "0")}s`;
}

const iso = (ms) => new Date(ms).toISOString();
// Fixed -03:00 (America/Sao_Paulo has no DST since 2019).
const local = (ms) => `${new Date(ms - 3 * 3600 * 1000).toISOString().slice(0, 19)}-03:00`;

export function report(r) {
  const lines = [
    `T0: ${iso(r.t0)}`,
    `Last tick: ${iso(r.last)}`,
    `Total wall time: ${fmtDuration(r.wall)}`,
    `Gaps over 10 min: ${r.gaps.length}`,
  ];
  for (const g of r.gaps) {
    lines.push(`  ${iso(g.start)} -> ${iso(g.end)}  ${fmtDuration(g.ms)}`);
  }
  lines.push(
    `Total downtime: ${fmtDuration(r.downtime)}`,
    `Uptime: ${fmtDuration(r.uptime)}`,
    `End (T0 + 48h + downtime): ${iso(r.end)} (${local(r.end)})`,
  );
  return lines.join("\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const t0 = process.argv[2];
  if (!t0) {
    console.error("usage: node scripts/tick-gaps.mjs <T0 ISO> [log path]");
    process.exit(2);
  }
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const path = process.argv[3] ?? join(root, ".data/run/worker.log");
  console.log(report(analyze(readFileSync(path, "utf8"), t0)));
}
