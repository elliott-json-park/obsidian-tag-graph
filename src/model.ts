/*
 * The graph model. Pure: no Obsidian imports, so scripts/test.mjs can run it in
 * Node. The view turns a base's entries into NoteInput[]; this file turns those
 * into the nodes and edges that get drawn.
 *
 * Two kinds of node:
 *   note — one per entry the base returned.
 *   hub  — one per value a facet takes (a tag, a folder, a status, a project…).
 *          A note is joined to every hub whose value it has, so notes that share
 *          values are pulled together even when they never link to each other.
 * plus, with "split by folder" on, a sub-hub per folder a value is used in.
 */

export type LinkKind = 'body' | 'heading' | 'block' | 'property' | 'embed';
export const LINK_KINDS: LinkKind[] = ['body', 'heading', 'block', 'property', 'embed'];

/** How a facet's values are read and, if at all, written back. */
export type FacetKind = 'tags' | 'folder' | 'link' | 'text' | 'readonly';

export interface FacetSpec {
  /** Bases property id, e.g. `file.tags`, `note.status`, `formula.stage`. */
  id: string;
  label: string;
  kind: FacetKind;
  /** True when at least one note stores this property as a list. */
  list: boolean;
}

export interface FacetValue {
  /** Identity of the value. Two notes share a hub when their keys match. */
  key: string;
  /** What the hub is labelled with. */
  label: string;
  /** Set when the value is a link that resolves to a note. */
  notePath?: string;
}

export interface NoteLink {
  target: string;
  kind: LinkKind;
}

export interface NoteInput {
  path: string;
  name: string;
  /** Parent folder path, '' for the vault root. */
  folder: string;
  /** facet id -> the note's values for it. */
  facets: Record<string, FacetValue[]>;
  /** Colour keys for the note (from "colour by" or the base's grouping). */
  colors: string[];
  links: NoteLink[];
}

export interface BuildOptions {
  facets: FacetSpec[];
  /** A hub is drawn only if at least this many notes have its value. */
  minCount: number;
  splitByFolder: boolean;
  linkKinds: ReadonlySet<LinkKind>;
  /** Hidden hub keys (`facetId\u0000valueKey`) and hidden facet ids. */
  hidden: ReadonlySet<string>;
  /** Draw notes that end up with no hub and no link. */
  showIsolated: boolean;
}

export type NodeType = 'note' | 'hub' | 'subhub';

export interface GNode {
  id: string;
  type: NodeType;
  label: string;
  /** note: file path. */
  path?: string;
  folder?: string;
  /** hub/subhub: the facet and value it stands for. */
  facet?: string;
  valueKey?: string;
  /** subhub: the folder it stands for, and its parent hub. */
  subFolder?: string;
  parent?: string;
  /** hub/subhub: notes with the value. note: number of hubs + links. */
  count: number;
  /** note: colour keys. */
  colors: string[];
}

export type EdgeType = 'member' | 'link' | 'split';

export interface GEdge {
  source: string;
  target: string;
  type: EdgeType;
  facet?: string;
  kind?: LinkKind;
}

export interface LegendValue {
  hubKey: string;
  valueKey: string;
  label: string;
  count: number;
  hidden: boolean;
  /** Below the minimum, so not drawn regardless of `hidden`. */
  belowMin: boolean;
  /** A link value whose target is itself one of the notes. */
  isNote: boolean;
}

export interface LegendFacet {
  facet: FacetSpec;
  hidden: boolean;
  values: LegendValue[];
}

export interface ColorKey {
  key: string;
  count: number;
}

export interface GraphModel {
  nodes: GNode[];
  edges: GEdge[];
  legend: LegendFacet[];
  colorKeys: ColorKey[];
  /** Link edges per kind, before the kind filter — so the legend can say what a toggle would add. */
  linkCounts: Record<LinkKind, number>;
  noteCount: number;
}

export const hubKey = (facetId: string, valueKey: string): string => facetId + '\u0000' + valueKey;
export const hubId = (facetId: string, valueKey: string): string => 'hub:' + hubKey(facetId, valueKey);
export const subhubId = (facetId: string, valueKey: string, folder: string): string =>
  'sub:' + hubKey(facetId, valueKey) + '\u0000' + folder;
export const noteId = (path: string): string => 'note:' + path;

export function folderLabel(folder: string): string {
  if (!folder || folder === '/') return '/';
  const i = folder.lastIndexOf('/');
  return i < 0 ? folder : folder.slice(i + 1);
}

export function buildGraph(notes: NoteInput[], opts: BuildOptions): GraphModel {
  const paths = new Set(notes.map(n => n.path));
  const nodes: GNode[] = [];
  const edges: GEdge[] = [];
  const degree = new Map<string, number>();
  const bump = (id: string) => degree.set(id, (degree.get(id) || 0) + 1);

  /* ---- collect every value of every facet ---- */
  interface Bucket { label: string; notes: NoteInput[]; notePath?: string }
  const buckets = new Map<string, Map<string, Bucket>>();
  for (const f of opts.facets) buckets.set(f.id, new Map());
  for (const n of notes) {
    for (const f of opts.facets) {
      const seen = new Set<string>();
      for (const v of n.facets[f.id] || []) {
        if (seen.has(v.key)) continue;
        seen.add(v.key);
        const m = buckets.get(f.id)!;
        let b = m.get(v.key);
        if (!b) { b = { label: v.label, notes: [], notePath: v.notePath }; m.set(v.key, b); }
        b.notes.push(n);
      }
    }
  }

  /* ---- legend: every value, drawn or not ---- */
  const legend: LegendFacet[] = opts.facets.map(f => {
    const values: LegendValue[] = [];
    for (const [valueKey, b] of buckets.get(f.id)!) {
      const isNote = !!b.notePath && paths.has(b.notePath);
      const hk = hubKey(f.id, valueKey);
      values.push({
        hubKey: hk, valueKey, label: b.label, count: b.notes.length,
        hidden: opts.hidden.has(hk),
        // A value that is itself a note on the graph is always drawn: it is
        // a real note, not a hub that could be clutter.
        belowMin: !isNote && b.notes.length < opts.minCount,
        isNote,
      });
    }
    values.sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
    return { facet: f, hidden: opts.hidden.has(f.id), values };
  });

  /* ---- note nodes ---- */
  for (const n of notes) {
    nodes.push({ id: noteId(n.path), type: 'note', label: n.name, path: n.path, folder: n.folder, count: 0, colors: n.colors });
  }

  /* ---- hubs and membership ---- */
  for (const lf of legend) {
    if (lf.hidden) continue;
    const f = lf.facet;
    const m = buckets.get(f.id)!;
    for (const lv of lf.values) {
      if (lv.hidden || lv.belowMin) continue;
      const b = m.get(lv.valueKey)!;
      if (lv.isNote) {
        // The value is a note on the graph: join members straight to it.
        const target = noteId(b.notePath!);
        for (const n of b.notes) {
          if (n.path === b.notePath) continue;
          edges.push({ source: noteId(n.path), target, type: 'member', facet: f.id });
          bump(noteId(n.path)); bump(target);
        }
        continue;
      }
      const hid = hubId(f.id, lv.valueKey);
      nodes.push({ id: hid, type: 'hub', label: b.label, facet: f.id, valueKey: lv.valueKey, count: b.notes.length, colors: [] });
      const byFolder = new Map<string, NoteInput[]>();
      if (opts.splitByFolder && f.kind !== 'folder') {
        for (const n of b.notes) {
          const arr = byFolder.get(n.folder);
          if (arr) arr.push(n); else byFolder.set(n.folder, [n]);
        }
      }
      if (byFolder.size > 1) {
        for (const [folder, members] of byFolder) {
          const sid = subhubId(f.id, lv.valueKey, folder);
          nodes.push({
            id: sid, type: 'subhub', label: b.label, facet: f.id, valueKey: lv.valueKey,
            subFolder: folder, parent: hid, count: members.length, colors: [],
          });
          edges.push({ source: sid, target: hid, type: 'split', facet: f.id });
          for (const n of members) {
            edges.push({ source: noteId(n.path), target: sid, type: 'member', facet: f.id });
            bump(noteId(n.path));
          }
        }
      } else {
        for (const n of b.notes) {
          edges.push({ source: noteId(n.path), target: hid, type: 'member', facet: f.id });
          bump(noteId(n.path));
        }
      }
    }
  }

  /* ---- links between notes ---- */
  const linkCounts: Record<LinkKind, number> = { body: 0, heading: 0, block: 0, property: 0, embed: 0 };
  const linkSeen = new Set<string>();
  for (const n of notes) {
    for (const l of n.links) {
      if (l.target === n.path || !paths.has(l.target)) continue;
      // One edge per pair and kind; a note that links another five times is
      // still one relationship.
      const a = n.path < l.target ? n.path : l.target;
      const b = n.path < l.target ? l.target : n.path;
      const k = a + '\u0000' + b + '\u0000' + l.kind;
      if (linkSeen.has(k)) continue;
      linkSeen.add(k);
      linkCounts[l.kind]++;
      if (!opts.linkKinds.has(l.kind)) continue;
      edges.push({ source: noteId(n.path), target: noteId(l.target), type: 'link', kind: l.kind });
      bump(noteId(n.path)); bump(noteId(l.target));
    }
  }

  /* ---- degree, isolated notes ---- */
  let out = nodes;
  for (const nd of nodes) if (nd.type === 'note') nd.count = degree.get(nd.id) || 0;
  if (!opts.showIsolated) out = nodes.filter(nd => nd.type !== 'note' || nd.count > 0);

  /* ---- colour keys, most used first so the first palette slots go to them ---- */
  const cc = new Map<string, number>();
  for (const n of notes) for (const c of n.colors) cc.set(c, (cc.get(c) || 0) + 1);
  const colorKeys = [...cc].map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));

  return { nodes: out, edges, legend, colorKeys, linkCounts, noteCount: notes.length };
}

/* ------------------------------------------------------------------ values */

/** `#Project/Alpha` and `project/alpha` are the same tag. */
export function tagKey(tag: string): string {
  return tag.replace(/^#/, '').trim().toLowerCase();
}

export function tagLabel(tag: string): string {
  return '#' + tag.replace(/^#/, '').trim();
}

/** Strip `[[` `]]`, an alias and a subpath: `[[A/B#h|x]]` -> `A/B`. */
export function wikilinkPath(raw: string): string | null {
  const m = /^\s*!?\[\[([^\]]+)\]\]\s*$/.exec(raw);
  if (!m) return null;
  return m[1].split('|')[0].split('#')[0].trim();
}

/** Link kind from the raw link text of a body link. */
export function bodyLinkKind(link: string): LinkKind {
  const hash = link.indexOf('#');
  if (hash < 0) return 'body';
  return link.charAt(hash + 1) === '^' ? 'block' : 'heading';
}

/** Flatten one frontmatter value into strings: lists, scalars, nothing for null/objects. */
export function rawValues(v: unknown): string[] {
  if (v === null || v === undefined) return [];
  if (Array.isArray(v)) {
    const out: string[] = [];
    for (const x of v as unknown[]) out.push(...rawValues(x));
    return out;
  }
  if (typeof v === 'string') { const s = v.trim(); return s ? [s] : []; }
  if (typeof v === 'number' || typeof v === 'boolean') return [String(v)];
  return [];
}

/* ------------------------------------------------------------------ palette */

/** Twelve hues that stay apart on both light and dark themes. */
export const PALETTE = [
  '#e0675b', '#3f9ad6', '#e6a23c', '#4fae7b', '#9b6ad6', '#d65c9b',
  '#34a7a4', '#c98a4b', '#6a7fd6', '#8dae3f', '#d6735c', '#5c8fae',
];

export function paletteColor(i: number): string {
  return PALETTE[((i % PALETTE.length) + PALETTE.length) % PALETTE.length];
}
