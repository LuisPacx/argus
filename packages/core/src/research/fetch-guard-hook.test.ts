import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { ClaudeCodeBrain } from "../brain.ts";
import { fetchGuardSettings } from "./fetch-guard.ts";

// Human researcher ticket 12 (b): the real hook command a research run is started with, run through a shell exactly as the CLI runs it, with the tool call on
// stdin. No model call, no network: a localhost address is refused before any lookup, and a public address literal needs none.
const args = new ClaudeCodeBrain({ dryRun: true }).buildArgs("researcher", { prompt: "p" });
const settings = JSON.parse(args[args.indexOf("--settings") + 1]!) as { hooks: { PreToolUse: { hooks: { command: string }[] }[] } };
const command = settings.hooks.PreToolUse[0]!.hooks[0]!.command;
const run = (cmd: string, stdin: string) => spawnSync("bash", ["-c", cmd], { input: stdin, encoding: "utf8", timeout: 20_000 });
const call = (url: string) => JSON.stringify({ tool_name: "WebFetch", tool_input: { url } });

describe("the WebFetch guard hook, as the CLI runs it", () => {
  it.each(["http://localhost:3100/api/picks", "http://127.0.0.1/", "http://2130706433/", "http://[::1]:3100/", "http://[::ffff:127.0.0.1]/", "http://169.254.169.254/latest/meta-data/", "http://10.0.0.1/", "http://192.168.0.1/"])("blocks %s with exit 2 and a reason for the model", (url) => {
    const r = run(command, call(url));
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("Argus refused this fetch");
  });

  it("lets a public address through with exit 0", () => {
    expect(run(command, call("https://93.184.216.34/")).status).toBe(0);
    expect(run(command, call("http://1572395042/")).status).toBe(0);
  });

  it("blocks a call it cannot read", () => {
    expect(run(command, "").status).toBe(2);
    expect(run(command, "{not json").status).toBe(2);
  });

  it("blocks when the guard cannot start at all", () => {
    const broken = JSON.parse(fetchGuardSettings("/nonexistent/node", "/nonexistent/hook.ts")) as typeof settings;
    expect(run(broken.hooks.PreToolUse[0]!.hooks[0]!.command, call("https://93.184.216.34/")).status).toBe(2);
  });
});
