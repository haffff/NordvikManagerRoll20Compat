# NordvikManagerRoll20Compat

A NordvikManager addon (same shape as [`dnd5e`](https://github.com/haffff/NordvikManager-DND), source-repo name `NordvikManagerCards`) that ports community Roll20 character sheets as addon cards. Addon key: `roll20compat`.

See the approved plan (`misty-twirling-hejlsberg`) for the full design. This repo currently holds deliverables #3 (repo scaffolding) and #4 (shared runtime library, source-only, no cards built on it yet).

## Structure

```
addon_files/{Actions,Templates,Views,Resources}/, info.json   # addon manifest, mirrors dnd5e's shape
card_sources/
  roll20compat-shared/     # shared runtime library — source-only, relative-imported by every card
    hooks/usePropertyListV2.js    # reactive wrapper around a list-typed property
    hooks/useFieldInput.js        # controlled, blur-committed field input (avoids the defaultValue/stale-closure trap)
    components/RepeatingSection.jsx  # generic repeating-row UI, backed by usePropertyListV2
    components/RollTemplate.jsx      # Roll20 {{key}} / {{#key}}...{{/key}} roll-result renderer
    components/rollTemplateParser.js # pure parser/renderer behind RollTemplate
    components/RollQueryModal.jsx    # client-side ?{Prompt|default} prompt
    components/rollQuery.js          # pure parse/resolve helpers behind RollQueryModal
    dice/roll20FormulaTranslator.js  # Roll20 dice-formula subset -> backend DiceEngine syntax
    translation/useTranslationBundle.js  # loads a ported sheet's bundled translation.json as a global Resource
  roll20compat-bitd/       # (not yet added) Blades in the Dark — first porting candidate, deliverable #6
  roll20compat-fate/       # (not yet added) Fate Core — second porting candidate, deliverable #6
scripts/
  pack-cards.mjs     # globs card_sources/*, builds each, collects JS+CSS into packed/Resources, zips
  smoke.mjs          # plain-Node checks for the shared library's pure logic (dice translator, roll query, roll template)
data/
```

## Building

```bash
pnpm install
pnpm run pack
```

Every card under `card_sources/` (except `roll20compat-shared`, which is relative-imported rather than built standalone) needs its own `package.json` with a `build` script producing a single-chunk Vite bundle in `dist/assets/` — no `manualChunks`, no dynamic imports. The packer only picks up the first `.js` and first `.css` file it finds per card.

## Testing the shared library

```bash
pnpm run smoke
```

Runs `scripts/smoke.mjs` — plain-Node checks (no framework, no build) against the three pure logic modules (`roll20FormulaTranslator.js`, `rollQuery.js`, `rollTemplateParser.js`), using real formulas/templates pulled from Blades in the Dark, Fate Core, and Dungeon World's actual Roll20 source. Does **not** cover the three `.jsx` components or the two hooks — there's no test runner in this repo yet, and standing one up wasn't in scope for the shared-library deliverable. Close that gap before shipping a real card on top of this.

Known caveat carried over from `usePropertyListV2.js` (see its comments): `CardAPI.js`'s `Properties.Init`/`Properties.Add` are fire-and-forget over the WebRTC channel, so `await`ing them only waits for the send, not for the server to actually create the property. There's a narrow theoretical race between a brand-new list property being created and its first read — pre-existing in the `usePropertyList` hook this supersedes, not introduced here, and hasn't been observed to matter in practice, but not something this library papers over either.

## Non-goals

No Compendium integration, no live Roll20 i18n service, no API-script (TokenMod etc.) bridge. A ported sheet's own bundled `translation.json` is fine (static JSON); a live `getTranslationByKey()` call is not.
