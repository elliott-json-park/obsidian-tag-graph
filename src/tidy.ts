/*
 * The sidebar's tidy list: a few tags worth a look this week, across the whole
 * vault. Pure, like insights.ts: the sidebar hands in what the metadata cache
 * says about every tag, and scripts/test.mjs runs this in Node.
 *
 * Three kinds of item, in this order:
 *   dup    — two tags that look like one written two ways (#recipe, #recipes).
 *   stale  — a tag on several notes, none of them edited for half a year.
 *   single — a tag on exactly one note that has not been edited for a month.
 * An item the reader chose to keep is never offered again.
 */
import { nearDuplicates } from './insights';

export interface TagUse {
  /** tagKey of the tag. */
  key: string;
  /** How it is written, with '#'. */
  label: string;
  /** Notes that carry it. */
  notes: string[];
  /** Newest edit among those notes, ms since the epoch; 0 when unknown. */
  latest: number;
}

export type TidyItem =
  | { kind: 'dup'; id: string; from: TagUse; into: TagUse }
  | { kind: 'stale'; id: string; tag: TagUse; days: number }
  | { kind: 'single'; id: string; tag: TagUse };

export interface TidyOptions {
  now: number;
  /** Ids of items the reader chose to keep. */
  kept: ReadonlySet<string>;
  /** At most this many items are returned. */
  limit?: number;
  staleDays?: number;
  singleDays?: number;
}

const DAY = 86400000;

export const dupId = (from: string, into: string): string => 'dup:' + from + '>' + into;
export const staleId = (key: string): string => 'stale:' + key;
export const singleId = (key: string): string => 'single:' + key;

/** The tidy list and how many items there were before the limit. */
export function tidyList(tags: TagUse[], o: TidyOptions): { items: TidyItem[]; total: number } {
  const staleDays = o.staleDays ?? 180, singleDays = o.singleDays ?? 30;
  const out: TidyItem[] = [];
  const covered = new Set<string>();

  const sorted = tags.slice().sort((a, b) => b.notes.length - a.notes.length || a.label.localeCompare(b.label));
  const pairs = nearDuplicates(sorted.map(t => ({ key: t.key, label: t.label, count: t.notes.length, t })), 50);
  for (const p of pairs) {
    const id = dupId(p.from.key, p.into.key);
    // A tag already being merged away is not offered again in another pair.
    if (o.kept.has(id) || covered.has(p.from.key)) continue;
    covered.add(p.from.key);
    covered.add(p.into.key);
    out.push({ kind: 'dup', id, from: p.from.t, into: p.into.t });
  }

  const age = (t: TagUse) => (t.latest && o.now > t.latest ? Math.floor((o.now - t.latest) / DAY) : 0);
  const stale = sorted
    .filter(t => t.notes.length >= 2 && !covered.has(t.key) && !o.kept.has(staleId(t.key)) && t.latest && age(t) >= staleDays)
    .sort((a, b) => a.latest - b.latest || a.label.localeCompare(b.label));
  for (const t of stale) out.push({ kind: 'stale', id: staleId(t.key), tag: t, days: age(t) });

  const single = sorted
    .filter(t => t.notes.length === 1 && !covered.has(t.key) && !o.kept.has(singleId(t.key)) && t.latest && age(t) >= singleDays)
    .sort((a, b) => a.latest - b.latest || a.label.localeCompare(b.label));
  for (const t of single) out.push({ kind: 'single', id: singleId(t.key), tag: t });

  return { items: out.slice(0, o.limit ?? 5), total: out.length };
}
