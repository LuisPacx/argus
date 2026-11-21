import { ClaudeCodeBrain } from "../brain.ts";
import { parseResearchTopic, researchPromptFor, type PromptCandidate, type PromptPost } from "./brief.ts";

/**
 * The researcher's dry run (human researcher ticket 05): what one run would send, without a model, the web, X or DexScreener. The topic is cleaned the way
 * the War Room cleans it; the X posts and the coins are fixed samples, so the output shows the shape of the fenced blocks and the exact `claude` argv
 * (the task's tools, model and per-run budget). `pnpm research:dry-run "<topic>"` prints it.
 */
const SAMPLE_CANDIDATES: PromptCandidate[] = [
  { id: "c1", name: "Sample Coin One", symbol: "ONE", marketCapUsd: 1_200_000, liquidityUsd: 85_000, ageMinutes: 600 },
  { id: "c2", name: "Sample Coin Two", symbol: "TWO", marketCapUsd: 48_000, liquidityUsd: 9_000, ageMinutes: 45 },
];
const SAMPLE_POSTS: PromptPost[] = [{ handle: "sample_handle", text: "A sample post about the topic.", likes: 1200, views: 90_000 }];

export function renderResearchDryRun(rawTopic: string): { ok: true; argv: string[]; prompt: string } | { ok: false; problem: string } {
  const topic = parseResearchTopic(rawTopic);
  if (!topic.ok) return { ok: false, problem: topic.problem };
  const prompt = researchPromptFor({ topic: topic.topic, candidates: SAMPLE_CANDIDATES, posts: SAMPLE_POSTS, xNote: "X was read (sample): 2 pages, 1 post found, the 1 most viewed shown" });
  const argv = new ClaudeCodeBrain({ dryRun: true }).buildArgs("researcher", { prompt });
  return { ok: true, argv, prompt };
}
