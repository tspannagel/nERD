import type { Column, DbObject, ObjectKind, Relation, SchemaModel } from '../src/model';
import { Direction, Lane, LayoutMode, Pos, Size, layout } from './layout';
import css from './style.css';

// ---------------------------------------------------------------------------
// host bridge

interface VsApi { postMessage(m: unknown): void; getState(): unknown; setState(s: unknown): void }
declare function acquireVsCodeApi(): VsApi;
const vscode: VsApi = typeof acquireVsCodeApi === 'function'
  ? acquireVsCodeApi()
  : { postMessage: (m) => console.log('postMessage', m), getState: () => undefined, setState: () => {} };

interface SavedLayout {
  positions: Record<string, Pos>;
  collapsed: string[];
  hiddenKinds: ObjectKind[];
  hiddenSchemas: string[];
  mode: LayoutMode;
  showDeps: boolean;
  view?: { x: number; y: number; k: number };
}

interface Options { direction: Direction; startCollapsed: boolean }

// ---------------------------------------------------------------------------
// constants

const KINDS: { kind: ObjectKind; label: string; tag: string }[] = [
  { kind: 'table', label: 'Tables', tag: 'TABLE' },
  { kind: 'view', label: 'Views', tag: 'VIEW' },
  { kind: 'function', label: 'Functions', tag: 'FUNCTION' },
  { kind: 'procedure', label: 'Procedures', tag: 'PROC' },
];
const HEAD_H = 40;
const ROW_H = 22;
const PAD_X = 12;
const MIN_W = 200;
const MAX_W = 420;
const SUMMARY_H = 24;
const SVGNS = 'http://www.w3.org/2000/svg';

// ---------------------------------------------------------------------------
// state

let model: SchemaModel | undefined;
let options: Options = { direction: 'RIGHT', startCollapsed: false };
const byId = new Map<string, DbObject>();
let positions = new Map<string, Pos>();
let lanes: Lane[] = [];
const collapsed = new Set<string>();
const hiddenKinds = new Set<ObjectKind>();
const hiddenSchemas = new Set<string>();
let mode: LayoutMode = 'layers';
let showDeps = true;
let view = { x: 40, y: 40, k: 1 };
let selected: string | undefined;
let search = '';
let matchIndex = -1;
let firstModel = true;
let hasManualPositions = false; // user dragged nodes → don't auto re-layout on changes

// ---------------------------------------------------------------------------
// DOM

const styleEl = document.createElement('style');
styleEl.textContent = css;
document.head.appendChild(styleEl);

function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, unknown> = {}, ...kids: (Node | string)[]) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v as EventListener);
    else if (k === 'style') el.setAttribute('style', String(v));
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  el.append(...kids);
  return el;
}

function s<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, unknown> = {}, ...kids: (Node | string)[]) {
  const el = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v as EventListener);
    else el.setAttribute(k, String(v));
  }
  el.append(...kids);
  return el;
}

const kindColor = (k: ObjectKind) => `var(--k-${k})`;

const app = document.getElementById('app')!;
const searchInput = h('input', { type: 'search', placeholder: 'Search objects & columns…', 'aria-label': 'Search' }) as HTMLInputElement;
const layerChips = h('div', { class: 'group', role: 'group', 'aria-label': 'Layers' });
const schemaMenu = h('div', { class: 'menu' });
const schemaSummary = h('summary', { class: 'chip' }, 'Schemas');
const schemaDetails = h('details', { class: 'schemas' }, schemaSummary, schemaMenu);
const modeLayers = h('button', { 'aria-pressed': 'true', title: 'Tables first, then views, functions and procedures as columns', onclick: () => setMode('layers') }, 'Layers');
const modeGraph = h('button', { 'aria-pressed': 'false', title: 'One graph of all objects', onclick: () => setMode('graph') }, 'Graph');
const depsChip = h('button', { class: 'chip', 'aria-pressed': 'true', title: 'Show dependency lines of views, functions and procedures', onclick: () => { showDeps = !showDeps; renderEdges(); syncToolbar(); persist(); } }, 'Dependencies');
const titleName = h('b', {}, 'nERD');
const titleSub = h('span', {}, '');

const toolbar = h('div', { class: 'toolbar' },
  h('div', { class: 'brand' }, titleName, titleSub),
  layerChips,
  h('div', { class: 'sep' }),
  schemaDetails,
  depsChip,
  h('div', { class: 'sep' }),
  searchInput,
  h('div', { class: 'spacer' }),
  h('div', { class: 'seg', role: 'group', 'aria-label': 'Layout mode' }, modeLayers, modeGraph),
  h('button', { title: 'Re-run automatic layout', onclick: () => void relayout(true) }, 'Auto layout'),
  h('button', { title: 'Expand all', class: 'icon', onclick: () => setAllCollapsed(false) }, '⊞'),
  h('button', { title: 'Collapse all', class: 'icon', onclick: () => setAllCollapsed(true) }, '⊟'),
  h('button', { title: 'Fit to view (F)', class: 'icon', onclick: () => fit() }, '⤢'),
  h('button', { title: 'Export as SVG', onclick: () => exportSvg() }, 'Export SVG'),
  h('button', { title: 'Reload from project', class: 'icon', onclick: () => vscode.postMessage({ type: 'refresh' }) }, '↻'),
);

const svg = s('svg', { role: 'img', 'aria-label': 'Entity relationship diagram' });
const defs = s('defs');
const viewport = s('g');
const laneLayer = s('g');
const edgeLayer = s('g');
const nodeLayer = s('g');
viewport.append(laneLayer, edgeLayer, nodeLayer);
svg.append(defs, s('rect', { width: '100%', height: '100%', fill: 'url(#grid)' }), viewport);
const canvas = h('div', { class: 'canvas' }, svg);
const empty = h('div', { class: 'empty' }, 'Loading project…');
canvas.append(empty);
const details = h('aside', { class: 'details', 'aria-label': 'Object details' });
const warningsBox = h('div', { class: 'warnings' });
const main = h('div', { class: 'main' }, canvas, details, warningsBox);
const statusCounts = h('span');
const statusWarn = h('span', { class: 'warn', onclick: () => warningsBox.classList.toggle('open') });
const statusZoom = h('span', { class: 'zoom' });
const status = h('div', { class: 'status' }, statusCounts, statusWarn,
  h('span', {}, 'Wheel: zoom · Drag: pan / move · Double-click: open source'), statusZoom);
app.append(toolbar, main, status);

defs.innerHTML = `
  <pattern id="grid" width="24" height="24" patternUnits="userSpaceOnUse">
    <circle cx="1" cy="1" r="1" fill="var(--grid)"/>
  </pattern>
  <marker id="many" viewBox="0 0 16 16" refX="15" refY="8" markerWidth="16" markerHeight="16" markerUnits="userSpaceOnUse" orient="auto-start-reverse">
    <path class="marker-fk" d="M15 1 L3 8 L15 15 M3 8 L15 8 M1 2 L1 14"/>
  </marker>
  <marker id="one" viewBox="0 0 16 16" refX="15" refY="8" markerWidth="16" markerHeight="16" markerUnits="userSpaceOnUse" orient="auto-start-reverse">
    <path class="marker-fk" d="M7 2 L7 14 M11 2 L11 14 M2 8 L15 8"/>
  </marker>
  <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="9" markerHeight="9" markerUnits="userSpaceOnUse" orient="auto">
    <path class="marker-dep" d="M0 0 L10 5 L0 10 z"/>
  </marker>`;

// ---------------------------------------------------------------------------
// measurement

const measureCtx = document.createElement('canvas').getContext('2d')!;
const fonts = (() => {
  const cs = getComputedStyle(document.body);
  const ui = cs.getPropertyValue('--vscode-font-family') || '-apple-system, Segoe UI, sans-serif';
  const mono = cs.getPropertyValue('--vscode-editor-font-family') || 'Consolas, monospace';
  return { title: `600 13px ${ui}`, mono: `12px ${mono}`, ui: `13px ${ui}` };
})();
function textW(text: string, font: string) { measureCtx.font = font; return measureCtx.measureText(text).width; }

interface Row { name: string; type: string; nullable?: boolean; badges: string[]; title?: string }

function rowsOf(o: DbObject): Row[] {
  const fkCols = new Set(o.foreignKeys.flatMap((f) => f.columns.map((c) => c.toLowerCase())));
  const cols = o.columns.map((c) => colRow(c, fkCols));
  const params = o.parameters.map<Row>((p) => ({
    name: p.name,
    type: p.type,
    badges: p.output ? ['OUT'] : [],
    title: p.default !== undefined ? `= ${p.default}` : undefined,
  }));
  if (o.kind === 'function') {
    const ret: Row[] = o.returns && !o.columns.length ? [{ name: 'RETURNS', type: o.returns, badges: [] }] : [];
    return [...params, ...ret, ...cols];
  }
  return [...params, ...cols];
}

function colRow(c: Column, fkCols: Set<string>): Row {
  const badges: string[] = [];
  if (c.isPrimaryKey) badges.push('PK');
  if (fkCols.has(c.name.toLowerCase())) badges.push('FK');
  if (c.unique && !c.isPrimaryKey) badges.push('UQ');
  const extra = [c.identity, c.default !== undefined ? `DEFAULT ${c.default}` : undefined].filter(Boolean).join(' · ');
  return { name: c.name, type: c.computed ? 'computed' : c.type, nullable: c.nullable && !c.computed, badges, title: c.computed ? c.type : extra || undefined };
}

/** Index of the first column row (params come first for modules). */
function columnRowOffset(o: DbObject) {
  return o.kind === 'function' ? o.parameters.length + (o.returns && !o.columns.length ? 1 : 0) : o.parameters.length;
}

const sizeCache = new Map<string, { w: number; rows: Row[] }>();
function nodeSize(o: DbObject): Size {
  let c = sizeCache.get(o.id);
  if (!c) {
    const rows = rowsOf(o);
    let w = PAD_X * 2 + textW(o.schema + '.', fonts.ui) + textW(o.name, fonts.title) + 40;
    for (const r of rows) {
      const badgeW = r.badges.length * 26 + (r.badges.length ? 4 : 0);
      w = Math.max(w, PAD_X * 2 + badgeW + textW(r.name, fonts.mono) + 24 + textW(r.type, fonts.mono) + (r.nullable ? 30 : 0));
    }
    c = { w: Math.min(MAX_W, Math.max(MIN_W, Math.ceil(w))), rows };
    sizeCache.set(o.id, c);
  }
  const isCollapsed = collapsed.has(o.id);
  const h = HEAD_H + (isCollapsed || !c.rows.length ? (c.rows.length ? SUMMARY_H : 0) : c.rows.length * ROW_H + 6);
  return { w: c.w, h };
}

// ---------------------------------------------------------------------------
// visibility

function visibleObjects(): DbObject[] {
  if (!model) return [];
  return model.objects.filter((o) => !hiddenKinds.has(o.kind) && !hiddenSchemas.has(o.schema.toLowerCase()));
}
function isVisible(id: string) {
  const o = byId.get(id);
  return !!o && !hiddenKinds.has(o.kind) && !hiddenSchemas.has(o.schema.toLowerCase());
}

// ---------------------------------------------------------------------------
// rendering

const nodeEls = new Map<string, SVGGElement>();

function render() {
  renderLanes();
  renderNodes();
  renderEdges();
  applyHighlight();
  renderStatus();
  empty.style.display = model && model.objects.length ? 'none' : 'grid';
  if (model && !model.objects.length) empty.textContent = 'No tables, views, functions or procedures found in this project.';
}

function renderLanes() {
  laneLayer.replaceChildren();
  if (mode !== 'layers') return;
  for (const l of lanes) {
    if (hiddenKinds.has(l.kind)) continue;
    const label = KINDS.find((k) => k.kind === l.kind)!.label;
    laneLayer.append(
      s('line', { class: 'lane-line', x1: l.x, x2: l.x + Math.min(l.w, 60), y1: l.y - 22, y2: l.y - 22, style: `--c:${kindColor(l.kind)}` }),
      s('text', { class: 'lane-label', x: l.x, y: l.y - 32 }, label),
    );
  }
}

function renderNodes() {
  nodeLayer.replaceChildren();
  nodeEls.clear();
  for (const o of visibleObjects()) {
    const g = renderNode(o);
    nodeEls.set(o.id, g);
    nodeLayer.append(g);
  }
}

function renderNode(o: DbObject): SVGGElement {
  const { w, h: hh } = nodeSize(o);
  const p = positions.get(o.id) ?? { x: 0, y: 0 };
  const kind = KINDS.find((k) => k.kind === o.kind)!;
  const rows = sizeCache.get(o.id)!.rows;
  const isCollapsed = collapsed.has(o.id);
  const g = s('g', { class: 'node', transform: `translate(${p.x},${p.y})`, style: `--c:${kindColor(o.kind)}`, 'data-id': o.id });

  const clipId = `clip-${cssId(o.id)}`;
  g.append(
    s('clipPath', { id: clipId }, s('rect', { width: w, height: hh, rx: 8 })),
    s('rect', { class: 'card', width: w, height: hh, rx: 8 }),
  );
  const inner = s('g', { 'clip-path': `url(#${clipId})` });
  inner.append(
    s('rect', { class: 'head', width: w, height: HEAD_H }),
    s('rect', { class: 'band', width: 4, height: hh }),
    s('text', { class: 'kindtag', x: PAD_X, y: 14 }, kind.tag),
  );
  const title = s('text', { x: PAD_X, y: 31 });
  const schemaSpan = s('tspan', { class: 'schema' }, `${o.schema}.`);
  const nameSpan = s('tspan', { class: 'title' }, truncate(o.name, fonts.title, w - PAD_X * 2 - 30 - textW(o.schema + '.', fonts.ui)));
  title.append(schemaSpan, nameSpan, s('title', {}, `${o.schema}.${o.name}`));
  inner.append(title);

  if (rows.length) {
    // collapse chevron
    const cx = w - 18;
    const cy = HEAD_H / 2;
    const hit = s('rect', { class: 'chev-hit', x: w - 34, y: 4, width: 30, height: HEAD_H - 8, rx: 4, 'data-chev': '1' });
    const chev = s('path', {
      class: 'chev', 'data-chev': '1',
      d: isCollapsed ? `M${cx - 3} ${cy - 5} L${cx + 3} ${cy} L${cx - 3} ${cy + 5} Z` : `M${cx - 5} ${cy - 3} L${cx + 5} ${cy - 3} L${cx} ${cy + 3} Z`,
    });
    inner.append(hit, chev);
  }

  if (isCollapsed && rows.length) {
    const nCols = o.columns.length;
    const nPar = o.parameters.length;
    const parts = [nCols ? `${nCols} column${nCols === 1 ? '' : 's'}` : '', nPar ? `${nPar} parameter${nPar === 1 ? '' : 's'}` : ''].filter(Boolean);
    inner.append(
      s('line', { class: 'divider', x1: 0, x2: w, y1: HEAD_H, y2: HEAD_H }),
      s('text', { class: 'summary', x: PAD_X, y: HEAD_H + 16 }, parts.join(' · ') || (o.returns ?? '')),
    );
  } else if (rows.length) {
    inner.append(s('line', { class: 'divider', x1: 0, x2: w, y1: HEAD_H, y2: HEAD_H }));
    const paramCount = o.kind === 'table' || o.kind === 'view' ? 0 : columnRowOffset(o);
    rows.forEach((r, i) => {
      const y = HEAD_H + 3 + i * ROW_H;
      const row = s('g', { class: 'row', 'data-row': i, transform: `translate(0,${y})` });
      row.append(s('rect', { class: 'row-bg', x: 0, y: 0, width: w, height: ROW_H }));
      if (paramCount && i === paramCount) row.append(s('line', { class: 'divider', x1: PAD_X, x2: w - PAD_X, y1: 0, y2: 0 }));
      let x = PAD_X;
      for (const b of r.badges) {
        const cls = b.toLowerCase();
        row.append(s('g', { class: `badge ${cls}`, transform: `translate(${x},${ROW_H / 2 - 7})` },
          s('rect', { width: 22, height: 14 }),
          s('text', { x: 11, y: 7 }, b)));
        x += 26;
      }
      if (r.badges.length) x += 4;
      const nullW = r.nullable ? 30 : 0;
      // name and type share the row; when both don't fit, each gets at least half
      const avail = w - x - PAD_X - nullW - 14;
      const nameW = textW(r.name, fonts.mono);
      const typeW = textW(r.type, fonts.mono);
      const typeMax = nameW + typeW <= avail ? typeW : Math.max(avail - nameW, Math.min(typeW, avail / 2));
      const nameMax = avail - typeMax;
      row.append(s('text', { class: `cname${r.nullable === false ? ' nn' : ''}`, x, y: 15 }, truncate(r.name, fonts.mono, nameMax)));
      if (r.type) row.append(s('text', { class: 'ctype', x: w - PAD_X - nullW, y: 15, 'text-anchor': 'end' }, truncate(r.type, fonts.mono, typeMax)));
      if (r.nullable) row.append(s('text', { class: 'cnull', x: w - PAD_X, y: 15, 'text-anchor': 'end' }, 'null'));
      const tip = [`${r.name}  ${r.type}${r.nullable ? ' NULL' : r.nullable === false ? ' NOT NULL' : ''}`, r.title].filter(Boolean).join('\n');
      row.append(s('title', {}, tip));
      inner.append(row);
    });
  }
  g.append(inner);
  return g;
}

function truncate(text: string, font: string, max: number): string {
  if (max <= 0) return '…';
  if (textW(text, font) <= max) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (textW(text.slice(0, mid) + '…', font) <= max) lo = mid; else hi = mid - 1;
  }
  return text.slice(0, lo) + '…';
}

function cssId(id: string) { return id.replace(/[^a-zA-Z0-9_-]/g, (c) => `_${c.charCodeAt(0).toString(16)}`); }

// edges ------------------------------------------------------------------

interface Anchor { x: number; y: number }

function rowY(o: DbObject, column: string | undefined): number {
  const p = positions.get(o.id)!;
  if (!column || collapsed.has(o.id)) return p.y + HEAD_H / 2;
  const idx = o.columns.findIndex((c) => c.name.toLowerCase() === column.toLowerCase());
  if (idx < 0) return p.y + HEAD_H / 2;
  return p.y + HEAD_H + 3 + (columnRowOffset(o) + idx) * ROW_H + ROW_H / 2;
}

function edgePath(a: DbObject, ay: number, b: DbObject, by: number): { d: string; start: Anchor; end: Anchor } {
  const pa = positions.get(a.id)!;
  const pb = positions.get(b.id)!;
  const wa = nodeSize(a).w;
  const wb = nodeSize(b).w;
  let sx: number, ex: number, sd: number, ed: number;
  if (a.id === b.id) {
    sx = pa.x + wa; ex = sx; sd = 1; ed = 1;
  } else if (pb.x > pa.x + wa + 20) {
    sx = pa.x + wa; ex = pb.x; sd = 1; ed = -1;
  } else if (pb.x + wb < pa.x - 20) {
    sx = pa.x; ex = pb.x + wb; sd = -1; ed = 1;
  } else {
    // overlapping horizontally: leave and enter on the same side
    const right = pa.x + wa / 2 <= pb.x + wb / 2;
    sx = right ? pa.x + wa : pa.x;
    ex = right ? pb.x + wb : pb.x;
    sd = right ? 1 : -1; ed = sd;
  }
  const dist = Math.abs(ex - sx);
  const bend = a.id === b.id ? 50 : Math.max(40, Math.min(160, dist / 2 + (sd === ed ? 40 : 0)));
  const c1 = sx + sd * bend;
  const c2 = ex + ed * bend;
  // short stubs so markers sit flat against the card edge
  const s1 = sx + sd * 14;
  const e1 = ex + ed * 14;
  return {
    d: `M${sx} ${ay} L${s1} ${ay} C${c1} ${ay} ${c2} ${by} ${e1} ${by} L${ex} ${by}`,
    start: { x: sx, y: ay },
    end: { x: ex, y: by },
  };
}

function visibleRelations(): Relation[] {
  if (!model) return [];
  return model.relations.filter((r) => isVisible(r.from) && isVisible(r.to) && (r.kind === 'fk' || showDeps));
}

function renderEdges() {
  edgeLayer.replaceChildren();
  for (const r of visibleRelations()) edgeLayer.append(renderEdge(r));
}

function renderEdge(r: Relation): SVGGElement {
  const a = byId.get(r.from)!;
  const b = byId.get(r.to)!;
  const ay = r.kind === 'fk' ? rowY(a, r.fromColumns?.[0]) : positions.get(a.id)!.y + HEAD_H / 2;
  const by = r.kind === 'fk' ? rowY(b, r.toColumns?.[0]) : positions.get(b.id)!.y + HEAD_H / 2;
  const { d } = edgePath(a, ay, b, by);
  const g = s('g', { class: `edge ${r.kind}`, 'data-id': r.id, style: `--c:${kindColor(a.kind)}` });
  const label = r.kind === 'fk'
    ? `${r.label ?? 'FK'}: ${a.schema}.${a.name}(${r.fromColumns?.join(', ')}) → ${b.schema}.${b.name}(${r.toColumns?.join(', ')})`
    : `${a.schema}.${a.name} uses ${b.schema}.${b.name}`;
  g.append(
    s('path', { class: 'hit', d }, s('title', {}, label)),
    s('path', {
      class: 'line', d,
      'marker-start': r.kind === 'fk' ? 'url(#many)' : undefined,
      'marker-end': r.kind === 'fk' ? 'url(#one)' : 'url(#arrow)',
    }),
  );
  return g;
}

// highlight ----------------------------------------------------------------

function neighbourhood(id: string) {
  const nodes = new Set([id]);
  const edges = new Set<string>();
  for (const r of visibleRelations()) {
    if (r.from === id || r.to === id) {
      nodes.add(r.from);
      nodes.add(r.to);
      edges.add(r.id);
    }
  }
  return { nodes, edges };
}

function matches(o: DbObject, q: string) {
  return `${o.schema}.${o.name}`.toLowerCase().includes(q)
    || o.columns.some((c) => c.name.toLowerCase().includes(q))
    || o.parameters.some((p) => p.name.toLowerCase().includes(q));
}

function applyHighlight() {
  const q = search.trim().toLowerCase();
  const nb = selected && nodeEls.has(selected) ? neighbourhood(selected) : undefined;
  viewport.classList.toggle('dim', !!nb || !!q);
  for (const [id, g] of nodeEls) {
    const o = byId.get(id)!;
    const isMatch = !!q && matches(o, q);
    g.classList.toggle('selected', id === selected);
    g.classList.toggle('match', isMatch);
    g.classList.toggle('hl', nb ? nb.nodes.has(id) : isMatch);
    // highlight matching / related rows
    g.querySelectorAll<SVGGElement>('.row').forEach((row) => {
      const idx = Number(row.dataset.row);
      const r = sizeCache.get(id)!.rows[idx];
      row.classList.toggle('lit', !!q && r.name.toLowerCase().includes(q));
    });
  }
  edgeLayer.querySelectorAll<SVGGElement>('.edge').forEach((e) => e.classList.toggle('hl', !!nb && nb.edges.has(e.dataset.id!)));
}

// ---------------------------------------------------------------------------
// details panel

function renderDetails() {
  const o = selected ? byId.get(selected) : undefined;
  details.classList.toggle('open', !!o);
  details.replaceChildren();
  if (!o) return;
  const kind = KINDS.find((k) => k.kind === o.kind)!;
  const src = o.source;
  details.append(
    h('h2', { style: `--c:${kindColor(o.kind)}` }, h('span', { class: 'dot' }), `${o.schema}.${o.name}`),
    h('div', { class: 'sub' },
      h('span', {}, kind.label.replace(/s$/, '')),
      src ? h('a', { class: 'link', onclick: () => openSource(o) }, `${basename(src.file)}:${src.line + 1}`) : '',
      h('button', { class: 'close', title: 'Close', onclick: () => select(undefined) }, '✕')),
  );
  if (o.parameters.length) {
    details.append(h('h3', {}, 'Parameters'), h('table', {}, ...o.parameters.map((p) => h('tr', {},
      h('td', {}, p.name), h('td', { class: 't' }, p.type), h('td', { class: 'f' }, [p.output ? 'OUTPUT' : '', p.default !== undefined ? `= ${p.default}` : ''].filter(Boolean).join(' '))))));
  }
  if (o.returns) details.append(h('h3', {}, 'Returns'), h('table', {}, h('tr', {}, h('td', { class: 't' }, o.returns))));
  if (o.columns.length) {
    const fkCols = new Set(o.foreignKeys.flatMap((f) => f.columns.map((c) => c.toLowerCase())));
    details.append(h('h3', {}, `Columns (${o.columns.length})`), h('table', {}, ...o.columns.map((c) => {
      const flags = [c.isPrimaryKey ? 'PK' : '', fkCols.has(c.name.toLowerCase()) ? 'FK' : '', c.unique ? 'UQ' : '', c.identity ?? '', c.computed ? '' : c.nullable ? 'NULL' : 'NOT NULL', c.default !== undefined ? `DEFAULT ${c.default}` : ''].filter(Boolean).join(' ');
      return h('tr', {}, h('td', {}, c.name), h('td', { class: 't' }, c.type || '—'), h('td', { class: 'f' }, flags));
    })));
  }
  if (o.foreignKeys.length) {
    details.append(h('h3', {}, 'Foreign keys'), h('table', {}, ...o.foreignKeys.map((f) => h('tr', {},
      h('td', {}, `${f.columns.join(', ')} → ${f.refSchema}.${f.refTable}(${f.refColumns.join(', ')})`),
      h('td', { class: 'f' }, [f.onDelete ? `ON DELETE ${f.onDelete}` : '', f.onUpdate ? `ON UPDATE ${f.onUpdate}` : ''].filter(Boolean).join(' '))))));
  }
  const uses = (model?.relations ?? []).filter((r) => r.from === o.id && r.to !== o.id).map((r) => r.to);
  const usedBy = (model?.relations ?? []).filter((r) => r.to === o.id && r.from !== o.id).map((r) => r.from);
  const list = (ids: string[]) => h('ul', {}, ...[...new Set(ids)].sort().map((id) => {
    const t = byId.get(id)!;
    return h('li', {}, h('a', { style: `--c:${kindColor(t.kind)}`, onclick: () => { select(id); reveal(id); } }, h('span', { class: 'dot' }), `${t.schema}.${t.name}`));
  }));
  if (uses.length) details.append(h('h3', {}, o.kind === 'table' ? 'References' : 'Uses'), list(uses));
  if (usedBy.length) details.append(h('h3', {}, 'Referenced by'), list(usedBy));
}

function basename(f: string) { return f.split(/[\\/]/).pop() ?? f; }

function openSource(o: DbObject) {
  if (o.source) vscode.postMessage({ type: 'open', file: o.source.file, line: o.source.line });
}

function select(id: string | undefined) {
  selected = id;
  applyHighlight();
  renderDetails();
}

// ---------------------------------------------------------------------------
// toolbar

function syncToolbar() {
  if (!model) return;
  titleSub.textContent = model.project;
  layerChips.replaceChildren(...KINDS.map(({ kind, label }) => {
    const n = model!.objects.filter((o) => o.kind === kind).length;
    return h('button', {
      class: 'chip', 'aria-pressed': String(!hiddenKinds.has(kind)), style: `--c:${kindColor(kind)}`, title: `Show ${label.toLowerCase()}`,
      onclick: () => { hiddenKinds.has(kind) ? hiddenKinds.delete(kind) : hiddenKinds.add(kind); onFilterChange(); },
    }, h('span', { class: 'dot' }), label, h('span', { class: 'n' }, String(n)));
  }));
  const schemas = [...new Set(model.objects.map((o) => o.schema.toLowerCase()))].sort();
  const names = new Map(model.objects.map((o) => [o.schema.toLowerCase(), o.schema]));
  schemaMenu.replaceChildren(...schemas.map((sc) => {
    const cb = h('input', { type: 'checkbox', checked: !hiddenSchemas.has(sc) }) as HTMLInputElement;
    cb.addEventListener('change', () => { cb.checked ? hiddenSchemas.delete(sc) : hiddenSchemas.add(sc); onFilterChange(); });
    const n = model!.objects.filter((o) => o.schema.toLowerCase() === sc).length;
    return h('label', {}, cb, names.get(sc)!, h('span', { class: 'n', style: 'margin-left:auto;color:var(--muted)' }, String(n)));
  }));
  const hidden = schemas.filter((sc) => hiddenSchemas.has(sc)).length;
  schemaSummary.textContent = hidden ? `Schemas (${schemas.length - hidden}/${schemas.length})` : 'Schemas';
  depsChip.setAttribute('aria-pressed', String(showDeps));
  modeLayers.setAttribute('aria-pressed', String(mode === 'layers'));
  modeGraph.setAttribute('aria-pressed', String(mode === 'graph'));
}

function renderStatus() {
  if (!model) return;
  const vis = visibleObjects();
  const rels = visibleRelations();
  statusCounts.textContent = `${vis.length} of ${model.objects.length} objects · ${rels.filter((r) => r.kind === 'fk').length} foreign keys · ${rels.filter((r) => r.kind === 'dependency').length} dependencies`;
  statusWarn.textContent = model.warnings.length ? `⚠ ${model.warnings.length} warning${model.warnings.length === 1 ? '' : 's'}` : '';
  warningsBox.replaceChildren(...model.warnings.map((w) => h('div', {}, w)));
  statusZoom.textContent = `${Math.round(view.k * 100)}%`;
}

function onFilterChange() {
  syncToolbar();
  if (mode === 'layers') void relayout(false);
  else render();
  persist();
}

function setMode(m: LayoutMode) {
  if (mode === m) return;
  mode = m;
  hasManualPositions = false;
  syncToolbar();
  void relayout(true);
}

function setAllCollapsed(c: boolean) {
  for (const o of visibleObjects()) c ? collapsed.add(o.id) : collapsed.delete(o.id);
  void relayout(true);
}

// ---------------------------------------------------------------------------
// layout

let layoutSeq = 0;
async function relayout(fitAfter: boolean) {
  const seq = ++layoutSeq;
  const objs = visibleObjects();
  const sizes = new Map(objs.map((o) => [o.id, nodeSize(o)]));
  const res = await layout(objs, model?.relations ?? [], sizes, mode, options.direction);
  if (seq !== layoutSeq) return;
  if (fitAfter) hasManualPositions = false;
  for (const [id, p] of res.positions) positions.set(id, p);
  lanes = res.lanes;
  render();
  if (fitAfter) fit();
  persist();
}

/** Adds positions for objects that don't have one yet (new files) below the diagram. */
async function placeMissing() {
  const missing = visibleObjects().filter((o) => !positions.has(o.id));
  if (!missing.length) return;
  const sizes = new Map(missing.map((o) => [o.id, nodeSize(o)]));
  const res = await layout(missing, model?.relations ?? [], sizes, 'graph', options.direction);
  const b = bounds([...positions.keys()].filter(isVisible));
  for (const [id, p] of res.positions) positions.set(id, { x: p.x + (b?.x ?? 0), y: p.y + (b ? b.y + b.h + 80 : 0) });
}

function bounds(ids: string[]) {
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const id of ids) {
    const p = positions.get(id);
    const o = byId.get(id);
    if (!p || !o) continue;
    const sz = nodeSize(o);
    x1 = Math.min(x1, p.x); y1 = Math.min(y1, p.y);
    x2 = Math.max(x2, p.x + sz.w); y2 = Math.max(y2, p.y + sz.h);
  }
  if (!Number.isFinite(x1)) return undefined;
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

// ---------------------------------------------------------------------------
// viewport

function applyView() {
  viewport.setAttribute('transform', `translate(${view.x},${view.y}) scale(${view.k})`);
  const pat = defs.querySelector('#grid') as SVGPatternElement;
  const g = 24 * view.k;
  pat.setAttribute('width', String(g));
  pat.setAttribute('height', String(g));
  pat.setAttribute('x', String(view.x % g));
  pat.setAttribute('y', String(view.y % g));
  statusZoom.textContent = `${Math.round(view.k * 100)}%`;
}

function fit() {
  const b = bounds(visibleObjects().map((o) => o.id));
  if (!b) return;
  const r = canvas.getBoundingClientRect();
  const top = mode === 'layers' && lanes.length ? 40 : 0;
  const k = Math.min(1.25, Math.max(0.1, Math.min((r.width - 60) / b.w, (r.height - 60 - top) / (b.h + top))));
  view = { k, x: (r.width - b.w * k) / 2 - b.x * k, y: (r.height - (b.h + top) * k) / 2 - (b.y - top) * k };
  applyView();
  persist();
}

function reveal(id: string) {
  const p = positions.get(id);
  const o = byId.get(id);
  if (!p || !o) return;
  const sz = nodeSize(o);
  const r = canvas.getBoundingClientRect();
  view.k = Math.max(view.k, 0.8);
  view.x = r.width / 2 - (p.x + sz.w / 2) * view.k;
  view.y = r.height / 2 - (p.y + Math.min(sz.h, r.height / view.k - 40) / 2) * view.k;
  applyView();
}

function toWorld(clientX: number, clientY: number) {
  const r = canvas.getBoundingClientRect();
  return { x: (clientX - r.left - view.x) / view.k, y: (clientY - r.top - view.y) / view.k };
}

canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const r = canvas.getBoundingClientRect();
  const mx = e.clientX - r.left;
  const my = e.clientY - r.top;
  // pinch / ctrl+wheel and mouse wheels zoom; shift+wheel pans
  if (e.shiftKey) {
    view.x -= e.deltaY || e.deltaX;
  } else {
    const factor = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015));
    const k = Math.min(3, Math.max(0.08, view.k * factor));
    view.x = mx - ((mx - view.x) * k) / view.k;
    view.y = my - ((my - view.y) * k) / view.k;
    view.k = k;
  }
  applyView();
  persistSoon();
}, { passive: false });

type Drag =
  | { kind: 'pan'; sx: number; sy: number; vx: number; vy: number; moved: boolean }
  | { kind: 'node'; id: string; ox: number; oy: number; moved: boolean; el: SVGGElement };
let drag: Drag | undefined;

canvas.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  schemaDetails.open = false;
  const target = e.target as Element;
  const nodeEl = target.closest<SVGGElement>('.node');
  if (nodeEl && !target.closest('[data-chev]')) {
    const id = nodeEl.dataset.id!;
    const w = toWorld(e.clientX, e.clientY);
    const p = positions.get(id)!;
    drag = { kind: 'node', id, ox: w.x - p.x, oy: w.y - p.y, moved: false, el: nodeEl };
    nodeLayer.append(nodeEl); // bring to front
  } else if (!nodeEl) {
    drag = { kind: 'pan', sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y, moved: false };
    canvas.classList.add('panning');
  }
  if (drag) canvas.setPointerCapture(e.pointerId);
});

canvas.addEventListener('pointermove', (e) => {
  if (!drag) return;
  if (drag.kind === 'pan') {
    const dx = e.clientX - drag.sx;
    const dy = e.clientY - drag.sy;
    if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
    view.x = drag.vx + dx;
    view.y = drag.vy + dy;
    applyView();
  } else {
    const w = toWorld(e.clientX, e.clientY);
    const p = { x: Math.round(w.x - drag.ox), y: Math.round(w.y - drag.oy) };
    const old = positions.get(drag.id)!;
    if (!drag.moved && Math.abs(p.x - old.x) + Math.abs(p.y - old.y) < 3) return;
    drag.moved = true;
    positions.set(drag.id, p);
    drag.el.setAttribute('transform', `translate(${p.x},${p.y})`);
    renderEdges();
    applyHighlight();
  }
});

canvas.addEventListener('pointerup', () => {
  const d = drag;
  drag = undefined;
  canvas.classList.remove('panning');
  if (!d) return;
  if (d.kind === 'pan') {
    if (!d.moved) select(undefined);
    else persist();
  } else if (d.moved) {
    hasManualPositions = true;
    persist();
  } else {
    select(d.id);
  }
});

canvas.addEventListener('click', (e) => {
  const target = e.target as Element;
  if (!target.closest('[data-chev]')) return;
  const id = target.closest<SVGGElement>('.node')!.dataset.id!;
  collapsed.has(id) ? collapsed.delete(id) : collapsed.add(id);
  if (mode === 'layers' && !hasManualPositions) void relayout(false);
  else { render(); persist(); }
});

canvas.addEventListener('dblclick', (e) => {
  const nodeEl = (e.target as Element).closest<SVGGElement>('.node');
  if (nodeEl && !(e.target as Element).closest('[data-chev]')) openSource(byId.get(nodeEl.dataset.id!)!);
});


window.addEventListener('keydown', (e) => {
  const inInput = (e.target as Element).tagName === 'INPUT';
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') { e.preventDefault(); searchInput.focus(); searchInput.select(); return; }
  if (inInput) return;
  if (e.key === 'Escape') { select(undefined); warningsBox.classList.remove('open'); }
  if (e.key === 'f' || e.key === 'F') fit();
  if (e.key === '+' || e.key === '=') zoomBy(1.2);
  if (e.key === '-') zoomBy(1 / 1.2);
});

function zoomBy(f: number) {
  const r = canvas.getBoundingClientRect();
  const k = Math.min(3, Math.max(0.08, view.k * f));
  view.x = r.width / 2 - ((r.width / 2 - view.x) * k) / view.k;
  view.y = r.height / 2 - ((r.height / 2 - view.y) * k) / view.k;
  view.k = k;
  applyView();
}

searchInput.addEventListener('input', () => {
  search = searchInput.value;
  matchIndex = -1;
  applyHighlight();
});
searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const q = search.trim().toLowerCase();
    if (!q) return;
    const hits = visibleObjects().filter((o) => matches(o, q));
    if (!hits.length) return;
    matchIndex = (matchIndex + (e.shiftKey ? -1 : 1) + hits.length) % hits.length;
    reveal(hits[matchIndex].id);
  }
  if (e.key === 'Escape') { searchInput.value = ''; search = ''; applyHighlight(); searchInput.blur(); }
});

window.addEventListener('resize', () => applyView());
document.addEventListener('click', (e) => { if (!schemaDetails.contains(e.target as Node)) schemaDetails.open = false; });

// ---------------------------------------------------------------------------
// persistence

function snapshot(): SavedLayout {
  return {
    positions: Object.fromEntries(positions),
    collapsed: [...collapsed],
    hiddenKinds: [...hiddenKinds],
    hiddenSchemas: [...hiddenSchemas],
    mode,
    showDeps,
    view,
  };
}

let persistTimer: number | undefined;
function persist() {
  clearTimeout(persistTimer);
  const snap = { ...snapshot(), manual: hasManualPositions };
  vscode.setState(snap);
  persistTimer = window.setTimeout(() => vscode.postMessage({ type: 'saveLayout', layout: snap }), 400);
}
function persistSoon() {
  clearTimeout(persistTimer);
  persistTimer = window.setTimeout(persist, 300);
}

function restore(saved: (SavedLayout & { manual?: boolean }) | undefined) {
  if (!saved) return false;
  positions = new Map(Object.entries(saved.positions ?? {}));
  collapsed.clear(); (saved.collapsed ?? []).forEach((c) => collapsed.add(c));
  hiddenKinds.clear(); (saved.hiddenKinds ?? []).forEach((c) => hiddenKinds.add(c));
  hiddenSchemas.clear(); (saved.hiddenSchemas ?? []).forEach((c) => hiddenSchemas.add(c));
  mode = saved.mode ?? 'layers';
  showDeps = saved.showDeps ?? true;
  hasManualPositions = !!saved.manual;
  if (saved.view) view = saved.view;
  return positions.size > 0;
}

// ---------------------------------------------------------------------------
// export

function exportSvg() {
  const b = bounds(visibleObjects().map((o) => o.id));
  if (!b) return;
  const pad = 40;
  const top = mode === 'layers' && lanes.length ? 44 : 0;
  const clone = viewport.cloneNode(true) as SVGGElement;
  clone.removeAttribute('transform');
  clone.classList.remove('dim');
  inlineStyles(viewport, clone);
  const bg = getComputedStyle(document.body).backgroundColor;
  const out = document.createElementNS(SVGNS, 'svg');
  out.setAttribute('xmlns', SVGNS);
  out.setAttribute('viewBox', `${b.x - pad} ${b.y - pad - top} ${b.w + pad * 2} ${b.h + pad * 2 + top}`);
  out.setAttribute('width', String(Math.round(b.w + pad * 2)));
  out.setAttribute('height', String(Math.round(b.h + pad * 2 + top)));
  const exportDefs = defs.cloneNode(true) as SVGDefsElement;
  inlineStyles(defs, exportDefs);
  exportDefs.querySelector('#grid')?.remove();
  out.append(exportDefs, s('rect', { x: b.x - pad, y: b.y - pad - top, width: b.w + pad * 2, height: b.h + pad * 2 + top, fill: bg }), clone);
  vscode.postMessage({ type: 'exportSvg', svg: '<?xml version="1.0" encoding="UTF-8"?>\n' + new XMLSerializer().serializeToString(out) });
}

const STYLE_PROPS = ['fill', 'stroke', 'stroke-width', 'stroke-dasharray', 'opacity', 'font-family', 'font-size', 'font-weight', 'font-style', 'letter-spacing', 'text-transform', 'dominant-baseline', 'text-anchor'];
function inlineStyles(src: Element, dst: Element) {
  const cs = getComputedStyle(src);
  if (src instanceof SVGElement && !(src instanceof SVGTitleElement)) {
    const style = STYLE_PROPS.map((p) => `${p}:${cs.getPropertyValue(p)}`).join(';');
    dst.setAttribute('style', style);
    dst.removeAttribute('class');
  }
  for (let i = 0; i < src.children.length; i++) inlineStyles(src.children[i], dst.children[i]);
}

// ---------------------------------------------------------------------------
// messages

window.addEventListener('message', async (e: MessageEvent) => {
  const m = e.data;
  if (m?.type !== 'model') return;
  const next = m.model as SchemaModel;
  options = { ...options, ...(m.options ?? {}) };
  model = next;
  byId.clear();
  sizeCache.clear();
  for (const o of next.objects) byId.set(o.id, o);

  if (firstModel) {
    firstModel = false;
    const saved = (vscode.getState() as SavedLayout | undefined) ?? (m.layout as SavedLayout | undefined);
    const hadLayout = restore(saved);
    if (!saved && options.startCollapsed) next.objects.forEach((o) => collapsed.add(o.id));
    syncToolbar();
    if (!hadLayout) {
      await relayout(true);
      return;
    }
    await placeMissing();
    if (!hasManualPositions && mode === 'layers') await relayout(!saved?.view);
    else render();
    applyView();
    return;
  }

  // reload: keep positions, drop deleted objects, place new ones
  for (const id of [...positions.keys()]) if (!byId.has(id)) positions.delete(id);
  if (selected && !byId.has(selected)) selected = undefined;
  syncToolbar();
  if (!hasManualPositions && mode === 'layers') await relayout(false);
  else { await placeMissing(); render(); }
  renderDetails();
});

applyView();
vscode.postMessage({ type: 'ready' });
