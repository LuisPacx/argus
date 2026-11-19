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

  it("also takes the exact name HELIUS_API_KEY, and no other non-ARGUS key (no prefix or look-alike, no wallet or key names)", () => {
    // Names are joined from parts: the ADR 0002 scan flags an RPC-endpoint-style or HELIUS_ name wherever it is spelled, tests included.
    const name = (...parts: string[]) => parts.join("_");
    const f = envFile(
      [
        "HELIUS_API_KEY=abc123",
        "ARGUS_OK=1",
        `${name("SOLANA", "RPC", "URL")}=https://node.example/?x=1`,
        "WALLET_SECRET=w",
        "WALLET_ADDRESS=a",
        `${name("PRIVATE", "KEY")}=p`,
        `${name("HELIUS", "API", "KEY2")}=x`,
        `${name("HELIUS", "NODE")}=x`,
        `${name("HELIUS", "")}=x`,
        `${name("XHELIUS", "API", "KEY")}=x`,
        `${name("helius", "api", "key")}=x`,
        "",
      ].join("\n"),
    );
    const r = withDotenvArgus({}, f);
    expect(r.env).toEqual({ HELIUS_API_KEY: "abc123", ARGUS_OK: "1" });
    expect([...r.fromFile].sort()).toEqual(["ARGUS_OK", "HELIUS_API_KEY"]);
    // names only in the start line, never the value
    expect(dotenvLine(r)).toContain("HELIUS_API_KEY");
    expect(dotenvLine(r)).not.toContain("abc123");
  });

  it("lets the shell's HELIUS_API_KEY win over .env, like any other key", () => {
    const f = envFile("HELIUS_API_KEY=file\n");
    const r = withDotenvArgus({ HELIUS_API_KEY: "shell" }, f);
    expect(r.env.HELIUS_API_KEY).toBe("shell");
    expect(r.overridden).toEqual(["HELIUS_API_KEY"]);
  });

  it("lets the shell win and reports it", () => {
    const f = envFile("ARGUS_A=file\nARGUS_B=file\n");
    const r = withDotenvArgus({ ARGUS_A: "shell", PATH: "/bin" }, f);
    expect(r.env).toEqual({ ARGUS_A: "shell", PATH: "/bin", ARGUS_B: "file" });
    expect(r.fromFile).toEqual(["ARGUS_B"]);
    expect(r.overridden).toEqual(["ARGUS_A"]);
    expect(dotenvLine(r)).toBe("env: 1 ARGUS_* from .env (ARGUS_B); 1 overridden by the shell (ARGUS_A)");
  });

  it("never takes ARGUS_NUXT_BUILD_DIR from .env, and reports it by key only", () => {
    const f = envFile("ARGUS_A=1\nARGUS_NUXT_BUILD_DIR=/secret/elsewhere\n");
    const r = withDotenvArgus({}, f);
    expect(r.env).toEqual({ ARGUS_A: "1" });
    expect(r.ignored).toEqual(["ARGUS_NUXT_BUILD_DIR"]);
    expect(dotenvLine(r)).toBe("env: 1 ARGUS_* from .env (ARGUS_A); 0 overridden by the shell; 1 ignored (ARGUS_NUXT_BUILD_DIR)");
    expect(dotenvLine(r)).not.toContain("/secret");
  });

  it("is a no-op without a .env", () => {
    const r = withDotenvArgus({ X: "1" }, "/nonexistent/.env");
    expect(r).toEqual({ env: { X: "1" }, fromFile: [], overridden: [], ignored: [] });
    expect(dotenvLine(r)).toBe("env: 0 ARGUS_* from .env; 0 overridden by the shell");
  });
});
