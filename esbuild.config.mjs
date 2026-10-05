import esbuild from 'esbuild';
import process from 'node:process';
import { builtinModules } from 'node:module';

const banner =
`/*
 * Tag Graph — bundled by esbuild. Do not edit main.js directly; the source is in src/.
 * Includes d3-force (ISC, Mike Bostock) — see THIRD-PARTY-NOTICES.md.
 */
`;

const prod = process.argv[2] === 'production';

const ctx = await esbuild.context({
  banner: { js: banner },
  entryPoints: ['src/main.ts'],
  bundle: true,
  /* Everything Obsidian provides at runtime. d3-force is deliberately bundled:
     a plugin may not fetch code at runtime. */
  external: [
    'obsidian', 'electron',
    '@codemirror/autocomplete', '@codemirror/collab', '@codemirror/commands',
    '@codemirror/language', '@codemirror/lint', '@codemirror/search',
    '@codemirror/state', '@codemirror/view',
    '@lezer/common', '@lezer/highlight', '@lezer/lr',
    ...builtinModules,
    ...builtinModules.map(m => 'node:' + m),
  ],
  format: 'cjs',
  target: 'es2018',
  logLevel: 'info',
  sourcemap: prod ? false : 'inline',
  treeShaking: true,
  outfile: 'main.js',
  minify: prod,
});

if (prod) { await ctx.rebuild(); await ctx.dispose(); }
else { await ctx.watch(); }
