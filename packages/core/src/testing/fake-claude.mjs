#!/usr/bin/env node
// Fake `claude` for offline, zero-spend tests. Behaviour comes from FAKE_CLAUDE_MODE:
// success | failure | failure-429text | budget | ratelimit | ratelimit-structured | ratelimit-event | noresult |
// noresult-ratelimit | hang | hang-stubborn | hang-success (prints a successful result, then hangs) | hang-report (on SIGTERM prints an error result carrying a cost). Output shape follows `--output-format` (json or stream-json).
// FAKE_CLAUDE_LOG, when set, receives one JSON line with this process's argv, environment and cwd (and the cwd's
// `.claude/skills` entries). FAKE_CLAUDE_STARTED, when set, is written to once the process is running and its SIGTERM handler is installed (hang modes).
// FAKE_CLAUDE_TERMED, when set, is written to when hang-stubborn receives (and ignores) SIGTERM.
import { appendFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";

const argv = process.argv.slice(2);
if (process.env.FAKE_CLAUDE_LOG) {
  const skills = existsSync(".claude/skills") ? readdirSync(".claude/skills") : [];
  appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ argv, env: process.env, cwd: process.cwd(), skills, pid: process.pid }) + "\n");
}
// Like the real CLI, sessions belong to the working directory: `--resume <id>` only works from the directory the session
// was started in. A run (not a resume) records its session under ./.fake-sessions; resuming an unknown one fails.
const resumeId = argv.includes("--resume") ? argv[argv.indexOf("--resume") + 1] : undefined;
if (resumeId && !existsSync(`.fake-sessions/${resumeId}`)) {
  console.error(`No conversation found with session ID: ${resumeId}`);
  process.exit(1);
}
mkdirSync(".fake-sessions", { recursive: true });
writeFileSync(".fake-sessions/fake-session-1", "");
const format = argv[argv.indexOf("--output-format") + 1] ?? "text";
const mode = process.env.FAKE_CLAUDE_MODE ?? "success";
// Field names and values follow real `claude -p` output (checked against a recorded haiku run): `api_error_status` is
// null unless an HTTP error caused the result, and `--output-format json` prints this one object.
const base = {
  type: "result",
  stop_reason: "end_turn",
  session_id: "fake-session-1",
  total_cost_usd: 0.0123,
  duration_ms: 5,
  is_error: false,
  num_turns: 1,
  terminal_reason: "completed",
  permission_denials: [],
  api_error_status: null,
  uuid: "00000000-0000-4000-8000-000000000001",
};
const FAKE_SPEC = "# Fake Spec\n\nA fake Spec.\n\n## Goal\n\nA visitor can do a thing.\n\n## Scope\n\n- One feature.\n\n## Acceptance criteria\n\n- [ ] It works.\n";
const results = {
  success: { ...base, subtype: "success", is_error: false, result: process.env.FAKE_CLAUDE_RESULT ?? FAKE_SPEC },
  failure: { ...base, subtype: "error_during_execution", is_error: true, result: "Something broke", total_cost_usd: 0.004 },
  budget: { ...base, subtype: "error_max_budget_usd", is_error: true, total_cost_usd: 2.01 },
  // Prose that merely mentions 429 and rate limits: must not be classified as throttling.
  "failure-429text": { ...base, subtype: "error_during_execution", is_error: true, result: "Listening on port 8429; rate limit config missing, HTTP 429 handling is in the spec", total_cost_usd: 0.004 },
  "ratelimit-structured": { ...base, subtype: "success", is_error: true, result: "API Error: Request rejected", api_error_status: 429, total_cost_usd: 0 },
  "ratelimit-event": { ...base, subtype: "error_during_execution", is_error: true, result: "Request rejected", total_cost_usd: 0 },
  ratelimit: { ...base, subtype: "success", is_error: true, result: "Claude AI usage limit reached", total_cost_usd: 0 },
};

if (mode === "hang" || mode === "hang-stubborn" || mode === "hang-report" || mode === "hang-success") {
  // Never finishes. hang-stubborn also ignores SIGTERM, so only SIGKILL stops it.
  if (mode === "hang-stubborn") {
    process.on("SIGTERM", () => {
      if (process.env.FAKE_CLAUDE_TERMED) writeFileSync(process.env.FAKE_CLAUDE_TERMED, String(process.pid));
    });
  }
  if (mode === "hang-report") {
    process.on("SIGTERM", () => {
      console.log(JSON.stringify({ ...base, subtype: "error_during_execution", is_error: true, result: "Interrupted", total_cost_usd: 0.004 }));
      process.exit(1);
    });
  }
  const hang = () => {
    if (process.env.FAKE_CLAUDE_STARTED) writeFileSync(process.env.FAKE_CLAUDE_STARTED, String(process.pid));
    setInterval(() => {}, 1000);
  };
  // hang-success prints a successful result, then never exits; the marker appears only once the result is flushed.
  if (mode === "hang-success") process.stdout.write(JSON.stringify(results.success) + "\n", hang);
  else hang();
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
  console.log(
    JSON.stringify({
      type: "system",
      subtype: "init",
      cwd: process.cwd(),
      session_id: result.session_id,
      tools: [],
      mcp_servers: [],
      skills: [],
      slash_commands: [],
      model: argv[argv.indexOf("--model") + 1] ?? "unknown",
      permissionMode: "default",
    }),
  );
  // Real statuses seen: "allowed" on a healthy run, "rejected" when the plan limit is hit.
  const status = mode === "ratelimit-event" ? "rejected" : "allowed";
  console.log(
    JSON.stringify({
      type: "rate_limit_event",
      rate_limit_info: { status, resetsAt: 1793839200, rateLimitType: "five_hour", isUsingOverage: false },
      session_id: result.session_id,
    }),
  );
  console.log(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "working" }] } }));
  console.log(JSON.stringify(result));
} else {
  console.log(JSON.stringify(result));
}
process.exit(mode === "success" ? 0 : 1);
}
