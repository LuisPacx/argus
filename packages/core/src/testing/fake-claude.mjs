#!/usr/bin/env node
// Fake `claude` for offline, zero-spend tests. Behaviour comes from FAKE_CLAUDE_MODE:
// success | failure | budget | ratelimit. Output shape follows `--output-format` (json or stream-json).
// FAKE_CLAUDE_LOG, when set, receives one JSON line with this process's argv and environment.
import { appendFileSync } from "node:fs";

const argv = process.argv.slice(2);
if (process.env.FAKE_CLAUDE_LOG) {
  appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ argv, env: process.env }) + "\n");
}
const format = argv[argv.indexOf("--output-format") + 1] ?? "text";
const mode = process.env.FAKE_CLAUDE_MODE ?? "success";
const base = { type: "result", session_id: "fake-session-1", total_cost_usd: 0.0123, duration_ms: 5 };
const results = {
  success: { ...base, subtype: "success", is_error: false, result: process.env.FAKE_CLAUDE_RESULT ?? "# Spec\n\nA fake Spec.\n" },
  failure: { ...base, subtype: "error_during_execution", is_error: true, result: "Something broke", total_cost_usd: 0.004 },
  budget: { ...base, subtype: "error_max_budget_usd", is_error: true, total_cost_usd: 2.01 },
  ratelimit: { type: "result", subtype: "success", is_error: true, result: "Claude AI usage limit reached", session_id: "fake-session-1", total_cost_usd: 0 },
};
const result = results[mode] ?? results.success;
if (format === "stream-json") {
  console.log(JSON.stringify({ type: "system", subtype: "init", session_id: result.session_id }));
  console.log(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "working" }] } }));
  console.log(JSON.stringify(result));
} else {
  console.log(JSON.stringify(result));
}
process.exit(mode === "success" ? 0 : 1);
