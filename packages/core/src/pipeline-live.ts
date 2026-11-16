/**
 * The "How it works" page's live numbers (warroom-redesign ticket 10, slice b): `Datastore.pipelineLive`'s counts and brain runs placed on
 * the graph's edges and nodes. Pure: the datastore reads, this only maps. `GET /api/pipeline-live` returns it.
 */
import type { PipelineLiveData } from "./datastore.ts";
import type { PipelineGraph } from "./pipeline-graph.ts";

export interface PipelineLiveEdge {
  /** The graph edge's `metric` key. */
  metric: string;
  count: number;
  /** Only on the Narratives to Judge edge: how many of those judged passed the buildability gate. */
  passedGate?: number;
}

/** A node's Claude spend in the window. The two currencies are never added: `spendUsd` is Est. usage, `apiUsd` real API dollars. */
export interface PipelineLiveNode {
  runs: number;
  spendUsd: number;
  apiRuns: number;
  apiUsd: number;
}

export interface PipelineLiveResponse {
  windowHours: 24;
  since: string;
  /** By edge id; an edge with no `metric` has no entry. */
  edges: Record<string, PipelineLiveEdge>;
  /** By node id, for every node that spends on a brain task (zeros when it did not run). Plain-code nodes have no entry. */
  nodes: Record<string, PipelineLiveNode>;
  /** Runs of a task no node owns (an unknown or retired task such as `study`), so nothing is silently dropped. */
  other: PipelineLiveNode & { tasks: string[] };
}

const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;

export function resolvePipelineLive(graph: PipelineGraph, data: PipelineLiveData): PipelineLiveResponse {
  const edges: Record<string, PipelineLiveEdge> = {};
  for (const e of graph.edges) {
    if (e.metric === undefined) continue;
    const count = data.counts[e.metric];
    if (count === undefined) continue; // pipeline-live.test.ts fails on this; the page just shows no number for the edge
    edges[e.id] = { metric: e.metric, count, ...(e.metric === "narratives_judged" ? { passedGate: data.narrativesPassedGate } : {}) };
  }
  const owner = new Map<string, string>();
  const nodes: Record<string, PipelineLiveNode> = {};
  for (const n of graph.nodes) {
    if (n.brainTask === undefined) continue;
    for (const task of [n.brainTask, ...(n.alsoBrainTasks ?? [])]) if (!owner.has(task)) owner.set(task, n.id);
    nodes[n.id] = { runs: 0, spendUsd: 0, apiRuns: 0, apiUsd: 0 };
  }
  const other: PipelineLiveResponse["other"] = { runs: 0, spendUsd: 0, apiRuns: 0, apiUsd: 0, tasks: [] };
  for (const r of data.brainRuns) {
    const target = nodes[owner.get(r.task) ?? ""] ?? other;
    if (target === other) other.tasks.push(r.task);
    target.runs += r.runs;
    target.spendUsd = round6(target.spendUsd + r.estUsd);
    target.apiRuns += r.apiRuns;
    target.apiUsd = round6(target.apiUsd + r.apiUsd);
  }
  other.tasks.sort();
  return { windowHours: 24, since: data.since, edges, nodes, other };
}
