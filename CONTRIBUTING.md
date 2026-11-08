# Contributing

Bug reports, feature requests and pull requests are all welcome. This file is
the short version of what will make any of them go smoothly.

## Reporting a bug

Open an issue at
[github.com/elliott-json-park/obsidian-tag-graph/issues](https://github.com/elliott-json-park/obsidian-tag-graph/issues).

The useful things are: your Obsidian version, desktop or mobile, the plugin
version, roughly how many notes the base shows, and what you did immediately
before it happened. If the graph draws the wrong thing, the base's filters and
the view's settings usually explain it — a screenshot of both helps.

## Suggesting a feature

Say what you were trying to do, not only what you would like added. Most of
the plugin was built from open requests on the Obsidian forum; linking the
forum thread you care about, if there is one, is a good start.

Two things are deliberately out of scope, so it saves time to say so:

- **Anything that reaches the network.** The plugin makes no requests and
  loads no code at runtime; `scripts/check-bundle.mjs` enforces it.
- **A second filter language.** Tag Graph is a Bases view, so the base's own
  filters decide what is drawn. Graph-search syntax inside the view would
  duplicate them.

## Pull requests

### Setting up

```bash
npm install
npm run dev        # rebuild main.js on change
npm run build      # type-check, then bundle main.js
npm test           # build, the test suite, and the bundle gate
npm run demo-vault # generate a demo vault to try changes in
```

The source is TypeScript in `src/`: `main.ts` (plugin lifecycle and
commands), `view.ts` (the Bases view), `model.ts` (turning the base into a
graph), `renderer.ts` (drawing and pointer input), `actions.ts` (every change
to the vault, with undo) and `i18n.ts`. `model.ts`, `insights.ts`,
`values.ts` and `frontmatter.ts` are pure — no Obsidian imports — so
`scripts/test.mjs` can run them in Node; please keep them that way. The
plugin needs Obsidian 1.13 or later and the Bases core plugin.

### Before you open the PR

1. **`npm test` passes.** It also runs `scripts/check-bundle.mjs`, which fails
   on network requests, runtime code loading and other things the community
   review rejects.
2. **Every edit can be undone.** Anything that changes notes (tags, properties,
   moves) goes through the same undo path as the existing actions.
3. **New text exists in every language.** The interface is in English, Korean
   and Simplified Chinese; add your strings to `src/i18n.ts` for all three.
4. **`CHANGELOG.md` has a line for it** under the next version.

### Commit messages

A sentence in the imperative that says what the change does for the user:
"Keep node positions when a filter changes". Not "fix bug".

## Releases

Maintainer only. Add the version's section to `CHANGELOG.md`, bump
`manifest.json`, `package.json` and `versions.json`, commit, then
`git tag <version> && git push origin <version>`. The workflow in
`.github/workflows/release.yml` runs `npm test`, builds from the tag, uses the
`CHANGELOG.md` section as the release notes, and mints a provenance
attestation so anyone can verify with `gh attestation verify` that the assets
were built by that workflow from this repository.

## License

By contributing you agree that your contribution is licensed under the MIT
licence, the same as the rest of the project. See [LICENSE](LICENSE).
