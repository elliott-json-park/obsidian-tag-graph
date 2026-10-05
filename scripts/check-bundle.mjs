/*
 * Gates a release on what the community review and users care about:
 *   - main.js makes no network requests and loads no code at runtime;
 *   - it does not write HTML strings into the DOM or log to the console;
 *   - styles.css avoids constructs the automated review rejects;
 *   - manifest.json, package.json and versions.json agree on the version.
 *
 *   node scripts/check-bundle.mjs
 */
import { readFileSync } from 'node:fs';

const fail = [];
const js = readFileSync('main.js', 'utf8');
const css = readFileSync('styles.css', 'utf8');
const manifest = JSON.parse(readFileSync('manifest.json', 'utf8'));
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const versions = JSON.parse(readFileSync('versions.json', 'utf8'));

const banned = [
  [/\bfetch\s*\(/, 'fetch('],
  [/XMLHttpRequest/, 'XMLHttpRequest'],
  [/\brequestUrl\b/, 'requestUrl'],
  [/new\s+WebSocket/, 'WebSocket'],
  [/\.innerHTML\s*=/, 'innerHTML ='],
  [/\.outerHTML\s*=/, 'outerHTML ='],
  [/insertAdjacentHTML/, 'insertAdjacentHTML'],
  [/\beval\s*\(/, 'eval('],
  [/new\s+Function\s*\(/, 'new Function('],
  [/createElement\(\s*["']script["']/, 'script element'],
  [/console\.log\s*\(/, 'console.log('],
];
for (const [re, name] of banned) if (re.test(js)) fail.push(`main.js contains ${name}`);

for (const [re, name] of [[/!important/, '!important'], [/:has\(/, ':has()']]) {
  if (re.test(css)) fail.push(`styles.css contains ${name}`);
}

if (manifest.version !== pkg.version) fail.push(`manifest ${manifest.version} != package ${pkg.version}`);
if (versions[manifest.version] !== manifest.minAppVersion) fail.push(`versions.json has no ${manifest.version}: ${manifest.minAppVersion}`);
if (/obsidian/i.test(manifest.id)) fail.push('plugin id must not contain "obsidian"');
if (!/\.$/.test(manifest.description)) fail.push('description should end with a period');
if (manifest.description.length > 250) fail.push('description is longer than 250 characters');
if (/obsidian/i.test(manifest.description)) fail.push('description should not say "Obsidian"');

if (fail.length) {
  console.error('check-bundle: FAIL\n  ' + fail.join('\n  '));
  process.exit(1);
}
console.log(`check-bundle: ok (main.js ${(js.length / 1024).toFixed(1)} KB, version ${manifest.version})`);
