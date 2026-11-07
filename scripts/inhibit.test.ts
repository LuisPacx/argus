import { describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs script, no types
import { MISSING_WARNING, countLocks, lockStatusLine, onPath, wrapCommand } from "./inhibit.mjs";

const LIST = [
  "WHO            UID  USER PID  COMM            WHAT                     WHY                 MODE",
  "NetworkManager 0    root 900  NetworkManager  sleep                    NetworkManager need to turn off network block",
  "argus          1000 u    4242 systemd-inhibit sleep:handle-lid-switch  argus worker is running block",
  "",
  "2 inhibitors listed.",
].join("\n");

describe("inhibit", () => {
  it("wraps the command in systemd-inhibit with what, who and why", () => {
    const w = wrapCommand("pnpm", ["--filter", "x", "start"], "argus is running", true);
    expect(w.command).toBe("systemd-inhibit");
    expect(w.args).toEqual([
      "--what=handle-lid-switch:sleep",
      "--who=argus",
      "--why=argus is running",
      "--mode=block",
      "pnpm",
      "--filter",
      "x",
      "start",
    ]);
    expect(w.warning).toBeNull();
  });

  it("runs unwrapped with one warning when systemd-inhibit is missing", () => {
    const w = wrapCommand("pnpm", ["start"], "why", false);
    expect(w).toEqual({ command: "pnpm", args: ["start"], warning: MISSING_WARNING });
    expect(MISSING_WARNING).toMatch(/not found/);
    expect(MISSING_WARNING).not.toContain("\n");
  });

  it("finds the binary on PATH only when executable", () => {
    const ok = (f: string) => f === "/b/systemd-inhibit";
    expect(onPath("systemd-inhibit", "/a:/b", ok)).toBe(true);
    expect(onPath("systemd-inhibit", "/a:/c", ok)).toBe(false);
    expect(onPath("systemd-inhibit", "", ok)).toBe(false);
  });

  it("counts only argus locks and reports status", () => {
    expect(countLocks(LIST)).toBe(1);
    expect(lockStatusLine(true, LIST)).toBe("sleep lock: held (1 argus lock, handle-lid-switch:sleep)");
    expect(lockStatusLine(true, "No inhibitors.\n")).toBe("sleep lock: not held");
    expect(lockStatusLine(true, null)).toMatch(/unknown/);
    expect(lockStatusLine(false, null)).toMatch(/unavailable/);
  });
});
