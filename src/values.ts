/*
 * Reads a facet's values off a file. The same functions decide both what hub a
 * note joins and which raw frontmatter entry an edit should touch, so a value
 * the graph shows as one hub is always edited as one value.
 */
import { App, BasesEntry, BasesPropertyId, TFile, getAllTags, getLinkpath, parsePropertyId } from 'obsidian';
import { t } from './i18n';
import { FacetKind, FacetSpec, FacetValue, NoteLink, bodyLinkKind, rawValues, tagKey, tagLabel, wikilinkPath } from './model';

export function facetKindOf(id: BasesPropertyId): FacetKind {
  if (id === 'file.tags') return 'tags';
  if (id === 'file.folder') return 'folder';
  if (id.startsWith('note.')) return 'text';
  return 'readonly';
}

/** The frontmatter key of a `note.*` property, matching case-insensitively as Obsidian does. */
export function frontmatterKey(fm: Record<string, unknown> | undefined, name: string): string {
  if (!fm) return name;
  if (name in fm) return name;
  const lower = name.toLowerCase();
  for (const k of Object.keys(fm)) if (k.toLowerCase() === lower) return k;
  return name;
}

export class Resolver {
  constructor(private app: App) {}

  /** The key a raw frontmatter/property string maps to under a facet. */
  keyOf(kind: FacetKind, raw: string, sourcePath: string): string {
    if (kind === 'tags') return tagKey(raw);
    const lp = wikilinkPath(raw);
    if (lp !== null) {
      const dest = this.app.metadataCache.getFirstLinkpathDest(getLinkpath(lp), sourcePath);
      return dest ? 'link:' + dest.path : 'link:' + lp.toLowerCase();
    }
    return raw.trim();
  }

  valueOf(kind: FacetKind, raw: string, sourcePath: string): FacetValue {
    if (kind === 'tags') return { key: tagKey(raw), label: tagLabel(raw) };
    const lp = wikilinkPath(raw);
    if (lp !== null) {
      const dest = this.app.metadataCache.getFirstLinkpathDest(getLinkpath(lp), sourcePath);
      if (dest) return { key: 'link:' + dest.path, label: dest.basename, notePath: dest.path };
      return { key: 'link:' + lp.toLowerCase(), label: lp };
    }
    const s = raw.trim();
    return { key: s, label: s };
  }

  /** Read a facet's values for one entry. Also reports whether the stored value was a list. */
  read(entry: BasesEntry, spec: { id: string; kind: FacetKind }): { values: FacetValue[]; list: boolean; links: boolean } {
    const file = entry.file;
    if (spec.kind === 'tags') {
      const cache = this.app.metadataCache.getFileCache(file);
      const tags = cache ? getAllTags(cache) || [] : [];
      return { values: tags.map(t => this.valueOf('tags', t, file.path)), list: true, links: false };
    }
    if (spec.kind === 'folder') {
      const folder = file.parent ? file.parent.path : '/';
      return { values: [{ key: folder, label: folder === '/' ? t('ui.root') : folder }], list: false, links: false };
    }
    if (spec.kind === 'text' || spec.kind === 'link') {
      const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
      const name = parsePropertyId(spec.id as BasesPropertyId).name;
      const v = fm ? fm[frontmatterKey(fm, name)] : undefined;
      const raws = rawValues(v);
      return {
        values: raws.map(r => this.valueOf('text', r, file.path)),
        list: Array.isArray(v),
        links: raws.some(r => wikilinkPath(r) !== null),
      };
    }
    // Formulas and other file properties: whatever Bases evaluated.
    return { values: basesValueStrings(entry, spec.id as BasesPropertyId).map(s => ({ key: s, label: s })), list: false, links: false };
  }

  /** Every link out of a file, with its kind. Targets are resolved paths. */
  links(file: TFile, skipPropertyKeys: ReadonlySet<string>): NoteLink[] {
    const cache = this.app.metadataCache.getFileCache(file);
    if (!cache) return [];
    const out: NoteLink[] = [];
    const resolve = (link: string) => this.app.metadataCache.getFirstLinkpathDest(getLinkpath(link), file.path);
    for (const l of cache.links || []) {
      const d = resolve(l.link);
      if (d) out.push({ target: d.path, kind: bodyLinkKind(l.link) });
    }
    for (const l of cache.embeds || []) {
      const d = resolve(l.link);
      if (d) out.push({ target: d.path, kind: 'embed' });
    }
    for (const l of cache.frontmatterLinks || []) {
      // A property already drawn as a facet would draw the same relationship twice.
      const key = l.key.split('.')[0].toLowerCase();
      if (skipPropertyKeys.has(key)) continue;
      const d = resolve(l.link);
      if (d) out.push({ target: d.path, kind: 'property' });
    }
    return out;
  }
}

/** A Bases value as strings: one per list item, nothing for null or empty. */
export function basesValueStrings(entry: BasesEntry, id: BasesPropertyId): string[] {
  let v: unknown;
  try { v = entry.getValue(id); } catch { return []; }
  return flattenValue(v);
}

interface ListLike { length(): number; get(i: number): unknown }

function flattenValue(v: unknown): string[] {
  if (v === null || v === undefined) return [];
  const list = v as Partial<ListLike>;
  if (typeof list.length === 'function' && typeof list.get === 'function') {
    const out: string[] = [];
    const n = list.length();
    for (let i = 0; i < n; i++) out.push(...flattenValue(list.get(i)));
    return out;
  }
  const s = String(v).trim();
  // NullValue renders as an empty string.
  if (!s || s === 'null') return [];
  return [s];
}

export function facetSpec(id: BasesPropertyId, label: string): FacetSpec {
  return { id, label, kind: facetKindOf(id), list: facetKindOf(id) === 'tags' };
}
