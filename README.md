# NordvikManagerRoll20Compat

A NordvikManager addon (same shape as [`dnd5e`](https://github.com/haffff/NordvikManager-DND), source-repo name `NordvikManagerCards`) that ports community Roll20 character sheets as addon cards. Addon key: `roll20compat`.

See the approved plan (`misty-twirling-hejlsberg`) for the full design. This repo currently holds deliverable #3 (repo scaffolding) — no cards have been ported yet.

## Structure

```
addon_files/{Actions,Templates,Views,Resources}/, info.json   # addon manifest, mirrors dnd5e's shape
card_sources/
  roll20compat-shared/     # (not yet added) shared runtime library — deliverable #4
  roll20compat-bitd/       # (not yet added) Blades in the Dark — first porting candidate, deliverable #6
  roll20compat-fate/       # (not yet added) Fate Core — second porting candidate, deliverable #6
scripts/pack-cards.mjs     # globs card_sources/*, builds each, collects JS+CSS into packed/Resources, zips
data/
```

## Building

```bash
pnpm install
pnpm run pack
```

Every card under `card_sources/` (except `roll20compat-shared`, which is relative-imported rather than built standalone) needs its own `package.json` with a `build` script producing a single-chunk Vite bundle in `dist/assets/` — no `manualChunks`, no dynamic imports. The packer only picks up the first `.js` and first `.css` file it finds per card.

## Non-goals

No Compendium integration, no live Roll20 i18n service, no API-script (TokenMod etc.) bridge. A ported sheet's own bundled `translation.json` is fine (static JSON); a live `getTranslationByKey()` call is not.
