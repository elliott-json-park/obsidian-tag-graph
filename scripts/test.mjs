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
const I = await load('src/insights.ts');

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

test('folderMoveDest: a folder dropped on a folder goes inside it, never into itself', () => {
  assert.deepEqual(M.folderMoveDest('Inbox/Books', 'Library'), { dest: 'Library/Books' });
  assert.deepEqual(M.folderMoveDest('Inbox/Books', '/'), { dest: 'Books' });
  assert.deepEqual(M.folderMoveDest('Books', 'Library/2026'), { dest: 'Library/2026/Books' });
  assert.deepEqual(M.folderMoveDest('Books', 'Books'), { reason: 'inside' });
  assert.deepEqual(M.folderMoveDest('Books', 'Books/Old'), { reason: 'inside' });
  // A sibling whose name only starts the same is not inside.
  assert.deepEqual(M.folderMoveDest('Books', 'Books2'), { dest: 'Books2/Books' });
  assert.deepEqual(M.folderMoveDest('Library/Books', 'Library'), { reason: 'same' });
  assert.deepEqual(M.folderMoveDest('Books', '/'), { reason: 'same' });
  assert.deepEqual(M.folderMoveDest('/', 'Library'), { reason: 'root' });
});

/* ---------------------------------------------------------------- insights */

const folderFacet = { id: 'file.folder', label: 'Folder', kind: 'folder', list: false };
const inFolder = path => {
  const n = note(path);
  const key = n.folder || '/';
  n.facets['file.folder'] = [{ key, label: key === '/' ? 'Vault root' : key }];
  return n;
};

test('folder tree: each folder hub joins its parent, drawing empty parents, one subtree per top-level folder', () => {
  const notes = [inFolder('Work/Clients/Acme/a.md'), inFolder('Work/b.md'), inFolder('Home/c.md'), inFolder('d.md')];
  const flat = M.buildGraph(notes, opts({ facets: [folderFacet] }));
  assert.equal(flat.edges.filter(e => e.type === 'tree').length, 0);
  const m = M.buildGraph(notes, opts({ facets: [folderFacet], folderTree: true }));
  const tree = m.edges.filter(e => e.type === 'tree').map(e => e.source + ' -> ' + e.target).sort();
  const h = k => M.hubId('file.folder', k);
  assert.deepEqual(tree, [h('Work/Clients') + ' -> ' + h('Work'), h('Work/Clients/Acme') + ' -> ' + h('Work/Clients')].sort());
  const clients = m.nodes.find(n => n.id === h('Work/Clients'));
  assert.equal(clients.structural, true);
  assert.equal(clients.count, 0);
  assert.equal(m.nodes.find(n => n.id === h('Work')).structural, undefined);
  // Top-level folders and the root are not joined to anything.
  assert.ok(!m.edges.some(e => e.type === 'tree' && (e.source === h('Home') || e.source === h('/') || e.target === h('/'))));
});

test('folder tree: a hidden folder is skipped over, a below-minimum parent is drawn with its notes', () => {
  const notes = [inFolder('A/B/C/x.md'), inFolder('A/B/C/y.md'), inFolder('A/z.md')];
  const h = k => M.hubId('file.folder', k);
  const m = M.buildGraph(notes, opts({ facets: [folderFacet], folderTree: true, minCount: 2,
    hidden: new Set([M.hubKey('file.folder', 'A/B')]) }));
  const tree = m.edges.filter(e => e.type === 'tree').map(e => e.source + ' -> ' + e.target);
  assert.deepEqual(tree, [h('A/B/C') + ' -> ' + h('A')]);
  assert.ok(!m.nodes.some(n => n.id === h('A/B')));
  const a = m.nodes.find(n => n.id === h('A'));
  assert.equal(a.count, 1);
  assert.equal(a.structural, false);
  assert.ok(m.edges.some(e => e.type === 'member' && e.source === M.noteId('A/z.md') && e.target === h('A')));
});

test('folder names: hubs are labelled with the folder name instead of the path', () => {
  const notes = [inFolder('Work/Clients/a.md'), inFolder('b.md')];
  const m = M.buildGraph(notes, opts({ facets: [folderFacet], folderTree: true, folderNames: true }));
  assert.deepEqual(hubs(m), ['Clients', 'Vault root', 'Work']);
  assert.deepEqual(hubs(M.buildGraph(notes, opts({ facets: [folderFacet] }))), ['Vault root', 'Work/Clients']);
});

test('validFileName refuses the characters Obsidian refuses', () => {
  assert.equal(M.validFileName('Meeting notes 2026-10-15'), true);
  assert.equal(M.validFileName('회의록'), true);
  for (const bad of ['a/b', 'a\\b', 'a:b', 'a#b', 'a^b', 'a[b', 'a]b', 'a|b', 'a?b', '.', '..']) assert.equal(M.validFileName(bad), false, bad);
});

console.log('insights');

const inote = (path, tags) => {
  const i = path.lastIndexOf('/');
  return { path, name: path.slice(i + 1).replace(/\.md$/, ''), folder: i < 0 ? '' : path.slice(0, i), values: { 'file.tags': tags.map(tv) }, mtime: 0 };
};

test('valueInsight: members, their folders, and the values they come with', () => {
  const ns = [
    inote('Tasks/b.md', ['task', 'urgent']), inote('Tasks/a.md', ['task', 'urgent', 'home']),
    inote('Inbox/c.md', ['task']), inote('Inbox/d.md', ['idea']),
  ];
  const vi = I.valueInsight(ns, 'file.tags', 'task');
  assert.deepEqual(vi.notes.map(n => n.name), ['a', 'b', 'c']);
  assert.deepEqual(vi.folders, [{ key: 'Tasks', count: 2 }, { key: 'Inbox', count: 1 }]);
  assert.deepEqual(vi.together.map(t => [t.label, t.count]), [['#urgent', 2], ['#home', 1]]);
});

test('valueInsight: the latest member and how many changed recently', () => {
  const D = 86400000, now = 100 * D;
  const ns = [inote('a.md', ['x']), inote('b.md', ['x']), inote('c.md', ['x']), inote('d.md', ['y'])];
  ns[0].mtime = now - 2 * D; ns[1].mtime = now - 40 * D; ns[3].mtime = now;
  const vi = I.valueInsight(ns, 'file.tags', 'x', now);
  assert.equal(vi.latest.name, 'a');
  assert.equal(vi.recent, 1);
  assert.equal(I.valueInsight(ns, 'file.tags', 'x').recent, 0);
});

test('similarNotes weighs rare shared values above common ones, and missing finds untagged notes', () => {
  const ns = [inote('a.md', ['task', 'homelab']), inote('b.md', ['task']), inote('c.md', ['task']), inote('d.md', ['task']),
    inote('e.md', ['homelab']), inote('f.md', [])];
  // e shares one rare value; b-d share one common one.
  assert.deepEqual(I.similarNotes(ns, 'a.md', 2).map(s => [s.note.name, s.shared]), [['e', ['#homelab']], ['b', ['#task']]]);
  const both = [inote('a.md', ['x', 'y']), inote('b.md', ['x', 'y']), inote('c.md', ['y'])];
  assert.deepEqual(I.similarNotes(both, 'a.md')[0].shared, ['#x', '#y']);
  assert.deepEqual(I.similarNotes(ns, 'f.md'), []);
  assert.deepEqual(I.missing(ns, 'file.tags').map(n => n.name), ['f']);
});

test('nearDuplicates: plurals, separators and typos, but not short look-alikes', () => {
  const v = (label, count) => ({ key: label.toLowerCase(), label, count });
  const pairs = I.nearDuplicates([v('#recipe', 6), v('#recipes', 2), v('#to-read', 1), v('#toread', 3),
    v('#game', 5), v('#gate', 1), v('#jounral', 1), v('#journal', 9), v('#boxes', 1), v('#box', 2), v('#study', 2), v('#studies', 1)]);
  const names = pairs.map(p => p.from.label + '>' + p.into.label).sort();
  assert.deepEqual(names, ['#boxes>#box', '#jounral>#journal', '#recipes>#recipe', '#studies>#study', '#to-read>#toread']);
  assert.equal(I.looseForm('#Class'), 'class');
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
