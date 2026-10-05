/*
 * Writes a sample vault that shows every part of Tag Graph: tags reused
 * across folders, a status property, project links, heading and block links,
 * and a couple of typo tags for the minimum-count filter to hide.
 *
 *   node scripts/make-demo-vault.mjs <vault dir>
 *
 * Deterministic: the same vault every time, so screenshots can be retaken.
 * Installs the built plugin into the vault's .obsidian/plugins.
 */
import { mkdirSync, writeFileSync, copyFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const vault = process.argv[2];
if (!vault) { console.error('usage: node scripts/make-demo-vault.mjs <vault dir>'); process.exit(1); }

let seed = 7;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const pick = a => a[Math.floor(rnd() * a.length)];
const some = (a, n) => { const c = a.slice(); const out = []; while (out.length < n && c.length) out.push(c.splice(Math.floor(rnd() * c.length), 1)[0]); return out; };

const notes = [];
const add = (path, fm, body) => notes.push({ path, fm, body });

const yaml = fm => {
  const lines = ['---'];
  for (const [k, v] of Object.entries(fm)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) { lines.push(`${k}:`); for (const x of v) lines.push(`  - ${JSON.stringify(x)}`); }
    else lines.push(`${k}: ${JSON.stringify(v)}`);
  }
  lines.push('---', '');
  return lines.join('\n');
};

/* ---- projects ---- */
const projects = ['Website Redesign', 'Garden Planner', 'Novel Draft', 'Home Lab'];
for (const p of projects) {
  add(`Projects/${p}.md`, { tags: ['project'], status: 'active' },
    `# ${p}\n\nThe hub for everything about ${p}.\n\n## Goals\n\nShip a first version this quarter.\n\n## Notes\n\n- Kickoff decisions are in [[Meeting 01]]. ^kickoff\n`);
}

/* ---- tasks, linked to projects by a property ---- */
const statuses = ['todo', 'doing', 'done', 'done', 'todo'];
const taskNames = [
  'Pick a colour palette', 'Write the about page', 'Set up analytics', 'Migrate the blog', 'Fix mobile menu',
  'Order seeds', 'Sketch bed layout', 'Build compost bin', 'Plan watering schedule',
  'Outline chapter 3', 'Rewrite the opening', 'Name the antagonist', 'Research 1920s Paris',
  'Flash the router', 'Rack the NAS', 'Set up backups', 'Label the cables',
];
taskNames.forEach((name, i) => {
  const p = projects[i < 5 ? 0 : i < 9 ? 1 : i < 13 ? 2 : 3];
  const tags = ['task', ...some(['urgent', 'waiting', 'quick', 'research'], Math.floor(rnd() * 2))];
  add(`Tasks/${name}.md`, { tags, status: statuses[i % statuses.length], project: `[[${p}]]`, priority: pick(['high', 'medium', 'low']) },
    `Part of [[${p}#Goals]].\n\n${rnd() > 0.6 ? `See also [[${pick(taskNames)}]].\n` : ''}`);
});

/* ---- reading notes: the same tags reused in other folders ---- */
const books = ['Deep Work', 'The Design of Everyday Things', 'Thinking in Systems', 'A Pattern Language',
  'The Making of a Manager', 'How to Take Smart Notes', 'Range', 'The Overstory'];
books.forEach(b => {
  const tags = ['book', ...some(['toread', 'reference', 'design', 'productivity', 'systems'], 1 + Math.floor(rnd() * 2))];
  add(`Reading/${b}.md`, { tags, status: pick(['toread', 'reading', 'finished']), author: pick(['Newport', 'Norman', 'Meadows', 'Alexander', 'Zhuo', 'Ahrens', 'Epstein', 'Powers']) },
    `Notes on *${b}*.\n\n${rnd() > 0.5 ? `Useful for [[${pick(projects)}]].` : ''}\n${rnd() > 0.6 ? `Connects to [[${pick(books)}]].` : ''}\n`);
});

/* ---- games: #toread and #reference again, in another folder ---- */
['Factorio', 'Outer Wilds', 'Hades', 'Celeste', 'Stardew Valley'].forEach(g => {
  add(`Games/${g}.md`, { tags: ['game', ...some(['toread', 'reference', 'mods'], 1 + Math.floor(rnd() * 2))], status: pick(['playing', 'finished', 'wishlist']) },
    `Thoughts on ${g}. Inline tag: #mods\n`);
});

/* ---- recipes ---- */
['Shakshuka', 'Miso Soup', 'Focaccia', 'Kimchi Fried Rice', 'Lemon Tart', 'Ramen Eggs'].forEach(r => {
  add(`Recipes/${r}.md`, { tags: ['recipe', ...some(['quick', 'vegetarian', 'reference', 'weekend'], 1 + Math.floor(rnd() * 2))] },
    `# ${r}\n\n## Ingredients\n\n## Method\n`);
});

/* ---- journal: links by heading and block ---- */
for (let d = 1; d <= 10; d++) {
  const day = `2026-09-${String(d).padStart(2, '0')}`;
  const p = pick(projects);
  add(`Journal/${day}.md`, { tags: ['journal', ...(rnd() > 0.7 ? ['idea'] : [])], mood: pick(['good', 'ok', 'tired']) },
    `Worked on [[${p}#Notes]]. Reading [[${pick(books)}]].\n${rnd() > 0.5 ? `Decision recorded: [[${p}#^kickoff]].` : ''}\n`);
}
add('Meetings/Meeting 01.md', { tags: ['meeting'] }, 'Decisions for every project.\n');
add('Meetings/Meeting 02.md', { tags: ['meeting', 'idea'] }, 'Follow-up to [[Meeting 01]].\n');

/* ---- two typo tags, used once each: the minimum count hides them ---- */
add('Inbox/Quick capture.md', { tags: ['todo', 'refrence'] }, 'Typo tags live here. #ideas\n');
add('Inbox/Scratch.md', { tags: ['idea'] }, 'An idea with no home yet.\n');

/* ---- a note with a base embedded in it ---- */
add('Dashboard.md', {}, 'The tasks board, embedded:\n\n![[Projects board.base]]\n\nMore text below the embed.\n');

/* ---- bases ---- */
const bases = {
  'Tag graph.base': `filters:
  and:
    - file.ext == "md"
views:
  - type: tag-graph
    name: Tags
    facet1: file.tags
    minCount: 2
`,
  'Projects board.base': `filters:
  and:
    - file.inFolder("Tasks")
views:
  - type: tag-graph
    name: Tasks by status and project
    facet1: note.status
    facet2: note.project
    colorBy: note.priority
    minCount: 1
    linkProperty: related
  - type: table
    name: Table
    order:
      - file.name
      - status
      - project
      - priority
`,
  'Tags by folder.base': `filters:
  and:
    - file.ext == "md"
    - not:
        - file.inFolder("Tasks")
views:
  - type: tag-graph
    name: Tags across folders
    facet1: file.tags
    splitByFolder: true
    minCount: 2
    colorBy: file.folder
`,
};

/* ---- write ---- */
if (existsSync(vault)) for (const dir of ['Projects', 'Tasks', 'Reading', 'Games', 'Recipes', 'Journal', 'Meetings', 'Inbox']) rmSync(join(vault, dir), { recursive: true, force: true });
// Notes written at the root are rewritten below; nothing else at the root is touched.
mkdirSync(vault, { recursive: true });
for (const n of notes) {
  const full = join(vault, n.path);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, (Object.keys(n.fm).length ? yaml(n.fm) : "") + n.body);
}
for (const [name, text] of Object.entries(bases)) writeFileSync(join(vault, name), text);

const ob = join(vault, '.obsidian');
const plug = join(ob, 'plugins', 'tag-graph');
mkdirSync(plug, { recursive: true });
for (const f of ['main.js', 'manifest.json', 'styles.css']) copyFileSync(f, join(plug, f));
writeFileSync(join(ob, 'community-plugins.json'), JSON.stringify(['tag-graph'], null, 2));
if (!existsSync(join(ob, 'core-plugins.json'))) {
  writeFileSync(join(ob, 'core-plugins.json'), JSON.stringify({
    'file-explorer': true, 'global-search': true, switcher: true, graph: true, backlink: true,
    'page-preview': true, 'command-palette': true, bases: true, 'file-recovery': true, properties: true,
  }, null, 2));
}
if (!existsSync(join(ob, 'app.json'))) writeFileSync(join(ob, 'app.json'), JSON.stringify({ promptDelete: false }, null, 2));
console.log(`wrote ${notes.length} notes and ${Object.keys(bases).length} bases to ${vault}`);
