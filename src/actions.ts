/*
 * Every change the graph makes to the vault goes through here. Each operation
 * records what the touched files looked like before and after, so the last
 * one can be undone — but only if nobody has changed those files since.
 */
import { App, Notice, TFile, TFolder, normalizePath, parsePropertyId } from 'obsidian';
import { FacetSpec, FacetValue, tagKey, tagLabel } from './model';
import { fmAdd, fmAddTag, fmRemove, fmRemoveTag, fmReplace, fmReplaceTag, rewriteInlineTags, Matcher } from './frontmatter';
import { Resolver, frontmatterKey } from './values';
import { t } from './i18n';

/** The frontmatter object processFrontMatter hands over. */
type FM = Record<string, unknown>;

interface FileSnap { path: string; before: string; after: string }
interface MoveSnap { from: string; to: string }
interface Op { files: FileSnap[]; moves: MoveSnap[] }

export interface ActionSettings {
  inlineTags: boolean;
}

export class Actions {
  private last: Op | null = null;
  private resolver: Resolver;

  constructor(private app: App, private settings: () => ActionSettings) {
    this.resolver = new Resolver(app);
  }

  /* ------------------------------------------------------------ helpers */

  private matcher(facet: FacetSpec, valueKey: string, sourcePath: string): Matcher {
    const kind = facet.kind === 'tags' ? 'tags' : 'text';
    return raw => this.resolver.keyOf(kind, raw, sourcePath) === valueKey;
  }

  /** The string to store for a value: a tag without '#', a link as `[[…]]`, text as is. */
  private written(facet: FacetSpec, value: FacetValue, sourcePath: string): string {
    if (facet.kind === 'tags') return value.label.replace(/^#/, '');
    if (value.notePath) {
      const f = this.app.vault.getAbstractFileByPath(value.notePath);
      if (f instanceof TFile) return '[[' + this.app.metadataCache.fileToLinktext(f, sourcePath, true) + ']]';
    }
    if (value.key.startsWith('link:')) return '[[' + value.label + ']]';
    return value.label;
  }

  /** Run `edit` on each file, keeping before/after text. Returns the files that changed. */
  private async edit(files: TFile[], edit: (file: TFile) => Promise<boolean>): Promise<FileSnap[]> {
    const snaps: FileSnap[] = [];
    for (const file of files) {
      try {
        const before = await this.app.vault.read(file);
        const changed = await edit(file);
        if (!changed) continue;
        const after = await this.app.vault.read(file);
        if (after !== before) snaps.push({ path: file.path, before, after });
      } catch (e) {
        new Notice(t('notice.failed', { note: file.basename, error: e instanceof Error ? e.message : String(e) }));
      }
    }
    return snaps;
  }

  private remember(op: Op, message: string): void {
    if (op.files.length === 0 && op.moves.length === 0) return;
    this.last = op;
    const frag = createFragment(f => {
      f.createSpan({ text: message + ' ' });
      const a = f.createEl('a', { text: t('notice.undo'), href: '#', cls: 'tag-graph-undo-link' });
      a.addEventListener('click', ev => { ev.preventDefault(); void this.undo(); });
    });
    new Notice(frag, 6000);
  }

  /** Inline #tags in the body that match, at the offsets the cache knows. */
  private async editBodyTags(file: TFile, same: Matcher, to: string | null): Promise<boolean> {
    if (!this.settings().inlineTags) return false;
    const cache = this.app.metadataCache.getFileCache(file);
    const spans = (cache?.tags || [])
      .filter(tg => same(tg.tag))
      .map(tg => ({ start: tg.position.start.offset, end: tg.position.end.offset }));
    if (spans.length === 0) return false;
    let changed = false;
    await this.app.vault.process(file, text => {
      const next = rewriteInlineTags(text, spans, same, to);
      if (next === null || next === text) return text;
      changed = true;
      return next;
    });
    return changed;
  }

  /* ------------------------------------------------------------ operations */

  /** Give one note a value. For a folder facet this moves the file. */
  async add(file: TFile, facet: FacetSpec, value: FacetValue): Promise<void> {
    if (facet.kind === 'folder') { await this.move(file, value.key); return; }
    const same = this.matcher(facet, value.key, file.path);
    const written = this.written(facet, value, file.path);
    let replaced = false;
    const snaps = await this.edit([file], async f => {
      let changed = false;
      await this.app.fileManager.processFrontMatter(f, (fm: FM) => {
        if (facet.kind === 'tags') { changed = fmAddTag(fm, written, same); return; }
        const key = frontmatterKey(fm, parsePropertyId(facet.id as `note.${string}`).name);
        const cur: unknown = fm[key];
        replaced = !facet.list && !Array.isArray(cur) && cur !== undefined && cur !== null && cur !== '';
        changed = fmAdd(fm, key, written, facet.list, same);
      });
      return changed;
    });
    const label = facet.kind === 'tags' ? tagLabel(written) : value.label;
    this.remember({ files: snaps, moves: [] }, replaced
      ? t('notice.set', { facet: facet.label, note: file.basename, value: label })
      : t('notice.added', { value: label, note: file.basename }));
  }

  /** Take a value off one note. */
  async remove(file: TFile, facet: FacetSpec, valueKey: string, label: string): Promise<void> {
    const same = this.matcher(facet, valueKey, file.path);
    const snaps = await this.edit([file], async f => {
      const body = facet.kind === 'tags' ? await this.editBodyTags(f, same, null) : false;
      let changed = false;
      await this.app.fileManager.processFrontMatter(f, (fm: FM) => {
        if (facet.kind === 'tags') { changed = fmRemoveTag(fm, same); return; }
        const key = frontmatterKey(fm, parsePropertyId(facet.id as `note.${string}`).name);
        changed = fmRemove(fm, key, same);
      });
      return changed || body;
    });
    this.remember({ files: snaps, moves: [] }, t('notice.removed', { value: label, note: file.basename }));
  }

  /**
   * Replace a value with another on every given note. Used for both rename
   * (`to` is new text) and merge (`to` is the other hub's value).
   */
  async replace(files: TFile[], facet: FacetSpec, fromKey: string, fromLabel: string, to: FacetValue, merge: boolean): Promise<void> {
    const snaps = await this.edit(files, async f => {
      const same = this.matcher(facet, fromKey, f.path);
      const written = this.written(facet, to, f.path);
      const sameAsNew = this.matcher(facet, facet.kind === 'tags' ? tagKey(written) : to.key, f.path);
      const body = facet.kind === 'tags' ? await this.editBodyTags(f, same, written) : false;
      let changed = false;
      await this.app.fileManager.processFrontMatter(f, (fm: FM) => {
        if (facet.kind === 'tags') { changed = fmReplaceTag(fm, same, written, sameAsNew); return; }
        const key = frontmatterKey(fm, parsePropertyId(facet.id as `note.${string}`).name);
        changed = fmReplace(fm, key, same, written, sameAsNew);
      });
      return changed || body;
    });
    const toLabel = facet.kind === 'tags' ? tagLabel(to.label) : to.label;
    this.remember({ files: snaps, moves: [] }, t(merge ? 'notice.merged' : 'notice.renamed', { from: fromLabel, to: toLabel, n: snaps.length }));
  }

  /** Move a file into a folder (a drop on a folder hub). */
  async move(file: TFile, folderPath: string): Promise<void> {
    const folder = folderPath === '/' ? this.app.vault.getRoot() : this.app.vault.getAbstractFileByPath(folderPath);
    if (!(folder instanceof TFolder)) return;
    const dest = normalizePath((folder.isRoot() ? '' : folder.path + '/') + file.name);
    if (dest === file.path) return;
    if (this.app.vault.getAbstractFileByPath(dest)) {
      new Notice(t('notice.exists', { folder: folder.isRoot() ? '/' : folder.path }));
      return;
    }
    const from = file.path;
    try {
      await this.app.fileManager.renameFile(file, dest);
    } catch (e) {
      new Notice(t('notice.failed', { note: file.basename, error: e instanceof Error ? e.message : String(e) }));
      return;
    }
    this.remember({ files: [], moves: [{ from, to: dest }] },
      t('notice.moved', { note: file.basename, folder: folder.isRoot() ? '/' : folder.path }));
  }

  /** Add a link to `target` in the given property of `file` (a note dropped on a note). */
  async link(file: TFile, target: TFile, property: string): Promise<void> {
    const written = '[[' + this.app.metadataCache.fileToLinktext(target, file.path, true) + ']]';
    const same: Matcher = raw => this.resolver.keyOf('text', raw, file.path) === 'link:' + target.path;
    const snaps = await this.edit([file], async f => {
      let changed = false;
      await this.app.fileManager.processFrontMatter(f, (fm: FM) => {
        changed = fmAdd(fm, frontmatterKey(fm, property), written, true, same);
      });
      return changed;
    });
    this.remember({ files: snaps, moves: [] }, t('notice.linked', { to: target.basename, note: file.basename }));
  }

  async undo(): Promise<void> {
    const op = this.last;
    if (!op) { new Notice(t('notice.nothingToUndo')); return; }
    this.last = null;
    // Check everything first: a half-undone operation is worse than none.
    let stale = 0;
    for (const s of op.files) {
      const f = this.app.vault.getAbstractFileByPath(s.path);
      if (!(f instanceof TFile) || (await this.app.vault.read(f)) !== s.after) stale++;
    }
    for (const m of op.moves) if (!(this.app.vault.getAbstractFileByPath(m.to) instanceof TFile)) stale++;
    if (stale > 0) { new Notice(t('notice.cannotUndo', { n: stale })); return; }
    for (const s of op.files) {
      const f = this.app.vault.getAbstractFileByPath(s.path);
      if (f instanceof TFile) await this.app.vault.modify(f, s.before);
    }
    for (const m of op.moves.slice().reverse()) {
      const f = this.app.vault.getAbstractFileByPath(m.to);
      if (f instanceof TFile && !this.app.vault.getAbstractFileByPath(m.from)) await this.app.fileManager.renameFile(f, m.from);
    }
    new Notice(t('notice.undone'));
  }
}
