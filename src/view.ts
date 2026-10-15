import {
  BasesAllOptions, BasesPropertyId, BasesView, HoverParent, HoverPopover, Keymap, Menu, Modal,
  Platform, QueryController, Setting, TFile, ToggleComponent, parsePropertyId, setIcon,
} from 'obsidian';
import type TagGraphPlugin from './main';
import {
  FacetSpec, FacetValue, GNode, GraphModel, LINK_KINDS, LegendFacet, LinkKind, NoteInput,
  buildGraph, folderMoveDest, hubKey, hubId, noteId, paletteColor, tagLabel, tagKey,
} from './model';
import { Renderer, DropVerdict, GRAPH_DEFAULTS, GraphSettings } from './renderer';
import { Resolver, facetSpec } from './values';
import { DuplicatePair, InsightNote, missing, nearDuplicates, similarNotes, valueInsight } from './insights';
import { fmAdd, fmAddTag, validTag } from './frontmatter';
import { ago, t } from './i18n';

export const VIEW_TYPE = 'tag-graph';

/** Hub colours — kept apart from the note palette so a hub never looks like a note. */
const FACET_COLORS = ['#8b6cf0', '#e08a3c', '#22a38b', '#d4588f'];
const FACET_KEYS = ['facet1', 'facet2', 'facet3', 'facet4'];
const LEGEND_ROWS = 8;

type NumberSetting = Exclude<keyof GraphSettings, 'arrows'>;
interface SliderSpec { key: NumberSetting; min: number; max: number; step: number }

/** The graph settings panel's sliders. Ranges follow Obsidian's graph view where it has one. */
const DISPLAY_SLIDERS: SliderSpec[] = [
  { key: 'textFade', min: -3, max: 3, step: 0.1 },
  { key: 'nodeSize', min: 0.25, max: 3, step: 0.05 },
  { key: 'linkWidth', min: 0.25, max: 4, step: 0.05 },
];
const FORCE_SLIDERS: SliderSpec[] = [
  { key: 'centerForce', min: 0, max: 1, step: 0.01 },
  { key: 'repelForce', min: 0, max: 20, step: 0.1 },
  { key: 'linkForce', min: 0, max: 1, step: 0.01 },
  { key: 'linkDistance', min: 30, max: 500, step: 1 },
];
const GRAPH_KEYS = Object.keys(GRAPH_DEFAULTS) as (keyof GraphSettings)[];
type PanelSection = 'filter' | 'display' | 'forces';

const facetPropertyFilter = (p: BasesPropertyId) =>
  p.startsWith('note.') || p.startsWith('formula.') || p === 'file.tags' || p === 'file.folder' || p === 'file.ext';

export function viewOptions(): BasesAllOptions[] {
  return [
    {
      type: 'group',
      displayName: t('opt.facets'),
      items: FACET_KEYS.map((key, i) => ({
        type: 'property' as const, key, displayName: t('opt.facet', { n: i + 1 }),
        placeholder: t('opt.none'), filter: facetPropertyFilter,
        ...(i === 0 ? { default: 'file.tags' } : {}),
      })),
    },
    { type: 'slider', key: 'minCount', displayName: t('opt.minCount'), default: 2, min: 1, max: 20, step: 1 },
    { type: 'toggle', key: 'splitByFolder', displayName: t('opt.split'), default: false },
    { type: 'property', key: 'colorBy', displayName: t('opt.colorBy'), placeholder: t('opt.colorBy.placeholder'), filter: facetPropertyFilter },
    { type: 'toggle', key: 'showIsolated', displayName: t('opt.isolated'), default: true },
    { type: 'text', key: 'linkProperty', displayName: t('opt.linkProp'), default: 'related', placeholder: 'related' },
  ];
}

interface NoteMeta { file: TFile; values: Record<string, FacetValue[]> }

export class TagGraphView extends BasesView implements HoverParent {
  type = VIEW_TYPE;
  hoverPopover: HoverPopover | null = null;

  private root: HTMLElement;
  private stage: HTMLElement;
  readonly renderer: Renderer;
  private legendEl: HTMLElement;
  private tipEl: HTMLElement;
  private emptyEl: HTMLElement;
  private hintEl: HTMLElement;
  private statusEl: HTMLElement;
  private searchEl: HTMLInputElement;
  private searchCount: HTMLElement;
  private freezeBtn: HTMLElement;
  private panelBtn: HTMLElement;
  private panelEl: HTMLElement;
  private infoBtn: HTMLElement;
  private infoEl: HTMLElement;
  private resultsEl: HTMLElement;
  private resolver: Resolver;

  private model: GraphModel | null = null;
  private facets: FacetSpec[] = [];
  private notes = new Map<string, NoteMeta>();
  /** The same notes, as the details panel reads them. */
  private rows: InsightNote[] = [];
  /** Note id -> links drawn out of it and into it. */
  private linkStats = new Map<string, { out: string[]; in: string[] }>();
  private values = new Map<string, FacetValue>();
  private colorIndex = new Map<string, number>();
  private expanded = new Set<string>();
  private lastHoverId: string | null = null;
  private lastHoverMod = false;
  private colorSource = '';
  /** Narrow (a sidebar, a small embed, a phone): the legend starts closed and is opened per session. */
  private narrow = false;
  private narrowLegend = false;
  /** The graph settings panel: open or not, and which of its sections are folded. Per view, not saved. */
  private panelOpen = false;
  private folded = new Set<PanelSection>();
  /** A panel slider is being dragged: a redraw of the panel now would drop it. */
  private sliding = false;
  /** The details panel was opened by hand; it also opens by itself while something is focused. */
  private infoOpen = false;
  /** Which group the details panel has lit on the graph (e.g. untagged notes), if any. */
  private spotKey: string | null = null;
  /** Notes list in the details panel shows everything rather than the first few. */
  private infoAll = false;
  /** What the details panel showed last, so it animates only when that changes. */
  private infoSubject = '';
  /** Bars drawn so far in this render of the panel, to stagger their growth. */
  private barIndex = 0;
  /** Where an up/down walk started, so it steps among that node's neighbours. */
  private stepFrom: string | null = null;
  /** Order of the notes list in the details panel. */
  private infoSort: 'name' | 'recent' = 'name';
  private results: GNode[] = [];
  private resultIndex = -1;

  constructor(controller: QueryController, containerEl: HTMLElement, private plugin: TagGraphPlugin) {
    super(controller);
    this.resolver = new Resolver(plugin.app);
    this.root = containerEl.createDiv({ cls: 'tag-graph' });
    this.stage = this.root.createDiv({ cls: 'tag-graph-stage' });
    this.renderer = new Renderer(this.stage, {
      facetColor: id => this.facetColor(id),
      noteColor: key => paletteColor(this.colorIndex.get(key) ?? 0),
      open: (g, newTab) => this.openNode(g, newTab),
      context: (g, x, y) => this.contextMenu(g, x, y),
      dropVerdict: (a, b, key) => this.dropVerdict(a, b, key),
      drop: (a, b, key) => { void this.drop(a, b, key); },
      hover: (g, ev) => this.hover(g, ev),
      focusChanged: () => { this.infoAll = false; this.setSpot(null, null); this.renderLegend(); this.renderInfo(); },
    });

    this.legendEl = this.root.createDiv({ cls: 'tag-graph-legend' });
    // A row can be redrawn under the pointer and miss its own mouseleave.
    this.legendEl.addEventListener('mouseleave', () => this.renderer.setPreview(null));
    this.tipEl = this.root.createDiv({ cls: 'tag-graph-tip' });
    this.emptyEl = this.root.createDiv({ cls: 'tag-graph-empty' });
    this.statusEl = this.root.createDiv({ cls: 'tag-graph-status' });
    this.hintEl = this.root.createDiv({ cls: 'tag-graph-hint' });

    const side = this.root.createDiv({ cls: 'tag-graph-side' });
    const bar = side.createDiv({ cls: 'tag-graph-toolbar' });
    const search = bar.createDiv({ cls: 'tag-graph-search' });
    this.searchEl = search.createEl('input', { type: 'search', attr: { placeholder: t('ui.search'), 'aria-label': t('ui.search') } });
    this.searchCount = search.createSpan({ cls: 'tag-graph-search-count' });
    this.resultsEl = search.createDiv({ cls: 'tag-graph-results', attr: { role: 'listbox' } });
    this.searchEl.addEventListener('input', () => this.onSearch());
    this.searchEl.addEventListener('keydown', ev => this.searchKey(ev));
    this.searchEl.addEventListener('focus', () => this.renderResults());
    this.searchEl.addEventListener('blur', () => window.setTimeout(() => this.root.removeClass('has-results'), 120));
    this.button(bar, 'list', t('ui.legend'), () => {
      if (this.narrow) {
        this.narrowLegend = !this.narrowLegend;
        // On a narrow pane the legend and the panel would cover each other.
        if (this.narrowLegend && this.panelOpen) this.setPanel(false);
      } else this.config.set('legendOpen', this.config.get('legendOpen') === false);
      this.applyLegend();
    });
    this.infoBtn = this.button(bar, 'info', t('ui.details'), () => this.toggleInfo());
    this.button(bar, 'maximize', t('ui.fit'), () => this.renderer.fit());
    this.freezeBtn = this.button(bar, 'snowflake', t('ui.freeze'), () => this.setFrozen(!this.renderer.frozen));
    this.panelBtn = this.button(bar, 'settings', t('ui.settings'), () => this.setPanel(!this.panelOpen));
    this.panelEl = side.createDiv({ cls: 'tag-graph-panel' });
    this.panelEl.addEventListener('keydown', ev => {
      if (ev.key === 'Escape') { ev.stopPropagation(); this.setPanel(false); this.panelBtn.focus(); }
    });
    this.infoEl = side.createDiv({ cls: 'tag-graph-info' });
    this.infoEl.addEventListener('mouseleave', () => this.renderer.setPreview(null));
    this.renderer.canvas.addEventListener('keydown', ev => this.canvasKey(ev));

    this.registerEvent(this.plugin.app.workspace.on('css-change', () => { this.readTheme(); this.renderer.refresh(); }));
    const ro = new ResizeObserver(() => {
      const narrow = this.root.clientWidth > 0 && this.root.clientWidth < 520;
      if (narrow === this.narrow) return;
      this.narrow = narrow;
      this.root.toggleClass('is-narrow', narrow);
      this.applyLegend();
    });
    ro.observe(this.root);
    this.register(() => ro.disconnect());
  }

  onload(): void {
    this.plugin.views.add(this);
    this.readTheme();
  }

  onunload(): void {
    this.plugin.views.delete(this);
    this.renderer.destroy();
    this.root.remove();
  }

  /* ================================================================ config */

  private legendOpen(): boolean {
    return this.narrow ? this.narrowLegend : this.config.get('legendOpen') !== false;
  }

  private applyLegend(): void {
    this.root.toggleClass('is-legend-closed', !this.legendOpen());
    this.updateInsets();
  }

  private num(key: string, def: number): number {
    const v = Number(this.config.get(key));
    return Number.isFinite(v) && v > 0 ? v : def;
  }

  private bool(key: string, def: boolean): boolean {
    const v = this.config.get(key);
    return typeof v === 'boolean' ? v : def;
  }

  private hiddenSet(): Set<string> {
    const v = this.config.get('hidden');
    return new Set(Array.isArray(v) ? v.map(String) : []);
  }

  private linkKinds(): Set<LinkKind> {
    const v = this.config.get('links');
    if (!Array.isArray(v)) return new Set(LINK_KINDS);
    return new Set(v.filter((x): x is LinkKind => (LINK_KINDS as string[]).includes(String(x))));
  }

  private facetIds(): BasesPropertyId[] {
    const ids: BasesPropertyId[] = [];
    FACET_KEYS.forEach((key, i) => {
      let id = this.config.getAsPropertyId(key);
      // Never configured: the first facet is tags, so a new view draws something.
      if (!id && i === 0 && this.config.get(key) === undefined) id = 'file.tags';
      if (id && !ids.includes(id)) ids.push(id);
    });
    return ids;
  }

  /** Bases calls file.tags "file tags"; people call it Tags. */
  private displayName(id: BasesPropertyId): string {
    if (id === 'file.tags') return t('facet.tags');
    if (id === 'file.folder') return t('facet.folder');
    return this.config.getDisplayName(id);
  }

  private facetColor(id: string): string {
    const i = this.facets.findIndex(f => f.id === id);
    return FACET_COLORS[Math.max(0, i) % FACET_COLORS.length];
  }

  /* ================================================================ data */

  onDataUpdated(): void {
    this.rebuild();
  }

  /** Redraw with current settings (called when plugin settings change). */
  refresh(): void {
    this.rebuild();
  }

  private rebuild(): void {
    const entries = this.data ? this.data.data : [];
    const ids = this.facetIds();
    const facets = ids.map(id => facetSpec(id, this.displayName(id)));
    const colorBy = this.config.getAsPropertyId('colorBy');
    const colorSpec = colorBy ? facetSpec(colorBy, '') : null;

    // Grouping colours the notes when no "colour by" property is chosen.
    const groupOf = new Map<string, string>();
    if (!colorSpec && this.data) {
      const groups = this.data.groupedData;
      if (groups.length > 1 || (groups.length === 1 && groups[0].hasKey())) {
        for (const g of groups) {
          const key = g.hasKey() && g.key ? g.key.toString() : '—';
          for (const e of g.entries) groupOf.set(e.file.path, key);
        }
      }
    }

    // Properties shown as facets are not drawn again as property links.
    const skip = new Set<string>();
    for (const f of facets) if (f.id.startsWith('note.')) skip.add(parsePropertyId(f.id as BasesPropertyId).name.toLowerCase());

    const inputs: NoteInput[] = [];
    this.notes.clear();
    this.values.clear();
    this.rows = [];
    for (const entry of entries) {
      const file = entry.file;
      const values: Record<string, FacetValue[]> = {};
      for (const f of facets) {
        const r = this.resolver.read(entry, f);
        values[f.id] = r.values;
        if (r.list) f.list = true;
        if (r.links && f.kind === 'text') f.kind = 'link';
        for (const v of r.values) if (!this.values.has(hubKey(f.id, v.key))) this.values.set(hubKey(f.id, v.key), v);
      }
      let colors: string[] = [];
      if (colorSpec) colors = this.resolver.read(entry, colorSpec).values.map(v => colorSpec.kind === 'tags' ? tagLabel(v.label) : v.label);
      else if (groupOf.size) colors = groupOf.has(file.path) ? [groupOf.get(file.path)!] : [];
      // Nothing chosen: colour by top-level folder, so where a note lives shows at a glance.
      else colors = [file.path.includes('/') ? file.path.slice(0, file.path.indexOf('/')) : t('ui.root')];
      const folder = file.parent ? (file.parent.isRoot() ? '' : file.parent.path) : '';
      inputs.push({ path: file.path, name: file.basename, folder, facets: values, colors, links: this.resolver.links(file, skip) });
      this.rows.push({ path: file.path, name: file.basename, folder, values, mtime: file.stat.mtime });
      this.notes.set(file.path, { file, values });
    }
    this.facets = facets;
    this.colorSource = colorSpec ? this.displayName(colorBy!) : groupOf.size ? t('ui.colors') : t('ui.colorFolder');

    const model = buildGraph(inputs, {
      facets,
      minCount: this.num('minCount', 2),
      splitByFolder: this.bool('splitByFolder', false),
      linkKinds: this.linkKinds(),
      hidden: this.hiddenSet(),
      showIsolated: this.bool('showIsolated', true),
    });
    this.model = model;
    this.colorIndex.clear();
    model.colorKeys.forEach((c, i) => this.colorIndex.set(c.key, i));
    this.linkStats.clear();
    const stat = (id: string) => {
      let s = this.linkStats.get(id);
      if (!s) { s = { out: [], in: [] }; this.linkStats.set(id, s); }
      return s;
    };
    // One entry per linked note, however many kinds of link join them.
    const add = (list: string[], id: string) => { if (!list.includes(id)) list.push(id); };
    for (const e of model.edges) {
      if (e.type !== 'link') continue;
      add(stat(e.source).out, e.target);
      add(stat(e.target).in, e.source);
      if (e.both) { add(stat(e.target).out, e.source); add(stat(e.source).in, e.target); }
    }

    this.renderer.frozen = this.bool('frozen', false);
    this.updateFreezeButton();
    this.root.toggleClass('is-legend-closed', !this.legendOpen());
    this.renderLegend();
    this.renderEmpty(entries.length, facets.length);
    if (this.panelOpen && !this.sliding) this.renderPanel();
    this.updateInsets();
    this.renderer.setSettings(this.graphSettings());
    this.renderer.setGraph(model, { animate: this.plugin.settings.animate });
    this.renderHint();
    if (this.searchEl.value) this.onSearch();
    this.renderInfo();
    const hubs = model.nodes.filter(n => n.type === 'hub').length;
    const links = model.edges.filter(e => e.type === 'link').length;
    this.statusEl.setText(t(links ? 'ui.status.links' : 'ui.status', { notes: model.noteCount, values: hubs, links }));
  }

  /* ================================================================ chrome */

  private button(parent: HTMLElement, icon: string, label: string, onClick: () => void): HTMLElement {
    const b = parent.createEl('button', { cls: 'clickable-icon tag-graph-button', attr: { 'aria-label': label } });
    setIcon(b, icon);
    b.addEventListener('click', onClick);
    return b;
  }

  /** Tell the renderer which parts of the canvas the legend and toolbar cover. */
  private updateInsets(): void {
    const r = this.root.getBoundingClientRect();
    const legend = this.legendOpen() && !this.root.hasClass('is-empty') ? this.legendEl.getBoundingClientRect() : null;
    const side = this.panelOpen ? this.panelEl : this.root.hasClass('has-info') ? this.infoEl : null;
    const box = side ? side.getBoundingClientRect() : null;
    this.renderer.insets = {
      left: legend && legend.width ? legend.right - r.left + 8 : 0,
      top: 52,
      right: box && box.width && !this.narrow ? r.right - box.left + 8 : 0,
      // On a narrow pane the details panel is a sheet along the bottom.
      bottom: box && box.height && this.narrow && side === this.infoEl ? r.bottom - box.top + 8 : 28,
    };
  }

  /* ================================================================ graph settings */

  /** The panel's values, from the view's config, each kept inside its slider's range. */
  private graphSettings(): GraphSettings {
    const out: GraphSettings = { ...GRAPH_DEFAULTS };
    const arrows = this.config.get('arrows');
    if (typeof arrows === 'boolean') out.arrows = arrows;
    for (const s of [...DISPLAY_SLIDERS, ...FORCE_SLIDERS]) {
      const raw = this.config.get(s.key);
      const v = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() ? Number(raw) : NaN;
      if (Number.isFinite(v)) out[s.key] = Math.max(s.min, Math.min(s.max, v));
    }
    return out;
  }

  /** Store a panel value; the default is stored as nothing, so the .base file stays clean. */
  private storeSetting(key: keyof GraphSettings, value: number | boolean): void {
    this.config.set(key, value === GRAPH_DEFAULTS[key] ? null : value);
  }

  private setPanel(open: boolean): void {
    this.panelOpen = open;
    this.root.toggleClass('is-panel-open', open);
    this.panelBtn.toggleClass('is-active', open);
    if (open) {
      if (this.narrow && this.narrowLegend) { this.narrowLegend = false; this.applyLegend(); }
      this.renderPanel();
    } else {
      this.panelEl.empty();
    }
    // The panel and the details share the right-hand column; the panel wins while open.
    this.renderInfo();
  }

  private renderPanel(): void {
    const el = this.panelEl;
    el.empty();
    const gs = this.graphSettings();

    /* filters: the graph view's "Tags" and "Orphans", plus the rare-value cut-off */
    const filter = this.panelSection(el, 'filter', t('panel.filter'), true);
    if (filter) {
      for (const lf of this.model ? this.model.legend : []) {
        this.panelToggle(filter, lf.facet.label, !lf.hidden, () => this.toggleHidden(lf.facet.id));
      }
      this.panelToggle(filter, t('panel.orphans'), this.bool('showIsolated', true), v => {
        this.config.set('showIsolated', v ? null : false);
        this.rebuild();
      });
      this.panelSlider(filter, t('opt.minCount'), { min: 1, max: 20, step: 1 }, this.num('minCount', 2), null, v => {
        this.config.set('minCount', v);
        this.rebuild();
      });
    }

    /* display */
    const display = this.panelSection(el, 'display', t('panel.display'));
    if (display) {
      this.panelToggle(display, t('panel.arrows'), gs.arrows, v => this.liveSetting('arrows', v, true));
      for (const s of DISPLAY_SLIDERS) {
        this.panelSlider(display, t(('panel.' + s.key) as 'panel.textFade'), s, gs[s.key],
          v => this.liveSetting(s.key, v, false), v => this.liveSetting(s.key, v, true));
      }
      const row = display.createDiv({ cls: 'tag-graph-panel-buttons' });
      const b = row.createEl('button', { text: t('ui.relayout') });
      b.addEventListener('click', () => this.renderer.relayout());
    }

    /* forces */
    const forces = this.panelSection(el, 'forces', t('panel.forces'));
    if (forces) {
      for (const s of FORCE_SLIDERS) {
        this.panelSlider(forces, t(('panel.' + s.key) as 'panel.centerForce'), s, gs[s.key],
          v => this.liveSetting(s.key, v, false), v => this.liveSetting(s.key, v, true));
      }
    }
  }

  /** Apply a panel value to the graph now; store it once the control is let go. */
  private liveSetting(key: keyof GraphSettings, value: number | boolean, store: boolean): void {
    const gs = this.graphSettings();
    (gs as unknown as Record<string, number | boolean>)[key] = value;
    this.renderer.setSettings(gs);
    if (store) this.storeSetting(key, value);
  }

  private resetPanel(): void {
    for (const key of GRAPH_KEYS) this.config.set(key, null);
    this.config.set('showIsolated', null);
    this.config.set('minCount', null);
    const hidden = this.hiddenSet();
    for (const f of this.facets) hidden.delete(f.id);
    this.config.set('hidden', hidden.size ? [...hidden] : null);
    this.rebuild();
    if (this.panelOpen) this.renderPanel();
  }

  /** A foldable section. The first one also carries the panel's reset and close buttons. Returns its body, or null if folded. */
  private panelSection(parent: HTMLElement, id: PanelSection, title: string, first = false): HTMLElement | null {
    const sec = parent.createDiv({ cls: 'tag-graph-panel-section' });
    const head = sec.createDiv({ cls: 'tag-graph-panel-head' });
    const folded = this.folded.has(id);
    const fold = head.createDiv({ cls: 'tag-graph-panel-fold', attr: { role: 'button', tabindex: '0', 'aria-expanded': String(!folded) } });
    setIcon(fold.createSpan({ cls: 'tag-graph-panel-chevron' }), folded ? 'chevron-right' : 'chevron-down');
    fold.createSpan({ text: title });
    const toggle = () => {
      if (this.folded.has(id)) this.folded.delete(id); else this.folded.add(id);
      this.renderPanel();
      this.updateInsets();
    };
    fold.addEventListener('click', toggle);
    fold.addEventListener('keydown', ev => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); toggle(); } });
    if (first) {
      this.button(head, 'rotate-ccw', t('panel.reset'), () => this.resetPanel());
      this.button(head, 'x', t('panel.close'), () => this.setPanel(false));
    }
    return folded ? null : sec.createDiv({ cls: 'tag-graph-panel-body' });
  }

  private panelToggle(parent: HTMLElement, name: string, value: boolean, onChange: (v: boolean) => void): void {
    const row = parent.createDiv({ cls: 'tag-graph-panel-item is-toggle' });
    row.createDiv({ cls: 'tag-graph-panel-name', text: name });
    new ToggleComponent(row).setValue(value).onChange(onChange);
  }

  /**
   * Name above, value and slider below, as in Obsidian's graph settings.
   * `onInput` runs while dragging (null: only the number follows), `onDone` on release.
   */
  private panelSlider(parent: HTMLElement, name: string, s: { min: number; max: number; step: number }, value: number,
    onInput: ((v: number) => void) | null, onDone: (v: number) => void): void {
    const item = parent.createDiv({ cls: 'tag-graph-panel-item' });
    item.createDiv({ cls: 'tag-graph-panel-name', text: name });
    const line = item.createDiv({ cls: 'tag-graph-panel-slider' });
    const digits = s.step >= 1 ? 0 : 2;
    const out = line.createSpan({ cls: 'tag-graph-panel-value', text: value.toFixed(digits) });
    const input = line.createEl('input', {
      type: 'range', cls: 'slider',
      attr: { min: String(s.min), max: String(s.max), step: String(s.step), 'aria-label': name },
    });
    input.value = String(value);
    // Newer Obsidian fills the track up to the thumb from this ratio; older versions ignore it.
    const fill = (v: number) => input.setCssProps({ '--slider-fill-ratio': String((v - s.min) / (s.max - s.min)) });
    fill(value);
    input.addEventListener('input', () => fill(Number(input.value)));
    input.addEventListener('pointerdown', () => { this.sliding = true; });
    for (const type of ['pointerup', 'pointercancel']) input.addEventListener(type, () => { this.sliding = false; });
    input.addEventListener('input', () => {
      const v = Number(input.value);
      out.setText(v.toFixed(digits));
      if (onInput) onInput(v);
    });
    input.addEventListener('change', () => {
      this.sliding = false;
      onDone(Number(input.value));
    });
  }

  private setFrozen(frozen: boolean): void {
    this.renderer.setFrozen(frozen);
    this.config.set('frozen', frozen);
    this.updateFreezeButton();
  }

  private updateFreezeButton(): void {
    const frozen = this.renderer.frozen;
    this.freezeBtn.empty();
    setIcon(this.freezeBtn, frozen ? 'play' : 'snowflake');
    this.freezeBtn.setAttr('aria-label', frozen ? t('ui.unfreeze') : t('ui.freeze'));
    this.freezeBtn.toggleClass('is-active', frozen);
  }

  private onSearch(): void {
    const n = this.renderer.setSearch(this.searchEl.value);
    this.searchCount.setText(this.searchEl.value.trim() ? t('ui.matches', { n }) : '');
    this.resultIndex = -1;
    this.renderResults();
  }

  /* ================================================================ search results */

  /** Values before notes, names that start with the query before names that contain it, then by size. */
  private findNodes(q: string): GNode[] {
    const s = q.trim().toLowerCase();
    if (!s || !this.model) return [];
    const scored: { g: GNode; score: number }[] = [];
    for (const g of this.model.nodes) {
      if (g.type === 'subhub') continue;
      const label = g.label.toLowerCase().replace(/^#/, '');
      const at = label.indexOf(s.replace(/^#/, ''));
      const inPath = at < 0 && (g.path || '').toLowerCase().includes(s);
      if (at < 0 && !inPath) continue;
      scored.push({ g, score: (g.type === 'hub' ? 0 : 1000) + (at === 0 ? 0 : inPath ? 600 : 300) - Math.min(g.count, 299) });
    }
    scored.sort((a, b) => a.score - b.score || a.g.label.localeCompare(b.g.label));
    return scored.slice(0, 8).map(x => x.g);
  }

  private renderResults(): void {
    const el = this.resultsEl;
    el.empty();
    // The view's own document: in a pop-out window that is not the main one.
    this.results = this.searchEl.ownerDocument.activeElement === this.searchEl ? this.findNodes(this.searchEl.value) : [];
    this.root.toggleClass('has-results', this.results.length > 0);
    if (this.resultIndex >= this.results.length) this.resultIndex = this.results.length - 1;
    const q = this.searchEl.value.trim().toLowerCase().replace(/^#/, '');
    this.results.forEach((g, i) => {
      const row = el.createDiv({ cls: 'tag-graph-result', attr: { role: 'option', 'aria-selected': String(i === this.resultIndex) } });
      row.toggleClass('is-active', i === this.resultIndex);
      this.nodeDot(row, g);
      const text = row.createDiv({ cls: 'tag-graph-result-text' });
      // The part that matched, in bold.
      const name = text.createDiv({ cls: 'tag-graph-result-name' });
      const at = g.label.toLowerCase().indexOf(q);
      if (q && at >= 0) {
        name.appendText(g.label.slice(0, at));
        name.createSpan({ cls: 'tag-graph-result-hit', text: g.label.slice(at, at + q.length) });
        name.appendText(g.label.slice(at + q.length));
      } else name.setText(g.label);
      text.createDiv({ cls: 'tag-graph-result-sub', text: g.type === 'note' ? (g.folder || t('ui.root')) : this.spec(g.facet)?.label || '' });
      if (g.type !== 'note') row.createSpan({ cls: 'tag-graph-result-count', text: String(g.count) });
      // mousedown, not click: the input's blur would close the list first.
      row.addEventListener('mousedown', ev => { ev.preventDefault(); this.choose(g); });
      row.addEventListener('mouseenter', () => this.renderer.setPreview(g.id));
      row.addEventListener('mouseleave', () => this.renderer.setPreview(null));
    });
  }

  private searchKey(ev: KeyboardEvent): void {
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      if (!this.results.length) return;
      ev.preventDefault();
      const n = this.results.length;
      this.resultIndex = ev.key === 'ArrowDown' ? (this.resultIndex + 1) % n : (this.resultIndex - 1 + n) % n;
      this.renderResults();
      this.renderer.setPreview(this.results[this.resultIndex].id);
    } else if (ev.key === 'Enter') {
      ev.preventDefault();
      if (this.resultIndex >= 0 && this.results[this.resultIndex]) this.choose(this.results[this.resultIndex]);
      else this.renderer.fitMatches();
    } else if (ev.key === 'Escape') {
      this.searchEl.value = '';
      this.onSearch();
      this.renderer.setPreview(null);
      this.renderer.canvas.focus();
    }
  }

  /** Go to a node: focus it, fly to it, and say what it is in the details panel. */
  private choose(g: GNode): void {
    this.searchEl.value = '';
    this.onSearch();
    this.renderer.setPreview(null);
    this.focusNode(g.id);
    this.renderer.canvas.focus({ preventScroll: true });
  }

  private focusNode(id: string, zoom = true): void {
    this.renderer.setFocus(id);
    this.infoAll = false;
    this.setSpot(null, null);
    this.renderLegend();
    // The panel first, so the zoom knows how much room it leaves.
    this.renderInfo();
    if (zoom) this.renderer.zoomToId(id);
    this.renderer.pulse(id);
  }

  private canvasKey(ev: KeyboardEvent): void {
    if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
    if (ev.key === '/') { ev.preventDefault(); this.searchEl.focus(); }
    else if (ev.key === 'i') this.toggleInfo();
    else if (ev.key === 'f') this.renderer.fit();
    else if (ev.key === '+' || ev.key === '=') this.renderer.zoomBy(1.25);
    else if (ev.key === '-') this.renderer.zoomBy(0.8);
    else if (ev.key.startsWith('Arrow')) { ev.preventDefault(); this.step(ev.key); }
  }

  /**
   * Walk the graph from the keyboard: left and right go through the values,
   * biggest first; up and down go through what the focused node is joined to.
   * Each step focuses the node and shows its details, like a click.
   */
  private step(key: string): void {
    const model = this.model;
    if (!model) return;
    const focus = this.renderer.focus;
    let list: GNode[];
    if (key === 'ArrowLeft' || key === 'ArrowRight' || !focus) {
      list = model.nodes.filter(n => n.type === 'hub').sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
    } else {
      const around = (id: string) => {
        const near = new Set<string>();
        for (const e of model.edges) {
          if (e.source === id) near.add(e.target);
          else if (e.target === id) near.add(e.source);
        }
        return model.nodes.filter(n => near.has(n.id)).sort((a, b) => a.label.localeCompare(b.label));
      };
      // Among the siblings of the node the walk went down from, while the focus is still one of them.
      const siblings = this.stepFrom ? around(this.stepFrom) : [];
      if (siblings.some(n => n.id === focus)) list = siblings;
      else { this.stepFrom = null; list = around(focus); }
    }
    if (!list.length) return;
    const at = list.findIndex(n => n.id === focus);
    const back = key === 'ArrowLeft' || key === 'ArrowUp';
    const next = at < 0 ? (back ? list.length - 1 : 0) : (at + (back ? -1 : 1) + list.length) % list.length;
    // Up and down remember where they came from, so the next press steps among its siblings.
    if ((key === 'ArrowUp' || key === 'ArrowDown') && at < 0 && focus) this.stepFrom = focus;
    if (key === 'ArrowLeft' || key === 'ArrowRight') this.stepFrom = null;
    this.focusNode(list[next].id, false);
  }

  /* ================================================================ details panel */

  private toggleInfo(): void {
    if (this.root.hasClass('has-info')) {
      this.infoOpen = false;
      if (this.renderer.focus) { this.renderer.setFocus(null); this.renderLegend(); }
      this.setSpot(null, null);
    } else {
      this.infoOpen = true;
      if (this.panelOpen) { this.setPanel(false); return; }
    }
    this.renderInfo();
  }

  /** Light a group of notes from the details panel; the same key again turns it off. */
  private setSpot(key: string | null, ids: string[] | null): void {
    this.spotKey = key;
    this.renderer.setSpotlight(key ? ids : null);
  }

  private renderInfo(): void {
    const el = this.infoEl;
    el.empty();
    const model = this.model;
    const focus = this.renderer.focus;
    const node = focus && model ? model.nodes.find(n => n.id === focus) || null : null;
    const show = !this.panelOpen && !!model && model.nodes.length > 0 && (!!node || this.infoOpen);
    this.root.toggleClass('has-info', show);
    this.infoBtn.toggleClass('is-active', show);
    if (show) {
      // A new subject slides in and its bars grow; a refresh of the same one stays put.
      const subject = node ? node.id : 'overview';
      const body = el.createDiv({ cls: 'tag-graph-info-body' });
      const fresh = subject !== this.infoSubject;
      body.toggleClass('is-enter', fresh);
      this.infoSubject = subject;
      this.barIndex = 0;
      if (node && node.type === 'note') this.noteInfo(body, node);
      else if (node) this.hubInfo(body, node);
      else this.overviewInfo(body);
      this.updateInsets();
      // The panel must not hide what it describes.
      if (fresh && node) this.renderer.ensureVisible(node.id);
      return;
    }
    this.infoSubject = '';
    this.updateInsets();
  }

  /** The panel's header: a kind line with a swatch, the name, and a close button. */
  private infoHead(el: HTMLElement, kind: string, title: string, swatch: (parent: HTMLElement) => void): void {
    const head = el.createDiv({ cls: 'tag-graph-info-head' });
    const line = head.createDiv({ cls: 'tag-graph-info-kind' });
    swatch(line);
    line.createSpan({ text: kind });
    this.button(head, 'x', t('panel.close'), () => {
      this.infoOpen = false;
      this.renderer.setFocus(null);
      this.setSpot(null, null);
      this.renderLegend();
      this.renderInfo();
    }).addClass('tag-graph-info-close');
    el.createDiv({ cls: 'tag-graph-info-title', text: title });
  }

  private infoStats(el: HTMLElement, stats: { value: string; label: string }[]): void {
    const row = el.createDiv({ cls: 'tag-graph-info-stats' });
    for (const s of stats) {
      const tile = row.createDiv({ cls: 'tag-graph-info-stat' });
      tile.createDiv({ cls: 'tag-graph-info-stat-value', text: s.value });
      tile.createDiv({ cls: 'tag-graph-info-stat-label', text: s.label });
    }
  }

  private infoSection(el: HTMLElement, title: string, count?: number): HTMLElement {
    const sec = el.createDiv({ cls: 'tag-graph-info-section' });
    const head = sec.createDiv({ cls: 'tag-graph-info-section-head' });
    head.createSpan({ text: title });
    if (count !== undefined) head.createSpan({ cls: 'tag-graph-info-section-count', text: String(count) });
    return sec;
  }

  /** A row with a label, a bar for its share and a number. Returns the row for wiring. */
  private barRow(parent: HTMLElement, label: string, value: number, max: number, color: string, dot?: (row: HTMLElement) => void, text?: string): HTMLElement {
    const row = parent.createDiv({ cls: 'tag-graph-info-bar' });
    if (dot) dot(row);
    row.createSpan({ cls: 'tag-graph-info-bar-label', text: label });
    const track = row.createSpan({ cls: 'tag-graph-info-bar-track' });
    track.createSpan({ cls: 'tag-graph-info-bar-fill' }).setCssProps({
      '--fg-color': color, '--fg-share': String(max ? value / max : 0), '--fg-delay': Math.min(12, this.barIndex++) * 30 + 'ms',
    });
    row.createSpan({ cls: 'tag-graph-info-bar-value', text: text ?? String(value) });
    return row;
  }

  private nodeDot(parent: HTMLElement, g: GNode): void {
    if (g.type === 'note') {
      const c = g.colors[0];
      parent.createSpan({ cls: 'tag-graph-swatch is-note' }).setCssProps({ '--fg-color': c !== undefined ? paletteColor(this.colorIndex.get(c) ?? 0) : 'var(--text-muted)' });
    } else {
      parent.createSpan({ cls: 'tag-graph-swatch is-hub' }).setCssProps({ '--fg-color': this.facetColor(g.facet || '') });
    }
  }

  /** Where a row points on the graph, if it is drawn there. */
  private drawn(id: string): boolean {
    return !!this.model && this.model.nodes.some(n => n.id === id);
  }

  /** Hover previews the node; a click goes to it. Rows for nodes that are not drawn stay plain. */
  private wireRow(row: HTMLElement, id: string, onClick?: (ev: MouseEvent) => void): void {
    if (!onClick && !this.drawn(id)) { row.addClass('is-static'); return; }
    row.addClass('is-link');
    row.addEventListener('mouseenter', () => this.renderer.setPreview(id));
    row.addEventListener('mouseleave', () => this.renderer.setPreview(null));
    row.addEventListener('click', ev => { this.renderer.setPreview(null); if (onClick) onClick(ev); else this.focusNode(id); });
  }

  private infoButtons(el: HTMLElement, items: { icon: string; text: string; run: () => void; cta?: boolean }[]): void {
    const row = el.createDiv({ cls: 'tag-graph-info-actions' });
    for (const it of items) {
      const b = row.createEl('button', { cls: it.cta ? 'mod-cta' : '' });
      setIcon(b.createSpan({ cls: 'tag-graph-info-action-icon' }), it.icon);
      b.createSpan({ text: it.text });
      b.addEventListener('click', it.run);
    }
  }

  private noteRow(parent: HTMLElement, n: InsightNote, extra?: string): void {
    const row = parent.createDiv({ cls: 'tag-graph-info-note' });
    const g = this.model?.nodes.find(x => x.id === noteId(n.path));
    if (g) this.nodeDot(row, g);
    else row.createSpan({ cls: 'tag-graph-swatch is-note' }).setCssProps({ '--fg-color': 'var(--text-faint)' });
    row.createSpan({ cls: 'tag-graph-info-note-name', text: n.name });
    row.createSpan({ cls: 'tag-graph-info-note-sub', text: extra ?? (n.folder || t('ui.root')) });
    this.wireRow(row, noteId(n.path), ev => {
      const file = this.notes.get(n.path)?.file;
      if (file) void this.plugin.app.workspace.getLeaf(Keymap.isModEvent(ev) ? 'tab' : false).openFile(file);
    });
  }

  /** A value: how much it is used, where, what it comes with, which notes, and what might be the same value. */
  private hubInfo(el: HTMLElement, g: GNode): void {
    const f = this.spec(g.facet);
    const v = this.valueOfHub(g);
    if (!f || !v || !this.model) return;
    const color = this.facetColor(f.id);
    const title = g.type === 'subhub' ? g.label + ' · ' + (g.subFolder || t('ui.root')) : g.label;
    this.infoHead(el, f.label, title, line => line.createSpan({ cls: 'tag-graph-swatch is-hub' }).setCssProps({ '--fg-color': color }));

    // A sub-hub speaks for its folder only.
    const scope = g.type === 'subhub' ? this.rows.filter(n => n.folder === (g.subFolder || '')) : this.rows;
    const vi = valueInsight(scope, f.id, v.key, Date.now());
    const members = vi.notes;
    const total = this.model.noteCount || 1;
    const share = Math.round(members.length / total * 100);
    const stats = [
      { value: String(members.length), label: count(members.length, 'info.note', 'info.notes') },
      { value: (share < 1 && members.length ? '<1' : String(share)) + '%', label: t('info.ofBase') },
    ];
    // A sub-hub is one folder's share of the value; the value's whole spread is on its parent.
    if (f.kind !== 'folder' && g.type === 'hub') stats.push({ value: String(vi.folders.length), label: count(vi.folders.length, 'info.folder', 'info.folders') });
    this.infoStats(el, stats);
    const meter = el.createDiv({ cls: 'tag-graph-info-meter' });
    meter.createSpan({ cls: 'tag-graph-info-bar-fill' }).setCssProps({ '--fg-color': color, '--fg-share': String(members.length / total) });
    // Is it still in use? When it was last touched, and how much of it lately.
    if (vi.latest) {
      const when = el.createDiv({ cls: 'tag-graph-info-when' });
      when.createSpan({ text: t('info.lastEdited', { when: ago(vi.latest.mtime) }) + ' · ' });
      const link = when.createSpan({ cls: 'tag-graph-info-when-note', text: vi.latest.name });
      this.wireRow(link, noteId(vi.latest.path));
      when.createDiv({ cls: 'tag-graph-info-when-sub', text: t('info.recent', { n: vi.recent, total: members.length }) });
    }

    /* where it is used */
    if (f.kind !== 'folder' && vi.folders.length > 1 && g.type !== 'subhub') {
      const sec = this.infoSection(el, t('info.where'));
      const top = vi.folders[0].count;
      for (const c of vi.folders.slice(0, 5)) {
        const ids = vi.notes.filter(n => n.folder === c.key).map(n => noteId(n.path));
        const row = this.barRow(sec, c.key || t('ui.root'), c.count, top, color);
        row.addClass('is-link');
        row.addEventListener('mouseenter', () => this.renderer.setSpotlight(ids));
        row.addEventListener('mouseleave', () => this.renderer.setSpotlight(null));
      }
      if (vi.folders.length > 5) sec.createDiv({ cls: 'tag-graph-info-more', text: t('info.andMore', { n: vi.folders.length - 5 }) });
    }

    /* what it comes with */
    const together = vi.together.filter(x => !(x.facet === f.id && x.key === v.key)).slice(0, 6);
    if (together.length) {
      const sec = this.infoSection(el, t('info.together'));
      for (const x of together) {
        const id = hubId(x.facet, x.key);
        const label = this.values.get(hubKey(x.facet, x.key))?.label || x.label;
        const row = this.barRow(sec, label, x.count, members.length || 1, this.facetColor(x.facet),
          r => r.createSpan({ cls: 'tag-graph-swatch is-hub' }).setCssProps({ '--fg-color': this.facetColor(x.facet) }));
        row.setAttr('aria-label', t('info.togetherTip', { n: x.count, value: label }));
        this.wireRow(row, id);
      }
    }

    /* its notes */
    const sec = this.infoSection(el, t('info.notesList'), members.length);
    // Name order finds a note; recent order shows what is happening with the value now.
    const sorter = sec.querySelector('.tag-graph-info-section-head')!.createDiv({ cls: 'tag-graph-info-sort' });
    for (const mode of ['name', 'recent'] as const) {
      const b = sorter.createSpan({ cls: 'tag-graph-info-sort-item', text: t(mode === 'name' ? 'info.sortName' : 'info.sortRecent') });
      b.toggleClass('is-active', this.infoSort === mode);
      b.addEventListener('click', () => { this.infoSort = mode; this.renderInfo(); });
    }
    if (this.infoSort === 'recent') members.sort((a, b) => b.mtime - a.mtime);
    const list = sec.createDiv({ cls: 'tag-graph-info-notes' });
    const limit = this.infoAll ? members.length : 6;
    // Beside each note: its folder when the value spans folders, else what else it is tagged with.
    const oneFolder = new Set(members.map(n => n.folder)).size <= 1;
    const others = (n: InsightNote) => {
      const out: string[] = [];
      for (const ff of this.facets) for (const x of n.values[ff.id] || []) if (!(ff.id === f.id && x.key === v.key)) out.push(x.label);
      return out.slice(0, 2).join(' ');
    };
    for (const n of members.slice(0, limit)) {
      this.noteRow(list, n, this.infoSort === 'recent' && n.mtime ? ago(n.mtime) : oneFolder ? others(n) : undefined);
    }
    if (members.length > limit) {
      const more = sec.createDiv({ cls: 'tag-graph-info-more is-link', text: t('ui.more', { n: members.length - limit }) });
      more.addEventListener('click', () => { this.infoAll = true; this.renderInfo(); });
    }

    /* the same value, written another way */
    const editable = f.kind !== 'readonly' && f.kind !== 'folder';
    if (editable) {
      const lf = this.model.legend.find(x => x.facet.id === f.id);
      const pairs = lf ? nearDuplicates(lf.values.map(x => ({ key: x.valueKey, label: x.label, count: x.count })))
        .filter(p => p.from.key === v.key || p.into.key === v.key) : [];
      if (pairs.length) {
        const dsec = this.infoSection(el, t('info.lookalike'));
        for (const p of pairs.slice(0, 3)) this.duplicateRow(dsec, f, p.from, p.into);
      }
    }

    /* what can be done with it */
    const actions: { icon: string; text: string; run: () => void }[] = [];
    if (editable) {
      actions.push({ icon: 'pencil', text: t('info.rename'), run: () => this.rename(f, v) });
      actions.push({ icon: 'file-plus', text: t('info.newNote'), run: () => { void this.newNoteWith(f, v); } });
    }
    actions.push({ icon: 'eye-off', text: t('info.hide'), run: () => { this.renderer.setFocus(null); this.toggleHidden(hubKey(f.id, v.key)); } });
    this.infoButtons(el, actions);
  }

  /** "#recipes (2) → #recipe (6)" with a button that merges them. */
  private duplicateRow(parent: HTMLElement, f: FacetSpec, from: { key: string; label: string; count: number }, into: { key: string; label: string; count: number }): void {
    const row = parent.createDiv({ cls: 'tag-graph-info-dup' });
    const names = row.createDiv({ cls: 'tag-graph-info-dup-names' });
    const name = (x: { key: string; label: string; count: number }) => {
      const s = names.createSpan({ cls: 'tag-graph-info-dup-name' });
      s.createSpan({ text: x.label });
      s.createSpan({ cls: 'tag-graph-info-dup-count', text: String(x.count) });
      const id = hubId(f.id, x.key);
      if (this.drawn(id)) {
        s.addClass('is-link');
        s.addEventListener('mouseenter', () => this.renderer.setPreview(id));
        s.addEventListener('mouseleave', () => this.renderer.setPreview(null));
      }
    };
    name(from);
    setIcon(names.createSpan({ cls: 'tag-graph-info-dup-arrow' }), 'arrow-right');
    name(into);
    const b = row.createEl('button', { text: t('info.merge') });
    b.addEventListener('click', () => {
      const a = this.values.get(hubKey(f.id, from.key)), z = this.values.get(hubKey(f.id, into.key));
      if (a && z) void this.replaceValue(f, a, z, true);
    });
  }

  /** A note: where it is, its values, its links, and the notes most like it. */
  private noteInfo(el: HTMLElement, g: GNode): void {
    const row = this.rows.find(n => n.path === g.path);
    if (!row) return;
    this.infoHead(el, g.folder || t('ui.root'), g.label, line => this.nodeDot(line, g));
    if (row.mtime) el.createDiv({ cls: 'tag-graph-info-when', text: t('info.edited', { when: ago(row.mtime) }) });
    const ls = this.linkStats.get(g.id) || { out: [], in: [] };
    let valueCount = 0;
    for (const f of this.facets) valueCount += (row.values[f.id] || []).length;
    this.infoStats(el, [
      { value: String(valueCount), label: count(valueCount, 'info.value', 'info.values') },
      { value: String(ls.out.length), label: count(ls.out.length, 'info.linkOut', 'info.linksOut') },
      { value: String(ls.in.length), label: count(ls.in.length, 'info.linkIn', 'info.linksIn') },
    ]);

    /* values, by property */
    for (const f of this.facets) {
      const vals = row.values[f.id] || [];
      if (!vals.length) continue;
      const sec = this.infoSection(el, f.label);
      const chips = sec.createDiv({ cls: 'tag-graph-info-chips' });
      for (const v of vals) {
        const c = chips.createSpan({ cls: 'tag-graph-chip', text: v.label });
        c.setCssProps({ '--fg-color': this.facetColor(f.id) });
        const id = v.notePath && this.drawn(noteId(v.notePath)) ? noteId(v.notePath) : hubId(f.id, v.key);
        this.wireRow(c, id);
      }
    }

    /* links */
    const byId = (id: string) => this.rows.find(n => noteId(n.path) === id);
    const linkList = (title: string, ids: string[], arrow: string) => {
      if (!ids.length) return;
      const sec = this.infoSection(el, title, ids.length);
      const list = sec.createDiv({ cls: 'tag-graph-info-notes' });
      for (const id of ids.slice(0, 6)) { const n = byId(id); if (n) this.noteRow(list, n, arrow); }
    };
    linkList(t('info.linksOutList'), ls.out, '→');
    linkList(t('info.linksInList'), ls.in, '←');

    /* most alike */
    const alike = similarNotes(this.rows, row.path, 5);
    if (alike.length) {
      const sec = this.infoSection(el, t('info.alike'));
      const list = sec.createDiv({ cls: 'tag-graph-info-notes' });
      for (const a of alike) this.noteRow(list, a.note, a.shared.slice(0, 2).join(' '));
    }

    const file = this.notes.get(row.path)?.file;
    if (file) {
      this.infoButtons(el, [
        { icon: 'file', text: t('menu.open'), run: () => this.openNode(g, false), cta: true },
        { icon: 'file-plus', text: t('menu.openTab'), run: () => this.openNode(g, true) },
      ]);
    }
  }

  /** The whole base: size, how well each property covers it, what is most used, and what needs tidying. */
  private overviewInfo(el: HTMLElement): void {
    const model = this.model;
    if (!model) return;
    this.infoHead(el, t('info.overviewKind'), t('info.overview'), line => setIcon(line.createSpan({ cls: 'tag-graph-info-kind-icon' }), 'layout-dashboard'));
    const hubs = model.nodes.filter(n => n.type === 'hub');
    const links = model.edges.filter(e => e.type === 'link').length;
    this.infoStats(el, [
      { value: String(model.noteCount), label: count(model.noteCount, 'info.note', 'info.notes') },
      { value: String(hubs.length), label: count(hubs.length, 'info.value', 'info.values') },
      { value: String(links), label: count(links, 'info.link', 'info.links') },
    ]);

    /* coverage: how many notes have each property, and a way to find the rest */
    const facets = model.legend.filter(lf => !lf.hidden && lf.facet.kind !== 'folder');
    if (facets.length) {
      const sec = this.infoSection(el, t('info.coverage'));
      for (const lf of facets) {
        const gaps = missing(this.rows, lf.facet.id);
        const have = model.noteCount - gaps.length;
        const color = this.facetColor(lf.facet.id);
        const row = this.barRow(sec, lf.facet.label, have, model.noteCount, color,
          r => r.createSpan({ cls: 'tag-graph-swatch is-hub' }).setCssProps({ '--fg-color': color }),
          Math.round(have / Math.max(1, model.noteCount) * 100) + '%');
        row.setAttr('aria-label', t('info.coverageTip', { n: have, total: model.noteCount }));
        if (gaps.length) this.spotRow(sec, 'missing:' + lf.facet.id, t(gaps.length === 1 ? 'info.without1' : 'info.without', { n: gaps.length, facet: lf.facet.label }), gaps.map(n => noteId(n.path)));
      }
    }

    /* most used */
    const top = hubs.slice().sort((a, b) => b.count - a.count).slice(0, 6);
    if (top.length) {
      const sec = this.infoSection(el, t('info.top'));
      for (const g of top) {
        const row = this.barRow(sec, g.label, g.count, top[0].count, this.facetColor(g.facet || ''), r => this.nodeDot(r, g));
        this.wireRow(row, g.id);
      }
    }

    /* needs tidying: look-alike values, rare values, notes with nothing */
    const tidy: (() => void)[] = [];
    const sec = el.createDiv();
    const dupFacets = model.legend.filter(lf => !lf.hidden && (lf.facet.kind === 'tags' || lf.facet.kind === 'text' || lf.facet.kind === 'link'));
    // A loop, not flatMap: the ES2018 target has no flatMap, and the review reads it as untyped.
    const dups: { lf: LegendFacet; p: DuplicatePair<{ key: string; label: string; count: number }> }[] = [];
    for (const lf of dupFacets) {
      for (const p of nearDuplicates(lf.values.map(x => ({ key: x.valueKey, label: x.label, count: x.count })), 4)) dups.push({ lf, p });
    }
    if (dups.length) tidy.push(() => {
      const d = this.infoSection(sec, t('info.lookalikes'), dups.length);
      for (const { lf, p } of dups.slice(0, 4)) this.duplicateRow(d, lf.facet, p.from, p.into);
    });
    const min = this.num('minCount', 2);
    const rare = model.legend.reduce((s, lf) => s + (lf.hidden ? 0 : lf.values.filter(v => v.belowMin).length), 0);
    const lonely = model.nodes.filter(n => n.type === 'note' && n.count === 0).map(n => n.id);
    if (rare || lonely.length) tidy.push(() => {
      const d = this.infoSection(sec, t('info.tidy'));
      if (rare) {
        const row = d.createDiv({ cls: 'tag-graph-info-spot' });
        row.createSpan({ cls: 'tag-graph-info-spot-text', text: t('ui.belowMin', { n: rare, min }) });
        const b = row.createEl('button', { text: t('info.showRare') });
        b.addEventListener('click', () => { this.config.set('minCount', 1); this.rebuild(); });
      }
      if (lonely.length) this.spotRow(d, 'lonely', t(lonely.length === 1 ? 'info.lonely1' : 'info.lonely', { n: lonely.length }), lonely);
    });
    for (const add of tidy) add();
    if (!tidy.length) sec.createDiv({ cls: 'tag-graph-info-ok', text: t('info.allTidy') });
  }

  /** "5 notes without tags  [Show]": the button lights them on the graph and fits the view to them. */
  private spotRow(parent: HTMLElement, key: string, text: string, ids: string[]): void {
    const row = parent.createDiv({ cls: 'tag-graph-info-spot' });
    row.createSpan({ cls: 'tag-graph-info-spot-text', text });
    const on = this.spotKey === key;
    const drawnIds = ids.filter(id => this.drawn(id));
    if (!drawnIds.length) return;
    const b = row.createEl('button', { text: on ? t('info.hideSpot') : t('info.showSpot'), cls: on ? 'mod-cta' : '' });
    b.addEventListener('click', () => {
      if (this.spotKey === key) this.setSpot(null, null);
      else { this.setSpot(key, drawnIds); this.renderer.fitIds(drawnIds); }
      this.renderInfo();
    });
  }

  private readTheme(): void {
    const cs = getComputedStyle(this.root);
    const v = (name: string, def: string) => cs.getPropertyValue(name).trim() || def;
    this.renderer.theme = {
      bg: v('--background-primary', '#ffffff'),
      text: v('--text-normal', '#222222'),
      muted: v('--text-muted', '#777777'),
      faint: v('--text-faint', '#aaaaaa'),
      accent: v('--interactive-accent', '#7c5cff'),
      accentText: v('--text-on-accent', '#ffffff'),
      font: v('--font-interface', 'sans-serif'),
    };
  }

  private renderEmpty(entries: number, facets: number): void {
    this.emptyEl.empty();
    const noNotes = entries === 0;
    const noFacet = !noNotes && facets === 0 && !(this.model && this.model.edges.length);
    this.root.toggleClass('is-empty', noNotes || noFacet);
    if (!noNotes && !noFacet) return;
    this.emptyEl.createDiv({ cls: 'tag-graph-empty-title', text: t('ui.empty.title') });
    this.emptyEl.createDiv({ text: noNotes ? t('ui.empty.noNotes') : t('ui.empty.noFacet') });
  }

  private renderHint(): void {
    this.hintEl.empty();
    const show = this.plugin.settings.showHints && !!this.model && this.model.nodes.length > 0;
    this.root.toggleClass('has-hint', show);
    if (!show) return;
    this.hintEl.createSpan({ text: t('ui.hint') });
    const b = this.hintEl.createEl('button', { text: t('ui.hint.dismiss'), cls: 'tag-graph-hint-dismiss' });
    b.addEventListener('click', () => {
      this.plugin.settings.showHints = false;
      void this.plugin.saveSettings();
      this.renderHint();
    });
  }

  /* ================================================================ legend */

  private renderLegend(): void {
    const el = this.legendEl;
    el.empty();
    const model = this.model;
    if (!model) return;
    const focus = this.renderer.focus;
    const min = this.num('minCount', 2);

    for (const lf of model.legend) {
      const color = this.facetColor(lf.facet.id);
      const sec = el.createDiv({ cls: 'tag-graph-legend-section' });
      sec.toggleClass('is-hidden', lf.hidden);
      const head = sec.createDiv({ cls: 'tag-graph-legend-head' });
      const sw = head.createSpan({ cls: 'tag-graph-swatch is-hub' });
      sw.setCssProps({ '--fg-color': color });
      head.createSpan({ cls: 'tag-graph-legend-title', text: lf.facet.label });
      head.createSpan({ cls: 'tag-graph-legend-count', text: String(lf.values.filter(v => !v.belowMin).length) });
      this.eye(head, !lf.hidden, () => this.toggleHidden(lf.facet.id));
      if (lf.hidden) continue;

      const visible = lf.values.filter(v => !v.belowMin);
      const below = lf.values.length - visible.length;
      const open = this.expanded.has(lf.facet.id);
      const rows = open ? visible : visible.slice(0, LEGEND_ROWS);
      const list = sec.createDiv({ cls: 'tag-graph-legend-rows' });
      for (const v of rows) {
        const id = hubId(lf.facet.id, v.valueKey);
        const target = v.isNote ? noteId(this.values.get(v.hubKey)?.notePath || '') : id;
        const row = list.createDiv({ cls: 'tag-graph-legend-row' });
        row.toggleClass('is-hidden', v.hidden);
        row.toggleClass('is-focused', focus === target);
        const dot = row.createSpan({ cls: 'tag-graph-swatch' + (v.isNote ? ' is-note' : ' is-hub') });
        dot.setCssProps({ '--fg-color': color });
        row.createSpan({ cls: 'tag-graph-legend-label', text: v.label });
        row.createSpan({ cls: 'tag-graph-legend-count', text: String(v.count) });
        this.eye(row, !v.hidden, () => this.toggleHidden(v.hubKey));
        row.addEventListener('click', ev => {
          if ((ev.target as HTMLElement).closest('.tag-graph-eye')) return;
          if (v.hidden) return;
          if (focus === target) { this.renderer.setFocus(null); this.renderLegend(); this.renderInfo(); }
          else this.focusNode(target, false);
        });
        // Hovering a row previews its notes on the graph; double-clicking zooms to them.
        row.addEventListener('mouseenter', () => { if (!v.hidden) this.renderer.setPreview(target); });
        row.addEventListener('mouseleave', () => this.renderer.setPreview(null));
        row.addEventListener('dblclick', ev => {
          if (v.hidden || (ev.target as HTMLElement).closest('.tag-graph-eye')) return;
          this.focusNode(target);
        });
      }
      if (visible.length > LEGEND_ROWS) {
        const more = sec.createDiv({ cls: 'tag-graph-legend-more', text: open ? t('ui.less') : t('ui.more', { n: visible.length - LEGEND_ROWS }) });
        more.addEventListener('click', () => { if (open) this.expanded.delete(lf.facet.id); else this.expanded.add(lf.facet.id); this.renderLegend(); });
      }
      if (below > 0) sec.createDiv({ cls: 'tag-graph-legend-note', text: t('ui.belowMin', { n: below, min }) });
    }

    /* links */
    const kinds = this.linkKinds();
    const present = LINK_KINDS.filter(k => model.linkCounts[k] > 0);
    if (present.length) {
      const sec = el.createDiv({ cls: 'tag-graph-legend-section' });
      sec.createDiv({ cls: 'tag-graph-legend-head' }).createSpan({ cls: 'tag-graph-legend-title', text: t('ui.links') });
      for (const k of present) {
        const row = sec.createDiv({ cls: 'tag-graph-legend-row' });
        row.toggleClass('is-hidden', !kinds.has(k));
        row.createSpan({ cls: 'tag-graph-line is-' + k });
        row.createSpan({ cls: 'tag-graph-legend-label', text: t(('link.' + k) as 'link.body') });
        row.createSpan({ cls: 'tag-graph-legend-count', text: String(model.linkCounts[k]) });
        this.eye(row, kinds.has(k), () => {
          const next = this.linkKinds();
          if (next.has(k)) next.delete(k); else next.add(k);
          this.config.set('links', LINK_KINDS.filter(x => next.has(x)));
          this.rebuild();
        });
      }
    }

    /* colours */
    if (model.colorKeys.length) {
      const sec = el.createDiv({ cls: 'tag-graph-legend-section' });
      sec.createDiv({ cls: 'tag-graph-legend-head' }).createSpan({ cls: 'tag-graph-legend-title', text: this.colorSource });
      const keys = model.colorKeys.slice(0, 12);
      for (const c of keys) {
        const row = sec.createDiv({ cls: 'tag-graph-legend-row is-static' });
        const sw = row.createSpan({ cls: 'tag-graph-swatch is-note' });
        sw.setCssProps({ '--fg-color': paletteColor(this.colorIndex.get(c.key) ?? 0) });
        row.createSpan({ cls: 'tag-graph-legend-label', text: c.key });
        row.createSpan({ cls: 'tag-graph-legend-count', text: String(c.count) });
      }
    }
  }

  private eye(parent: HTMLElement, on: boolean, toggle: () => void): void {
    const b = parent.createEl('button', { cls: 'clickable-icon tag-graph-eye', attr: { 'aria-label': on ? t('ui.hide') : t('ui.show') } });
    setIcon(b, on ? 'eye' : 'eye-off');
    b.addEventListener('click', ev => { ev.stopPropagation(); toggle(); });
  }

  private toggleHidden(key: string): void {
    const h = this.hiddenSet();
    if (h.has(key)) h.delete(key); else h.add(key);
    this.config.set('hidden', h.size ? [...h] : null);
    this.rebuild();
  }

  /* ================================================================ hover */

  private hover(g: GNode | null, ev: PointerEvent | null): void {
    if (!g || !ev) {
      this.tipEl.removeClass('is-visible');
      this.lastHoverId = null;
      return;
    }
    if (g.id !== this.lastHoverId) {
      this.lastHoverId = g.id;
      this.lastHoverMod = false;
      this.fillTip(g, ev.pointerType === 'mouse');
    }
    const mod = Keymap.isModEvent(ev) === true || ev.ctrlKey || ev.metaKey;
    if (g.type === 'note' && g.path && mod && !this.lastHoverMod) {
      this.lastHoverMod = true;
      this.plugin.app.workspace.trigger('hover-link', {
        event: ev, source: VIEW_TYPE, hoverParent: this, targetEl: this.renderer.canvas, linktext: g.path, sourcePath: '',
      });
    }
    const r = this.root.getBoundingClientRect();
    let x = ev.clientX - r.left + 16, y = ev.clientY - r.top + 16;
    const tw = this.tipEl.offsetWidth || 220, th = this.tipEl.offsetHeight || 60;
    if (x + tw > r.width - 8) x = ev.clientX - r.left - tw - 12;
    if (y + th > r.height - 8) y = ev.clientY - r.top - th - 12;
    this.tipEl.setCssProps({ '--fg-x': Math.max(4, x) + 'px', '--fg-y': Math.max(4, y) + 'px' });
    this.tipEl.addClass('is-visible');
  }

  private fillTip(g: GNode, mouse: boolean): void {
    const el = this.tipEl;
    el.empty();
    if (g.type === 'note') {
      el.createDiv({ cls: 'tag-graph-tip-title', text: g.label });
      const file = g.path ? this.notes.get(g.path)?.file : undefined;
      const edited = file ? ' · ' + t('info.edited', { when: ago(file.stat.mtime) }) : '';
      el.createDiv({ cls: 'tag-graph-tip-sub', text: (g.folder || t('ui.root')) + edited });
      const meta = g.path ? this.notes.get(g.path) : undefined;
      if (meta) {
        const chips = el.createDiv({ cls: 'tag-graph-tip-chips' });
        let n = 0;
        for (const f of this.facets) {
          for (const v of meta.values[f.id] || []) {
            if (n++ >= 10) break;
            const c = chips.createSpan({ cls: 'tag-graph-chip', text: v.label });
            c.setCssProps({ '--fg-color': this.facetColor(f.id) });
          }
        }
      }
      const ls = this.linkStats.get(g.id);
      if (ls && (ls.out.length || ls.in.length)) el.createDiv({ cls: 'tag-graph-tip-sub tag-graph-tip-links', text: t('tip.links', {
        out: ls.out.length, in: ls.in.length,
        outLabel: count(ls.out.length, 'info.linkOut', 'info.linksOut'), inLabel: count(ls.in.length, 'info.linkIn', 'info.linksIn'),
      }) });
    } else {
      const f = this.facets.find(x => x.id === g.facet);
      el.createDiv({ cls: 'tag-graph-tip-title', text: g.label });
      const where = g.type === 'subhub' ? ' · ' + (g.subFolder ? g.subFolder : '/') : '';
      el.createDiv({ cls: 'tag-graph-tip-sub', text: (f ? f.label : '') + where + ' · ' + t('ui.notes', { n: g.count }) });
      const v = this.valueOfHub(g);
      if (f && v && this.model) {
        const pct = Math.round(g.count / Math.max(1, this.model.noteCount) * 100);
        const meter = el.createDiv({ cls: 'tag-graph-tip-meter' });
        meter.createSpan({ cls: 'tag-graph-info-bar-fill' }).setCssProps({ '--fg-color': this.facetColor(f.id), '--fg-share': String(g.count / Math.max(1, this.model.noteCount)) });
        el.createDiv({ cls: 'tag-graph-tip-sub', text: t('tip.share', { pct }) });
        const top = valueInsight(this.rows, f.id, v.key).together.slice(0, 3).map(x => this.values.get(hubKey(x.facet, x.key))?.label || x.label);
        if (top.length) el.createDiv({ cls: 'tag-graph-tip-sub', text: t('tip.with', { values: top.join(', ') }) });
      }
    }
    // What a click does, for as long as the editing hint is shown. Touch has its own gestures.
    if (mouse && this.plugin.settings.showHints) {
      el.createDiv({ cls: 'tag-graph-tip-hint', text: g.type === 'note' ? t('tip.note', { keys: linkKeys() }) : t('tip.hub') });
    }
  }

  /* ================================================================ open */

  private fileOf(g: GNode): TFile | null {
    if (!g.path) return null;
    const meta = this.notes.get(g.path);
    if (meta) return meta.file;
    const f = this.plugin.app.vault.getAbstractFileByPath(g.path);
    return f instanceof TFile ? f : null;
  }

  private openNode(g: GNode, newTab: boolean): void {
    const file = this.fileOf(g);
    if (file) void this.plugin.app.workspace.getLeaf(newTab ? 'tab' : false).openFile(file);
  }

  /* ================================================================ drops */

  private spec(id: string | undefined): FacetSpec | undefined {
    return this.facets.find(f => f.id === id);
  }

  private has(path: string, facetId: string, valueKey: string): boolean {
    const meta = this.notes.get(path);
    return !!meta && (meta.values[facetId] || []).some(v => v.key === valueKey);
  }

  private valueOfHub(g: GNode): FacetValue | null {
    if (!g.facet || g.valueKey === undefined) return null;
    return this.values.get(hubKey(g.facet, g.valueKey)) || null;
  }

  /** If a note is itself the value of a link facet, which facet. */
  private linkFacetOfNote(path: string): FacetSpec | null {
    for (const f of this.facets) {
      if (f.kind !== 'link') continue;
      if (this.values.has(hubKey(f.id, 'link:' + path))) return f;
    }
    return null;
  }

  /**
   * What dropping `a` on `b` would do. A plain link between two notes needs
   * Alt or Ctrl (Option or Cmd on a Mac) held, so passing over a note on the
   * way somewhere does not link it by accident; touch has no keys and is exempt.
   */
  private dropVerdict(a: GNode, b: GNode, linkKey: boolean): DropVerdict | null {
    if (a.type === 'note' && b.type !== 'note') {
      const f = this.spec(b.facet);
      const v = this.valueOfHub(b);
      if (!f || !v) return null;
      if (f.kind === 'readonly') return { text: t('ui.readonly', { facet: f.label }), ok: false };
      if (this.has(a.path!, f.id, v.key)) return { text: t('drop.already', { value: v.label }), ok: false };
      if (f.kind === 'folder') return { text: t('drop.move', { value: v.label }), ok: true };
      const cur = this.notes.get(a.path!)?.values[f.id] || [];
      if (!f.list && cur.length > 0) return { text: t('drop.set', { facet: f.label, value: v.label }), ok: true };
      return { text: t('drop.add', { value: v.label }), ok: true };
    }
    if (a.type === 'note' && b.type === 'note') {
      const lf = this.linkFacetOfNote(b.path!);
      if (lf) {
        if (this.has(a.path!, lf.id, 'link:' + b.path)) return { text: t('drop.already', { value: b.label }), ok: false };
        const cur = this.notes.get(a.path!)?.values[lf.id] || [];
        if (!lf.list && cur.length > 0) return { text: t('drop.set', { facet: lf.label, value: b.label }), ok: true };
        return { text: t('drop.add', { value: b.label }), ok: true };
      }
      const prop = this.linkProperty();
      if (!prop) return null;
      if (!linkKey) return { text: t('drop.linkHold', { keys: linkKeys(), prop }), ok: false };
      return { text: t('drop.link', { prop }), ok: true };
    }
    if (a.type !== 'note' && b.type !== 'note') {
      if (a.facet !== b.facet) return { text: t('drop.cannot'), ok: false };
      if (a.valueKey === b.valueKey) return null;
      const f = this.spec(a.facet);
      const to = this.valueOfHub(b);
      if (!f || !to) return null;
      if (f.kind === 'readonly') return { text: t('ui.readonly', { facet: f.label }), ok: false };
      if (f.kind === 'folder') {
        if (!this.plugin.settings.moveFolders || a.type !== 'hub' || b.type !== 'hub') return null;
        const where = folderMoveDest(a.valueKey!, to.key);
        if ('dest' in where) return { text: t('drop.move', { value: to.label }), ok: true };
        if (where.reason === 'same') return { text: t('drop.already', { value: to.label }), ok: false };
        if (where.reason === 'inside') return { text: t('drop.folderInside'), ok: false };
        return null;
      }
      return { text: t('drop.merge', { value: to.label }), ok: true };
    }
    return null;
  }

  private linkProperty(): string {
    const v = this.config.get('linkProperty');
    if (v === undefined) return 'related';
    return String(v ?? '').trim();
  }

  private async drop(a: GNode, b: GNode, linkKey: boolean): Promise<void> {
    const actions = this.plugin.actions;
    if (a.type === 'note' && b.type !== 'note') {
      const file = this.fileOf(a);
      const f = this.spec(b.facet);
      const v = this.valueOfHub(b);
      if (!file || !f || !v) return;
      if (f.kind === 'folder') {
        if (this.plugin.settings.confirmMoves &&
          !(await confirm(this.plugin, t('modal.move.title', { note: file.basename, folder: v.label }), t('modal.move.desc')))) return;
        await actions.move(file, v.key);
        return;
      }
      await actions.add(file, f, v);
      return;
    }
    if (a.type === 'note' && b.type === 'note') {
      const file = this.fileOf(a), target = this.fileOf(b);
      if (!file || !target) return;
      const lf = this.linkFacetOfNote(target.path);
      if (lf) { await actions.add(file, lf, { key: 'link:' + target.path, label: target.basename, notePath: target.path }); return; }
      const prop = this.linkProperty();
      if (prop && linkKey) await actions.link(file, target, prop);
      return;
    }
    if (a.type !== 'note' && b.type !== 'note') {
      const f = this.spec(a.facet);
      const from = this.valueOfHub(a), to = this.valueOfHub(b);
      if (!f || !from || !to) return;
      if (f.kind === 'folder') {
        if (!this.plugin.settings.moveFolders || !('dest' in folderMoveDest(from.key, to.key))) return;
        if (this.plugin.settings.confirmMoves &&
          !(await confirm(this.plugin, t('modal.move.title', { note: from.label, folder: to.label }), t('modal.moveFolder.desc')))) return;
        await actions.moveFolder(from.key, to.key);
        return;
      }
      await this.replaceValue(f, from, to, true);
    }
  }

  /** Files in this base that have the value. */
  private filesWith(facetId: string, valueKey: string): TFile[] {
    const out: TFile[] = [];
    for (const m of this.notes.values()) if ((m.values[facetId] || []).some(v => v.key === valueKey)) out.push(m.file);
    return out;
  }

  private async replaceValue(f: FacetSpec, from: FacetValue, to: FacetValue, merge: boolean): Promise<void> {
    const files = this.filesWith(f.id, from.key);
    if (!files.length) return;
    const fromLabel = f.kind === 'tags' ? tagLabel(from.label) : from.label;
    const toLabel = f.kind === 'tags' ? tagLabel(to.label) : to.label;
    if (merge && files.length > 1 && this.plugin.settings.confirmBulk) {
      const ok = await confirm(this.plugin, t('modal.merge.title', { from: fromLabel, to: toLabel }),
        t('modal.merge.desc', { n: files.length, from: fromLabel, to: toLabel }));
      if (!ok) return;
    }
    await this.plugin.actions.replace(files, f, from.key, fromLabel, to, merge);
  }

  /* ================================================================ menus */

  private contextMenu(g: GNode | null, x: number, y: number): void {
    const menu = new Menu();
    if (!g) {
      menu.addItem(i => i.setTitle(t('ui.fit')).setIcon('maximize').onClick(() => this.renderer.fit()));
      menu.addItem(i => i.setTitle(this.renderer.frozen ? t('ui.unfreeze') : t('ui.freeze'))
        .setIcon(this.renderer.frozen ? 'play' : 'snowflake').onClick(() => this.setFrozen(!this.renderer.frozen)));
      menu.addItem(i => i.setTitle(t('ui.relayout')).setIcon('refresh-cw').onClick(() => this.renderer.relayout()));
      menu.addItem(i => i.setTitle(t('ui.settings')).setIcon('settings').onClick(() => this.setPanel(true)));
      menu.showAtPosition({ x, y });
      return;
    }
    if (g.type === 'note') {
      const file = this.fileOf(g);
      if (!file) return;
      menu.addItem(i => i.setSection('open').setTitle(t('menu.open')).setIcon('file').onClick(() => this.openNode(g, false)));
      menu.addItem(i => i.setSection('open').setTitle(t('menu.openTab')).setIcon('file-plus').onClick(() => this.openNode(g, true)));
      menu.addItem(i => i.setSection('open').setTitle(t('ui.details')).setIcon('info').onClick(() => this.focusNode(g.id, false)));
      const meta = this.notes.get(file.path);
      for (const f of this.facets) {
        if (f.kind === 'readonly' || f.kind === 'folder') continue;
        for (const v of meta?.values[f.id] || []) {
          const label = f.kind === 'tags' ? v.label : f.label + ': ' + v.label;
          menu.addItem(i => i.setSection('action-primary').setTitle(t('menu.remove', { value: label })).setIcon('x')
            .onClick(() => { void this.plugin.actions.remove(file, f, v.key, label); }));
        }
      }
      this.plugin.app.workspace.trigger('file-menu', menu, file, 'tag-graph');
      menu.showAtPosition({ x, y });
      return;
    }
    const f = this.spec(g.facet);
    const v = this.valueOfHub(g);
    if (!f || !v) return;
    const focused = this.renderer.focus === g.id;
    menu.addItem(i => i.setTitle(focused ? t('menu.unfocus') : t('menu.focus')).setIcon('focus')
      .onClick(() => {
        if (focused) { this.renderer.setFocus(null); this.renderLegend(); this.renderInfo(); } else this.focusNode(g.id, false);
      }));
    if (f.kind !== 'readonly' && f.kind !== 'folder') {
      menu.addItem(i => i.setTitle(t('menu.rename')).setIcon('pencil').onClick(() => this.rename(f, v)));
      menu.addItem(i => i.setTitle(t('menu.newNote')).setIcon('file-plus').onClick(() => { void this.newNoteWith(f, v); }));
    }
    menu.addItem(i => i.setTitle(t('menu.hide')).setIcon('eye-off').onClick(() => this.toggleHidden(hubKey(f.id, v.key))));
    menu.showAtPosition({ x, y });
  }

  private rename(f: FacetSpec, v: FacetValue): void {
    const files = this.filesWith(f.id, v.key);
    const current = f.kind === 'tags' ? v.label.replace(/^#/, '') : v.label;
    new RenameModal(this.plugin, t('modal.rename.title', { value: f.kind === 'tags' ? tagLabel(v.label) : v.label }),
      t('modal.rename.desc', { n: files.length }), current, f.kind === 'tags', async text => {
        let to: FacetValue;
        if (f.kind === 'tags') to = { key: tagKey(text), label: text.replace(/^#/, '') };
        else if (f.kind === 'link') {
          const raw = /^\[\[.*\]\]$/.test(text) ? text : '[[' + text + ']]';
          to = this.resolver.valueOf('text', raw, files[0]?.path || '');
        } else to = { key: text.trim(), label: text.trim() };
        if (to.key === v.key && to.label === (f.kind === 'tags' ? current : v.label)) return;
        await this.replaceValue(f, v, to, false);
      }).open();
  }

  private async newNoteWith(f: FacetSpec, v: FacetValue): Promise<void> {
    const name = f.kind === 'tags' ? 'tags' : parsePropertyId(f.id as BasesPropertyId).name;
    const written = f.kind === 'tags' ? v.label.replace(/^#/, '')
      : v.notePath || v.key.startsWith('link:') ? '[[' + v.label + ']]' : v.label;
    await this.createFileForView(undefined, (fm: Record<string, unknown>) => {
      if (f.kind === 'tags') fmAddTag(fm, written, () => false);
      else fmAdd(fm, name, written, f.list, () => false);
    });
  }
}

/** The keys that turn a note-on-note drop into a link, as this platform names them. */
function linkKeys(): string {
  return Platform.isMacOS ? '⌥/⌘' : 'Alt/Ctrl';
}

/** A tile caption that agrees with its number: "1 note", "2 notes". */
function count(n: number, one: Parameters<typeof t>[0], many: Parameters<typeof t>[0]): string {
  return t(n === 1 ? one : many);
}

/* ==================================================================== modals */

function confirm(plugin: TagGraphPlugin, title: string, desc: string): Promise<boolean> {
  return new Promise(resolve => {
    const m = new ConfirmModal(plugin, title, desc, resolve);
    m.open();
  });
}

class ConfirmModal extends Modal {
  private done = false;
  constructor(plugin: TagGraphPlugin, private title: string, private desc: string, private resolve: (ok: boolean) => void) {
    super(plugin.app);
  }
  onOpen(): void {
    this.setTitle(this.title);
    this.contentEl.createEl('p', { text: this.desc });
    new Setting(this.contentEl)
      .addButton(b => b.setButtonText(t('modal.cancel')).onClick(() => this.close()))
      .addButton(b => b.setButtonText(t('modal.confirm')).setCta().onClick(() => { this.finish(true); }));
  }
  private finish(ok: boolean): void {
    if (this.done) return;
    this.done = true;
    this.resolve(ok);
    this.close();
  }
  onClose(): void {
    this.contentEl.empty();
    if (!this.done) { this.done = true; this.resolve(false); }
  }
}

class RenameModal extends Modal {
  constructor(plugin: TagGraphPlugin, private title: string, private desc: string, private value: string,
    private isTag: boolean, private submit: (text: string) => Promise<void>) {
    super(plugin.app);
  }
  onOpen(): void {
    this.setTitle(this.title);
    this.contentEl.createEl('p', { text: this.desc, cls: 'setting-item-description' });
    const input = this.contentEl.createEl('input', { type: 'text', cls: 'tag-graph-rename-input', value: this.value });
    const err = this.contentEl.createDiv({ cls: 'tag-graph-rename-error' });
    const go = async () => {
      const text = input.value.trim();
      if (!text) return;
      if (this.isTag && !validTag(text)) { err.setText(t('modal.rename.invalid')); return; }
      this.close();
      await this.submit(text);
    };
    input.addEventListener('keydown', ev => { if (ev.key === 'Enter') { ev.preventDefault(); void go(); } });
    new Setting(this.contentEl)
      .addButton(b => b.setButtonText(t('modal.cancel')).onClick(() => this.close()))
      .addButton(b => b.setButtonText(t('modal.confirm')).setCta().onClick(() => { void go(); }));
    window.setTimeout(() => { input.focus(); input.select(); }, 0);
  }
  onClose(): void { this.contentEl.empty(); }
}
