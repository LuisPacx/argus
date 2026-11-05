import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tempDir } from "./temp.ts";
import { ClaudeCodeBrain, resolveRouting, type Routing, type TaskRoute } from "../brain.ts";
import type { BuildRunnerOptions } from "../build-runner.ts";
import { Datastore, type Proposal } from "../datastore.ts";
import { DISCLOSURE_SENTENCE } from "../disclosure.ts";
import { approve } from "../lifecycle.ts";
import { specPathFor } from "../spec-drafting.ts";
import { FAKE_CLAUDE } from "./fake-claude.ts";
import { FAKE_GH, FAKE_WRANGLER } from "./fake-tools.ts";

/** Real `git`, but only ever against throwaway directories and with no user config. */
export function vcs(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.test", "-c", "commit.gpgsign=false", ...args], {
    cwd,
    encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: cwd, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
  }).trim();
}

export const TEMPLATE_PACKAGE = { name: "template", scripts: { check: "pnpm typecheck && pnpm lint", "check:footer": "node scripts/check-footer.ts" }, devDependencies: {} };

/** A local stand-in for argus-build-template: one commit holding the protected paths a Build must not change. */
export function makeTemplate(root: string): string {
  const dir = join(root, "argus-build-template");
  mkdirSync(join(dir, "scripts"), { recursive: true });
  mkdirSync(join(dir, ".claude/skills/implement-spec"), { recursive: true });
  mkdirSync(join(dir, ".github/workflows"), { recursive: true });
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify(TEMPLATE_PACKAGE, null, 2) + "\n");
  writeFileSync(join(dir, "scripts/check-footer.ts"), "// the template's own footer check\n");
  writeFileSync(join(dir, ".claude/settings.json"), '{ "permissions": { "deny": [] } }\n');
  writeFileSync(join(dir, ".claude/skills/implement-spec/SKILL.md"), "# implement-spec\n");
  writeFileSync(join(dir, ".github/workflows/ci.yml"), "name: ci\n");
  writeFileSync(join(dir, "src/index.ts"), "export default {};\n");
  writeFileSync(join(dir, "wrangler.jsonc"), '{\n  // The Build Runner replaces "name" with the project slug before deploying.\n  "name": "argus-build-template",\n  "main": "src/index.ts"\n}\n');
  writeFileSync(join(dir, ".gitignore"), "node_modules/\n.fake-sessions/\n.env\n.env.*\n.dev.vars\n");
  vcs(dir, "init", "--quiet", "-b", "main");
  vcs(dir, "add", "-A");
  vcs(dir, "commit", "--quiet", "-m", "Template");
  return dir;
}

export const SPEC = "# Cat Coin\n\n## Goal\n\nA visitor can adopt a cat.\n\n## Scope\n\n- One page.\n\n## Acceptance criteria\n\n- [ ] It works.\n";

export const PAGE = (body = "") => `<!doctype html><html><body>${body}<footer data-argus-disclosure>${DISCLOSURE_SENTENCE}</footer></body></html>`;

/** A preview that serves a footered `/` and 404 page, unless `pages` says otherwise (path -> [status, type, body]). */
export function fakePreview(pages: Record<string, [number, string, string]> = {}): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    const [status, type, body] = pages[url.pathname] ?? (url.pathname === "/" ? [200, "text/html", PAGE()] : [404, "text/html", PAGE("<h1>Not found</h1>")]);
    return new Response(body, { status, headers: { "content-type": type } });
  }) as typeof fetch;
}

export interface Harness {
  store: Datastore;
  brain: ClaudeCodeBrain;
  options: BuildRunnerOptions;
  root: string;
  buildRoot: string;
  dataDir: string;
  logs: string[];
  /** Names of Workers that already exist in the (fake) Cloudflare account; add to it mid-build to race a deploy. */
  workers: Set<string>;
  /** Requests the runner made to the (fake) Cloudflare API. */
  apiCalls: Array<{ url: string; authorization: string | null }>;
  /** Files the fakes append JSON lines to. */
  claudeLog: string;
  ghLog: string;
  wranglerLog: string;
  remotes: string;
  release: string;
  started: string;
  /** Creates a Proposal and takes it through shortlist, Spec and approval. */
  seedApproved(name: string): Proposal;
  calls(file: string): Array<Record<string, any>>;
  /** The fake wrangler's real deploys: its calls that were not `--dry-run` bundling. */
  deployCalls(): Array<Record<string, any>>;
  repoDir(slug: string): string;
}

export function makeHarness(
  opts: { claudeEnv?: Record<string, string>; ghEnv?: Record<string, string>; wranglerEnv?: Record<string, string>; fetch?: typeof fetch; cloudflareDown?: boolean; workers?: string[]; routing?: Partial<Record<keyof Routing, Partial<TaskRoute>>>; dryRun?: boolean } = {},
): Harness {
  const root = tempDir("argus-build-");
  const buildRoot = join(root, "code");
  const dataDir = join(root, "data");
  mkdirSync(buildRoot, { recursive: true });
  const templateRepo = makeTemplate(root);
  const claudeLog = join(root, "claude.jsonl");
  const ghLog = join(root, "gh.jsonl");
  const wranglerLog = join(root, "wrangler.jsonl");
  const remotes = join(root, "remotes");
  const release = join(root, "release");
  const started = join(root, "started");
  const logs: string[] = [];
  const previewFetch = fakePreview();
  const apiCalls: Array<{ url: string; authorization: string | null }> = [];
  const workers = new Set(opts.workers ?? []);
  const base = { PATH: process.env.PATH, HOME: root };
  const fakeEnv = {
    FAKE_CLAUDE_MODE: "success",
    FAKE_CLAUDE_EFFECT: "commit",
    FAKE_CLAUDE_RESULT: "Built the Spec. pnpm check passed.",
    FAKE_CLAUDE_LOG: claudeLog,
    FAKE_CLAUDE_STARTED: started,
    FAKE_CLAUDE_RELEASE: release,
    FAKE_GH_LOG: ghLog,
    FAKE_GH_REMOTES: remotes,
    FAKE_WRANGLER_LOG: wranglerLog,
  };
  const brain = new ClaudeCodeBrain({
    command: FAKE_CLAUDE,
    routing: resolveRouting(opts.routing),
    dryRun: opts.dryRun,
    log: (l) => logs.push(l),
    env: { ...base, ANTHROPIC_API_KEY: "sk-secret", CLOUDFLARE_API_TOKEN: "cf-secret", ...fakeEnv, ...opts.claudeEnv },
    passEnv: [...Object.keys(fakeEnv), ...Object.keys(opts.claudeEnv ?? {})],
    killGraceMs: 200,
  });
  const store = Datastore.open(":memory:");
  const options: BuildRunnerOptions = {
    buildRoot,
    templateRepo,
    dataDir,
    ghBin: FAKE_GH,
    wranglerBin: FAKE_WRANGLER,
    env: { ...base, ANTHROPIC_API_KEY: "sk-secret", CLOUDFLARE_API_TOKEN: "cf-secret", CLOUDFLARE_ACCOUNT_ID: "acct", ...fakeEnv, ...opts.ghEnv, ...opts.wranglerEnv },
    passEnv: [...Object.keys(fakeEnv), ...Object.keys(opts.ghEnv ?? {}), ...Object.keys(opts.wranglerEnv ?? {})],
    fetch: ((input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.hostname !== "api.cloudflare.com") return (opts.fetch ?? previewFetch)(input, init);
      const m = /^\/client\/v4\/accounts\/([^/]+)\/workers\/scripts\/([^/]+)\/settings$/.exec(url.pathname);
      apiCalls.push({ url: String(url), authorization: new Headers(init?.headers).get("authorization") });
      if (opts.cloudflareDown) return Promise.resolve(new Response("bad gateway", { status: 502 }));
      if (!m) return Promise.resolve(Response.json({ success: false, errors: [{ code: 7003, message: "Could not route" }] }, { status: 404 }));
      const taken = workers.has(m[2]!);
      return Promise.resolve(
        taken
          ? Response.json({ success: true, errors: [], result: {} })
          : Response.json({ success: false, errors: [{ code: 10007, message: "This Worker does not exist on your account." }] }, { status: 404 }),
      );
    }) as typeof fetch,
    previewAttempts: 1,
    previewDelayMs: 0,
    dryRun: opts.dryRun,
    log: (l) => logs.push(l),
  };
  let n = 0;
  return {
    store,
    brain,
    options,
    root,
    buildRoot,
    dataDir,
    logs,
    workers,
    apiCalls,
    claudeLog,
    ghLog,
    wranglerLog,
    remotes,
    release,
    started,
    seedApproved(name) {
      const p = store.createProposal({ narrativeSummary: "n", techOneLiner: "t", whyNow: "w", name, ticker: `T${++n}`, description: "d", evidenceLinks: [] });
      store.transition(p.id, "shortlisted", "operator");
      const path = specPathFor(dataDir, p.id);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, SPEC);
      store.completeSpec(p.id, { path, hash: "h" });
      approve(store, p.id);
      return store.getProposal(p.id)!;
    },
    calls(file) {
      try {
        return readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, any>);
      } catch {
        return [];
      }
    },
    deployCalls() {
      return this.calls(wranglerLog).filter((c) => !c.argv.includes("--dry-run"));
    },
    repoDir: (slug) => join(buildRoot, slug),
  };
}
