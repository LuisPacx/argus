#!/usr/bin/env node
// Fake `claude` for offline, zero-spend tests. Behaviour comes from FAKE_CLAUDE_MODE:
// success | failure | failure-429text | budget | ratelimit | ratelimit-structured | ratelimit-event | noresult |
// noresult-ratelimit | hang | hang-stubborn. Output shape follows `--output-format` (json or stream-json).
// FAKE_CLAUDE_LOG, when set, receives one JSON line with this process's argv, environment and cwd (and the cwd's
// `.claude/skills` entries). FAKE_CLAUDE_STARTED, when set, is written to once the process is running (hang modes).
import { appendFileSync, existsSync, readdirSync, writeFileSync } from "node:fs";

const argv = process.argv.slice(2);
if (process.env.FAKE_CLAUDE_LOG) {
  const skills = existsSync(".claude/skills") ? readdirSync(".claude/skills") : [];
  appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ argv, env: process.env, cwd: process.cwd(), skills, pid: process.pid }) + "\n");
}
const format = argv[argv.indexOf("--output-format") + 1] ?? "text";
const mode = process.env.FAKE_CLAUDE_MODE ?? "success";
const base = { type: "result", session_id: "fake-session-1", total_cost_usd: 0.0123, duration_ms: 5 };
const results = {
  success: { ...base, subtype: "success", is_error: false, result: process.env.FAKE_CLAUDE_RESULT ?? "# Spec\n\nA fake Spec.\n" },
  failure: { ...base, subtype: "error_during_execution", is_error: true, result: "Something broke", total_cost_usd: 0.004 },
  budget: { ...base, subtype: "error_max_budget_usd", is_error: true, total_cost_usd: 2.01 },
  // Prose that merely mentions 429 and rate limits: must not be classified as throttling.
  "failure-429text": { ...base, subtype: "error_during_execution", is_error: true, result: "Listening on port 8429; rate limit config missing, HTTP 429 handling is in the spec", total_cost_usd: 0.004 },
  "ratelimit-structured": { ...base, subtype: "success", is_error: true, result: "API Error: Request rejected", api_error_status: 429, total_cost_usd: 0 },
  "ratelimit-event": { ...base, subtype: "error_during_execution", is_error: true, result: "Request rejected", total_cost_usd: 0 },
  ratelimit: { type: "result", subtype: "success", is_error: true, result: "Claude AI usage limit reached", session_id: "fake-session-1", total_cost_usd: 0 },
};

if (mode === "hang" || mode === "hang-stubborn") {
  // Never finishes. hang-stubborn also ignores SIGTERM, so only SIGKILL stops it.
  if (mode === "hang-stubborn") process.on("SIGTERM", () => {});
  if (process.env.FAKE_CLAUDE_STARTED) writeFileSync(process.env.FAKE_CLAUDE_STARTED, String(process.pid));
  setInterval(() => {}, 1000);
} else if (mode === "noresult") {
  // Exits without ever printing a result message.
  console.error("fatal: something unrelated to limits, error code 429 in line 429");
  process.exit(1);
} else if (mode === "noresult-ratelimit") {
  console.error("Claude AI usage limit reached|1760000000");
  process.exit(1);
} else {
  emit();
}

function emit() {
const result = results[mode] ?? results.success;
if (format === "stream-json") {
  console.log(JSON.stringify({ type: "system", subtype: "init", session_id: result.session_id }));
  const status = mode === "ratelimit-event" ? "rejected" : "allowed_warning";
  console.log(JSON.stringify({ type: "rate_limit_event", rate_limit_info: { status } }));
  console.log(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "working" }] } }));
  console.log(JSON.stringify(result));
} else {
  console.log(JSON.stringify(result));
}
process.exit(mode === "success" ? 0 : 1);
}
