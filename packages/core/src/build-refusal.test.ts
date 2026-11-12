import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cloudflareRefusal } from "./build-refusal.ts";
import { runNextBuild } from "./build-runner.ts";
import { makeHarness, TEST_TOKEN, type Harness } from "./testing/build-harness.ts";

const SECRET = "sk-ant-oat01-THIS-MUST-NEVER-BE-SHOWN";
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("the preflight answers with a typed refusal", { timeout: 60_000 }, () => {
  const code = async (h: Harness) => (await h.options.sandbox.preflightRefusal())?.code;

  it("podman-missing, image-missing, network-missing", async () => {
    const a = makeHarness();
    a.options.sandbox = a.makeSandbox({ podmanBin: join(a.root, "no-such-podman") });
    expect(await code(a)).toBe("podman-missing");
    const b = makeHarness();
    b.sandboxEnv.FAKE_PODMAN_IMAGES = "";
    expect(await code(b)).toBe("image-missing");
    const c = makeHarness();
    c.sandboxEnv.FAKE_PODMAN_NETWORK = "";
    expect(await code(c)).toBe("network-missing");
  });

  it("the five token cases, each with the message the string preflight gives", async () => {
    const h = makeHarness();
    expect(await h.options.sandbox.preflightRefusal()).toBeUndefined();
    rmSync(h.tokenPath);
    expect(await h.options.sandbox.preflightRefusal()).toEqual({ code: "token-missing", message: expect.stringContaining(`the Build token file ${h.tokenPath} does not exist`) });
    mkdirSync(h.tokenPath);
    expect(await code(h)).toBe("token-not-file");
    rmSync(h.tokenPath, { recursive: true });
    writeFileSync(h.tokenPath, `${TEST_TOKEN}\n`, { mode: 0o644 });
    chmodSync(h.tokenPath, 0o644);
    expect(await code(h)).toBe("token-mode");
    writeFileSync(h.tokenPath, "\n", { mode: 0o600 });
    chmodSync(h.tokenPath, 0o600);
    expect(await code(h)).toBe("token-empty");
    writeFileSync(h.tokenPath, "one\ntwo\n", { mode: 0o600 });
    expect(await code(h)).toBe("token-multiline");
    expect(await h.options.sandbox.preflight()).toContain("holds more than one line");
  });
});

describe("Cloudflare credentials in the Build's environment", () => {
  it("names only the missing variables, never a value", () => {
    expect(cloudflareRefusal({ CLOUDFLARE_ACCOUNT_ID: "a", CLOUDFLARE_API_TOKEN: "t" })).toBeUndefined();
    expect(cloudflareRefusal({ CLOUDFLARE_ACCOUNT_ID: "a", CLOUDFLARE_API_TOKEN: "" })?.message).toBe("CLOUDFLARE_API_TOKEN is not set; the Build needs them to check that the Worker name is free");
    expect(cloudflareRefusal({ CLOUDFLARE_API_TOKEN: "t" })?.message).toMatch(/^CLOUDFLARE_ACCOUNT_ID is not set/);
    expect(cloudflareRefusal({})?.message).toMatch(/^CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are not set/);
    expect(cloudflareRefusal({ CLOUDFLARE_ACCOUNT_ID: "acct-value", CLOUDFLARE_API_TOKEN: "" })?.message).not.toContain("acct-value");
  });
});

describe("runNextBuild stores why a Build was not started", { timeout: 60_000 }, () => {
  it("regression for Proposal 148: missing Cloudflare variables start nothing and are stored by name", async () => {
    for (const drop of [["CLOUDFLARE_ACCOUNT_ID"], ["CLOUDFLARE_API_TOKEN"], ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN"]]) {
      const h = makeHarness();
      for (const name of drop) delete h.options.env![name];
      const p = h.seedApproved("Cat Coin");
      expect(await runNextBuild(h.store, h.brain, h.options)).toBeUndefined();
      const stored = h.store.buildRefusalFor(p.id)!;
      expect(stored.code).toBe("cloudflare-creds-missing");
      for (const name of drop) expect(stored.message).toContain(name);
      expect(stored.message).not.toContain("cf-secret");
      expect(h.store.getProposal(p.id)!.status).toBe("approved");
      expect(h.store.brainRunsFor(p.id)).toEqual([]);
      expect(h.calls(h.ghLog)).toEqual([]);
      expect(h.logs.join("\n")).toContain("not started");
    }
    const ok = makeHarness();
    ok.seedApproved("Cat Coin");
    expect((await runNextBuild(ok.store, ok.brain, ok.options))?.result).toBe("built");
  });

  it("the in-Build check still fails a Build whose environment lost the credentials after the preflight", async () => {
    const h = makeHarness();
    let lost = false;
    const env = h.options.env!;
    const [account, token] = [env.CLOUDFLARE_ACCOUNT_ID, env.CLOUDFLARE_API_TOKEN];
    Object.defineProperty(env, "CLOUDFLARE_ACCOUNT_ID", { get: () => (lost ? undefined : account), enumerable: true });
    Object.defineProperty(env, "CLOUDFLARE_API_TOKEN", { get: () => (lost ? undefined : token), enumerable: true });
    const begin = h.store.beginBuild.bind(h.store);
    h.store.beginBuild = (...a) => {
      lost = true;
      return begin(...a);
    };
    const p = h.seedApproved("Cat Coin");
    expect((await runNextBuild(h.store, h.brain, h.options))?.result).toBe("build-failed");
    expect(h.store.getProposal(p.id)!.status).toBe("build-failed");
    expect(h.store.historyFor(p.id).at(-1)!.reason).toContain("CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are needed");
  });

  it("stores one value: a second identical refusal moves only the time, a different one replaces it", async () => {
    const h = makeHarness();
    h.sandboxEnv.FAKE_PODMAN_IMAGES = "";
    const p = h.seedApproved("Cat Coin");
    await runNextBuild(h.store, h.brain, h.options);
    const first = h.store.buildRefusalFor(p.id)!;
    expect(first.code).toBe("image-missing");
    expect(first.at).toMatch(/^\d{4}-\d\d-\d\dT.*Z$/);
    const historyBefore = h.store.historyFor(p.id).length;
    await wait(5);
    await runNextBuild(h.store, h.brain, h.options);
    const second = h.store.buildRefusalFor(p.id)!;
    expect(second.message).toBe(first.message);
    expect(second.at > first.at).toBe(true);
    expect(h.store.historyFor(p.id)).toHaveLength(historyBefore); // no event rows
    h.sandboxEnv.FAKE_PODMAN_IMAGES = "localhost/argus-build:test-0123456789ab";
    h.sandboxEnv.FAKE_PODMAN_NETWORK = "";
    await runNextBuild(h.store, h.brain, h.options);
    expect(h.store.buildRefusalFor(p.id)!.code).toBe("network-missing");
  });

  it("every approved Proposal shows the refusal, and the Build start clears them all", async () => {
    const h = makeHarness();
    h.sandboxEnv.FAKE_PODMAN_IMAGES = "";
    const a = h.seedApproved("Cat Coin");
    const b = h.seedApproved("Dog Coin");
    await runNextBuild(h.store, h.brain, h.options);
    expect(h.store.buildRefusalFor(a.id)?.code).toBe("image-missing");
    expect(h.store.buildRefusalFor(b.id)?.code).toBe("image-missing");
    h.sandboxEnv.FAKE_PODMAN_IMAGES = "localhost/argus-build:test-0123456789ab";
    expect((await runNextBuild(h.store, h.brain, h.options))?.proposalId).toBe(a.id);
    expect(h.store.buildRefusalFor(a.id)).toBeNull();
    expect(h.store.buildRefusalFor(b.id)).toBeNull();
  });

  it("a Proposal that leaves approved has none, whichever way it leaves", async () => {
    const h = makeHarness();
    h.sandboxEnv.FAKE_PODMAN_IMAGES = "";
    const p = h.seedApproved("Cat Coin");
    await runNextBuild(h.store, h.brain, h.options);
    expect(h.store.buildRefusalFor(p.id)).not.toBeNull();
    h.store.transition(p.id, "needs-human", "build", "x");
    expect(h.store.buildRefusalFor(p.id)).toBeNull();
    const q = h.seedApproved("Dog Coin");
    await runNextBuild(h.store, h.brain, h.options);
    expect(h.store.buildRefusalFor(q.id)).not.toBeNull();
    h.store.transition(q.id, "dismissed", "operator");
    expect(h.store.buildRefusalFor(q.id)).toBeNull();
  });

  it("dry-run is stored as a refusal with code dry-run", async () => {
    const h = makeHarness({ dryRun: true });
    const p = h.seedApproved("Cat Coin");
    await runNextBuild(h.store, h.brain, h.options);
    expect(h.store.buildRefusalFor(p.id)).toMatchObject({ code: "dry-run", message: expect.stringContaining("dry-run") });
    expect(h.store.getProposal(p.id)!.status).toBe("approved");
  });

  it("no token refusal puts the token file's content into the stored value, the payload or the log", async () => {
    const cases: Array<[string, (h: Harness) => void]> = [
      ["token-mode", (h) => { writeFileSync(h.tokenPath, `${SECRET}\n`); chmodSync(h.tokenPath, 0o644); }],
      ["token-multiline", (h) => writeFileSync(h.tokenPath, `${SECRET}\n${SECRET}-2\n`, { mode: 0o600 })],
      ["token-empty", (h) => writeFileSync(h.tokenPath, "  \n", { mode: 0o600 })],
      ["token-missing", (h) => rmSync(h.tokenPath)],
      ["token-not-file", (h) => { rmSync(h.tokenPath); mkdirSync(h.tokenPath); }],
      ["token-unreadable", (h) => { writeFileSync(h.tokenPath, `${SECRET}\n`); chmodSync(h.tokenPath, 0o200); }],
    ];
    for (const [expected, setup] of cases) {
      const h = makeHarness();
      setup(h);
      const p = h.seedApproved("Cat Coin");
      await runNextBuild(h.store, h.brain, h.options);
      const stored = h.store.buildRefusalFor(p.id)!;
      expect(stored.code).toBe(expected);
      expect(JSON.stringify(stored)).not.toContain("THIS-MUST-NEVER");
      expect(h.logs.join("\n")).not.toContain("THIS-MUST-NEVER");
    }
  });
});
