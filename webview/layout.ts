import ELK from 'elkjs/lib/elk.bundled.js';
import type { DbObject, ObjectKind, Relation } from '../src/model';

export interface Size { w: number; h: number }
export interface Pos { x: number; y: number }
export interface Lane { kind: ObjectKind; x: number; y: number; w: number }
export type LayoutMode = 'layers' | 'graph';
export type Direction = 'RIGHT' | 'DOWN' | 'LEFT' | 'UP';

export interface LayoutResult {
  positions: Map<string, Pos>;
  lanes: Lane[];
}

const elk = new ELK();
const LANE_ORDER: ObjectKind[] = ['table', 'view', 'function', 'procedure'];
const LANE_GAP = 140;
const NODE_GAP = 28;

/**
 * `layers`: tables laid out by FK graph, then views / functions / procedures
 * as columns to the right, each object placed near the objects it references.
 * `graph`: one layered graph of everything.
 */
export async function layout(
  objects: DbObject[],
  relations: Relation[],
  sizes: Map<string, Size>,
  mode: LayoutMode,
  direction: Direction,
): Promise<LayoutResult> {
  const ids = new Set(objects.map((o) => o.id));
  const rels = relations.filter((r) => ids.has(r.from) && ids.has(r.to) && r.from !== r.to);

  if (mode === 'graph') {
    const positions = await elkLayout(objects.map((o) => o.id), rels, sizes, direction);
    return { positions, lanes: [] };
  }

  const tables = objects.filter((o) => o.kind === 'table').map((o) => o.id);
  const positions = await elkLayout(tables, rels.filter((r) => r.kind === 'fk'), sizes, direction);
  const lanes: Lane[] = [];

  let right = 0;
  let top = 0;
  for (const id of tables) {
    const p = positions.get(id)!;
    right = Math.max(right, p.x + sizes.get(id)!.w);
    top = Math.min(top, p.y);
  }
  if (tables.length) lanes.push({ kind: 'table', x: 0, y: top, w: right });
  else right = -LANE_GAP;

  // neighbours in both directions, so callers sit next to callees too
  const neighbours = new Map<string, string[]>();
  for (const r of rels) {
    if (r.kind !== 'dependency') continue;
    (neighbours.get(r.from) ?? neighbours.set(r.from, []).get(r.from)!).push(r.to);
    (neighbours.get(r.to) ?? neighbours.set(r.to, []).get(r.to)!).push(r.from);
  }

  for (const kind of LANE_ORDER.slice(1)) {
    const lane = objects.filter((o) => o.kind === kind);
    if (!lane.length) continue;
    const x = right + LANE_GAP;
    const want = new Map<string, number>();
    for (const o of lane) {
      const ys = (neighbours.get(o.id) ?? [])
        .map((n) => positions.get(n))
        .filter((p): p is Pos => !!p)
        .map((p) => p.y);
      want.set(o.id, ys.length ? ys.reduce((a, b) => a + b, 0) / ys.length : Number.POSITIVE_INFINITY);
    }
    lane.sort((a, b) => want.get(a.id)! - want.get(b.id)! || a.id.localeCompare(b.id));
    let y = top;
    let w = 0;
    let lastFinite = top;
    for (const o of lane) {
      const target = want.get(o.id)!;
      const desired = Number.isFinite(target) ? target : Math.max(y, lastFinite);
      const py = Math.max(y, desired);
      if (Number.isFinite(target)) lastFinite = py;
      positions.set(o.id, { x, y: py });
      const s = sizes.get(o.id)!;
      y = py + s.h + NODE_GAP;
      w = Math.max(w, s.w);
    }
    lanes.push({ kind, x, y: top, w });
    right = x + w;
  }
  return { positions, lanes };
}

async function elkLayout(ids: string[], rels: Relation[], sizes: Map<string, Size>, direction: Direction) {
  const positions = new Map<string, Pos>();
  if (!ids.length) return positions;
  const graph = await elk.layout({
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': direction,
      'elk.spacing.nodeNode': '40',
      'elk.layered.spacing.nodeNodeBetweenLayers': '110',
      'elk.spacing.componentComponent': '70',
      'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
      'elk.layered.crossingMinimization.semiInteractive': 'true',
      'elk.separateConnectedComponents': 'true',
      'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
    },
    children: ids.map((id) => ({ id, width: sizes.get(id)!.w, height: sizes.get(id)!.h })),
    // referenced object first: parent table → child table, table → view/procedure
    edges: rels.map((r) => ({ id: r.id, sources: [r.to], targets: [r.from] })),
  });
  for (const c of graph.children ?? []) positions.set(c.id, { x: c.x ?? 0, y: c.y ?? 0 });
  return positions;
}
