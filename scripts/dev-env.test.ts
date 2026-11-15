import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs script, no types
import { dotenvLine, withDotenvArgus } from "./dev-env.mjs";

const dirs: string[] = [];
function envFile(text: string): string {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), "dev-env-"));
  dirs.push(dir);
  const file = path.join(dir, ".env");
  fs.writeFileSync(file, text);
  return file;
}
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("withDotenvArgus", () => {
  it("parses comments, blanks, quotes and does no expansion", () => {
    const f = envFile(`# c\n\nARGUS_A=1\nARGUS_B="two words"\nARGUS_C='x'\nARGUS_D=$HOME\n`);
    const r = withDotenvArgus({}, f);
    expect(r.env).toEqual({ ARGUS_A: "1", ARGUS_B: "two words", ARGUS_C: "x", ARGUS_D: "$HOME" });
    expect(r.fromFile).toEqual(["ARGUS_A", "ARGUS_B", "ARGUS_C", "ARGUS_D"]);
  });

  it("takes only ARGUS_[A-Z0-9_]+ keys", () => {
    const f = envFile("ARGUS_OK=1\nTELEGRAM_BOT_TOKEN=s\nANTHROPIC_API_KEY=k\nARGUS_lower=1\nXARGUS_A=1\nARGUS_=1\n");
    const r = withDotenvArgus({}, f);
    expect(r.env).toEqual({ ARGUS_OK: "1" });
  });

  it("lets the shell win and reports it", () => {
    const f = envFile("ARGUS_A=file\nARGUS_B=file\n");
    const r = withDotenvArgus({ ARGUS_A: "shell", PATH: "/bin" }, f);
    expect(r.env).toEqual({ ARGUS_A: "shell", PATH: "/bin", ARGUS_B: "file" });
    expect(r.fromFile).toEqual(["ARGUS_B"]);
    expect(r.overridden).toEqual(["ARGUS_A"]);
    expect(dotenvLine(r)).toBe("env: 1 ARGUS_* from .env (ARGUS_B); 1 overridden by the shell (ARGUS_A)");
  });

  it("is a no-op without a .env", () => {
    const r = withDotenvArgus({ X: "1" }, "/nonexistent/.env");
    expect(r).toEqual({ env: { X: "1" }, fromFile: [], overridden: [] });
    expect(dotenvLine(r)).toBe("env: 0 ARGUS_* from .env; 0 overridden by the shell");
  });
});
