import { Datastore, PIPELINE, resolvePipeline, SEED_GATE_MIN_SCORE } from "@argus/core";
import { beforeEach, expect, it, vi } from "vitest";
import { type Box, layoutPipeline, NODE_W, COL_GAP, CHIP_H, HEAD_H, type Point, type PipelinePayload } from "../../app/utils/pipeline-layout.ts";

/** The page's data and geometry: the real route handler over an in-memory store, and the pure layout helper over the real graph. */
let store: Datastore;
vi.stubGlobal("defineEventHandler", (f: unknown) => f);
vi.stubGlobal("useStore", () => store);
const route = (await import("../api/pipeline.get.ts")).default as unknown as () => ReturnType<typeof resolvePipeline>;

beforeEach(() => {
  store = Datastore.open(":memory:");
});

const SHOWN = ["sources", "signals", "narratives", "judge", "proposals", "shortlist", "spec", "approve", "build", "preview", "study", "meta", "beta"];

// The client reads the payload through its own type: the server's response must stay assignable to it (a renamed field fails the type check).
const asPayload = (r: ReturnType<typeof resolvePipeline>): PipelinePayload => r;
const nodesOf = (p: PipelinePayload) => p.nodes.map((n) => ({ id: n.id, column: n.column, row: n.row, chips: n.sources.length }));

it("GET /api/pipeline returns the on-page graph as plain data, with the stored Rubric's gate and version", () => {
  const out = route();
  expect(out.nodes.map((n) => n.id)).toEqual(SHOWN);
  expect(out.rubric).toEqual({ version: 1, gateMinScore: SEED_GATE_MIN_SCORE });
  const gate = out.edges.find((e) => e.id === "judge-proposals")!.gates[0]!;
  expect(gate).toMatchObject({ label: "Buildability gate, minimum", value: SEED_GATE_MIN_SCORE, rubricVersion: 1 });
  expect(JSON.parse(JSON.stringify(out))).toEqual(out); // survives JSON: no function, no undefined hole
  expect(out.nodes.find((n) => n.id === "beta")).toMatchObject({ status: "off" });
  expect(out.nodes.find((n) => n.id === "study")).toMatchObject({ status: "on" });
  expect(out.nodes.find((n) => n.id === "study")).not.toHaveProperty("brainTask"); // plain code: no Claude cost
});

it("the gate follows an edit of the Rubric: the stored value and the new version, not the code's seed", () => {
  const r = store.getRubric();
  store.saveRubric({ baseVersion: r.version, dimensions: r.dimensions.map(({ key, description, weight }) => ({ key, description, weight })), gateMinScore: 7 });
  const gate = route().edges.find((e) => e.id === "judge-proposals")!.gates[0]!;
  expect(gate).toMatchObject({ value: 7, display: "7", rubricVersion: 2 });
});

it("the response is the client's payload type", () => {
  expect(asPayload(route()).nodes).toHaveLength(SHOWN.length);
});

const layout = () => layoutPipeline(nodesOf(asPayload(route())), asPayload(route()).edges);
const overlaps = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const inside = (p: Point, b: Box) => p.x > b.x && p.x < b.x + b.w && p.y > b.y && p.y < b.y + b.h;
const onEdgeOf = (p: Point, b: Box) => {
  const withinX = p.x >= b.x && p.x <= b.x + b.w;
  const withinY = p.y >= b.y && p.y <= b.y + b.h;
  return (withinX && (p.y === b.y || p.y === b.y + b.h)) || (withinY && (p.x === b.x || p.x === b.x + b.w));
};

it("layout: columns go left to right, rows top to bottom, and no two nodes overlap", () => {
  const l = layout();
  const payload = asPayload(route());
  for (const n of payload.nodes) {
    const b = l.boxes[n.id]!;
    expect(b.x).toBe(n.column * (NODE_W + COL_GAP));
    expect(b.w).toBe(NODE_W);
  }
  const ids = Object.keys(l.boxes);
  for (const [i, a] of ids.entries()) for (const b of ids.slice(i + 1)) expect(overlaps(l.boxes[a]!, l.boxes[b]!), `${a} overlaps ${b}`).toBe(false);
  // The ten stages read left to right in order.
  const stages = ["sources", "signals", "narratives", "judge", "proposals", "shortlist", "spec", "approve", "build", "preview"];
  const xs = stages.map((id) => l.boxes[id]!.x);
  expect(xs).toEqual([...xs].sort((a, b) => a - b));
  expect(new Set(stages.map((id) => l.boxes[id]!.y)).size).toBe(1);
  // The side row sits beneath the tallest stage node (the Sources node, with its chips).
  const tallest = Math.max(...stages.map((id) => l.boxes[id]!.y + l.boxes[id]!.h));
  for (const id of ["study", "meta", "beta"]) expect(l.boxes[id]!.y).toBeGreaterThan(tallest);
  expect(l.boxes.sources!.h).toBe(HEAD_H + 5 * CHIP_H);
  // It fits the 1240 px content width, so only a narrower screen scrolls.
  expect(l.width).toBeLessThanOrEqual(1240);
  expect(l.height).toBeGreaterThan(tallest);
});

it("layout: every edge leaves one node and enters another on their borders, and no path crosses a third node", () => {
  const l = layout();
  const payload = asPayload(route());
  expect(l.edges).toHaveLength(payload.edges.length);
  for (const e of payload.edges) {
    const placed = l.edges.find((p) => p.id === e.id)!;
    const from = l.boxes[e.from]!;
    const to = l.boxes[e.to]!;
    expect(onEdgeOf(placed.start, from), `${e.id} start`).toBe(true);
    expect(onEdgeOf(placed.end, to), `${e.id} end`).toBe(true);
    expect(placed.d).toMatch(/^M [\d.]+ [\d.]+ (L [\d.]+ [\d.]+|C [\d., ]+)$/);
    // Sample the path (a straight line or a cubic Bezier) and keep it out of every other node.
    const nums = placed.d.match(/[\d.]+/g)!.map(Number);
    const pts: Point[] = [];
    for (let t = 0.05; t < 0.96; t += 0.05) {
      if (placed.d.includes("L")) pts.push({ x: nums[0]! + (nums[2]! - nums[0]!) * t, y: nums[1]! + (nums[3]! - nums[1]!) * t });
      else {
        const u = 1 - t;
        const at = (k: 0 | 1) => u ** 3 * nums[k]! + 3 * u * u * t * nums[2 + k]! + 3 * u * t * t * nums[4 + k]! + t ** 3 * nums[6 + k]!;
        pts.push({ x: at(0), y: at(1) });
      }
    }
    for (const [id, box] of Object.entries(l.boxes)) for (const p of pts) expect(inside(p, box), `${e.id} crosses ${id}`).toBe(false);
  }
});

it("layout: the middle of a path is on the path's own line or curve, and the output is deterministic", () => {
  const a = layout();
  expect(layout()).toEqual(a);
  const straight = a.edges.find((e) => e.id === "narratives-judge")!;
  expect(straight.mid.x).toBeCloseTo((straight.start.x + straight.end.x) / 2, 1);
  expect(straight.mid.y).toBeCloseTo(straight.start.y, 1);
});

it("layout: an edge that names a missing node is skipped, and an empty graph is empty", () => {
  const l = layoutPipeline([{ id: "a", column: 0, row: 0 }], [{ id: "x", from: "a", to: "nope" }]);
  expect(l.edges).toEqual([]);
  expect(layoutPipeline([], [])).toMatchObject({ width: 0, height: 0, edges: [] });
});

it("the graph definition has a cell for every drawn node and reaches the same ids as the page's list", () => {
  expect(resolvePipeline(PIPELINE).nodes.map((n) => n.id)).toEqual(SHOWN);
});
