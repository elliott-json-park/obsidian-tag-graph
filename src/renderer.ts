/*
 * Draws a GraphModel on a canvas and turns pointer input into intents (open,
 * drop, context menu). It knows nothing about files: the view decides what a
 * drop means and whether it is allowed.
 *
 * Layout is d3-force, but seeded deterministically — hubs on a circle, notes
 * at the middle of their hubs — and run to rest before the first frame, so the
 * same base opens to the same picture rather than a different hairball each
 * time. Positions carry over when the data changes, so editing a note moves
 * that note and leaves the rest of the picture where the reader left it.
 */
import {
  Simulation, SimulationLinkDatum, SimulationNodeDatum,
  forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY,
} from 'd3-force';
import { GEdge, GNode, GraphModel, folderLabel } from './model';

export interface SimNode extends SimulationNodeDatum {
  id: string;
  g: GNode;
  r: number;
}
interface SimEdge extends SimulationLinkDatum<SimNode> {
  e: GEdge;
  source: SimNode;
  target: SimNode;
}

export interface Theme {
  bg: string;
  text: string;
  muted: string;
  faint: string;
  accent: string;
  accentText: string;
  font: string;
}

export interface DropVerdict { text: string; ok: boolean }

export interface RendererHost {
  facetColor(facetId: string): string;
  noteColor(key: string): string;
  open(node: GNode, newTab: boolean): void;
  context(node: GNode | null, x: number, y: number): void;
  dropVerdict(dragged: GNode, target: GNode): DropVerdict | null;
  drop(dragged: GNode, target: GNode): void;
  hover(node: GNode | null, ev: PointerEvent | null): void;
  focusChanged(id: string | null): void;
}

export interface LayoutOptions {
  animate: boolean;
}

const TAU = Math.PI * 2;
const DRAG_PX = 4;
const LONG_PRESS_MS = 550;

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

function lcg(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}

function radiusOf(g: GNode): number {
  if (g.type === 'hub') return Math.min(42, 9 + Math.sqrt(g.count) * 2.4);
  if (g.type === 'subhub') return Math.min(26, 6 + Math.sqrt(g.count) * 1.8);
  return Math.min(11, 4 + Math.sqrt(g.count) * 0.9);
}

export class Renderer {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private nodes: SimNode[] = [];
  private edges: SimEdge[] = [];
  private byId = new Map<string, SimNode>();
  private adj = new Map<string, Set<string>>();
  private sim: Simulation<SimNode, SimEdge> | null = null;
  private known = new Map<string, { x: number; y: number }>();

  private w = 0;
  private h = 0;
  private dpr = 1;
  private tx = 0;
  private ty = 0;
  private k = 1;
  private fitted = false;

  theme: Theme = { bg: '#fff', text: '#222', muted: '#888', faint: '#bbb', accent: '#7c5cff', accentText: '#fff', font: 'sans-serif' };
  /** Screen space covered by overlays (legend, toolbar) that fitting should avoid. */
  insets = { left: 0, top: 0, right: 0, bottom: 0 };
  frozen = false;
  private animate = true;

  private hovered: SimNode | null = null;
  private focusId: string | null = null;
  private matches: Set<string> | null = null;

  private pointers = new Map<number, { x: number; y: number }>();
  private down: { id: number; x: number; y: number; node: SimNode | null; moved: boolean; button: number; mod: boolean } | null = null;
  private dragging: SimNode | null = null;
  private dropTarget: SimNode | null = null;
  private held: { node: SimNode; wasPinned: boolean } | null = null;
  private verdict: DropVerdict | null = null;
  private dragScreen = { x: 0, y: 0 };
  private pinch: { d: number; k: number; cx: number; cy: number; wx: number; wy: number } | null = null;
  private pressTimer: number | null = null;
  private lastTap = { t: 0, id: '' };
  private longPressAt = -Infinity;
  private longPressPointer: number | null = null;

  private raf = 0;
  private dirty = true;
  private viewAnim: { from: [number, number, number]; to: [number, number, number]; t0: number; ms: number } | null = null;
  private ro: ResizeObserver;
  private destroyed = false;

  constructor(private parent: HTMLElement, private host: RendererHost) {
    this.canvas = parent.createEl('canvas', { cls: 'tag-graph-canvas', attr: { tabindex: '0' } });
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D is not available');
    this.ctx = ctx;
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(parent);
    this.bind();
    this.resize();
  }

  destroy(): void {
    this.destroyed = true;
    window.cancelAnimationFrame(this.raf);
    this.ro.disconnect();
    this.sim?.stop();
    this.clearPress();
  }

  /* ================================================================ data */

  private signature = '';

  setGraph(model: GraphModel, opts: LayoutOptions): void {
    this.animate = opts.animate;
    // Same nodes and edges as before (an edit that changed no value, a theme
    // change, a repeated update from Bases): keep the layout, refresh the data.
    const sig = model.nodes.map(n => n.id).join('\n') + '\u0001' +
      model.edges.map(e => e.source + '>' + e.target + ':' + e.type + (e.kind || '')).join('\n');
    if (sig === this.signature && this.nodes.length === model.nodes.length) {
      model.nodes.forEach((g, i) => {
        const n = this.byId.get(g.id) || this.nodes[i];
        n.g = g; n.r = radiusOf(g);
      });
      this.dirty = true;
      this.loop();
      return;
    }
    this.signature = sig;
    for (const n of this.nodes) if (n.x !== undefined && n.y !== undefined) this.known.set(n.id, { x: n.x, y: n.y });

    const nodes: SimNode[] = model.nodes.map(g => ({ id: g.id, g, r: radiusOf(g) }));
    const byId = new Map(nodes.map(n => [n.id, n]));
    const edges: SimEdge[] = [];
    const adj = new Map<string, Set<string>>();
    for (const n of nodes) adj.set(n.id, new Set());
    for (const e of model.edges) {
      const s = byId.get(e.source), t = byId.get(e.target);
      if (!s || !t) continue;
      edges.push({ e, source: s, target: t });
      adj.get(s.id)!.add(t.id);
      adj.get(t.id)!.add(s.id);
    }
    this.nodes = nodes; this.edges = edges; this.byId = byId; this.adj = adj;
    if (this.focusId && !byId.has(this.focusId)) { this.focusId = null; this.host.focusChanged(null); }
    if (this.hovered && !byId.has(this.hovered.id)) this.hovered = null;

    const fresh = this.place();
    this.buildSim(fresh);
    this.dirty = true;
    this.loop();
  }

  /** Give every node a position: remembered, near a placed neighbour, or seeded. Returns how many were new. */
  private place(): number {
    let fresh = 0;
    const hubs = this.nodes.filter(n => n.g.type === 'hub');
    const ring = 70 * Math.sqrt(Math.max(1, hubs.length));
    hubs.forEach((n, i) => {
      const p = this.known.get(n.id);
      if (p) { n.x = p.x; n.y = p.y; return; }
      fresh++;
      const a = (i / Math.max(1, hubs.length)) * TAU + (hash(n.id) % 100) / 400;
      n.x = Math.cos(a) * ring; n.y = Math.sin(a) * ring;
    });
    for (const n of this.nodes) {
      if (n.g.type === 'hub') continue;
      const p = this.known.get(n.id);
      if (p) { n.x = p.x; n.y = p.y; continue; }
      fresh++;
      let sx = 0, sy = 0, c = 0;
      for (const id of this.adj.get(n.id) || []) {
        const m = this.byId.get(id)!;
        if (m.x !== undefined && m.y !== undefined && (m.g.type !== 'note' || this.known.has(m.id))) { sx += m.x; sy += m.y; c++; }
      }
      const h = hash(n.id);
      const a = (h % 3600) / 3600 * TAU;
      const d = 18 + (h >>> 12) % 40;
      if (c > 0) { n.x = sx / c + Math.cos(a) * d; n.y = sy / c + Math.sin(a) * d; }
      else { const rr = ring * 0.6 + (h >>> 8) % Math.max(60, ring); n.x = Math.cos(a) * rr; n.y = Math.sin(a) * rr; }
    }
    return fresh;
  }

  private buildSim(fresh: number): void {
    this.sim?.stop();
    const deg = (n: SimNode) => this.adj.get(n.id)!.size || 1;
    // The pane's shape shapes the layout; read it now, as the resize observer
    // may not have reported yet and a guess would give a different picture.
    const box = this.parent.getBoundingClientRect();
    const bw = box.width || this.w, bh = box.height || this.h;
    const ratio = bw > 1 && bh > 1 ? Math.max(0.5, Math.min(2.2, Math.round(bw / bh * 10) / 10)) : 1.4;
    const aspectX = 1 / ratio, aspectY = ratio;
    const sim = forceSimulation<SimNode, SimEdge>(this.nodes)
      .randomSource(lcg(1234567))
      .force('link', forceLink<SimNode, SimEdge>(this.edges)
        .distance(l => l.e.type === 'member' ? l.target.r + 26 : l.e.type === 'split' ? l.target.r + l.source.r + 18 : 46)
        .strength(l => {
          const base = 1 / Math.min(deg(l.source), deg(l.target));
          return l.e.type === 'link' ? base * 0.5 : l.e.type === 'split' ? 0.7 : base;
        }))
      .force('charge', forceManyBody<SimNode>()
        .strength(n => n.g.type === 'hub' ? -220 - Math.min(400, n.g.count * 6) : n.g.type === 'subhub' ? -110 : -38)
        .distanceMax(900).theta(0.9))
      .force('collide', forceCollide<SimNode>(n => n.r + (n.g.type === 'note' ? 2 : 6)).iterations(1))
      // Pull towards the middle in proportion to the view's shape, so a wide
      // pane gets a wide graph. Notes with no connections are held closer, or
      // they drift to the edge and shrink everything else when fitting.
      .force('x', forceX<SimNode>(0).strength(n => (this.adj.get(n.id)!.size ? 0.03 : 0.12) * aspectX))
      .force('y', forceY<SimNode>(0).strength(n => (this.adj.get(n.id)!.size ? 0.03 : 0.12) * aspectY))
      .stop();
    this.sim = sim;

    // A small edit should nudge, not rebuild the picture.
    const total = this.nodes.length || 1;
    const share = fresh / total;
    sim.alpha(share > 0.5 ? 1 : Math.max(0.12, Math.min(0.6, share * 2)));
    if (this.frozen) { sim.alpha(0); return; }
    this.settle(this.animate ? 0.08 : sim.alphaMin(), this.animate ? 220 : 1600);
    if (!this.fitted && this.w > 0) { this.fitNow(null, false); this.fitted = true; }
  }

  /** Run ticks synchronously until alpha drops below `until` or the budget runs out. */
  private settle(until: number, budgetMs: number): void {
    const sim = this.sim;
    if (!sim) return;
    const t0 = performance.now();
    while (sim.alpha() > until && performance.now() - t0 < budgetMs) sim.tick();
    if (!this.animate) sim.alpha(0);
  }

  relayout(): void {
    this.known.clear();
    this.signature = '';
    for (const n of this.nodes) { n.x = undefined; n.y = undefined; n.vx = 0; n.vy = 0; n.fx = null; n.fy = null; }
    const was = this.frozen;
    this.frozen = false;
    this.place();
    this.buildSim(this.nodes.length);
    this.frozen = was;
    this.fitNow(null, true);
  }

  setFrozen(frozen: boolean): void {
    this.frozen = frozen;
    if (!frozen && this.sim) { this.sim.alpha(Math.max(this.sim.alpha(), 0.05)); }
    this.dirty = true;
    this.loop();
  }

  /* ============================================================ highlight */

  setFocus(id: string | null): void {
    this.focusId = id && this.byId.has(id) ? id : null;
    this.dirty = true;
    this.loop();
  }

  get focus(): string | null { return this.focusId; }

  /** Highlight nodes whose label contains `q`. Returns the number of matches. */
  setSearch(q: string): number {
    const s = q.trim().toLowerCase();
    if (!s) { this.matches = null; this.dirty = true; this.loop(); return 0; }
    const m = new Set<string>();
    for (const n of this.nodes) {
      const label = n.g.type === 'subhub' ? n.g.label + ' ' + folderLabel(n.g.subFolder || '') : n.g.label;
      if (label.toLowerCase().includes(s) || (n.g.path || '').toLowerCase().includes(s)) m.add(n.id);
    }
    this.matches = m;
    this.dirty = true;
    this.loop();
    return m.size;
  }

  fitMatches(): void {
    if (this.matches && this.matches.size) this.fitNow(this.matches, true);
  }

  /** What the highlight radiates from: the node being carried, else the hovered one, else the focus. */
  private centerId(): string | null {
    if (this.dragging) return this.dragging.id;
    return this.hovered?.id || this.focusId;
  }

  /**
   * The nodes a highlight radiates from: the centre, plus — for a hub split by
   * folder — its sub-hubs, so the notes behind them light up too.
   */
  private coreSet(center: string): Set<string> {
    const core = new Set<string>([center]);
    const n = this.byId.get(center);
    if (n && n.g.type === 'hub') {
      for (const id of this.adj.get(center) || []) if (this.byId.get(id)?.g.parent === center) core.add(id);
    }
    return core;
  }

  private highlight(): { all: Set<string>; core: Set<string> | null } | null {
    const center = this.centerId();
    if (center) {
      const core = this.coreSet(center);
      const all = new Set<string>(core);
      for (const c of core) for (const id of this.adj.get(c) || []) all.add(id);
      // Whatever the carried node is over stays lit, so the drop target can be read.
      if (this.dragging && this.dropTarget) all.add(this.dropTarget.id);
      return { all, core };
    }
    return this.matches ? { all: this.matches, core: null } : null;
  }

  /* ============================================================ view */

  private resize(): void {
    const r = this.parent.getBoundingClientRect();
    const w = Math.max(1, Math.floor(r.width)), h = Math.max(1, Math.floor(r.height));
    const dpr = window.devicePixelRatio || 1;
    if (w === this.w && h === this.h && dpr === this.dpr) return;
    const first = this.w === 0;
    // Keep the world point at the centre where it was.
    const cx = (this.w / 2 - this.tx) / this.k, cy = (this.h / 2 - this.ty) / this.k;
    this.w = w; this.h = h; this.dpr = dpr;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    if (first || !this.fitted) {
      if (this.nodes.length) { this.fitNow(null, false); this.fitted = true; }
      else { this.tx = w / 2; this.ty = h / 2; }
    } else {
      this.tx = w / 2 - cx * this.k; this.ty = h / 2 - cy * this.k;
    }
    this.dirty = true;
    this.loop();
  }

  fit(): void { this.fitNow(null, true); }

  private fitNow(only: Set<string> | null, animate: boolean): void {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const n of this.nodes) {
      if (only && !only.has(n.id)) continue;
      if (n.x === undefined || n.y === undefined) continue;
      x0 = Math.min(x0, n.x - n.r); y0 = Math.min(y0, n.y - n.r);
      x1 = Math.max(x1, n.x + n.r); y1 = Math.max(y1, n.y + n.r);
    }
    if (!isFinite(x0) || this.w <= 1) return;
    const pad = 40;
    // Overlays only count when the graph would still have room beside them.
    const ins = this.w - this.insets.left - this.insets.right > 320 ? this.insets : { left: 0, top: 0, right: 0, bottom: 0 };
    const aw = this.w - ins.left - ins.right - pad * 2, ah = this.h - ins.top - ins.bottom - pad * 2;
    const k = Math.max(0.05, Math.min(2.5, Math.min(aw / Math.max(1, x1 - x0), ah / Math.max(1, y1 - y0))));
    const cx = ins.left + pad + aw / 2, cy = ins.top + pad + ah / 2;
    const tx = cx - ((x0 + x1) / 2) * k, ty = cy - ((y0 + y1) / 2) * k;
    if (animate && this.animate) {
      this.viewAnim = { from: [this.tx, this.ty, this.k], to: [tx, ty, k], t0: performance.now(), ms: 320 };
    } else {
      this.tx = tx; this.ty = ty; this.k = k; this.viewAnim = null;
    }
    this.dirty = true;
    this.loop();
  }

  private zoomAt(sx: number, sy: number, k: number): void {
    k = Math.max(0.05, Math.min(6, k));
    const wx = (sx - this.tx) / this.k, wy = (sy - this.ty) / this.k;
    this.k = k;
    this.tx = sx - wx * k; this.ty = sy - wy * k;
    this.viewAnim = null;
    this.dirty = true;
    this.loop();
  }

  private toWorld(sx: number, sy: number): [number, number] {
    return [(sx - this.tx) / this.k, (sy - this.ty) / this.k];
  }

  private local(ev: { clientX: number; clientY: number }): [number, number] {
    const r = this.canvas.getBoundingClientRect();
    return [ev.clientX - r.left, ev.clientY - r.top];
  }

  /** Topmost node under a screen point. Hubs are drawn last, so they win. */
  private hit(sx: number, sy: number, skip?: SimNode | null): SimNode | null {
    const [wx, wy] = this.toWorld(sx, sy);
    const slop = 4 / this.k;
    let best: SimNode | null = null;
    let bestRank = -1;
    for (const n of this.nodes) {
      if (n === skip || n.x === undefined || n.y === undefined) continue;
      const dx = n.x - wx, dy = n.y - wy;
      const rr = n.r + slop;
      if (dx * dx + dy * dy > rr * rr) continue;
      const rank = n.g.type === 'hub' ? 2 : n.g.type === 'subhub' ? 1 : 0;
      if (rank > bestRank) { best = n; bestRank = rank; }
    }
    return best;
  }

  /* ============================================================ input */

  private bind(): void {
    const c = this.canvas;
    c.addEventListener('pointerdown', ev => this.onDown(ev));
    c.addEventListener('pointermove', ev => this.onMove(ev));
    c.addEventListener('pointerup', ev => this.onUp(ev));
    c.addEventListener('pointercancel', ev => this.onCancel(ev));
    c.addEventListener('pointerleave', ev => {
      // A finger lifting also "leaves"; on touch the tapped note's card should stay.
      if (ev.pointerType !== 'mouse') return;
      if (!this.down && this.hovered) { this.hovered = null; this.host.hover(null, null); this.dirty = true; this.loop(); }
    });
    c.addEventListener('wheel', ev => {
      ev.preventDefault();
      const [sx, sy] = this.local(ev);
      const f = Math.exp(-ev.deltaY * (ev.deltaMode === 1 ? 0.05 : 0.0015));
      this.zoomAt(sx, sy, this.k * f);
    }, { passive: false });
    c.addEventListener('contextmenu', ev => {
      ev.preventDefault();
      // A long press already opened the menu (phones also send contextmenu for it).
      if (performance.now() - this.longPressAt < 1000) return;
      const [sx, sy] = this.local(ev);
      this.host.context(this.hit(sx, sy)?.g || null, ev.clientX, ev.clientY);
    });
    c.addEventListener('dblclick', ev => {
      const [sx, sy] = this.local(ev);
      const n = this.hit(sx, sy);
      if (n && n.g.type !== 'note') this.zoomTo(n);
    });
    c.addEventListener('keydown', ev => {
      if (ev.key === 'Escape') {
        if (this.dragging) { this.cancelDrag(); return; }
        if (this.focusId) { this.focusId = null; this.host.focusChanged(null); this.dirty = true; this.loop(); }
      }
    });
  }

  private zoomTo(n: SimNode): void {
    const s = new Set<string>([n.id]);
    for (const id of this.adj.get(n.id) || []) s.add(id);
    this.fitNow(s, true);
  }

  private clearPress(): void {
    if (this.pressTimer !== null) { window.clearTimeout(this.pressTimer); this.pressTimer = null; }
  }

  private onDown(ev: PointerEvent): void {
    this.canvas.focus({ preventScroll: true });
    const [sx, sy] = this.local(ev);
    this.pointers.set(ev.pointerId, { x: sx, y: sy });
    if (this.pointers.size === 2) {
      // Second finger: switch to pinch and abandon whatever the first was doing.
      this.clearPress();
      if (this.dragging) this.cancelDrag();
      this.down = null;
      const [a, b] = [...this.pointers.values()];
      const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
      const [wx, wy] = this.toWorld(cx, cy);
      this.pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, k: this.k, cx, cy, wx, wy };
      return;
    }
    if (ev.button !== 0 && ev.pointerType === 'mouse') return;
    this.canvas.setPointerCapture(ev.pointerId);
    const node = this.hit(sx, sy);
    this.down = { id: ev.pointerId, x: sx, y: sy, node, moved: false, button: ev.button, mod: ev.ctrlKey || ev.metaKey };
    this.viewAnim = null;
    if (ev.pointerType !== 'mouse') {
      this.clearPress();
      this.pressTimer = window.setTimeout(() => {
        this.pressTimer = null;
        if (this.down && !this.down.moved) {
          const n = this.down.node;
          // The finger is still down; its release must not count as a tap.
          this.down = null;
          this.longPressAt = performance.now();
          this.longPressPointer = ev.pointerId;
          this.lastTap = { t: 0, id: '' };
          this.host.context(n?.g || null, ev.clientX, ev.clientY);
        }
      }, LONG_PRESS_MS);
    }
  }

  private onMove(ev: PointerEvent): void {
    const [sx, sy] = this.local(ev);
    if (this.pointers.has(ev.pointerId)) this.pointers.set(ev.pointerId, { x: sx, y: sy });

    if (this.pinch && this.pointers.size >= 2) {
      const [a, b] = [...this.pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
      this.k = Math.max(0.05, Math.min(6, this.pinch.k * d / this.pinch.d));
      this.tx = cx - this.pinch.wx * this.k; this.ty = cy - this.pinch.wy * this.k;
      this.dirty = true; this.loop();
      return;
    }

    const d = this.down;
    if (!d || d.id !== ev.pointerId) {
      if (ev.pointerType === 'mouse') this.updateHover(sx, sy, ev);
      return;
    }
    if (!d.moved && Math.hypot(sx - d.x, sy - d.y) > DRAG_PX) {
      d.moved = true;
      this.clearPress();
      if (d.node) this.startDrag(d.node);
    }
    if (!d.moved) return;

    if (this.dragging) {
      const [wx, wy] = this.toWorld(sx, sy);
      const n = this.dragging;
      n.fx = wx; n.fy = wy; n.x = wx; n.y = wy;
      this.dragScreen = { x: sx, y: sy };
      const target = this.hit(sx, sy, n);
      if (target !== this.dropTarget) {
        this.dropTarget = target;
        this.verdict = target ? this.host.dropVerdict(n.g, target.g) : null;
        this.holdTarget(target);
      }
      this.edgePan(sx, sy);
    } else {
      this.tx += sx - d.x; this.ty += sy - d.y;
      d.x = sx; d.y = sy;
    }
    this.dirty = true;
    this.loop();
  }

  /** While dragging near the edge, scroll the view so far-away targets can be reached. */
  private edgePan(sx: number, sy: number): void {
    const m = 28, v = 9;
    let dx = 0, dy = 0;
    if (sx < m) dx = v; else if (sx > this.w - m) dx = -v;
    if (sy < m) dy = v; else if (sy > this.h - m) dy = -v;
    if (dx || dy) { this.tx += dx; this.ty += dy; }
  }

  private onUp(ev: PointerEvent): void {
    this.pointers.delete(ev.pointerId);
    this.clearPress();
    if (ev.pointerId === this.longPressPointer) {
      // The menu opened under the finger; the click that follows the lift
      // would land on its first item. Swallow that one click.
      this.longPressPointer = null;
      const swallow = (e: MouseEvent) => { e.preventDefault(); e.stopPropagation(); };
      window.addEventListener('click', swallow, { capture: true, once: true });
      window.setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 600);
    }
    if (this.pinch) { if (this.pointers.size < 2) this.pinch = null; return; }
    const d = this.down;
    if (!d || d.id !== ev.pointerId) return;
    this.down = null;
    if (this.canvas.hasPointerCapture(ev.pointerId)) this.canvas.releasePointerCapture(ev.pointerId);

    if (this.dragging) {
      const n = this.dragging, target = this.dropTarget, verdict = this.verdict;
      this.endDrag();
      if (target && verdict && verdict.ok) this.host.drop(n.g, target.g);
      return;
    }
    if (d.moved) return;

    // A click.
    const n = d.node;
    if (!n) {
      if (this.focusId) { this.focusId = null; this.host.focusChanged(null); this.dirty = true; this.loop(); }
      return;
    }
    if (n.g.type === 'note') {
      // Touch has no hover: the first tap shows the note's neighbourhood and
      // card, a second tap on the same note opens it.
      if (ev.pointerType !== 'mouse') {
        const now = performance.now();
        if (this.lastTap.id !== n.id || now - this.lastTap.t > 2500) {
          this.lastTap = { t: now, id: n.id };
          this.hovered = n;
          this.host.hover(n.g, ev);
          this.dirty = true; this.loop();
          return;
        }
      }
      this.host.open(n.g, d.mod || ev.button === 1);
      return;
    }
    this.focusId = this.focusId === n.id ? null : n.id;
    this.host.focusChanged(this.focusId);
    this.dirty = true;
    this.loop();
  }

  private onCancel(ev: PointerEvent): void {
    this.pointers.delete(ev.pointerId);
    this.clearPress();
    if (this.pointers.size < 2) this.pinch = null;
    if (this.down?.id === ev.pointerId) { this.down = null; if (this.dragging) this.cancelDrag(); }
  }

  private updateHover(sx: number, sy: number, ev: PointerEvent): void {
    const n = this.hit(sx, sy);
    if (n !== this.hovered) {
      this.hovered = n;
      this.canvas.toggleClass('is-over-node', !!n);
      this.dirty = true;
      this.loop();
    }
    this.host.hover(n?.g || null, ev);
  }

  private startDrag(n: SimNode): void {
    this.dragging = n;
    this.hovered = null;
    this.host.hover(null, null);
    this.canvas.addClass('is-dragging');
    n.fx = n.x; n.fy = n.y;
    // The layout stays alive while a node is carried, so its neighbours follow
    // it. Only a frozen or motionless graph holds still.
    if (this.sim && !this.frozen && this.animate) this.sim.alphaTarget(0.08).alpha(Math.max(this.sim.alpha(), 0.08));
  }

  /**
   * Hold the node under the pointer in place while something is dragged over
   * it. Otherwise the carried node's repulsion pushes its own drop target away.
   */
  private holdTarget(target: SimNode | null): void {
    const prev = this.held;
    if (prev && prev.node !== target) {
      if (!prev.wasPinned) { prev.node.fx = null; prev.node.fy = null; }
      this.held = null;
    }
    if (target && (!this.held || this.held.node !== target)) {
      const wasPinned = target.fx !== null && target.fx !== undefined;
      target.fx = target.x; target.fy = target.y;
      target.vx = 0; target.vy = 0;
      this.held = { node: target, wasPinned };
    }
  }

  private endDrag(): void {
    const n = this.dragging;
    if (!n) return;
    this.dragging = null;
    this.dropTarget = null;
    this.verdict = null;
    this.canvas.removeClass('is-dragging');
    this.holdTarget(null);
    // Frozen: the node stays where it was put. Otherwise it rejoins the layout.
    n.fx = null; n.fy = null;
    n.vx = 0; n.vy = 0;
    if (this.sim) this.sim.alphaTarget(0);
    if (this.sim && !this.frozen) this.sim.alpha(Math.max(this.sim.alpha(), 0.08));
    this.dirty = true;
    this.loop();
  }

  private cancelDrag(): void { this.endDrag(); }

  /* ============================================================ frame loop */

  private loop(): void {
    if (this.raf || this.destroyed) return;
    this.raf = window.requestAnimationFrame(() => {
      this.raf = 0;
      if (this.destroyed) return;
      let again = false;
      const sim = this.sim;
      if (sim && !this.frozen && (sim.alpha() > sim.alphaMin() || (this.dragging && this.animate))) {
        if (this.animate) { sim.tick(); again = true; this.dirty = true; }
        else { this.settle(sim.alphaMin(), 400); this.dirty = true; }
      }
      if (this.viewAnim) {
        const a = this.viewAnim;
        const p = Math.min(1, (performance.now() - a.t0) / a.ms);
        const e = 1 - Math.pow(1 - p, 3);
        this.tx = a.from[0] + (a.to[0] - a.from[0]) * e;
        this.ty = a.from[1] + (a.to[1] - a.from[1]) * e;
        this.k = a.from[2] + (a.to[2] - a.from[2]) * e;
        if (p >= 1) this.viewAnim = null; else again = true;
        this.dirty = true;
      }
      if (this.dirty) { this.dirty = false; this.draw(); }
      if (again) this.loop();
    });
  }

  /* ============================================================ drawing */

  private draw(): void {
    const ctx = this.ctx, th = this.theme, k = this.k;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = th.bg;
    ctx.fillRect(0, 0, this.w, this.h);
    ctx.setTransform(this.dpr * k, 0, 0, this.dpr * k, this.dpr * this.tx, this.dpr * this.ty);

    const h = this.highlight();
    const hl = h ? h.all : null;
    const core = h ? h.core : null;
    const px = 1 / k;
    // Under focus only the spokes from the centre are lit, not edges between its neighbours.
    const lit = (e: SimEdge) => !hl || (hl.has(e.source.id) && hl.has(e.target.id) &&
      (!core || core.has(e.source.id) || core.has(e.target.id)));

    /* ---- edges, batched by style ---- */
    const batches = new Map<string, { color: string; width: number; dash: number[]; alpha: number; segs: SimEdge[] }>();
    const add = (key: string, color: string, width: number, dash: number[], alpha: number, e: SimEdge) => {
      let b = batches.get(key);
      if (!b) { b = { color, width, dash, alpha, segs: [] }; batches.set(key, b); }
      b.segs.push(e);
    };
    for (const e of this.edges) {
      const on = lit(e);
      const dim = hl && !on;
      const a = dim ? 0.06 : 1;
      if (e.e.type === 'member') {
        add('m' + e.e.facet + (dim ? 'd' : on && hl ? 'h' : ''), this.host.facetColor(e.e.facet!), (on && hl ? 1.6 : 1.1) * px, [], a * (on && hl ? 0.85 : 0.45), e);
      } else if (e.e.type === 'split') {
        add('s' + e.e.facet + (dim ? 'd' : ''), this.host.facetColor(e.e.facet!), 1.4 * px, [4 * px, 3 * px], a * 0.6, e);
      } else {
        const kind = e.e.kind || 'body';
        const color = kind === 'property' ? th.accent : th.muted;
        const dash = kind === 'heading' ? [6 * px, 3 * px] : kind === 'block' ? [1.5 * px, 3 * px] : kind === 'embed' ? [10 * px, 3 * px, 2 * px, 3 * px] : [];
        add('l' + kind + (dim ? 'd' : on && hl ? 'h' : ''), color, (on && hl ? 1.8 : 1) * px, dash, a * (on && hl ? 0.95 : 0.3), e);
      }
    }
    ctx.lineCap = 'round';
    for (const b of batches.values()) {
      ctx.strokeStyle = b.color;
      ctx.globalAlpha = b.alpha;
      ctx.lineWidth = b.width;
      ctx.setLineDash(b.dash);
      ctx.beginPath();
      for (const e of b.segs) { ctx.moveTo(e.source.x!, e.source.y!); ctx.lineTo(e.target.x!, e.target.y!); }
      ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;

    /* ---- nodes: notes, then sub-hubs, then hubs on top ---- */
    const order: SimNode[] = [];
    for (const n of this.nodes) if (n.g.type === 'note') order.push(n);
    for (const n of this.nodes) if (n.g.type === 'subhub') order.push(n);
    for (const n of this.nodes) if (n.g.type === 'hub') order.push(n);
    // What is being dragged is drawn above what it is dragged over.
    if (this.dragging) { order.splice(order.indexOf(this.dragging), 1); order.push(this.dragging); }
    for (const n of order) {
      if (n.x === undefined || n.y === undefined) continue;
      const dim = !!hl && !hl.has(n.id);
      ctx.globalAlpha = dim ? 0.14 : 1;
      if (n.g.type === 'note') this.drawNote(n, px);
      else this.drawHub(n, px);
      if (this.matches && this.matches.has(n.id)) {
        ctx.globalAlpha = 1;
        ctx.strokeStyle = th.accent;
        ctx.lineWidth = 2.5 * px;
        ctx.beginPath(); ctx.arc(n.x, n.y, n.r + 4 * px, 0, TAU); ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;

    /* ---- drop target ring ---- */
    if (this.dragging && this.dropTarget && this.verdict) {
      const t = this.dropTarget;
      ctx.strokeStyle = this.verdict.ok ? th.accent : th.faint;
      ctx.lineWidth = 3 * px;
      ctx.setLineDash(this.verdict.ok ? [] : [4 * px, 4 * px]);
      ctx.beginPath(); ctx.arc(t.x!, t.y!, t.r + 6 * px, 0, TAU); ctx.stroke();
      ctx.setLineDash([]);
    }

    /* ---- labels, in screen space so they stay one size ---- */
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.drawLabels(hl);

    if (this.dragging && this.verdict) this.drawBadge(this.verdict);
  }

  private drawNote(n: SimNode, px: number): void {
    const ctx = this.ctx, th = this.theme;
    const x = n.x!, y = n.y!, r = n.r;
    const cols = n.g.colors;
    const screenR = r * this.k;
    if (cols.length === 0) {
      ctx.fillStyle = th.muted;
      ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fill();
    } else if (cols.length === 1 || screenR < 3) {
      ctx.fillStyle = this.host.noteColor(cols[0]);
      ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fill();
    } else {
      // Several values: one slice each, up to four, like a pie.
      const shown = cols.slice(0, 4);
      const step = TAU / shown.length;
      shown.forEach((c, i) => {
        ctx.fillStyle = this.host.noteColor(c);
        ctx.beginPath(); ctx.moveTo(x, y);
        ctx.arc(x, y, r, -Math.PI / 2 + i * step, -Math.PI / 2 + (i + 1) * step);
        ctx.closePath(); ctx.fill();
      });
    }
    ctx.strokeStyle = th.bg;
    ctx.lineWidth = 1.5 * px;
    ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.stroke();
    if (this.hovered === n || this.focusId === n.id || this.dragging === n) {
      ctx.strokeStyle = th.text;
      ctx.lineWidth = 1.5 * px;
      ctx.beginPath(); ctx.arc(x, y, r + 2.5 * px, 0, TAU); ctx.stroke();
    }
  }

  private drawHub(n: SimNode, px: number): void {
    const ctx = this.ctx;
    const x = n.x!, y = n.y!, r = n.r;
    const color = this.host.facetColor(n.g.facet!);
    const ga = ctx.globalAlpha;
    ctx.fillStyle = this.theme.bg;
    ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fill();
    ctx.fillStyle = color;
    ctx.globalAlpha = ga * (n.g.type === 'hub' ? 0.22 : 0.12);
    ctx.fill();
    ctx.globalAlpha = ga;
    ctx.strokeStyle = color;
    ctx.lineWidth = (n.g.type === 'hub' ? 2.2 : 1.5) * px;
    if (n.g.type === 'subhub') ctx.setLineDash([3 * px, 2 * px]);
    ctx.stroke();
    ctx.setLineDash([]);
    if (this.focusId === n.id || this.hovered === n) {
      ctx.lineWidth = 1.5 * px;
      ctx.strokeStyle = this.theme.text;
      ctx.beginPath(); ctx.arc(x, y, r + 3 * px, 0, TAU); ctx.stroke();
    }
    // The count, inside the hub when there is room.
    if (n.g.type === 'hub' && r * this.k >= 12) {
      ctx.fillStyle = color;
      ctx.font = `600 ${Math.min(r * 0.8, 14 / this.k)}px ${this.theme.font}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(n.g.count), x, y);
    }
  }

  /**
   * Labels in priority order — the node under the pointer, highlighted and
   * matching nodes, hubs by size, then notes — each skipped if it would overlap
   * one already drawn. Dense areas stay readable instead of turning into ink.
   */
  private drawLabels(hl: Set<string> | null): void {
    const th = this.theme, k = this.k;
    const center = this.centerId();
    type Item = { n: SimNode; text: string; font: string; color: string; rank: number };
    const items: Item[] = [];
    const hubCap = k < 0.35 ? 24 : k < 0.7 ? 80 : Infinity;
    let hubsSeen = 0;
    const hubs = this.nodes.filter(n => n.g.type !== 'note').sort((a, b) => b.g.count - a.g.count);
    for (const n of hubs) {
      if (hl && !hl.has(n.id)) continue;
      if (!hl && hubsSeen++ >= hubCap) continue;
      const text = n.g.type === 'subhub' ? n.g.label + ' · ' + folderLabel(n.g.subFolder || '') : n.g.label;
      const isHub = n.g.type === 'hub';
      items.push({ n, text, font: `${isHub ? 600 : 500} ${isHub ? 12 : 11}px ${th.font}`, color: isHub ? th.text : th.muted,
        rank: n.id === center ? 0 : isHub ? 2 : 3 });
    }
    const showAllNotes = k >= 1.15;
    for (const n of this.nodes) {
      if (n.g.type !== 'note') continue;
      const special = this.hovered === n || this.focusId === n.id || this.dragging === n || (!!this.matches && this.matches.has(n.id));
      const inHl = !!hl && hl.has(n.id) && !!center;
      if (!(special || inHl || (showAllNotes && !hl))) continue;
      items.push({ n, text: n.g.label, font: `${special ? 600 : 400} 11px ${th.font}`, color: special ? th.text : th.muted,
        rank: n.id === center || this.dragging === n ? 0 : special ? 1 : 4 });
    }
    items.sort((a, b) => a.rank - b.rank);

    const ctx = this.ctx;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.lineJoin = 'round';
    const placed: [number, number, number, number][] = [];
    let drawn = 0;
    for (const it of items) {
      if (drawn > 500) break;
      const n = it.n;
      const sx = n.x! * k + this.tx, sy = (n.y! + n.r) * k + this.ty + 3;
      if (sx < -200 || sx > this.w + 200 || sy < -40 || sy > this.h + 40) continue;
      const s = it.text.length > 40 ? it.text.slice(0, 38) + '…' : it.text;
      ctx.font = it.font;
      const w = ctx.measureText(s).width, h = 13;
      const box: [number, number, number, number] = [sx - w / 2 - 2, sy - 1, sx + w / 2 + 2, sy + h];
      if (it.rank > 0 && placed.some(p => box[0] < p[2] && box[2] > p[0] && box[1] < p[3] && box[3] > p[1])) continue;
      placed.push(box);
      ctx.strokeStyle = th.bg;
      ctx.lineWidth = 3;
      ctx.globalAlpha = 0.9;
      ctx.strokeText(s, sx, sy);
      ctx.globalAlpha = 1;
      ctx.fillStyle = it.color;
      ctx.fillText(s, sx, sy);
      drawn++;
    }
  }

  private drawBadge(v: DropVerdict): void {
    const ctx = this.ctx, th = this.theme;
    ctx.font = `600 12px ${th.font}`;
    const w = ctx.measureText(v.text).width + 16;
    let x = this.dragScreen.x + 14, y = this.dragScreen.y - 30;
    if (x + w > this.w - 4) x = this.dragScreen.x - 14 - w;
    if (y < 4) y = this.dragScreen.y + 18;
    ctx.fillStyle = v.ok ? th.accent : th.bg;
    ctx.strokeStyle = v.ok ? th.accent : th.faint;
    ctx.lineWidth = 1;
    const h = 22, r = 6;
    ctx.beginPath();
    ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y); ctx.arcTo(x + w, y, x + w, y + r, r);
    ctx.lineTo(x + w, y + h - r); ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
    ctx.lineTo(x + r, y + h); ctx.arcTo(x, y + h, x, y + h - r, r);
    ctx.lineTo(x, y + r); ctx.arcTo(x, y, x + r, y, r);
    ctx.fill(); ctx.stroke();
    ctx.fillStyle = v.ok ? th.accentText : th.muted;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(v.text, x + 8, y + h / 2 + 0.5);
  }

  /** Redraw after a theme change. */
  refresh(): void { this.dirty = true; this.loop(); }

  /** For tests: where a node is on screen. */
  screenOf(id: string): { x: number; y: number } | null {
    const n = this.byId.get(id);
    if (!n || n.x === undefined || n.y === undefined) return null;
    return { x: n.x * this.k + this.tx, y: n.y * this.k + this.ty };
  }
}
