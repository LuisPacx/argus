/**
 * The mermaid diagrams of `docs/architecture.md` that are generated, not drawn: the system overview from the pipeline graph
 * (`pipeline-graph.ts`) and the Proposal lifecycle from `TRANSITIONS` (`lifecycle.ts`). `pnpm docs:graph` rewrites them; the docs check
 * (`pipeline-docs.test.ts`) fails while they are stale. The Build Runner sequence diagram is a call sequence, below the level of
 * this graph, and stays hand-written.
 */
// pipeline-graph.ts first: entering the package through lifecycle.ts trips the lifecycle <-> datastore <-> study/store import cycle.
import { formatRuleValue, PIPELINE, type PipelineGraph, type PipelineNode, type PipelineRule } from "./pipeline-graph.ts";
import { PROPOSAL_STATUSES, TRANSITIONS, type Transition } from "./lifecycle.ts";

/** A label inside a mermaid quoted string: quotes become entities and a line break is `<br/>`. */
const q = (text: string): string => text.replaceAll('"', "#quot;");
const idOf = (nodeId: string): string => nodeId.toUpperCase().replaceAll("-", "_");
const ruleText = (r: PipelineRule): string => {
  const shown = formatRuleValue(r.ref(), r.unit);
  return r.liveFrom === "rubric" ? `${r.label} (default ${shown})` : `${r.label}: ${shown}`;
};

function nodeText(n: PipelineNode): string {
  const lines = [n.label];
  if (n.sources && n.sources.length > 0) {
    const market = n.sources.filter((s) => s.status === "on").map((s) => s.label);
    const context = n.sources.filter((s) => s.status === "context-only").map((s) => s.label);
    if (market.length > 0) lines.push(`market: ${market.join(", ")}`);
    if (context.length > 0) lines.push(`context only: ${context.join(", ")}`);
  }
  if (n.diagramNote) lines.push(n.diagramNote);
  for (const r of n.rules) if (r.diagram) lines.push(ruleText(r));
  if (n.status === "off") lines.push("(off)");
  return lines.map(q).join("<br/>");
}

/** The system overview as a mermaid flowchart (no fence). */
export function renderOverview(graph: PipelineGraph = PIPELINE): string {
  const out = ["flowchart TD"];
  for (const n of graph.nodes) {
    const text = nodeText(n);
    const id = idOf(n.id);
    out.push(n.shape === "store" ? `  ${id}[("${text}")]` : n.shape === "actor" ? `  ${id}{{"${text}"}}` : `  ${id}["${text}"]`);
  }
  out.push("");
  for (const e of graph.edges) {
    const gates = (e.gates ?? []).map(ruleText);
    const label = q([e.label, ...gates].join("<br/>"));
    out.push(`  ${idOf(e.from)} ${e.dashed ? "-.->" : "-->"}|"${label}"| ${idOf(e.to)}`);
  }
  return out.join("\n");
}

/** The Proposal lifecycle as a mermaid state diagram (no fence), drawn from the transition table. */
export function renderLifecycle(transitions: readonly Transition[] = TRANSITIONS): string {
  const alias = (s: string): string => s.replaceAll("-", "_");
  const out = ["stateDiagram-v2"];
  for (const s of PROPOSAL_STATUSES) if (s.includes("-")) out.push(`  state "${s}" as ${alias(s)}`);
  out.push("", "  [*] --> new");
  for (const t of transitions) out.push(`  ${alias(t.from)} --> ${alias(t.to)} : ${t.reason} (${t.actor})`);
  out.push("  dismissed --> [*]", "  closed --> [*]");
  return out.join("\n");
}

const BLOCKS = [
  { name: "pipeline-overview", render: (graph: PipelineGraph) => renderOverview(graph) },
  { name: "pipeline-lifecycle", render: (_graph: PipelineGraph, transitions: readonly Transition[]) => renderLifecycle(transitions) },
] as const;

const startMarker = (name: string) => `<!-- generated:${name} -->`;
const endMarker = (name: string) => `<!-- /generated:${name} -->`;

function block(name: string, body: string): string {
  return [
    startMarker(name),
    "<!-- Generated from packages/core/src/pipeline-graph.ts and lifecycle.ts by `pnpm docs:graph`. Do not edit by hand. -->",
    "",
    "```mermaid",
    body,
    "```",
    "",
    endMarker(name),
  ].join("\n");
}

/**
 * `markdown` with every generated block rewritten from the graph and the transition table. Throws when a marker pair is missing, so a
 * moved or deleted marker is an error and not a silently stale diagram.
 */
export function renderGeneratedDocs(markdown: string, graph: PipelineGraph = PIPELINE, transitions: readonly Transition[] = TRANSITIONS): string {
  let doc = markdown;
  for (const b of BLOCKS) {
    const start = doc.indexOf(startMarker(b.name));
    const end = doc.indexOf(endMarker(b.name));
    if (start === -1 || end === -1 || end < start) throw new Error(`docs/architecture.md has no "${startMarker(b.name)}" ... "${endMarker(b.name)}" pair`);
    doc = doc.slice(0, start) + block(b.name, b.render(graph, transitions)) + doc.slice(end + endMarker(b.name).length);
  }
  return doc;
}
