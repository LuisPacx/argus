import { decideHook, refusalText } from "./fetch-guard.ts";

// The PreToolUse hook the Brain installs on WebFetch for every task that has it (human researcher ticket 12). The CLI writes the tool call on stdin; exit 0
// lets the fetch run, exit 2 blocks it and shows stderr to the model. Only an explicit allow exits 0: every other end (a throw, an unreadable call) is 2.
// Logic and its tests are in fetch-guard.ts.
let input = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) input += chunk;
try {
  const verdict = await decideHook(input);
  if (verdict.allow) process.exit(0);
  process.stderr.write(`${refusalText(verdict.reason)}\n`);
} catch {
  process.stderr.write(`${refusalText("the guard could not judge the address")}\n`);
}
process.exit(2);
