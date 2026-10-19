/*
 * What the details panel tells the reader about a value, a note or the whole
 * base. Pure, like model.ts: the view hands in what it already read from the
 * notes, and scripts/test.mjs runs these in Node.
 */
import { FacetValue } from './model';

export interface InsightNote {
  path: string;
  name: string;
  /** Parent folder path, '' for the vault root. */
  folder: string;
  /** facet id -> the note's values for it. */
  values: Record<string, FacetValue[]>;
  /** Last modified, ms since the epoch; 0 when unknown. */
  mtime: number;
}

export interface Counted { key: string; count: number }

export interface FolderGroup { folder: string; notes: InsightNote[] }

/**
 * A value's notes under their folders: folders in name order with the vault
 * root last, notes in name order inside each. The graph already shows which
 * folder a note sits in; this is the same structure for the list beside it.
 */
export function groupByFolder(notes: InsightNote[]): FolderGroup[] {
  const by = new Map<string, InsightNote[]>();
  for (const n of notes) {
    const list = by.get(n.folder);
    if (list) list.push(n); else by.set(n.folder, [n]);
  }
  const cmp = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true });
  return [...by.keys()]
    .sort((a, b) => (a === '' ? 1 : 0) - (b === '' ? 1 : 0) || cmp(a, b))
    .map(folder => ({ folder, notes: by.get(folder)!.slice().sort((a, b) => cmp(a.name, b.name)) }));
}

export interface Together {
  facet: string;
  key: string;
  label: string;
  /** Notes that have both values. */
  count: number;
}

export interface ValueInsight {
  /** Notes with the value, in name order. */
  notes: InsightNote[];
  /** Folders those notes live in, most notes first. */
  folders: Counted[];
  /** Other values those notes also have, most shared first. */
  together: Together[];
  /** The member edited most recently, if any has a date. */
  latest: InsightNote | null;
  /** Members edited within the last `recentDays`. */
  recent: number;
}

const DAY = 86400000;

const byCount = (a: Counted, b: Counted) => b.count - a.count || a.key.localeCompare(b.key);

function has(n: InsightNote, facet: string, key: string): boolean {
  return (n.values[facet] || []).some(v => v.key === key);
}

/** Everything the panel shows for one value: where it is used and what it comes with. */
export function valueInsight(notes: InsightNote[], facet: string, key: string, now = 0, recentDays = 30): ValueInsight {
  const members = notes.filter(n => has(n, facet, key)).sort((a, b) => a.name.localeCompare(b.name));
  const folders = new Map<string, number>();
  const together = new Map<string, Together>();
  for (const n of members) {
    folders.set(n.folder, (folders.get(n.folder) || 0) + 1);
    for (const f of Object.keys(n.values)) {
      const seen = new Set<string>();
      for (const v of n.values[f]) {
        if ((f === facet && v.key === key) || seen.has(v.key)) continue;
        seen.add(v.key);
        const id = f + '\u0000' + v.key;
        const t = together.get(id);
        if (t) t.count++;
        else together.set(id, { facet: f, key: v.key, label: v.label, count: 1 });
      }
    }
  }
  let latest: InsightNote | null = null, recent = 0;
  for (const n of members) {
    if (n.mtime && (!latest || n.mtime > latest.mtime)) latest = n;
    if (n.mtime && now && now - n.mtime <= recentDays * DAY) recent++;
  }
  return {
    latest, recent,
    notes: members,
    folders: [...folders].map(([k, count]) => ({ key: k, count })).sort(byCount),
    together: [...together.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)),
  };
}

/**
 * Notes most like `path` by the values they share. A rare value shared counts
 * for more than a common one: two notes both tagged #task say little, two
 * notes both tagged #home-lab say a lot.
 */
export function similarNotes(notes: InsightNote[], path: string, limit = 5): { note: InsightNote; shared: string[] }[] {
  const me = notes.find(n => n.path === path);
  if (!me) return [];
  const mine = new Map<string, string>();
  for (const f of Object.keys(me.values)) for (const v of me.values[f]) mine.set(f + '\u0000' + v.key, v.label);
  if (!mine.size) return [];
  const used = new Map<string, number>();
  for (const n of notes) for (const f of Object.keys(n.values)) for (const v of n.values[f]) {
    const id = f + '\u0000' + v.key;
    if (mine.has(id)) used.set(id, (used.get(id) || 0) + 1);
  }
  const out: { note: InsightNote; shared: string[]; score: number }[] = [];
  for (const n of notes) {
    if (n.path === path) continue;
    const shared: { label: string; w: number }[] = [];
    for (const f of Object.keys(n.values)) for (const v of n.values[f]) {
      const id = f + '\u0000' + v.key;
      if (mine.has(id)) shared.push({ label: mine.get(id)!, w: 1 / Math.log2(1 + (used.get(id) || 1)) });
    }
    if (!shared.length) continue;
    shared.sort((a, b) => b.w - a.w);
    out.push({ note: n, shared: shared.map(s => s.label), score: shared.reduce((s, x) => s + x.w, 0) });
  }
  out.sort((a, b) => b.score - a.score || a.note.name.localeCompare(b.note.name));
  return out.slice(0, limit).map(({ note, shared }) => ({ note, shared }));
}

/** Notes with no value for the facet: the untagged ones, for tags. */
export function missing(notes: InsightNote[], facet: string): InsightNote[] {
  return notes.filter(n => !(n.values[facet] || []).length);
}

/* ------------------------------------------------------------------ near duplicates */

/** `#Recipes`, `recipe` and `re-cipe` all come out as `recipe`. */
export function looseForm(label: string): string {
  let s = label.replace(/^#/, '').toLowerCase().replace(/[\s_\-.]+/g, '');
  if (s.length > 3 && s.endsWith('ies')) s = s.slice(0, -3) + 'y';
  else if (s.length > 3 && s.endsWith('es') && /(ss|x|ch|sh)es$/.test(s)) s = s.slice(0, -2);
  else if (s.length > 3 && s.endsWith('s') && !s.endsWith('ss')) s = s.slice(0, -1);
  return s;
}

/** At most one edit apart (insert, delete, substitute or swap two neighbours). */
function withinOne(a: string, b: string): boolean {
  if (a === b) return true;
  const la = a.length, lb = b.length;
  if (Math.abs(la - lb) > 1) return false;
  let i = 0;
  while (i < la && i < lb && a[i] === b[i]) i++;
  if (la === lb) {
    if (a.slice(i + 1) === b.slice(i + 1)) return true;
    return a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2);
  }
  return la > lb ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1);
}

export interface DuplicatePair<V> {
  /** The less used of the two: the one to merge away. */
  from: V;
  into: V;
}

/**
 * Values that look like one value written two ways — a plural, a hyphen, a
 * typo. Short words need an exact loose match, as `game` and `gate` are not a typo.
 */
export function nearDuplicates<V extends { key: string; label: string; count: number }>(values: V[], limit = 8): DuplicatePair<V>[] {
  const list = values.slice(0, 400).map(v => ({ v, s: looseForm(v.label) }));
  const out: DuplicatePair<V>[] = [];
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i], b = list[j];
      if (a.v.key === b.v.key) continue;
      const same = a.s === b.s || (Math.min(a.s.length, b.s.length) >= 5 && withinOne(a.s, b.s));
      if (!same) continue;
      const aWins = a.v.count > b.v.count || (a.v.count === b.v.count && a.v.label.length <= b.v.label.length);
      out.push(aWins ? { from: b.v, into: a.v } : { from: a.v, into: b.v });
    }
  }
  out.sort((x, y) => (y.from.count + y.into.count) - (x.from.count + x.into.count));
  return out.slice(0, limit);
}
