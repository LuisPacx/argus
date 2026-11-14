// The "How it works" page's geometry and text, as pure functions: where each node sits in the fixed columns, the SVG path of each edge,
// and the words on the page. The graph itself comes from GET /api/pipeline (the server's `PipelineResponse`, one definition in
// packages/core/src/pipeline-graph.ts); this file only places and words it. Every string is drawn as text by the template.

/** The part of GET /api/pipeline the page reads (a field renamed in the server's `PipelineResponse` is a type error in its server test). */
export interface PipelinePayload {
  nodes: Array<{
    id: string;
    label: string;
    column: number;
    row: number;
    status: "on" | "off" | "context-only";
    statusNote?: string;
    sources: Array<{ id: string; label: string; status: "on" | "context-only" }>;
  }>;
  edges: Array<{
    id: string;
    from: string;
    to: string;
    label: string;
    dashed: boolean;
    gates: Array<{ label: string; display: string; rubricVersion?: number }>;
  }>;
  rubric: { version: number; gateMinScore: number } | null;
}

/** Fixed geometry, in pixels. Ten columns fit the 1240 px content width; a narrower screen scrolls the graph sideways. */
export const NODE_W = 90;
export const COL_GAP = 34;
export const ROW_GAP = 46;
/** A node's head (label and status pill); an edge leaves and enters at the middle of it. */
export const HEAD_H = 76;
/** What one Source chip adds under the head of the Sources node. */
export const CHIP_H = 40;

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface Point {
  x: number;
  y: number;
}
export interface LayoutNode {
  id: string;
  column: number;
  row: number;
  /** Source chips under the head. */
  chips?: number;
}
export interface LayoutEdge {
  id: string;
  from: string;
  to: string;
}
export interface PlacedEdge {
  id: string;
  d: string;
  start: Point;
  end: Point;
  /** The middle of the path, where a gate marker sits. */
  mid: Point;
}
export interface Layout {
  width: number;
  height: number;
  boxes: Record<string, Box>;
  edges: PlacedEdge[];
}

const round = (n: number): number => Math.round(n * 10) / 10;

/** Columns left to right, rows top to bottom, a row starting under the tallest node of the row above. A node whose edge names a missing node is skipped. */
export function layoutPipeline(nodes: readonly LayoutNode[], edges: readonly LayoutEdge[]): Layout {
  const heightOf = (n: LayoutNode): number => HEAD_H + (n.chips ?? 0) * CHIP_H;
  const rows = [...new Set(nodes.map((n) => n.row))].sort((a, b) => a - b);
  const rowTop = new Map<number, number>();
  let y = 0;
  for (const r of rows) {
    rowTop.set(r, y);
    y += Math.max(...nodes.filter((n) => n.row === r).map(heightOf)) + ROW_GAP;
  }
  const boxes: Record<string, Box> = {};
  for (const n of nodes) boxes[n.id] = { x: n.column * (NODE_W + COL_GAP), y: rowTop.get(n.row)!, w: NODE_W, h: heightOf(n) };
  const columns = nodes.length === 0 ? 0 : Math.max(...nodes.map((n) => n.column)) + 1;
  const width = columns === 0 ? 0 : columns * NODE_W + (columns - 1) * COL_GAP;
  const height = Math.max(0, ...Object.values(boxes).map((b) => b.y + b.h));

  const placed: PlacedEdge[] = [];
  for (const e of edges) {
    const a = nodes.find((n) => n.id === e.from);
    const b = nodes.find((n) => n.id === e.to);
    if (!a || !b) continue;
    const from = boxes[a.id]!;
    const to = boxes[b.id]!;
    let start: Point;
    let end: Point;
    let c1: Point;
    let c2: Point;
    if (a.row === b.row && b.column === a.column + 1) {
      // The next column on the same row: a straight line between the heads.
      start = { x: from.x + from.w, y: from.y + HEAD_H / 2 };
      end = { x: to.x, y: to.y + HEAD_H / 2 };
      c1 = start;
      c2 = end;
    } else if (a.row === b.row) {
      // Further along (or back) on the same row: out of the bottom, under the nodes between, into the bottom.
      start = { x: from.x + from.w / 2, y: from.y + from.h };
      end = { x: to.x + to.w / 2, y: to.y + to.h };
      const dip = ROW_GAP * 0.8;
      c1 = { x: start.x, y: start.y + dip };
      c2 = { x: end.x, y: end.y + dip };
    } else {
      // Another row: bottom to top going down, top to bottom going up.
      const down = b.row > a.row;
      start = { x: from.x + from.w / 2, y: down ? from.y + from.h : from.y };
      end = { x: to.x + to.w / 2, y: down ? to.y : to.y + to.h };
      const mid = (start.y + end.y) / 2;
      c1 = { x: start.x, y: mid };
      c2 = { x: end.x, y: mid };
    }
    const d = a.row === b.row && b.column === a.column + 1 ? `M ${round(start.x)} ${round(start.y)} L ${round(end.x)} ${round(end.y)}` : `M ${round(start.x)} ${round(start.y)} C ${round(c1.x)} ${round(c1.y)}, ${round(c2.x)} ${round(c2.y)}, ${round(end.x)} ${round(end.y)}`;
    // The point of a cubic Bezier at t = 0.5 is (P0 + 3 P1 + 3 P2 + P3) / 8; for the straight line c1 = start and c2 = end give the midpoint.
    const mid = { x: round((start.x + 3 * c1.x + 3 * c2.x + end.x) / 8), y: round((start.y + 3 * c1.y + 3 * c2.y + end.y) / 8) };
    placed.push({ id: e.id, d, start, end, mid });
  }
  return { width, height, boxes, edges: placed };
}

// ---------------------------------------------------------------- the view

export const STATUS_WORD: Record<"on" | "off" | "context-only", string> = { on: "on", off: "off", "context-only": "context only" };
const TONE: Record<"on" | "off" | "context-only", string> = { on: "pill-green", off: "", "context-only": "pill-accent" };

export interface PipelineView {
  width: number;
  height: number;
  nodes: Array<{
    id: string;
    label: string;
    status: "on" | "off" | "context-only";
    statusWord: string;
    tone: string;
    note: string | null;
    style: Record<string, string>;
    chips: Array<{ id: string; label: string; statusWord: string; tone: string }>;
  }>;
  edges: Array<{ id: string; d: string; dashed: boolean; gate: { x: number; y: number; text: string } | null }>;
  /** One sentence per edge, for reading the graph without the picture. */
  legend: Array<{ id: string; text: string; gate: string | null }>;
}

const gateText = (g: { label: string; display: string; rubricVersion?: number }): string => `${g.label}: ${g.display}${g.rubricVersion === undefined ? "" : ` (Rubric v${g.rubricVersion})`}`;

/** Everything the template draws, from the API payload. */
export function pipelineView(p: PipelinePayload): PipelineView {
  const layout = layoutPipeline(
    p.nodes.map((n) => ({ id: n.id, column: n.column, row: n.row, chips: n.sources.length })),
    p.edges,
  );
  const labelOf = new Map(p.nodes.map((n) => [n.id, n.label]));
  const drawn = new Map(layout.edges.map((e) => [e.id, e]));
  return {
    width: layout.width,
    height: layout.height,
    nodes: p.nodes.map((n) => {
      const box = layout.boxes[n.id]!;
      return {
        id: n.id,
        label: n.label,
        status: n.status,
        statusWord: STATUS_WORD[n.status],
        tone: TONE[n.status],
        note: n.statusNote ?? null,
        style: { left: `${box.x}px`, top: `${box.y}px`, width: `${box.w}px`, height: `${box.h}px` },
        chips: n.sources.map((c) => ({ id: c.id, label: c.label, statusWord: c.status === "on" ? "market" : "context only", tone: c.status === "on" ? "pill-green" : "pill-accent" })),
      };
    }),
    edges: p.edges.flatMap((e) => {
      const at = drawn.get(e.id);
      if (!at) return [];
      return [{ id: e.id, d: at.d, dashed: e.dashed, gate: e.gates.length > 0 ? { x: at.mid.x, y: at.mid.y, text: e.gates.map(gateText).join("; ") } : null }];
    }),
    legend: p.edges.map((e) => ({
      id: e.id,
      text: `${labelOf.get(e.from) ?? e.from} to ${labelOf.get(e.to) ?? e.to}: ${e.label}${e.dashed ? " (not an item moving: a decision or a path not wired yet)" : ""}`,
      gate: e.gates.length > 0 ? e.gates.map(gateText).join("; ") : null,
    })),
  };
}
