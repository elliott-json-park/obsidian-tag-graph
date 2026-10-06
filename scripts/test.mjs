/*
 * Unit tests for the parts that do not need Obsidian: the graph model and the
 * frontmatter / inline-tag edits. Both are bundled to a temporary CommonJS file
 * with esbuild and exercised with node:assert.
 *
 *   node scripts/test.mjs
 */
import esbuild from 'esbuild';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const dir = mkdtempSync(join(tmpdir(), 'tag-graph-test-'));
const require = createRequire(import.meta.url);
let passed = 0, failed = 0;

async function load(entry) {
  const out = join(dir, entry.replace(/\W/g, '_') + '.cjs');
  await esbuild.build({ entryPoints: [entry], bundle: true, format: 'cjs', platform: 'node', outfile: out, logLevel: 'silent' });
  return require(out);
}

function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e && e.message ? e.message.split('\n').join('\n       ') : e)); }
}

const M = await load('src/model.ts');
const F = await load('src/frontmatter.ts');

/* ---------------------------------------------------------------- fixtures */

const tags = { id: 'file.tags', label: 'Tags', kind: 'tags', list: true };
const status = { id: 'note.status', label: 'Status', kind: 'text', list: false };
const project = { id: 'note.project', label: 'Project', kind: 'link', list: false };
const tv = t => ({ key: M.tagKey(t), label: M.tagLabel(t) });
const sv = s => ({ key: s, label: s });

function note(path, { t = [], s = [], p = [], links = [], colors = [] } = {}) {
  const i = path.lastIndexOf('/');
  return {
    path, name: path.slice(i + 1).replace(/\.md$/, ''), folder: i < 0 ? '' : path.slice(0, i),
    facets: { 'file.tags': t.map(tv), 'note.status': s.map(sv), 'note.project': p }, colors, links,
  };
}

const opts = (o = {}) => ({
  facets: [tags], minCount: 1, splitByFolder: false, linkKinds: new Set(M.LINK_KINDS),
  hidden: new Set(), showIsolated: true, ...o,
});

const ids = m => m.nodes.map(n => n.id).sort();
const hubs = m => m.nodes.filter(n => n.type === 'hub').map(n => n.label).sort();

/* ---------------------------------------------------------------- model */

console.log('model');

test('notes sharing a tag meet at one hub', () => {
  const m = M.buildGraph([note('a.md', { t: ['x'] }), note('b.md', { t: ['#X'] })], opts());
  assert.deepEqual(hubs(m), ['#x']);
  assert.equal(m.edges.filter(e => e.type === 'member').length, 2);
});

test('minCount hides values used by too few notes and counts them in the legend', () => {
  const m = M.buildGraph([note('a.md', { t: ['x', 'typo'] }), note('b.md', { t: ['x'] })], opts({ minCount: 2 }));
  assert.deepEqual(hubs(m), ['#x']);
  const lf = m.legend[0];
  assert.equal(lf.values.find(v => v.label === '#typo').belowMin, true);
});

test('a hidden value and a hidden facet are not drawn', () => {
  const ns = [note('a.md', { t: ['x', 'y'], s: ['done'] }), note('b.md', { t: ['x', 'y'], s: ['done'] })];
  const m1 = M.buildGraph(ns, opts({ facets: [tags, status], hidden: new Set([M.hubKey('file.tags', 'y')]) }));
  assert.deepEqual(hubs(m1), ['#x', 'done']);
  const m2 = M.buildGraph(ns, opts({ facets: [tags, status], hidden: new Set(['note.status']) }));
  assert.deepEqual(hubs(m2), ['#x', '#y']);
  assert.equal(m2.legend[1].hidden, true);
});

test('split by folder adds one sub-hub per folder, joined to the hub', () => {
  const ns = [note('Games/a.md', { t: ['toread'] }), note('Games/b.md', { t: ['toread'] }), note('Books/c.md', { t: ['toread'] })];
  const m = M.buildGraph(ns, opts({ splitByFolder: true }));
  const subs = m.nodes.filter(n => n.type === 'subhub');
  assert.equal(subs.length, 2);
  assert.deepEqual(subs.map(s => s.subFolder).sort(), ['Books', 'Games']);
  assert.equal(subs.find(s => s.subFolder === 'Games').count, 2);
  assert.equal(m.edges.filter(e => e.type === 'split').length, 2);
  // Notes join the sub-hub, not the hub.
  const hub = M.hubId('file.tags', 'toread');
  assert.equal(m.edges.filter(e => e.type === 'member' && e.target === hub).length, 0);
});

test('split by folder leaves a single-folder value unsplit', () => {
  const m = M.buildGraph([note('G/a.md', { t: ['x'] }), note('G/b.md', { t: ['x'] })], opts({ splitByFolder: true }));
  assert.equal(m.nodes.filter(n => n.type === 'subhub').length, 0);
});

test('a link value that is itself a note joins members to that note, with no hub', () => {
  const ns = [
    note('P.md'),
    note('t1.md', { p: [{ key: 'link:P.md', label: 'P', notePath: 'P.md' }] }),
    note('t2.md', { p: [{ key: 'link:P.md', label: 'P', notePath: 'P.md' }] }),
  ];
  const m = M.buildGraph(ns, opts({ facets: [project], minCount: 5 }));
  assert.deepEqual(hubs(m), []);
  assert.equal(m.edges.filter(e => e.type === 'member' && e.target === M.noteId('P.md')).length, 2);
  assert.equal(m.legend[0].values[0].isNote, true);
  assert.equal(m.legend[0].values[0].belowMin, false);
});

test('links are classified, deduplicated and filtered by kind', () => {
  const ns = [
    note('a.md', { links: [
      { target: 'b.md', kind: 'body' }, { target: 'b.md', kind: 'body' },
      { target: 'b.md', kind: 'heading' }, { target: 'c.md', kind: 'block' },
      { target: 'a.md', kind: 'body' }, { target: 'zz.md', kind: 'body' },
    ] }),
    note('b.md', { links: [{ target: 'a.md', kind: 'body' }] }),
    note('c.md'),
  ];
  const m = M.buildGraph(ns, opts({ facets: [], linkKinds: new Set(['body']) }));
  assert.deepEqual(m.linkCounts, { body: 1, heading: 1, block: 1, property: 0, embed: 0 });
  assert.equal(m.edges.length, 1);
  assert.equal(m.edges[0].kind, 'body');
  // a links b and b links a back: one edge, marked two-way.
  assert.equal(m.edges[0].both, true);
  const one = M.buildGraph([note('a.md', { links: [{ target: 'b.md', kind: 'body' }] }), note('b.md')], opts({ facets: [] }));
  assert.equal(one.edges[0].both, undefined);
});

test('isolated notes can be left out', () => {
  const ns = [note('a.md', { t: ['x'] }), note('b.md', { t: ['x'] }), note('lonely.md')];
  assert.equal(M.buildGraph(ns, opts()).nodes.length, 4);
  assert.deepEqual(ids(M.buildGraph(ns, opts({ showIsolated: false }))).includes(M.noteId('lonely.md')), false);
});

test('colour keys are ordered by use', () => {
  const ns = [note('a.md', { colors: ['red'] }), note('b.md', { colors: ['blue'] }), note('c.md', { colors: ['blue', 'red'] }), note('d.md', { colors: ['blue'] })];
  assert.deepEqual(M.buildGraph(ns, opts({ facets: [] })).colorKeys.map(c => c.key), ['blue', 'red']);
});

test('a note listing the same value twice joins its hub once', () => {
  const n = note('a.md', { t: ['x', 'X', '#x'] });
  const m = M.buildGraph([n, note('b.md', { t: ['x'] })], opts());
  assert.equal(m.edges.filter(e => e.source === M.noteId('a.md')).length, 1);
});

test('helpers', () => {
  assert.equal(M.wikilinkPath('[[A/B#h|alias]]'), 'A/B');
  assert.equal(M.wikilinkPath('plain'), null);
  assert.equal(M.bodyLinkKind('a#^blk'), 'block');
  assert.equal(M.bodyLinkKind('a#Heading'), 'heading');
  assert.equal(M.bodyLinkKind('a'), 'body');
  assert.deepEqual(M.rawValues(['a', ['b', null], 3, true, { x: 1 }, '  ']), ['a', 'b', '3', 'true']);
  assert.equal(M.folderLabel('a/b/c'), 'c');
  assert.equal(M.folderLabel(''), '/');
});

/* ---------------------------------------------------------------- frontmatter */

console.log('frontmatter');

const eq = v => raw => raw.trim() === v;
const teq = v => raw => M.tagKey(raw) === M.tagKey(v);

test('fmAdd appends to a list and does not duplicate', () => {
  const fm = { aliases: ['x'] };
  assert.equal(F.fmAdd(fm, 'aliases', 'y', true, eq('y')), true);
  assert.deepEqual(fm.aliases, ['x', 'y']);
  assert.equal(F.fmAdd(fm, 'aliases', 'y', true, eq('y')), false);
});

test('fmAdd replaces a single value, and wraps a scalar when the facet is a list', () => {
  const fm = { status: 'todo' };
  F.fmAdd(fm, 'status', 'done', false, eq('done'));
  assert.equal(fm.status, 'done');
  const fm2 = { area: 'work' };
  F.fmAdd(fm2, 'area', 'home', true, eq('home'));
  assert.deepEqual(fm2.area, ['work', 'home']);
  const fm3 = {};
  F.fmAdd(fm3, 'area', 'home', true, eq('home'));
  assert.deepEqual(fm3.area, ['home']);
});

test('fmRemove takes the value out of lists and scalars', () => {
  const fm = { a: ['x', 'y', 'x'], b: 'x', c: 'z' };
  assert.equal(F.fmRemove(fm, 'a', eq('x')), true);
  assert.deepEqual(fm.a, ['y']);
  assert.equal(F.fmRemove(fm, 'b', eq('x')), true);
  assert.equal('b' in fm, false);
  assert.equal(F.fmRemove(fm, 'c', eq('x')), false);
});

test('fmReplace keeps position and drops the duplicate it would create', () => {
  const fm = { a: ['p', 'old', 'q', 'new'] };
  F.fmReplace(fm, 'a', eq('old'), 'new', eq('new'));
  assert.deepEqual(fm.a, ['p', 'new', 'q']);
});

test('tags: key is reused, string form is split, # is stripped, case-insensitive match', () => {
  const fm = { Tags: 'alpha, Beta gamma' };
  assert.equal(F.tagsKey(fm), 'Tags');
  assert.equal(F.fmAddTag(fm, '#delta', teq('delta')), true);
  assert.deepEqual(fm.Tags, ['alpha', 'Beta', 'gamma', 'delta']);
  assert.equal(F.fmAddTag(fm, 'BETA', teq('BETA')), false);
  assert.equal(F.fmReplaceTag(fm, teq('beta'), 'b2', teq('b2')), true);
  assert.deepEqual(fm.Tags, ['alpha', 'b2', 'gamma', 'delta']);
  assert.equal(F.fmRemoveTag(fm, teq('gamma')), true);
  assert.deepEqual(fm.Tags, ['alpha', 'b2', 'delta']);
  const empty = {};
  F.fmAddTag(empty, 'x', teq('x'));
  assert.deepEqual(empty.tags, ['x']);
});

test('inline tags are rewritten at their offsets, and refused if the text moved', () => {
  const text = 'Hello #Todo and #todo/sub and #todo.';
  const spans = [{ start: 6, end: 11 }, { start: 30, end: 35 }];
  assert.equal(F.rewriteInlineTags(text, spans, teq('todo'), 'task'), 'Hello #task and #todo/sub and #task.');
  assert.equal(F.rewriteInlineTags(text, spans, teq('todo'), null), 'Hello and #todo/sub and.');
  assert.equal(F.rewriteInlineTags('XX' + text, spans, teq('todo'), 'task'), null);
});

test('validTag', () => {
  assert.equal(F.validTag('project/alpha'), true);
  assert.equal(F.validTag('#ok_1-2'), true);
  assert.equal(F.validTag('has space'), false);
  assert.equal(F.validTag('1984'), false);
  assert.equal(F.validTag(''), false);
  assert.equal(F.validTag('a,b'), false);
});

rmSync(dir, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
