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
  /** Eased highlight state, 0..1: how far it is dimmed, and how far it is lit as a neighbour. */
  dim: number;
  lit: number;
  /** Eased size multiplier: hovered nodes and drop targets swell a little. */
  grow: number;
  /** When it started to appear (0: it is simply there), and over how long. */
  born: number;
  bornMs: number;
  /** A highlight reaches this node at this time, so a focus spreads outwards. */
  waveAt: number;
  /** How far it has appeared this frame: scale (may overshoot) and opacity. */
  as: number;
  aa: number;
}
interface SimEdge extends SimulationLinkDatum<SimNode> {
  e: GEdge;
  source: SimNode;
  target: SimNode;
  dim: number;
  lit: number;
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
  /** `linkKey`: Alt, Ctrl or Cmd is held (or the drag is by touch, which has no keys). */
  dropVerdict(dragged: GNode, target: GNode, linkKey: boolean): DropVerdict | null;
  drop(dragged: GNode, target: GNode, linkKey: boolean): void;
  hover(node: GNode | null, ev: PointerEvent | null): void;
  focusChanged(id: string | null): void;
}

export interface LayoutOptions {
  animate: boolean;
}

/** What the graph settings panel controls. Ranges and defaults follow Obsidian's own graph view. */
export interface GraphSettings {
  arrows: boolean;
  /** -3..3: higher shows note names from further out. */
  textFade: number;
  nodeSize: number;
  linkWidth: number;
  centerForce: number;
  repelForce: number;
  linkForce: number;
  linkDistance: number;
}

export const GRAPH_DEFAULTS: GraphSettings = {
  arrows: false, textFade: 0, nodeSize: 1, linkWidth: 1,
  centerForce: 0.5, repelForce: 10, linkForce: 1, linkDistance: 250,
};

const TAU = Math.PI * 2;
const DRAG_PX = 4;
/** How near, on screen, the pointer must come to a node for it to take a drop. */
const DROP_CATCH_PX = 14;
/** While dragging, nodes this near the pointer on screen hold still. */
const HOLD_PX = 110;
const LONG_PRESS_MS = 550;
/** Time constant of the highlight fade: quick, but eased rather than a jump. */
const FADE_MS = 70;
/** How far a dimmed node and a dimmed edge fade. */
const DIM_NODE = 0.86, DIM_EDGE = 0.94;
/** Opening bloom: hubs first, notes after, spreading out from the middle. */
const INTRO_MS = 480, INTRO_SPREAD_MS = 420;
/** A node that arrives after an edit pops in; one that leaves shrinks away. */
const POP_MS = 360, GHOST_MS = 260;
/** A focus spreads at this many screen pixels per millisecond, and reaches everything within this time. */
const WAVE_SPEED = 2.2, WAVE_MAX_MS = 180;
const RIPPLE_MS = 700;

/** Overshoots a little before settling, so a node landing reads as a landing. */
function easeOutBack(p: number): number {
  const c = 1.7, q = p - 1;
  return 1 + (c + 1) * q * q * q + c * q * q;
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

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
  private gs: GraphSettings = { ...GRAPH_DEFAULTS };
  private aspect: [number, number] = [1, 1];

  private hovered: SimNode | null = null;
  private focusId: string | null = null;
  /** A node highlighted from outside the canvas, e.g. while its legend row is hovered. */
  private previewId: string | null = null;
  private matches: Set<string> | null = null;
  /** Nodes lit from outside as a group, e.g. the untagged notes the details panel points at. */
  private spotlight: Set<string> | null = null;
  private fadeAt = 0;
  /** The highlight centre the current wave started from. */
  private waveCenter: string | null = null;
  /** Nodes that left with the last data change, shrinking away where they were. */
  private ghosts: { n: SimNode; t0: number }[] = [];
  private ripples: { x: number; y: number; r: number; color: string; t0: number }[] = [];
  private badgeAt = 0;

  private pointers = new Map<number, { x: number; y: number }>();
  private down: { id: number; x: number; y: number; node: SimNode | null; moved: boolean; button: number; mod: boolean } | null = null;
  private dragging: SimNode | null = null;
  private dropTarget: SimNode | null = null;
  private held: { node: SimNode; wasPinned: boolean } | null = null;
  /** Nodes held still because the pointer is near them mid-drag, and whether they were pinned before. */
  private stilled = new Map<SimNode, boolean>();
  /** Modifier keys held during the current drag, and whether it is by touch or pen. */
  private dragKeys = false;
  private dragTouch = false;
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
        n.g = g; n.r = this.radius(g);
      });
      if (this.edges.length === model.edges.length) model.edges.forEach((e, i) => { this.edges[i].e = e; });
      this.dirty = true;
      this.loop();
      return;
    }
    this.signature = sig;
    for (const n of this.nodes) if (n.x !== undefined && n.y !== undefined) this.known.set(n.id, { x: n.x, y: n.y });
    const intro = this.nodes.length === 0;

    // Nodes that stay keep their highlight state, so a redraw mid-fade does not flash.
    const nodes: SimNode[] = model.nodes.map(g => {
      const old = this.byId.get(g.id);
      return old
        ? { id: g.id, g, r: this.radius(g), dim: old.dim, lit: old.lit, grow: old.grow, born: old.born, bornMs: old.bornMs, waveAt: 0, as: old.as, aa: old.aa }
        : { id: g.id, g, r: this.radius(g), dim: 0, lit: 0, grow: 1, born: -1, bornMs: 0, waveAt: 0, as: 1, aa: 1 };
    });
    const byId = new Map(nodes.map(n => [n.id, n]));
    if (this.motion()) {
      const now = performance.now();
      for (const n of this.nodes) if (!byId.has(n.id) && n.x !== undefined) this.ghosts.push({ n, t0: now });
    }
    const edges: SimEdge[] = [];
    const adj = new Map<string, Set<string>>();
    for (const n of nodes) adj.set(n.id, new Set());
    for (const e of model.edges) {
      const s = byId.get(e.source), t = byId.get(e.target);
      if (!s || !t) continue;
      edges.push({ e, source: s, target: t, dim: Math.max(s.dim, t.dim), lit: 0 });
      adj.get(s.id)!.add(t.id);
      adj.get(t.id)!.add(s.id);
    }
    this.nodes = nodes; this.edges = edges; this.byId = byId; this.adj = adj;
    if (this.focusId && !byId.has(this.focusId)) { this.focusId = null; this.host.focusChanged(null); }
    if (this.hovered && !byId.has(this.hovered.id)) this.hovered = null;
    if (this.previewId && !byId.has(this.previewId)) this.previewId = null;

    const fresh = this.place();
    this.buildSim(fresh);
    // What an edit added pops in where it was placed; the first picture blooms.
    const now = performance.now(), pop = !intro && this.motion();
    for (const n of nodes) if (n.born < 0) { n.born = pop ? now + hash(n.id) % 90 : 0; n.bornMs = POP_MS; }
    if (intro) this.bloom();
    this.dirty = true;
    this.loop();
  }

  /** Motion on, and the reader has not asked their system for less of it. */
  private motion(): boolean {
    return this.animate && !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  /**
   * The opening: hubs grow in first, then notes, spreading out from the middle
   * of the picture — so the eye learns where the hubs are before the notes arrive.
   */
  private bloom(): void {
    if (!this.motion()) return;
    let cx = 0, cy = 0, c = 0;
    for (const n of this.nodes) if (n.x !== undefined && n.y !== undefined) { cx += n.x; cy += n.y; c++; }
    if (!c) return;
    cx /= c; cy /= c;
    let far = 1;
    for (const n of this.nodes) far = Math.max(far, Math.hypot(n.x! - cx, n.y! - cy));
    const now = performance.now() + 40;
    for (const n of this.nodes) {
      const d = Math.hypot(n.x! - cx, n.y! - cy) / far;
      const hubLike = n.g.type !== 'note';
      n.born = now + (hubLike ? d * INTRO_SPREAD_MS * 0.45 : 120 + d * INTRO_SPREAD_MS);
      n.bornMs = hubLike ? INTRO_MS + 80 : INTRO_MS;
    }
  }

  /** Set how far a node has appeared by now. Returns true while it is still appearing. */
  private appear(n: SimNode, now: number): boolean {
    if (!n.born) { n.as = 1; n.aa = 1; return false; }
    const p = clamp01((now - n.born) / n.bornMs);
    if (p >= 1) { n.born = 0; n.as = 1; n.aa = 1; return false; }
    n.as = Math.max(0, easeOutBack(p)); n.aa = clamp01(p * 2.5);
    return true;
  }

  /** A ring that spreads from a node: what just changed. */
  pulse(id: string): void {
    const n = this.byId.get(id);
    if (!n || n.x === undefined || n.y === undefined || !this.motion()) return;
    const color = n.g.type === 'note' ? this.theme.accent : this.host.facetColor(n.g.facet!);
    this.ripples.push({ x: n.x, y: n.y, r: n.r, color, t0: performance.now() });
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

  private radius(g: GNode): number {
    return radiusOf(g) * this.gs.nodeSize;
  }

  /**
   * Install the forces. The graph settings scale the tuned defaults rather
   * than replace them, so the default settings give the picture people know.
   */
  private applyForces(): void {
    const sim = this.sim;
    if (!sim) return;
    const gs = this.gs, d = GRAPH_DEFAULTS;
    const dist = gs.linkDistance / d.linkDistance;
    const pull = gs.linkForce / d.linkForce;
    const repel = gs.repelForce / d.repelForce;
    const center = gs.centerForce / d.centerForce;
    const [aspectX, aspectY] = this.aspect;
    const deg = (n: SimNode) => this.adj.get(n.id)!.size || 1;
    sim
      .force('link', forceLink<SimNode, SimEdge>(this.edges)
        .distance(l => l.e.type === 'member' ? l.target.r + 26 * dist
          : l.e.type === 'split' || l.e.type === 'tree' ? l.target.r + l.source.r + 18 * dist : 46 * dist)
        .strength(l => {
          const base = 1 / Math.min(deg(l.source), deg(l.target));
          return pull * (l.e.type === 'link' ? base * 0.5 : l.e.type === 'split' || l.e.type === 'tree' ? 0.7 : base);
        }))
      // The node being carried neither pushes nor bumps: otherwise whatever it is
      // brought towards — a small note above all — backs away before it can be dropped on.
      .force('charge', forceManyBody<SimNode>()
        .strength(n => n === this.dragging ? 0 : repel * (n.g.type === 'hub' ? -220 - Math.min(400, n.g.count * 6) : n.g.type === 'subhub' ? -110 : -38))
        .distanceMax(900).theta(0.9))
      .force('collide', forceCollide<SimNode>(n => n === this.dragging ? 0 : n.r + (n.g.type === 'note' ? 2 : 6)).iterations(1))
      // Pull towards the middle in proportion to the view's shape, so a wide
      // pane gets a wide graph. Notes with no connections are held closer, or
      // they drift to the edge and shrink everything else when fitting.
      .force('x', forceX<SimNode>(0).strength(n => center * (this.adj.get(n.id)!.size ? 0.03 : 0.12) * aspectX))
      .force('y', forceY<SimNode>(0).strength(n => center * (this.adj.get(n.id)!.size ? 0.03 : 0.12) * aspectY));
  }

  /** Change the graph settings. Forces and node size nudge the layout; the rest only redraws. */
  setSettings(next: GraphSettings): void {
    const prev = this.gs;
    this.gs = { ...next };
    const sized = prev.nodeSize !== next.nodeSize;
    if (sized) for (const n of this.nodes) n.r = this.radius(n.g);
    const moved = sized || prev.centerForce !== next.centerForce || prev.repelForce !== next.repelForce ||
      prev.linkForce !== next.linkForce || prev.linkDistance !== next.linkDistance;
    if (moved && this.sim) {
      this.applyForces();
      if (!this.frozen) this.sim.alpha(Math.max(this.sim.alpha(), 0.3));
    }
    this.dirty = true;
    this.loop();
  }

  private buildSim(fresh: number): void {
    this.sim?.stop();
    // The pane's shape shapes the layout; read it now, as the resize observer
    // may not have reported yet and a guess would give a different picture.
    const box = this.parent.getBoundingClientRect();
    const bw = box.width || this.w, bh = box.height || this.h;
    const ratio = bw > 1 && bh > 1 ? Math.max(0.5, Math.min(2.2, Math.round(bw / bh * 10) / 10)) : 1.4;
    this.aspect = [1 / ratio, ratio];
    const sim = forceSimulation<SimNode, SimEdge>(this.nodes).randomSource(lcg(1234567)).stop();
    this.sim = sim;
    this.applyForces();

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
    this.bloom();
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

  /**
   * If a node is off screen or under an overlay (the details panel opening
   * next to it, say), glide it into the open part of the view. Zoom stays.
   */
  ensureVisible(id: string): void {
    const n = this.byId.get(id);
    if (!n || n.x === undefined || n.y === undefined || this.w <= 1) return;
    const ins = this.w - this.insets.left - this.insets.right > 320 ? this.insets : { left: 0, top: 0, right: 0, bottom: 0 };
    const [tx, ty] = this.viewAnim ? [this.viewAnim.to[0], this.viewAnim.to[1]] : [this.tx, this.ty];
    const k = this.viewAnim ? this.viewAnim.to[2] : this.k;
    // The node and its neighbours, on screen as they will be.
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const m of [n, ...[...this.adj.get(id) || []].map(i => this.byId.get(i)!)]) {
      if (m.x === undefined || m.y === undefined) continue;
      const sx = m.x * k + tx, sy = m.y * k + ty, r = m.r * k + 16;
      x0 = Math.min(x0, sx - r); x1 = Math.max(x1, sx + r); y0 = Math.min(y0, sy - r); y1 = Math.max(y1, sy + r + 14);
    }
    const fx0 = ins.left + 8, fx1 = this.w - ins.right - 8, fy0 = ins.top, fy1 = this.h - ins.bottom;
    // Per axis: if the group fits, the least move that brings it all in; if not, centre the node.
    const shift = (a0: number, a1: number, f0: number, f1: number, at: number): number => {
      if (a1 - a0 <= f1 - f0) return a0 < f0 ? f0 - a0 : a1 > f1 ? f1 - a1 : 0;
      return (f0 + f1) / 2 - at;
    };
    const dx = shift(x0, x1, fx0, fx1, n.x * k + tx), dy = shift(y0, y1, fy0, fy1, n.y * k + ty);
    if (Math.abs(dx) < 2 && Math.abs(dy) < 2) return;
    const to: [number, number, number] = [tx + dx, ty + dy, k];
    if (this.motion()) this.viewAnim = { from: [this.tx, this.ty, this.k], to, t0: performance.now(), ms: 360 };
    else { [this.tx, this.ty, this.k] = to; this.viewAnim = null; }
    this.dirty = true;
    this.loop();
  }

  /** Fit the view to a group of nodes. */
  fitIds(ids: Iterable<string>): void {
    const s = new Set(ids);
    if (s.size) this.fitNow(s, true);
  }

  /** Light a group of nodes, dimming the rest, until cleared with null. */
  setSpotlight(ids: Iterable<string> | null): void {
    const next = ids ? new Set([...ids].filter(id => this.byId.has(id))) : null;
    this.spotlight = next && next.size ? next : null;
    this.dirty = true;
    this.loop();
  }

  /** Zoom out or in around the middle of the view. */
  zoomBy(f: number): void {
    this.zoomAt(this.w / 2, this.h / 2, this.k * f);
  }

  /** Highlight a node as if it were hovered, e.g. while its legend row is. */
  setPreview(id: string | null): void {
    const next = id && this.byId.has(id) ? id : null;
    if (next === this.previewId) return;
    this.previewId = next;
    this.dirty = true;
    this.loop();
  }

  /** Zoom to a node and its neighbours. */
  zoomToId(id: string): void {
    const n = this.byId.get(id);
    if (n) this.zoomTo(n);
  }

  /** What the highlight radiates from: the node being carried, else the hovered one, a preview, the focus. */
  private centerId(): string | null {
    if (this.dragging) return this.dragging.id;
    return this.hovered?.id || this.previewId || this.focusId;
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
    const group = this.spotlight || this.matches;
    return group ? { all: group, core: null } : null;
  }

  /** Under focus only the spokes from the centre are lit, not edges between its neighbours. */
  private edgeOn(e: SimEdge, hl: Set<string>, core: Set<string> | null): boolean {
    return hl.has(e.source.id) && hl.has(e.target.id) && (!core || core.has(e.source.id) || core.has(e.target.id));
  }

  /**
   * Ease every node and edge towards what the highlight asks of it, the way
   * Obsidian's graph does: quick, but a fade rather than a jump. Returns true
   * while something is still on its way.
   */
  private stepFade(now: number): boolean {
    const dt = this.fadeAt ? Math.min(100, now - this.fadeAt) : 16;
    this.fadeAt = now;
    const a = 1 - Math.exp(-dt / FADE_MS);
    const h = this.highlight();
    const hl = h ? h.all : null, core = h ? h.core : null;
    this.startWave(now);
    let busy = false;
    const ease = (cur: number, to: number, at = 0): number => {
      if (cur === to) return to;
      // The wave has not reached it yet: hold, but keep the frames coming.
      if (now < at) { busy = true; return cur; }
      const v = cur + (to - cur) * a;
      if (Math.abs(to - v) < 0.01) return to;
      busy = true;
      return v;
    };
    const over = this.dragging && this.dropTarget && this.verdict?.ok ? this.dropTarget : null;
    const pointed = this.hovered || (this.previewId ? this.byId.get(this.previewId) : null) || null;
    for (const n of this.nodes) {
      const on = !!hl && hl.has(n.id);
      n.dim = ease(n.dim, hl && !on ? 1 : 0, n.waveAt);
      n.lit = ease(n.lit, on && core ? 1 : 0, n.waveAt);
      n.grow = ease(n.grow, n === over ? 1.22 : n === pointed || n === this.dragging ? 1.12 : 1);
    }
    for (const e of this.edges) {
      const on = !!hl && this.edgeOn(e, hl, core);
      const at = Math.max(e.source.waveAt, e.target.waveAt);
      e.dim = ease(e.dim, hl && !on ? 1 : 0, at);
      e.lit = ease(e.lit, on ? 1 : 0, at);
    }
    return busy;
  }

  /**
   * When the focus moves, its highlight spreads from the new centre outwards
   * instead of switching everywhere at once, so the eye follows it. Hover
   * spreads faster, as it follows the hand; dragging and clearing are immediate.
   */
  private startWave(now: number): void {
    const center = this.centerId();
    if (center === this.waveCenter) return;
    this.waveCenter = center;
    const c = center && !this.dragging ? this.byId.get(center) : undefined;
    const cx = c?.x, cy = c?.y;
    const wave = cx !== undefined && cy !== undefined && this.motion();
    const max = this.hovered || this.previewId ? WAVE_MAX_MS * 0.6 : WAVE_MAX_MS;
    for (const n of this.nodes) {
      n.waveAt = wave && n.x !== undefined && n.y !== undefined
        ? now + Math.min(max, Math.hypot(n.x - cx, n.y - cy) * this.k / WAVE_SPEED)
        : 0;
    }
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

  /**
   * Topmost node under a screen point. Hubs are drawn last, so they win.
   * `catchPx` widens the reach (for drop targets, so a small note need not be
   * hit dead on); outside every node, the one whose rim is nearest is taken.
   */
  private hit(sx: number, sy: number, skip?: SimNode | null, catchPx = 4): SimNode | null {
    const [wx, wy] = this.toWorld(sx, sy);
    const slop = catchPx / this.k;
    let best: SimNode | null = null;
    let bestRank = -1, bestGap = Infinity;
    for (const n of this.nodes) {
      if (n === skip || n.x === undefined || n.y === undefined) continue;
      const d = Math.hypot(n.x - wx, n.y - wy);
      if (d > n.r + slop) continue;
      const inside = d <= n.r;
      const rank = inside ? (n.g.type === 'hub' ? 4 : n.g.type === 'subhub' ? 3 : 2) : 0;
      const gap = d - n.r;
      if (rank > bestRank || (rank === bestRank && gap < bestGap)) { best = n; bestRank = rank; bestGap = gap; }
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
      if (!n || n.g.type === 'note') return;
      // The two clicks before this toggled the highlight on and off; leave it on.
      this.focusId = n.id;
      this.host.focusChanged(n.id);
      this.zoomTo(n);
    });
    c.addEventListener('keydown', ev => {
      if (ev.key === 'Escape') {
        if (this.dragging) { this.cancelDrag(); return; }
        if (this.focusId) { this.focusId = null; this.host.focusChanged(null); this.dirty = true; this.loop(); }
      }
      if (this.dragging && (ev.key === 'Alt' || ev.key === 'Control' || ev.key === 'Meta')) {
        // Alt on its own would otherwise move focus to the window menu on some systems.
        ev.preventDefault();
        this.setLinkKey(ev);
      }
    });
    c.addEventListener('keyup', ev => {
      if (this.dragging && (ev.key === 'Alt' || ev.key === 'Control' || ev.key === 'Meta')) this.setLinkKey(ev);
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
    this.dragTouch = ev.pointerType !== 'mouse';
    this.dragKeys = ev.altKey || ev.ctrlKey || ev.metaKey;
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
      const target = this.hit(sx, sy, n, DROP_CATCH_PX);
      if (target !== this.dropTarget) {
        this.dropTarget = target;
        this.verdict = target ? this.host.dropVerdict(n.g, target.g, this.linkKey()) : null;
        this.badgeAt = performance.now();
        this.holdTarget(target);
      } else this.setLinkKey(ev);
      this.holdNear(wx, wy, n);
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
      this.setLinkKey(ev);
      const n = this.dragging, target = this.dropTarget, verdict = this.verdict, key = this.linkKey();
      this.endDrag();
      if (target && verdict && verdict.ok) { this.pulse(target.id); this.host.drop(n.g, target.g, key); }
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
    if (this.focusId) this.pulse(n.id);
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

  /** Alt, Ctrl or Cmd held — or a drag by touch or pen, which has no keys to hold. */
  private linkKey(): boolean {
    return this.dragKeys || this.dragTouch;
  }

  /** Read the keys off an event; if that changes what a drop would do, say so at once. */
  private setLinkKey(ev: { altKey: boolean; ctrlKey: boolean; metaKey: boolean }): void {
    const keys = ev.altKey || ev.ctrlKey || ev.metaKey;
    if (keys === this.dragKeys) return;
    this.dragKeys = keys;
    if (this.dragging && this.dropTarget) {
      this.verdict = this.host.dropVerdict(this.dragging.g, this.dropTarget.g, this.linkKey());
      this.badgeAt = performance.now();
      this.dirty = true;
      this.loop();
    }
  }

  private startDrag(n: SimNode): void {
    this.dragging = n;
    this.hovered = null;
    this.host.hover(null, null);
    this.canvas.addClass('is-dragging');
    n.fx = n.x; n.fy = n.y;
    // Re-read the forces, which now leave the carried node out of repulsion and collision.
    this.applyForces();
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
      // Still near the pointer: the hold around it keeps it, not this.
      if (!prev.wasPinned && !this.stilled.has(prev.node)) { prev.node.fx = null; prev.node.fy = null; }
      this.held = null;
    }
    if (target && (!this.held || this.held.node !== target)) {
      const wasPinned = target.fx !== null && target.fx !== undefined;
      target.fx = target.x; target.fy = target.y;
      target.vx = 0; target.vy = 0;
      this.held = { node: target, wasPinned };
    }
  }

  /**
   * Keep still whatever is near the pointer while a node is carried. The
   * carried node still pulls its hubs, and they pull their other notes, so
   * without this the very note being aimed at drifts off with the crowd. Far
   * away the layout stays alive; each node rejoins once the pointer has gone.
   */
  private holdNear(wx: number, wy: number, carried: SimNode): void {
    const reach = HOLD_PX / this.k;
    const near = new Set<SimNode>();
    for (const n of this.nodes) {
      if (n === carried || n.x === undefined || n.y === undefined) continue;
      if (Math.hypot(n.x - wx, n.y - wy) - n.r <= reach) near.add(n);
    }
    for (const [n, wasPinned] of this.stilled) {
      if (near.has(n)) continue;
      if (!wasPinned && this.held?.node !== n) { n.fx = null; n.fy = null; }
      this.stilled.delete(n);
    }
    for (const n of near) {
      if (this.stilled.has(n)) continue;
      this.stilled.set(n, n.fx !== null && n.fx !== undefined);
      n.fx = n.x; n.fy = n.y; n.vx = 0; n.vy = 0;
    }
  }

  private releaseStilled(): void {
    for (const [n, wasPinned] of this.stilled) if (!wasPinned) { n.fx = null; n.fy = null; }
    this.stilled.clear();
  }

  private endDrag(): void {
    const n = this.dragging;
    if (!n) return;
    this.dragging = null;
    this.dropTarget = null;
    this.verdict = null;
    this.canvas.removeClass('is-dragging');
    this.holdTarget(null);
    this.releaseStilled();
    this.applyForces();
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
      if (this.dirty) {
        if (this.stepFade(performance.now())) again = true;
        else this.fadeAt = 0;
        this.dirty = false;
        if (this.draw()) again = true;
        if (again) this.dirty = true;
      }
      if (again) this.loop();
    });
  }

  /* ============================================================ drawing */

  /** Draw a frame. Returns true while something on it is still moving by itself. */
  private draw(): boolean {
    const ctx = this.ctx, th = this.theme, k = this.k;
    const now = performance.now();
    let busy = false;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = th.bg;
    ctx.fillRect(0, 0, this.w, this.h);
    ctx.setTransform(this.dpr * k, 0, 0, this.dpr * k, this.dpr * this.tx, this.dpr * this.ty);

    const h = this.highlight();
    const hl = h ? h.all : null;
    const px = 1 / k;
    const lw = this.gs.linkWidth;
    for (const n of this.nodes) if (this.appear(n, now)) busy = true;

    /* ---- the soft disc behind a focused node, so the eye finds the centre ---- */
    const focused = this.focusId ? this.byId.get(this.focusId) : null;
    if (focused && focused.x !== undefined && focused.y !== undefined && !this.dragging) {
      const color = focused.g.type === 'note' ? th.accent : this.host.facetColor(focused.g.facet!);
      ctx.fillStyle = color;
      ctx.globalAlpha = 0.1 * focused.aa;
      ctx.beginPath(); ctx.arc(focused.x, focused.y, focused.r * focused.grow + 14 * px, 0, TAU); ctx.fill();
      ctx.globalAlpha = 1;
    }

    /* ---- edges, batched by style; eased alphas are rounded so batches stay few ---- */
    const batches = new Map<string, { color: string; width: number; dash: number[]; alpha: number; segs: SimEdge[]; arrows: SimEdge[] }>();
    const q = (v: number) => Math.round(v * 40) / 40;
    // Arrows only where direction means something: from a note to the note it links.
    const arrowLen = 4 + 2 * Math.sqrt(lw);
    const arrows = this.gs.arrows && arrowLen * k >= 3;
    for (const e of this.edges) {
      const keep = (1 - DIM_EDGE * e.dim) * Math.min(e.source.aa, e.target.aa), l = e.lit;
      if (keep < 0.01) continue;
      let key: string, color: string, width: number, alpha: number, dash: number[] = [];
      if (e.e.type === 'member') {
        key = 'm' + e.e.facet; color = this.host.facetColor(e.e.facet!);
        width = 1.1 + 0.7 * l; alpha = (0.45 + 0.45 * l) * keep;
      } else if (e.e.type === 'split') {
        key = 's' + e.e.facet; color = this.host.facetColor(e.e.facet!);
        width = 1.4; alpha = 0.6 * keep; dash = [4 * px, 3 * px];
      } else if (e.e.type === 'tree') {
        key = 't' + e.e.facet; color = this.host.facetColor(e.e.facet!);
        width = 1.8 + 0.6 * l; alpha = (0.55 + 0.35 * l) * keep;
      } else {
        const kind = e.e.kind || 'body';
        key = 'l' + kind; color = kind === 'property' ? th.accent : th.muted;
        dash = kind === 'heading' ? [6 * px, 3 * px] : kind === 'block' ? [1.5 * px, 3 * px] : kind === 'embed' ? [10 * px, 3 * px, 2 * px, 3 * px] : [];
        width = 1 + 0.8 * l; alpha = (0.3 + 0.65 * l) * keep;
      }
      alpha = q(alpha); width = q(width);
      key += '|' + alpha + '|' + width;
      let b = batches.get(key);
      if (!b) { b = { color, width: width * lw * px, dash, alpha, segs: [], arrows: [] }; batches.set(key, b); }
      b.segs.push(e);
      if (arrows && e.source.g.type === 'note' && e.target.g.type === 'note') b.arrows.push(e);
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
      if (b.arrows.length) {
        ctx.fillStyle = b.color;
        ctx.beginPath();
        for (const e of b.arrows) {
          this.arrowHead(e.source, e.target, arrowLen);
          if (e.e.both) this.arrowHead(e.target, e.source, arrowLen);
        }
        ctx.fill();
      }
    }
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;

    /* ---- what the drop would connect, drawn before it happens ---- */
    if (this.dragging && this.dropTarget && this.verdict?.ok) {
      if (this.drawDropPreview(this.dragging, this.dropTarget, px, now)) busy = true;
    }

    /* ---- nodes that just left, shrinking away ---- */
    if (this.ghosts.length) {
      this.ghosts = this.ghosts.filter(gh => now - gh.t0 < GHOST_MS);
      for (const gh of this.ghosts) {
        const p = (now - gh.t0) / GHOST_MS;
        ctx.globalAlpha = (1 - p) * 0.8;
        const r = gh.n.r * (1 - p * p);
        if (gh.n.g.type === 'note') this.drawNote(gh.n, px, r); else this.drawHub(gh.n, px, r);
      }
      ctx.globalAlpha = 1;
      if (this.ghosts.length) busy = true;
    }

    /* ---- nodes: notes, then sub-hubs, then hubs on top ---- */
    const order: SimNode[] = [];
    for (const n of this.nodes) if (n.g.type === 'note') order.push(n);
    for (const n of this.nodes) if (n.g.type === 'subhub') order.push(n);
    for (const n of this.nodes) if (n.g.type === 'hub') order.push(n);
    // What is being dragged is drawn above what it is dragged over.
    if (this.dragging) { order.splice(order.indexOf(this.dragging), 1); order.push(this.dragging); }
    for (const n of order) {
      if (n.x === undefined || n.y === undefined) continue;
      if (n.aa <= 0) continue;
      const r = n.r * n.as * n.grow;
      ctx.globalAlpha = (1 - DIM_NODE * n.dim) * n.aa;
      // Carried over a target: see-through, so what it would land on still reads.
      if (n === this.dragging && this.dropTarget) ctx.globalAlpha *= 0.55;
      if (n.g.type === 'note') this.drawNote(n, px, r);
      else this.drawHub(n, px, r);
      if (this.matches && this.matches.has(n.id)) {
        ctx.globalAlpha = n.aa;
        ctx.strokeStyle = th.accent;
        ctx.lineWidth = 2.5 * px;
        ctx.beginPath(); ctx.arc(n.x, n.y, r + 4 * px, 0, TAU); ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;

    /* ---- drop target ring ---- */
    if (this.dragging && this.dropTarget && this.verdict) {
      const t = this.dropTarget;
      ctx.strokeStyle = this.verdict.ok ? th.accent : th.faint;
      ctx.lineWidth = 3 * px;
      ctx.setLineDash(this.verdict.ok ? [] : [4 * px, 4 * px]);
      ctx.beginPath(); ctx.arc(t.x!, t.y!, t.r * t.grow + 6 * px, 0, TAU); ctx.stroke();
      ctx.setLineDash([]);
    }

    /* ---- ripples: what just changed ---- */
    if (this.ripples.length) {
      this.ripples = this.ripples.filter(rp => now - rp.t0 < RIPPLE_MS);
      for (const rp of this.ripples) {
        const p = (now - rp.t0) / RIPPLE_MS;
        const e = 1 - Math.pow(1 - p, 3);
        ctx.strokeStyle = rp.color;
        ctx.globalAlpha = 0.55 * (1 - p);
        ctx.lineWidth = (2.5 - 1.5 * p) * px;
        ctx.beginPath(); ctx.arc(rp.x, rp.y, rp.r + (8 + 46 * e) * px, 0, TAU); ctx.stroke();
      }
      ctx.globalAlpha = 1;
      if (this.ripples.length) busy = true;
    }

    /* ---- labels, in screen space so they stay one size ---- */
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.drawLabels(hl);

    if (this.dragging && this.verdict && this.drawBadge(this.verdict, now)) busy = true;
    return busy;
  }

  /**
   * Dashed lines for the links a drop would make: a note to the value it is
   * over, or — for a merge or a folder move — every note of the carried hub to
   * the hub it is over. The dashes march towards the target.
   */
  private drawDropPreview(from: SimNode, to: SimNode, px: number, now: number): boolean {
    const ctx = this.ctx;
    const color = to.g.type === 'note' || !to.g.facet ? this.theme.accent : this.host.facetColor(to.g.facet);
    const moving = this.motion();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.6 * px;
    ctx.setLineDash([5 * px, 4 * px]);
    ctx.lineDashOffset = moving ? -((now / 40) % 9) * px : 0;
    ctx.beginPath();
    if (from.g.type === 'note') {
      ctx.globalAlpha = 0.9;
      ctx.moveTo(from.x!, from.y!); ctx.lineTo(to.x!, to.y!);
    } else {
      ctx.globalAlpha = 0.55;
      for (const id of this.adj.get(from.id) || []) {
        const m = this.byId.get(id);
        if (!m || m.g.type !== 'note' || m.x === undefined || m.y === undefined) continue;
        ctx.moveTo(m.x, m.y); ctx.lineTo(to.x!, to.y!);
      }
    }
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.lineDashOffset = 0;
    ctx.globalAlpha = 1;
    return moving;
  }

  /** Add an arrowhead to the current path, its tip on the rim of `to`. */
  private arrowHead(from: SimNode, to: SimNode, len: number): void {
    const dx = to.x! - from.x!, dy = to.y! - from.y!;
    const d = Math.hypot(dx, dy);
    if (d < from.r + to.r + len) return;
    const ux = dx / d, uy = dy / d;
    const tx = to.x! - ux * (to.r + 1), ty = to.y! - uy * (to.r + 1);
    const bx = tx - ux * len, by = ty - uy * len, w = len * 0.42;
    const ctx = this.ctx;
    ctx.moveTo(tx, ty);
    ctx.lineTo(bx - uy * w, by + ux * w);
    ctx.lineTo(bx + uy * w, by - ux * w);
    ctx.closePath();
  }

  private drawNote(n: SimNode, px: number, r: number): void {
    const ctx = this.ctx, th = this.theme;
    const x = n.x!, y = n.y!;
    if (r <= 0) return;
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

  private drawHub(n: SimNode, px: number, r: number): void {
    const ctx = this.ctx;
    const x = n.x!, y = n.y!;
    if (r <= 0) return;
    const color = this.host.facetColor(n.g.facet!);
    const ga = ctx.globalAlpha;
    const lit = this.focusId === n.id || this.hovered === n;
    ctx.fillStyle = this.theme.bg;
    ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fill();
    ctx.fillStyle = color;
    // A focused hub fills in more, so it reads as selected from across the graph.
    ctx.globalAlpha = ga * (n.g.type === 'hub' ? (lit ? 0.34 : 0.22) : 0.12);
    ctx.fill();
    ctx.globalAlpha = ga;
    ctx.strokeStyle = color;
    ctx.lineWidth = (n.g.type === 'hub' ? (lit ? 2.8 : 2.2) : 1.5) * px;
    if (n.g.type === 'subhub') ctx.setLineDash([3 * px, 2 * px]);
    ctx.stroke();
    ctx.setLineDash([]);
    if (lit) {
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
   * Hub names sit on a plate, so they read over the lines that run into them.
   */
  private drawLabels(hl: Set<string> | null): void {
    const th = this.theme, k = this.k;
    const center = this.centerId();
    type Item = { n: SimNode; text: string; font: string; color: string; rank: number; alpha: number; plate: boolean };
    const items: Item[] = [];
    // Text fade threshold: each step right shows names from further out.
    const reach = Math.pow(2, this.gs.textFade * 0.6);
    const kr = k * reach;
    const hubCap = kr < 0.35 ? 24 : kr < 0.7 ? 80 : Infinity;
    // Note names fade in over the half-octave of zoom below the threshold, instead of popping in.
    const noteFade = Math.max(0, Math.min(1, Math.log2(kr / 1.15) / 0.5 + 1));
    let hubsSeen = 0;
    const hubs = this.nodes.filter(n => n.g.type !== 'note').sort((a, b) => b.g.count - a.g.count);
    for (const n of hubs) {
      const inHl = !!hl && hl.has(n.id);
      if (!inHl && hubsSeen++ >= hubCap) continue;
      const alpha = (1 - n.dim) * n.aa;
      if (alpha < 0.03) continue;
      const text = n.g.type === 'subhub' ? n.g.label + ' · ' + folderLabel(n.g.subFolder || '') : n.g.label;
      const isHub = n.g.type === 'hub';
      items.push({ n, text, font: `${isHub ? 600 : 500} ${isHub ? 12 : 11}px ${th.font}`, color: isHub ? th.text : th.muted,
        rank: n.id === center ? 0 : isHub ? 2 : 3, alpha, plate: isHub });
    }
    for (const n of this.nodes) {
      if (n.g.type !== 'note') continue;
      const special = this.hovered === n || this.focusId === n.id || this.dragging === n || (!!this.matches && this.matches.has(n.id));
      const alpha = (special ? 1 : Math.max(n.lit, noteFade * (1 - n.dim))) * n.aa;
      if (alpha < 0.03) continue;
      items.push({ n, text: n.g.label, font: `${special ? 600 : 400} 11px ${th.font}`, color: special ? th.text : th.muted,
        rank: n.id === center || this.dragging === n ? 0 : special ? 1 : 4, alpha, plate: special });
    }
    // Labels on their way out give way to the ones coming in.
    const order = (it: Item) => it.rank + (it.alpha < 0.35 ? 10 : 0);
    items.sort((a, b) => order(a) - order(b));

    const ctx = this.ctx;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.lineJoin = 'round';
    const placed: [number, number, number, number][] = [];
    // Visible hubs are obstacles too: a name written across another hub reads as that hub's.
    const discs: { n: SimNode; x: number; y: number; r: number }[] = [];
    for (const n of this.nodes) {
      if (n.g.type === 'note' || n.x === undefined || n.y === undefined || n.dim > 0.9 || n.aa < 0.1) continue;
      const x = n.x * k + this.tx, y = n.y * k + this.ty;
      if (x > -60 && x < this.w + 60 && y > -60 && y < this.h + 60) discs.push({ n, x, y, r: n.r * n.grow * k + 2 });
    }
    const hitsLabel = (b: number[]) => placed.some(p => b[0] < p[2] && b[2] > p[0] && b[1] < p[3] && b[3] > p[1]);
    const hitsHub = (b: number[], own: SimNode) => discs.some(d => {
      if (d.n === own) return false;
      const cx = Math.max(b[0], Math.min(d.x, b[2])), cy = Math.max(b[1], Math.min(d.y, b[3]));
      return (cx - d.x) * (cx - d.x) + (cy - d.y) * (cy - d.y) < d.r * d.r;
    });
    let drawn = 0;
    for (const it of items) {
      if (drawn > 500) break;
      const n = it.n;
      const sx = n.x! * k + this.tx;
      const below = (n.y! + n.r * n.grow) * k + this.ty + 4, above = (n.y! - n.r * n.grow) * k + this.ty - 17;
      if (sx < -200 || sx > this.w + 200 || below < -40 || below > this.h + 40) continue;
      const s = it.text.length > 40 ? it.text.slice(0, 38) + '…' : it.text;
      ctx.font = it.font;
      const w = ctx.measureText(s).width, h = 13;
      const boxAt = (y: number): [number, number, number, number] => [sx - w / 2 - 4, y - 2, sx + w / 2 + 4, y + h + 1];
      // Below the node by default; above it when below would sit on another hub or label.
      let sy = below, box = boxAt(below);
      if (it.rank > 0 && (hitsLabel(box) || hitsHub(box, n))) {
        const up = boxAt(above);
        if (!hitsLabel(up) && !hitsHub(up, n)) { sy = above; box = up; }
        // A note name that fits nowhere is left out; a hub keeps its place unless a label is already there.
        else if (n.g.type === 'note' || hitsLabel(box)) continue;
      }
      placed.push(box);
      if (it.plate) {
        ctx.globalAlpha = 0.86 * it.alpha;
        ctx.fillStyle = th.bg;
        this.roundRect(box[0], box[1], box[2] - box[0], box[3] - box[1], 4);
        ctx.fill();
      } else {
        ctx.strokeStyle = th.bg;
        ctx.lineWidth = 3;
        ctx.globalAlpha = 0.9 * it.alpha;
        ctx.strokeText(s, sx, sy);
      }
      ctx.globalAlpha = it.alpha;
      ctx.fillStyle = it.color;
      ctx.fillText(s, sx, sy);
      drawn++;
    }
    ctx.globalAlpha = 1;
  }

  private roundRect(x: number, y: number, w: number, h: number, r: number): void {
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y); ctx.arcTo(x + w, y, x + w, y + r, r);
    ctx.lineTo(x + w, y + h - r); ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
    ctx.lineTo(x + r, y + h); ctx.arcTo(x, y + h, x, y + h - r, r);
    ctx.lineTo(x, y + r); ctx.arcTo(x, y, x + r, y, r);
    ctx.closePath();
  }

  /** The note by the pointer saying what letting go will do. It slides in when the target changes. */
  private drawBadge(v: DropVerdict, now: number): boolean {
    const ctx = this.ctx, th = this.theme;
    const p = this.motion() ? clamp01((now - this.badgeAt) / 140) : 1;
    const e = 1 - Math.pow(1 - p, 3);
    ctx.font = `600 12px ${th.font}`;
    const w = ctx.measureText(v.text).width + 16;
    let x = this.dragScreen.x + 14, y = this.dragScreen.y - 30 + (1 - e) * 6;
    if (x + w > this.w - 4) x = this.dragScreen.x - 14 - w;
    if (y < 4) y = this.dragScreen.y + 18;
    ctx.globalAlpha = e;
    ctx.fillStyle = v.ok ? th.accent : th.bg;
    ctx.strokeStyle = v.ok ? th.accent : th.faint;
    ctx.lineWidth = 1;
    const h = 22;
    this.roundRect(x, y, w, h, 6);
    ctx.fill(); ctx.stroke();
    ctx.fillStyle = v.ok ? th.accentText : th.muted;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(v.text, x + 8, y + h / 2 + 0.5);
    ctx.globalAlpha = 1;
    return p < 1;
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
