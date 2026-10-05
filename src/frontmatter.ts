/*
 * Edits to a note's frontmatter object and body tags. Pure: they take the
 * object Obsidian's processFrontMatter hands over (or the file text) and change
 * it in place, so scripts/test.mjs can check them without Obsidian.
 *
 * Every function is careful about the shape a property already has: a list
 * stays a list, a single value stays a single value, and a value that is
 * already there is not added twice.
 */

export type Matcher = (raw: string) => boolean;
type FM = Record<string, unknown>;

/** The key a note keeps its tags under: an existing `tags`/`tag` (any case), else `tags`. */
export function tagsKey(fm: FM): string {
  for (const k of Object.keys(fm)) if (/^tags?$/i.test(k)) return k;
  return 'tags';
}

/** Tags written as one string (`a, b` or `a b`) become a list before editing. */
function tagList(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter(x => x !== null && x !== undefined).map(x => String(x));
  if (typeof v === 'string') return v.split(/[,\s]+/).filter(Boolean);
  if (v === null || v === undefined) return [];
  return [String(v)];
}

function asList(v: unknown): unknown[] {
  if (Array.isArray(v)) return v.slice();
  if (v === null || v === undefined || v === '') return [];
  return [v];
}

const str = (x: unknown): string => (x === null || x === undefined ? '' : String(x));

/**
 * Give the note `value` under `key`. A list property gets it appended; a
 * single-value property gets it replaced. Returns false when nothing changed.
 */
export function fmAdd(fm: FM, key: string, value: string, list: boolean, matches: Matcher): boolean {
  const cur = fm[key];
  if (Array.isArray(cur) || list) {
    const arr = asList(cur);
    if (arr.some(x => matches(str(x)))) return false;
    arr.push(value);
    fm[key] = arr;
    return true;
  }
  if (cur !== undefined && cur !== null && matches(str(cur))) return false;
  fm[key] = value;
  return true;
}

/** Remove every occurrence of the value. An emptied list is left as an empty list. */
export function fmRemove(fm: FM, key: string, matches: Matcher): boolean {
  const cur = fm[key];
  if (cur === undefined || cur === null) return false;
  if (Array.isArray(cur)) {
    const next = cur.filter(x => !matches(str(x)));
    if (next.length === cur.length) return false;
    fm[key] = next;
    return true;
  }
  if (!matches(str(cur))) return false;
  delete fm[key];
  return true;
}

/** Replace the value with `value`, keeping its place in a list and dropping duplicates it creates. */
export function fmReplace(fm: FM, key: string, matches: Matcher, value: string, sameAsNew: Matcher): boolean {
  const cur = fm[key];
  if (cur === undefined || cur === null) return false;
  if (Array.isArray(cur)) {
    if (!cur.some(x => matches(str(x)))) return false;
    const out: unknown[] = [];
    let placed = false;
    for (const x of cur) {
      const s = str(x);
      if (matches(s) || sameAsNew(s)) {
        if (!placed) { out.push(value); placed = true; }
        continue;
      }
      out.push(x);
    }
    fm[key] = out;
    return true;
  }
  if (!matches(str(cur))) return false;
  fm[key] = value;
  return true;
}

/* ------------------------------------------------------------------ tags */

const bare = (t: string) => t.replace(/^#/, '').trim();

export function fmAddTag(fm: FM, tag: string, same: Matcher): boolean {
  const k = tagsKey(fm);
  const list = tagList(fm[k]);
  if (list.some(x => same(x))) return false;
  list.push(bare(tag));
  fm[k] = list;
  return true;
}

export function fmRemoveTag(fm: FM, same: Matcher): boolean {
  const k = tagsKey(fm);
  if (fm[k] === undefined || fm[k] === null) return false;
  const list = tagList(fm[k]);
  const next = list.filter(x => !same(x));
  if (next.length === list.length) return false;
  fm[k] = next;
  return true;
}

export function fmReplaceTag(fm: FM, same: Matcher, tag: string, sameAsNew: Matcher): boolean {
  const k = tagsKey(fm);
  if (fm[k] === undefined || fm[k] === null) return false;
  const list = tagList(fm[k]);
  if (!list.some(x => same(x))) return false;
  const out: string[] = [];
  let placed = false;
  for (const x of list) {
    if (same(x) || sameAsNew(x)) {
      if (!placed) { out.push(bare(tag)); placed = true; }
      continue;
    }
    out.push(x);
  }
  fm[k] = out;
  return true;
}

export interface TagSpan { start: number; end: number }

/**
 * Rewrite inline `#tags` in the body at the offsets Obsidian's metadata cache
 * reported. Each span is checked against the text before it is touched, so a
 * file that changed since it was indexed is left alone rather than mangled.
 * `to` null removes the tag (and one space before it, so no double space is left).
 * Returns the new text, or null if a span no longer matches.
 */
export function rewriteInlineTags(text: string, spans: TagSpan[], same: Matcher, to: string | null): string | null {
  const sorted = spans.slice().sort((a, b) => b.start - a.start);
  let out = text;
  for (const s of sorted) {
    const found = out.slice(s.start, s.end);
    if (!found.startsWith('#') || !same(found)) return null;
    if (to === null) {
      let start = s.start;
      if (start > 0 && out.charAt(start - 1) === ' ') start--;
      out = out.slice(0, start) + out.slice(s.end);
    } else {
      out = out.slice(0, s.start) + '#' + bare(to) + out.slice(s.end);
    }
  }
  return out;
}

/** A tag that Obsidian will accept: no spaces, not only digits, no punctuation it rejects. */
export function validTag(tag: string): boolean {
  const t = bare(tag);
  if (!t) return false;
  if (/^[0-9/]+$/.test(t)) return false;
  return !/[\s#,.:;!?"'`~@$%^&*()+=[\]{}<>|\\]/.test(t);
}
