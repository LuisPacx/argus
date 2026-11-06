import { describe, expect, it } from "vitest";
import { runNextBuild } from "./build-runner.ts";
import { Datastore } from "./datastore.ts";
import { TelegramNotifier, announceNewProposals, newProposalText, type Notifier } from "./telegram.ts";
import { makeHarness, type Harness } from "./testing/build-harness.ts";

const recorder = (): Notifier & { sent: string[] } => {
  const sent: string[] = [];
  return { enabled: true, sent, notify: (t) => void sent.push(t) };
};

async function build(h: Harness) {
  const p = h.seedApproved("Cat Coin");
  const outcome = await runNextBuild(h.store, h.brain, h.options);
  return { p, outcome, after: h.store.getProposal(p.id)! };
}

describe("Build notifications", { timeout: 90_000 }, () => {
  it("announces the start and, when built, the preview link", async () => {
    const h = makeHarness();
    const n = recorder();
    h.options.notifier = n;
    const r = await build(h);
    expect(r.outcome?.result).toBe("built");
    expect(r.after.previewUrl).toMatch(/^https:\/\/.*\.workers\.dev/);
    expect(n.sent).toEqual([`Build started: Cat Coin ($${r.after.ticker})`, `Build done: Cat Coin ($${r.after.ticker})\nPreview: ${r.after.previewUrl}`]);
  });

  it("announces a final failure with its reason, and not the first attempt that is retried", async () => {
    const h = makeHarness({ claudeEnv: { FAKE_CLAUDE_MODE: "failure", FAKE_CLAUDE_EFFECT: "" } });
    const n = recorder();
    h.options.notifier = n;
    const r = await build(h);
    expect(r.outcome?.result).toBe("build-failed");
    expect(n.sent).toHaveLength(2);
    expect(n.sent[0]).toMatch(/^Build started/);
    expect(n.sent[1]).toMatch(/^Build failed: Cat Coin .*\nReason: Build failed: claude failed/);
  });

  it("a notifier that throws cannot fail a Build", async () => {
    const h = makeHarness();
    h.options.notifier = {
      enabled: true,
      notify: () => {
        throw new Error("boom");
      },
    };
    const r = await build(h);
    expect(r.outcome?.result).toBe("built");
  });

  it("a Telegram that never answers does not hold the Build up", async () => {
    const h = makeHarness();
    const hung = new TelegramNotifier({ token: "1:abc", chatId: "1", fetch: (() => new Promise(() => {})) as typeof fetch, log: () => {} });
    h.options.notifier = hung;
    try {
      const r = await build(h);
      expect(r.outcome?.result).toBe("built");
    } finally {
      hung.close();
    }
  });
});

describe("new Proposal cards", () => {
  const input = (name: string) => ({
    narrativeSummary: "Cats everywhere",
    techOneLiner: "Adopt a cat",
    whyNow: "Trending today",
    name,
    ticker: "CAT",
    description: "d",
    evidenceLinks: ["https://example.com/a", "https://example.com/b", "https://example.com/c", "https://example.com/d"],
  });

  it("announces each new Proposal once, even across passes", () => {
    const store = Datastore.open(":memory:");
    const n = recorder();
    store.createProposal(input("Moon Cat"));
    expect(announceNewProposals(store, n)).toBe(1);
    expect(announceNewProposals(store, n)).toBe(0);
    store.createProposal(input("Sun Dog"));
    expect(announceNewProposals(store, n)).toBe(1);
    expect(n.sent).toHaveLength(2);
    expect(n.sent[0]).toContain("New Proposal: Moon Cat ($CAT)");
    expect(n.sent[0]).toContain("Narrative: Cats everywhere");
    expect(n.sent[0]).toContain("Evidence: https://example.com/c");
    expect(n.sent[0]).not.toContain("example.com/d"); // three links at most
  });

  it("does nothing, and keeps the Proposals for later, while notifications are off", () => {
    const store = Datastore.open(":memory:");
    store.createProposal(input("Moon Cat"));
    expect(announceNewProposals(store, { enabled: false, notify: () => {} })).toBe(0);
    expect(announceNewProposals(store, recorder())).toBe(1);
  });

  it("keeps untrusted text on one plain line", () => {
    const store = Datastore.open(":memory:");
    const p = store.createProposal(input("Evil\n*[click](http://x)* _<b>"));
    const text = newProposalText(p);
    expect(text.split("\n")[0]).toBe("New Proposal: Evil *[click](http://x)* _<b> ($CAT)");
  });
});
