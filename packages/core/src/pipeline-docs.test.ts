import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { renderGeneratedDocs, renderLifecycle, renderOverview } from "./pipeline-diagrams.ts";
import { PIPELINE, type PipelineGraph } from "./pipeline-graph.ts";
import { TRANSITIONS } from "./lifecycle.ts";

const DOC = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "docs", "architecture.md");
const doc = readFileSync(DOC, "utf8");

/** The first line where the committed doc and the regenerated one differ, so a stale diagram says where. */
function firstDifference(a: string, b: string): string {
  const x = a.split("\n");
  const y = b.split("\n");
  const i = x.findIndex((line, n) => line !== y[n]);
  return `line ${i + 1}: committed "${x[i] ?? "(end)"}" but the graph gives "${y[i] ?? "(end)"}"`;
}

describe("docs/architecture.md generated diagrams", () => {
  it("are current: the system overview and the lifecycle match the graph and the transition table (run `pnpm docs:graph` when this fails)", () => {
    const next = renderGeneratedDocs(doc);
    if (next !== doc) throw new Error(`docs/architecture.md is stale, run \`pnpm docs:graph\` (${firstDifference(doc, next)})`);
  });

  it("go stale when the graph changes: a renamed node, a new edge, a changed rule", () => {
    const renamed: PipelineGraph = { ...PIPELINE, nodes: PIPELINE.nodes.map((n) => (n.id === "judge" ? { ...n, label: "Scorer" } : n)) };
    expect(renderGeneratedDocs(doc, renamed)).not.toBe(doc);
    const edged: PipelineGraph = { ...PIPELINE, edges: [...PIPELINE.edges, { id: "x", from: "signals", to: "judge", label: "new path" }] };
    expect(renderGeneratedDocs(doc, edged)).not.toBe(doc);
    const reruled: PipelineGraph = {
      ...PIPELINE,
      nodes: PIPELINE.nodes.map((n) => (n.id === "judge" ? { ...n, rules: n.rules.map((r) => (r.diagram ? { ...r, ref: () => 1_800_001 } : r)) } : n)),
    };
    expect(renderGeneratedDocs(doc, reruled)).not.toBe(doc);
  });

  it("go stale when the transition table changes", () => {
    expect(renderGeneratedDocs(doc, PIPELINE, [...TRANSITIONS, { from: "closed", to: "new", actor: "operator", reason: "Reopened" }])).not.toBe(doc);
    expect(renderGeneratedDocs(doc, PIPELINE, TRANSITIONS.filter((t) => t.reason !== "Score threshold"))).not.toBe(doc);
  });

  it("draw every transition of the table and every status", () => {
    const lifecycle = renderLifecycle();
    for (const t of TRANSITIONS) expect(lifecycle).toContain(`${t.from.replaceAll("-", "_")} --> ${t.to.replaceAll("-", "_")} : ${t.reason} (${t.actor})`);
  });

  it("still show what the hand-drawn overview showed: Telegram, the Launch handoff, the Study and Playbook path, the Operator and the War Room", () => {
    const overview = renderOverview();
    for (const text of ["Telegram, notify only", "Launch handoff: newpairspam form prefilled", "Operator marks launched + mint", "Playbook: lessons and Rubric changes", "War Room: Study page and weekly Playbook review", "War Room (localhost)", "Operator"]) {
      expect(overview, text).toContain(text);
    }
    expect(overview).toContain("STUDY -->|\"lesson candidates\"| PLAYBOOK");
    expect(overview).toContain("PLAYBOOK -->|\"approved lessons, versioned\"| JUDGE");
    expect(overview).toContain("MARKED -->|\"mint read-only at 1h, 24h, 7d\"| STUDY");
    expect(overview).toContain("Meme ideas<br/>");
    expect(overview).toContain("<br/>(off)\"]"); // the Meme ideas node is off until the Operator sets ARGUS_MEME_IDEAS=1
    expect(overview).toContain("META -->|\"new Meta, then every 12 h, cap 8 a day, room-left as a reason\"| MEME");
    expect(overview).toContain("MEME -->|\"3 meme Proposals per run\"| PROPOSALS");
    expect(overview).not.toContain("Beta finder");
    expect(overview).toContain("Needs a market Signal from: pumpportal:events, dexscreener:trending");
    expect(overview).toContain("Runs every: 30 min");
  });

  it("rewrite only between their markers, and leave the Build Runner sequence diagram hand-written and marked as such", () => {
    const body = doc.indexOf("sequenceDiagram");
    expect(body).toBeGreaterThan(-1);
    expect(doc.slice(doc.lastIndexOf("<!--", body), body)).toContain("Not generated");
    const wrecked = doc.replace(/(<!-- generated:pipeline-overview -->)[\s\S]*?(<!-- \/generated:pipeline-overview -->)/, "$1 junk $2");
    expect(wrecked).not.toBe(doc);
    expect(renderGeneratedDocs(wrecked)).toBe(doc); // everything outside the markers (the sequence diagram included) is kept byte for byte
  });

  it("refuse a doc that lost a marker, instead of leaving a diagram silently stale", () => {
    expect(() => renderGeneratedDocs(doc.replace("<!-- generated:pipeline-lifecycle -->", ""))).toThrow(/pipeline-lifecycle/);
    expect(() => renderGeneratedDocs(doc.replace("<!-- /generated:pipeline-overview -->", ""))).toThrow(/pipeline-overview/);
  });
});
