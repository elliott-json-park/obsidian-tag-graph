import {
  BasesAllOptions, BasesPropertyId, BasesView, HoverParent, HoverPopover, Keymap, Menu, Modal,
  QueryController, Setting, TFile, parsePropertyId, setIcon,
} from 'obsidian';
import type TagGraphPlugin from './main';
import {
  FacetSpec, FacetValue, GNode, GraphModel, LINK_KINDS, LinkKind, NoteInput,
  buildGraph, hubKey, hubId, noteId, paletteColor, tagLabel, tagKey,
} from './model';
import { Renderer, DropVerdict } from './renderer';
import { Resolver, facetSpec } from './values';
import { fmAdd, fmAddTag, validTag } from './frontmatter';
import { t } from './i18n';

export const VIEW_TYPE = 'tag-graph';

/** Hub colours — kept apart from the note palette so a hub never looks like a note. */
const FACET_COLORS = ['#8b6cf0', '#e08a3c', '#22a38b', '#d4588f'];
const FACET_KEYS = ['facet1', 'facet2', 'facet3', 'facet4'];
const LEGEND_ROWS = 8;

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
  private resolver: Resolver;

  private model: GraphModel | null = null;
  private facets: FacetSpec[] = [];
  private notes = new Map<string, NoteMeta>();
  private values = new Map<string, FacetValue>();
  private colorIndex = new Map<string, number>();
  private expanded = new Set<string>();
  private lastHoverId: string | null = null;
  private lastHoverMod = false;
  private colorSource = '';
  /** Narrow (a sidebar, a small embed, a phone): the legend starts closed and is opened per session. */
  private narrow = false;
  private narrowLegend = false;

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
      dropVerdict: (a, b) => this.dropVerdict(a, b),
      drop: (a, b) => { void this.drop(a, b); },
      hover: (g, ev) => this.hover(g, ev),
      focusChanged: () => this.renderLegend(),
    });

    this.legendEl = this.root.createDiv({ cls: 'tag-graph-legend' });
    this.tipEl = this.root.createDiv({ cls: 'tag-graph-tip' });
    this.emptyEl = this.root.createDiv({ cls: 'tag-graph-empty' });
    this.statusEl = this.root.createDiv({ cls: 'tag-graph-status' });
    this.hintEl = this.root.createDiv({ cls: 'tag-graph-hint' });

    const bar = this.root.createDiv({ cls: 'tag-graph-toolbar' });
    const search = bar.createDiv({ cls: 'tag-graph-search' });
    this.searchEl = search.createEl('input', { type: 'search', attr: { placeholder: t('ui.search'), 'aria-label': t('ui.search') } });
    this.searchCount = search.createSpan({ cls: 'tag-graph-search-count' });
    this.searchEl.addEventListener('input', () => this.onSearch());
    this.searchEl.addEventListener('keydown', ev => {
      if (ev.key === 'Enter') this.renderer.fitMatches();
      if (ev.key === 'Escape') { this.searchEl.value = ''; this.onSearch(); this.renderer.canvas.focus(); }
    });
    this.button(bar, 'list', t('ui.legend'), () => {
      if (this.narrow) this.narrowLegend = !this.narrowLegend;
      else this.config.set('legendOpen', this.config.get('legendOpen') === false);
      this.applyLegend();
    });
    this.button(bar, 'maximize', t('ui.fit'), () => this.renderer.fit());
    this.freezeBtn = this.button(bar, 'snowflake', t('ui.freeze'), () => this.setFrozen(!this.renderer.frozen));
    this.button(bar, 'refresh-cw', t('ui.relayout'), () => this.renderer.relayout());

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

    this.renderer.frozen = this.bool('frozen', false);
    this.updateFreezeButton();
    this.root.toggleClass('is-legend-closed', !this.legendOpen());
    this.renderLegend();
    this.renderEmpty(entries.length, facets.length);
    this.updateInsets();
    this.renderer.setGraph(model, { animate: this.plugin.settings.animate });
    this.renderHint();
    if (this.searchEl.value) this.onSearch();
    const hubs = model.nodes.filter(n => n.type === 'hub').length;
    this.statusEl.setText(t('ui.status', { notes: model.noteCount, values: hubs }));
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
    this.renderer.insets = {
      left: legend && legend.width ? legend.right - r.left + 8 : 0,
      top: 52,
      right: 0,
      bottom: 28,
    };
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
          this.renderer.setFocus(focus === target ? null : target);
          this.renderLegend();
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
    this.config.set('hidden', [...h]);
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
      this.fillTip(g);
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

  private fillTip(g: GNode): void {
    const el = this.tipEl;
    el.empty();
    if (g.type === 'note') {
      el.createDiv({ cls: 'tag-graph-tip-title', text: g.label });
      if (g.folder) el.createDiv({ cls: 'tag-graph-tip-sub', text: g.folder });
      const meta = g.path ? this.notes.get(g.path) : undefined;
      if (meta) {
        const chips = el.createDiv({ cls: 'tag-graph-tip-chips' });
        let n = 0;
        for (const f of this.facets) {
          for (const v of meta.values[f.id] || []) {
            if (n++ >= 10) break;
            const c = chips.createSpan({ cls: 'tag-graph-chip', text: f.kind === 'tags' ? v.label : v.label });
            c.setCssProps({ '--fg-color': this.facetColor(f.id) });
          }
        }
      }
    } else {
      const f = this.facets.find(x => x.id === g.facet);
      el.createDiv({ cls: 'tag-graph-tip-title', text: g.label });
      const where = g.type === 'subhub' ? ' · ' + (g.subFolder ? g.subFolder : '/') : '';
      el.createDiv({ cls: 'tag-graph-tip-sub', text: (f ? f.label : '') + where + ' · ' + t('ui.notes', { n: g.count }) });
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

  private dropVerdict(a: GNode, b: GNode): DropVerdict | null {
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
      return { text: t('drop.link', { prop }), ok: true };
    }
    if (a.type !== 'note' && b.type !== 'note') {
      if (a.facet !== b.facet) return { text: t('drop.cannot'), ok: false };
      if (a.valueKey === b.valueKey) return null;
      const f = this.spec(a.facet);
      const to = this.valueOfHub(b);
      if (!f || !to) return null;
      if (f.kind === 'readonly') return { text: t('ui.readonly', { facet: f.label }), ok: false };
      if (f.kind === 'folder') return null;
      return { text: t('drop.merge', { value: to.label }), ok: true };
    }
    return null;
  }

  private linkProperty(): string {
    const v = this.config.get('linkProperty');
    if (v === undefined) return 'related';
    return String(v ?? '').trim();
  }

  private async drop(a: GNode, b: GNode): Promise<void> {
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
      if (prop) await actions.link(file, target, prop);
      return;
    }
    if (a.type !== 'note' && b.type !== 'note') {
      const f = this.spec(a.facet);
      const from = this.valueOfHub(a), to = this.valueOfHub(b);
      if (!f || !from || !to) return;
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
      menu.showAtPosition({ x, y });
      return;
    }
    if (g.type === 'note') {
      const file = this.fileOf(g);
      if (!file) return;
      menu.addItem(i => i.setSection('open').setTitle(t('menu.open')).setIcon('file').onClick(() => this.openNode(g, false)));
      menu.addItem(i => i.setSection('open').setTitle(t('menu.openTab')).setIcon('file-plus').onClick(() => this.openNode(g, true)));
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
      .onClick(() => { this.renderer.setFocus(focused ? null : g.id); this.renderLegend(); }));
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
