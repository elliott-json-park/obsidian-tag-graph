/*
 * The tag sidebar: a view of its own, outside Bases, that sits beside the notes.
 *
 *   Top    — the note open now, the tags it has, and the notes that share them
 *            (plus the notes it links with). It follows the active note, so the
 *            graph is something seen while writing, not only while tidying.
 *   Bottom — a short list of tags worth a look this week, across the whole
 *            vault (tidy.ts), each with the one action it suggests and a way to
 *            say "keep it as it is".
 *
 * Every edit goes through Actions, the same as the graph: undoable from the notice.
 */
import { ItemView, Keymap, TFile, WorkspaceLeaf, debounce, getAllTags, setIcon } from 'obsidian';
import type TagGraphPlugin from './main';
import { FacetSpec, FacetValue, GNode, LINK_KINDS, NoteInput, buildGraph, paletteColor, tagLabel } from './model';
import { Renderer, DropVerdict } from './renderer';
import { Resolver } from './values';
import { InsightNote, similarNotes } from './insights';
import { TagUse, TidyItem, tidyList } from './tidy';
import { confirm } from './view';
import { ago, t } from './i18n';

export const COMPANION_TYPE = 'tag-graph-companion';

/** Notes drawn around the active note: the most alike by shared tags, then the ones it links with. */
const NEAR_LIMIT = 24, LINK_LIMIT = 10;
const TAG_HUB = '#8b6cf0';

export class TagCompanionView extends ItemView {
  private resolver: Resolver;
  private renderer: Renderer | null = null;
  private headEl!: HTMLElement;
  private graphEl!: HTMLElement;
  private graphMsg!: HTMLElement;
  private tidyEl!: HTMLElement;
  private tagSpec: FacetSpec;
  /** Every markdown note's tags, as the details panel reads them. Rebuilt when the cache changes. */
  private rows: InsightNote[] = [];
  private byPath = new Map<string, InsightNote>();
  private center: string | null = null;
  private colorIndex = new Map<string, number>();
  /** Tidy items whose notes are listed open. */
  private openItems = new Set<string>();
  private readonly later = debounce(() => this.refresh(false), 500, true);

  constructor(leaf: WorkspaceLeaf, private plugin: TagGraphPlugin) {
    super(leaf);
    this.resolver = new Resolver(plugin.app);
    this.tagSpec = { id: 'file.tags', label: t('facet.tags'), kind: 'tags', list: true };
    this.navigation = false;
  }

  getViewType(): string { return COMPANION_TYPE; }
  getDisplayText(): string { return t('comp.name'); }
  getIcon(): string { return 'tags'; }

  async onOpen(): Promise<void> {
    const root = this.contentEl;
    root.empty();
    root.addClass('tag-graph-companion');

    const top = root.createDiv({ cls: 'tag-graph-comp-top' });
    this.headEl = top.createDiv({ cls: 'tag-graph-comp-head' });
    const open = top.createEl('button', { cls: 'clickable-icon tag-graph-comp-open', attr: { 'aria-label': t('comp.openFull') } });
    setIcon(open, 'waypoints');
    open.addEventListener('click', () => { void this.plugin.openVaultGraph(); });

    this.graphEl = root.createDiv({ cls: 'tag-graph-comp-graph' });
    this.graphMsg = this.graphEl.createDiv({ cls: 'tag-graph-comp-msg' });
    this.renderer = new Renderer(this.graphEl, {
      facetColor: () => TAG_HUB,
      noteColor: key => key === 'center' ? this.renderer?.theme.accent || TAG_HUB : paletteColor(this.colorIndex.get(key) ?? 0),
      open: (g, newTab) => this.openNode(g, newTab),
      context: () => undefined,
      dropVerdict: (a, b) => this.dropVerdict(a, b),
      drop: (a, b) => { void this.drop(a, b); },
      hover: () => undefined,
      focusChanged: () => undefined,
    });
    this.readTheme();

    this.tidyEl = root.createDiv({ cls: 'tag-graph-comp-tidy' });

    this.registerEvent(this.app.workspace.on('file-open', () => this.follow()));
    this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.follow()));
    this.registerEvent(this.app.metadataCache.on('changed', () => this.later()));
    this.registerEvent(this.app.metadataCache.on('resolved', () => this.later()));
    this.registerEvent(this.app.vault.on('delete', () => this.later()));
    this.registerEvent(this.app.vault.on('rename', () => this.later()));
    this.registerEvent(this.app.workspace.on('css-change', () => { this.readTheme(); this.renderer?.refresh(); }));
    this.app.workspace.onLayoutReady(() => this.refresh(true));
  }

  async onClose(): Promise<void> {
    this.renderer?.destroy();
    this.renderer = null;
  }

  /** Settings changed (language, motion): draw again. */
  redraw(): void {
    this.tagSpec.label = t('facet.tags');
    this.refresh(true);
  }

  /* ================================================================ data */

  private readAll(): void {
    this.rows = [];
    this.byPath.clear();
    for (const file of this.app.vault.getMarkdownFiles()) {
      const cache = this.app.metadataCache.getFileCache(file);
      const tags = cache ? getAllTags(cache) || [] : [];
      const seen = new Set<string>();
      const values: FacetValue[] = [];
      for (const raw of tags) {
        const v = this.resolver.valueOf('tags', raw, file.path);
        if (seen.has(v.key)) continue;
        seen.add(v.key);
        values.push(v);
      }
      const folder = file.parent && !file.parent.isRoot() ? file.parent.path : '';
      const row: InsightNote = { path: file.path, name: file.basename, folder, values: { 'file.tags': values }, mtime: file.stat.mtime };
      this.rows.push(row);
      this.byPath.set(file.path, row);
    }
  }

  /** The active note changed: redraw the graph around it if it is a different note. */
  private follow(): void {
    const file = this.app.workspace.getActiveFile();
    const path = file && file.extension === 'md' ? file.path : null;
    if (!path || path === this.center) return;
    this.center = path;
    this.drawGraph(true);
  }

  private refresh(fit: boolean): void {
    if (!this.renderer) return;
    this.readAll();
    const file = this.app.workspace.getActiveFile();
    if (file && file.extension === 'md') this.center = file.path;
    if (this.center && !this.byPath.has(this.center)) this.center = null;
    this.drawGraph(fit);
    this.drawTidy();
  }

  /* ================================================================ graph */

  private drawGraph(fit: boolean): void {
    const r = this.renderer;
    if (!r) return;
    this.headEl.empty();
    const me = this.center ? this.byPath.get(this.center) : undefined;
    if (!me) {
      this.headEl.createDiv({ cls: 'tag-graph-comp-title', text: t('comp.name') });
      this.message(t('comp.noNote'));
      r.setGraph(buildGraph([], this.opts()), { animate: false });
      return;
    }
    const mine = me.values['file.tags'] || [];
    const keys = new Set(mine.map(v => v.key));

    // Who is drawn: the note, the notes most like it by shared tags, and the notes it links with.
    const chosen = new Set<string>([me.path]);
    for (const a of similarNotes(this.rows, me.path, NEAR_LIMIT)) chosen.add(a.note.path);
    let linked = 0;
    const resolved = this.app.metadataCache.resolvedLinks;
    const out = Object.keys(resolved[me.path] || {});
    const back: string[] = [];
    for (const from in resolved) if (resolved[from][me.path]) back.push(from);
    for (const p of [...out, ...back]) {
      if (linked >= LINK_LIMIT) break;
      if (!chosen.has(p) && this.byPath.has(p)) { chosen.add(p); linked++; }
    }

    // Around it, only the note's own tags are hubs: the others would pull in the whole vault.
    this.colorIndex.clear();
    const inputs: NoteInput[] = [];
    for (const p of chosen) {
      const row = this.byPath.get(p)!;
      const top = row.folder ? row.folder.split('/')[0] : '/';
      if (p !== me.path && !this.colorIndex.has(top)) this.colorIndex.set(top, this.colorIndex.size + 1);
      const file = this.app.vault.getAbstractFileByPath(p);
      inputs.push({
        path: p, name: row.name, folder: row.folder,
        facets: { 'file.tags': (row.values['file.tags'] || []).filter(v => keys.has(v.key)) },
        colors: [p === me.path ? 'center' : top],
        links: file instanceof TFile ? this.resolver.links(file, new Set()) : [],
      });
    }

    const title = this.headEl.createDiv({ cls: 'tag-graph-comp-title' });
    title.createSpan({ cls: 'tag-graph-comp-kind', text: t('comp.here') });
    title.createSpan({ cls: 'tag-graph-comp-note', text: me.name });
    this.headEl.createDiv({
      cls: 'tag-graph-comp-sub',
      text: mine.length ? t('comp.summary', { tags: mine.length, notes: chosen.size - 1 }) : t('comp.noTags'),
    });
    this.message(chosen.size > 1 || mine.length ? '' : t('comp.alone'));

    r.setGraph(buildGraph(inputs, this.opts()), { animate: this.plugin.settings.animate });
    if (fit) r.fit();
  }

  private opts() {
    return {
      facets: [this.tagSpec], minCount: 1, splitByFolder: false,
      linkKinds: new Set(LINK_KINDS), hidden: new Set<string>(), showIsolated: true,
    };
  }

  private message(text: string): void {
    this.graphMsg.setText(text);
    this.graphEl.toggleClass('has-msg', !!text);
  }

  private readTheme(): void {
    if (!this.renderer) return;
    const cs = getComputedStyle(this.contentEl);
    const v = (name: string, def: string) => cs.getPropertyValue(name).trim() || def;
    this.renderer.theme = {
      bg: v('--background-secondary', '#f6f6f6'),
      text: v('--text-normal', '#222222'),
      muted: v('--text-muted', '#777777'),
      faint: v('--text-faint', '#aaaaaa'),
      accent: v('--interactive-accent', '#7c5cff'),
      accentText: v('--text-on-accent', '#ffffff'),
      font: v('--font-interface', 'sans-serif'),
    };
  }

  private fileAt(path: string | undefined): TFile | null {
    if (!path) return null;
    const f = this.app.vault.getAbstractFileByPath(path);
    return f instanceof TFile ? f : null;
  }

  private openNode(g: GNode, newTab: boolean): void {
    const file = this.fileAt(g.path);
    if (file) void this.app.workspace.getLeaf(newTab ? 'tab' : false).openFile(file);
  }

  /** A note dropped on one of the tags takes that tag. Nothing else is a drop here. */
  private dropVerdict(a: GNode, b: GNode): DropVerdict | null {
    if (a.type !== 'note' || b.type !== 'hub' || b.valueKey === undefined) return null;
    const row = a.path ? this.byPath.get(a.path) : undefined;
    const label = tagLabel(b.label);
    if (row && (row.values['file.tags'] || []).some(v => v.key === b.valueKey)) return { text: t('drop.already', { value: label }), ok: false };
    return { text: t('drop.add', { value: label }), ok: true };
  }

  private async drop(a: GNode, b: GNode): Promise<void> {
    const file = this.fileAt(a.path);
    if (!file || b.valueKey === undefined || !this.dropVerdict(a, b)?.ok) return;
    await this.plugin.actions.add(file, this.tagSpec, { key: b.valueKey, label: b.label });
  }

  /* ================================================================ tidy */

  private uses(): TagUse[] {
    const by = new Map<string, TagUse>();
    for (const row of this.rows) {
      for (const v of row.values['file.tags'] || []) {
        let u = by.get(v.key);
        if (!u) { u = { key: v.key, label: v.label, notes: [], latest: 0 }; by.set(v.key, u); }
        u.notes.push(row.path);
        if (row.mtime > u.latest) u.latest = row.mtime;
      }
    }
    return [...by.values()];
  }

  private drawTidy(): void {
    const el = this.tidyEl;
    el.empty();
    const kept = new Set(this.plugin.settings.tidyKept);
    const { items, total } = tidyList(this.uses(), { now: Date.now(), kept, limit: 5 });
    const head = el.createDiv({ cls: 'tag-graph-comp-tidy-head' });
    head.createSpan({ text: t('comp.tidy') });
    if (total) head.createSpan({ cls: 'tag-graph-comp-count', text: String(total) });
    if (!items.length) {
      const ok = el.createDiv({ cls: 'tag-graph-comp-ok' });
      setIcon(ok.createSpan({ cls: 'tag-graph-comp-ok-icon' }), 'sparkles');
      ok.createSpan({ text: t('comp.tidyNone') });
      return;
    }
    const list = el.createDiv({ cls: 'tag-graph-comp-items' });
    items.forEach((item, i) => this.tidyCard(list, item, i));
    if (total > items.length) el.createDiv({ cls: 'tag-graph-comp-more', text: t('comp.tidyMore', { n: total - items.length }) });
  }

  private tidyCard(parent: HTMLElement, item: TidyItem, index: number): void {
    const card = parent.createDiv({ cls: 'tag-graph-comp-item is-' + item.kind });
    card.setCssProps({ '--tg-delay': index * 40 + 'ms' });
    const kind = card.createDiv({ cls: 'tag-graph-comp-item-kind' });
    setIcon(kind.createSpan({ cls: 'tag-graph-comp-item-icon' }), item.kind === 'dup' ? 'copy' : item.kind === 'stale' ? 'hourglass' : 'circle-dot');
    kind.createSpan({
      text: item.kind === 'dup' ? t('comp.dup') : item.kind === 'stale' ? t('comp.stale', { days: item.days }) : t('comp.single'),
    });

    const chips = card.createDiv({ cls: 'tag-graph-comp-chips' });
    const chip = (u: TagUse) => {
      const c = chips.createSpan({ cls: 'tag-graph-chip tag-graph-comp-chip' });
      c.setCssProps({ '--fg-color': TAG_HUB });
      c.createSpan({ text: u.label });
      c.createSpan({ cls: 'tag-graph-comp-chip-count', text: String(u.notes.length) });
    };
    const tags = item.kind === 'dup' ? [item.from, item.into] : [item.tag];
    chip(tags[0]);
    if (item.kind === 'dup') {
      setIcon(chips.createSpan({ cls: 'tag-graph-comp-arrow' }), 'arrow-right');
      chip(item.into);
    }

    // Which notes: folded by default, a click on the card's text opens the list.
    const noteSet = new Set<string>();
    for (const u of tags) for (const p of u.notes) noteSet.add(p);
    const notes = [...noteSet];
    const open = this.openItems.has(item.id);
    const toggle = card.createDiv({ cls: 'tag-graph-comp-toggle', text: t(open ? 'comp.hideNotes' : 'comp.showNotes', { n: notes.length }) });
    toggle.addEventListener('click', () => {
      if (this.openItems.has(item.id)) this.openItems.delete(item.id); else this.openItems.add(item.id);
      this.drawTidy();
    });
    if (open) {
      const list = card.createDiv({ cls: 'tag-graph-comp-notes' });
      for (const p of notes.slice(0, 12)) {
        const row = this.byPath.get(p);
        if (!row) continue;
        const r = list.createDiv({ cls: 'tag-graph-comp-note-row' });
        r.createSpan({ text: row.name });
        if (row.mtime) r.createSpan({ cls: 'tag-graph-comp-note-sub', text: ago(row.mtime) });
        r.addEventListener('click', ev => {
          const file = this.fileAt(p);
          if (file) void this.app.workspace.getLeaf(Keymap.isModEvent(ev) ? 'tab' : false).openFile(file);
        });
      }
      if (notes.length > 12) list.createDiv({ cls: 'tag-graph-comp-note-sub', text: t('ui.more', { n: notes.length - 12 }) });
    }

    const actions = card.createDiv({ cls: 'tag-graph-comp-actions' });
    const main = actions.createEl('button', {
      cls: 'mod-cta',
      text: item.kind === 'dup' ? t('comp.merge', { into: item.into.label }) : t('comp.removeTag'),
    });
    main.addEventListener('click', () => { void this.apply(item); });
    const keep = actions.createEl('button', { text: t('comp.keep') });
    keep.addEventListener('click', () => { void this.keep(item); });
  }

  private files(paths: string[]): TFile[] {
    const out: TFile[] = [];
    for (const p of paths) { const f = this.fileAt(p); if (f) out.push(f); }
    return out;
  }

  private async apply(item: TidyItem): Promise<void> {
    const s = this.plugin.settings;
    if (item.kind === 'dup') {
      const files = this.files(item.from.notes);
      if (!files.length) return;
      if (s.confirmBulk && files.length > 1) {
        const ok = await confirm(this.plugin, t('modal.merge.title', { from: item.from.label, to: item.into.label }),
          t('modal.mergeVault.desc', { n: files.length, from: item.from.label, to: item.into.label }));
        if (!ok) return;
      }
      await this.plugin.actions.replace(files, this.tagSpec, item.from.key, item.from.label, { key: item.into.key, label: item.into.label }, true);
    } else {
      const files = this.files(item.tag.notes);
      if (!files.length) return;
      if (s.confirmBulk || files.length > 1) {
        const ok = await confirm(this.plugin, t('modal.removeAll.title', { value: item.tag.label, n: files.length }),
          t('modal.removeVault.desc', { value: item.tag.label }));
        if (!ok) return;
      }
      await this.plugin.actions.removeAll(files, this.tagSpec, item.tag.key, item.tag.label);
    }
    // The cache catches up on its own; a quicker redraw keeps the list honest meanwhile.
    this.later();
  }

  private async keep(item: TidyItem): Promise<void> {
    const s = this.plugin.settings;
    if (!s.tidyKept.includes(item.id)) s.tidyKept.push(item.id);
    await this.plugin.saveSettings();
    this.drawTidy();
  }
}
