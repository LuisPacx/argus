#!/usr/bin/env node
// Fake `gh` for offline tests: creates nothing on GitHub. `gh repo create <name> ... --source . --remote origin` makes a bare
// repo under FAKE_GH_REMOTES and adds it as the cwd repo's remote. Every call's argv is appended to FAKE_GH_LOG.
// FAKE_GH_FAIL=1 makes `repo create` fail. `gh repo view <name>` succeeds for a repo that was created (see below).
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { registerFake } from "./run-registry.mjs";

registerFake();

const argv = process.argv.slice(2);
if (process.env.FAKE_GH_LOG) appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify({ argv, cwd: process.cwd(), env: process.env }) + "\n");
if (argv[0] === "repo" && argv[1] === "create") {
  if (process.env.FAKE_GH_FAIL) {
    console.error("GraphQL: Name already exists on this account (createRepository)");
    process.exit(1);
  }
  const remote = join(process.env.FAKE_GH_REMOTES ?? ".", `${argv[2]}.git`);
  mkdirSync(remote, { recursive: true });
  execFileSync("git", ["init", "--bare", "--quiet", remote]);
  execFileSync("git", ["remote", "add", argv[argv.indexOf("--remote") + 1] ?? "origin", remote]);
  console.log(`https://github.com/fake-owner/${argv[2]}`);
  process.exit(0);
}
if (argv[0] === "repo" && argv[1] === "view") {
  // A repo exists when `repo create` made its bare repo under FAKE_GH_REMOTES. FAKE_GH_VIEW_FAIL=1 fails the way a network error does.
  if (process.env.FAKE_GH_VIEW_FAIL) {
    console.error("error connecting to api.github.com");
    process.exit(1);
  }
  if (existsSync(join(process.env.FAKE_GH_REMOTES ?? ".", `${argv[2]}.git`))) {
    console.log(JSON.stringify({ name: argv[2] }));
    process.exit(0);
  }
  console.error(`GraphQL: Could not resolve to a Repository with the name 'fake-owner/${argv[2]}'. (repository)`);
  // FAKE_GH_VIEW_EXIT: the not-found text with another exit code (gh uses 4 for an authentication problem, 2 for a cancel).
  process.exit(Number(process.env.FAKE_GH_VIEW_EXIT ?? 1));
}
if (argv[0] === "api" && argv.includes("-i") && argv.includes("user")) {
  // What GitHub's X-OAuth-Scopes header says of the token. FAKE_GH_SCOPES: the scopes ("repo, read:org" by default), or "none" for a
  // token that has no such header (a fine-grained one). FAKE_GH_API_FAIL=1 fails the call.
  if (process.env.FAKE_GH_API_FAIL) {
    console.error("error connecting to api.github.com");
    process.exit(1);
  }
  const scopes = process.env.FAKE_GH_SCOPES ?? "repo, read:org";
  console.log(`HTTP/2.0 200 OK\nContent-Type: application/json; charset=utf-8${scopes === "none" ? "" : `\nX-Oauth-Scopes: ${scopes}`}\nX-Ratelimit-Limit: 5000\n\n{"login":"fake-owner"}`);
  process.exit(0);
}
console.error(`fake gh: unsupported ${argv.join(" ")}`);
process.exit(2);
