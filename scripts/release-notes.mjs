/*
 * Prints the CHANGELOG.md section for a version, for the release workflow.
 * A version with no section is an error: a release with no notes tells a user
 * nothing about what changed.
 *
 *   node scripts/release-notes.mjs 1.0.0
 */
import { readFileSync } from 'node:fs';

const version = process.argv[2];
const text = readFileSync('CHANGELOG.md', 'utf8');
const lines = text.split(/\r?\n/);
const start = lines.findIndex(l => l.trim() === `## ${version}`);
if (start < 0) { console.error(`CHANGELOG.md has no "## ${version}" section`); process.exit(1); }
let end = lines.findIndex((l, i) => i > start && /^## /.test(l));
if (end < 0) end = lines.length;
console.log(lines.slice(start + 1, end).join('\n').trim());
