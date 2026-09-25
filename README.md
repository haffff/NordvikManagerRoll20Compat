# NordvikManagerRoll20Compat

A NordvikManager addon (same shape as [`dnd5e`](https://github.com/haffff/NordvikManager-DND), source-repo name `NordvikManagerCards`) that runs community Roll20 character sheets as NordvikManager cards, unmodified. Addon key: `roll20compat`.

A Roll20 sheet is HTML + CSS + an optional sheet-worker script written against Roll20's host API (`on`, `getAttrs`, `setAttrs`, repeating sections, roll buttons). This addon gives it that host API inside a card: a small plain-JS runtime binds `attr_*` fields and repeating sections to card properties, runs the sheet's own worker script against a shim of Roll20's API, and routes roll buttons to the platform's dice/chat.

No sheets ship with the addon. The GM opens **Addons → Roll20 Compat Tools → Import Roll20 Sheet**, uploads a sheet's files (or picks one from [Roll20's public sheet repo](https://github.com/Roll20/roll20-character-sheets) on GitHub), and it becomes a new Template, owned by the GM, that character cards are created from. The importer transforms the sheet once (`card_sources/roll20compat-shared/tools/sheetTransform.mjs`); the Template's render shell inlines the current shared runtime every time a card opens, so runtime fixes reach already-imported sheets without re-importing.

## Structure

```
addon_files/                         # the addon as installed (manifest, Actions, Views, Templates, Resources)
  info.json
  Actions/                           # install, create_menus, open_roll20_importer,
                                     # create_imported_template, fetch_github_tree/file
  Views/roll20_importer_view.json    # "Roll20 Sheet Importer"
  Templates/roll20sheet_template.json  # render shell every imported Template is cloned from
  Resources/                         # the two cards' HTML shells (built JS/CSS is added by pack)
card_sources/
  roll20compat-shared/               # not built standalone — imported by the cards and scripts
    runtime/                         # plain <script> runtime loaded into every sheet (window.Roll20Compat):
      propertyStore.js               #   local copy of the card's properties: batched Init/Set, Get answered locally
      attrBinding.js                 #   attr_* fields <-> card properties
      repeatingBinding.js            #   fieldset.repeating_* sections <-> list properties
      sheetWorkerShim.js             #   Roll20 worker API (on/getAttrs/setAttrs/getSectionIDs/...)
      rollDispatch.js                #   Roll20 formula -> platform /roll command, result correlation
      rollButtons.js                 #   type="roll"/type="action" buttons, ?{...} query dialog
      translationFill.js             #   data-i18n fill from a sheet's own translation.json
      bootstrap.js                   #   entry point wiring the above together
      roll20-base.css                #   the layout primitives Roll20's platform CSS normally supplies
    tools/rollTemplateEngine.mjs     # roll messages -> one server batch of inline rolls -> the sheet's <rolltemplate> in chat
    tools/sheetTransform.mjs         # pure HTML/CSS transforms (worker split, class prefixing, rolltemplate
                                     # + local <link> stripping, .ui-dialog/.charsheet wrapping, translation config)
    patches/<key>.css                # per-sheet CSS fixes, applied by the key the GM gives on import
                                     # (e.g. bladesinthedark.css: Blades' Pictos icon glyphs)
    components/, hooks/, dice/, translation/   # React helpers for hand-ported cards (RollTemplate,
                                               # RollQueryModal, usePropertyListV2, formula translator)
  roll20compat-importer/             # the Roll20 Sheet Importer view (React)
  roll20compat-sheetrenderer/        # render shell cloned into every imported Template
scripts/
  pack-cards.mjs                     # builds every card, collects JS+CSS into packed/Resources, zips
  smoke.mjs                          # plain-Node checks for all pure logic
sandbox/                             # Playwright harness that imports + renders sheets without the real app
```

## Building

```bash
pnpm install
pnpm run pack
```

Every card under `card_sources/` (except `roll20compat-shared`) needs its own `package.json` with a `build` script producing a single-chunk Vite bundle in `dist/assets/` — no `manualChunks`, no dynamic imports. The packer only picks up the first `.js` and first `.css` file it finds per card.

If `pnpm install` inside a card fails with `ERR_PNPM_PACKAGE_MANAGER_REMOVE_MODULES_DIR` / "access denied" after a pnpm upgrade, delete that card's `node_modules` by hand and rerun the pack.

## Testing

```bash
pnpm run smoke               # pure logic: transforms, formula translation, query parsing, worker shim parsing
pnpm run sandbox:check       # imports + renders 12 reference sheets (or: sandbox:check <key|corpus folder> ...)
                             # — console errors, authored defaults, dead CSS selectors, screenshots in sandbox/output/
pnpm run sandbox:importer    # importer view end to end: upload + GitHub-browse -> Template -> render shell
pnpm run sandbox:rollquery   # ?{...} roll-query dialog: answer, cancel, Enter
pnpm run sandbox:interact    # page switching, sheet-script calculations, repeating rows, and a cap on
                             # CardAPI calls per sheet open (performance guard)
pnpm run sandbox:inspect <key> "<JS expression>"        # ad-hoc query against a rendered sheet
pnpm run sandbox:compare <key> <savedRoll20Popout.html> # structural diff vs a real saved Roll20 page
```

The fake CardAPI (`sandbox/fakeCardApi.mjs`) counts every call in `window.__apiCounts` — in the real app each is a round trip to the host, and a lookup of a missing property is always a server request, so watch these when touching the runtime.

Every `sandbox:*` check uses the built cards, so run `pnpm run pack` first after any change.

`sandbox:check`, `sandbox:rollquery`, `sandbox:inspect` and `sandbox:compare` take sheets from a local clone of [roll20-character-sheets](https://github.com/Roll20/roll20-character-sheets): set `ROLL20_SHEETS_DIR` to it (default: `../../roll20-analysis/roll20-character-sheets-master/roll20-character-sheets-master` relative to this repo). Each sheet goes through the importer's own `transformUpload()` and the built render shell (`sandbox/importedSheet.mjs`), the same path as a real import. The 12 default sheets and their corpus folders are listed in `DEFAULT_SHEETS` there.

All sandbox checks load the card inside an `<iframe sandbox="allow-scripts">` (`sandbox/cardSandboxFrame.mjs`), the same flags the real `CardPanel.js` uses. That matters: the sandbox silently blocks `<form>` submission (no `allow-forms`) and `prompt`/`alert`/`confirm` (no `allow-modals`), and a check run on a top-level page won't notice. **Don't use either in card or runtime code.**

`sandbox:check` exits non-zero on any console error or missing authored default, but not every hit is a bug: a sheet's worker can legitimately rewrite a field on load (e.g. Cyberpunk Red's `version` migration), and dead selectors are often CSS for modes/tabs not currently shown.

## Known limitations

- **Roll templates and several inline rolls need the platform's roll API** (`CardAPI.Rolls`, backend `RollsController`). With it, a roll button or a sheet script's `startRoll`/`finishRoll` rolls every `[[...]]` of the message in one server call and posts the sheet's own `<rolltemplate>` rendered in chat (`tools/rollTemplateEngine.mjs`); without it, rolls fall back to one formula through `/roll`. Sheets imported before templates were kept have none stored — re-import them, or their rolls use Roll20's default template.
- **Roll20 dice modifiers are translated for the platform's dice engine:** `cs`/`cf` critical ranges (e.g. `1d100cs<5cf>96`) drive crit/fumble highlighting and `rollWasCrit`/`rollWasFumble` but don't change the total; `5d6>4` target numbers become the platform's success counting (`cs>3`); `4d6k3`/`4d6d1` become `kh3`/`dl1`. Rerolls (`r`, `ro`), failure counting (`f`) and sorting are passed through as-is.
- **Roll20's Compendium API** (`getCompendiumPage`/`getCompendiumQuery`, 22 corpus sheets) never answers — no compendium exists — so compendium-driven auto-fill (e.g. Warhammer 4e's species skills/talents) doesn't happen; the rest of the sheet works.
- **Not supported in roll messages:** whisper prefixes (`/w gm ...` — the roll is posted publicly), `[label](~ability)` reroll links (shown, but inert), `%{...}` ability calls, and `@{field}` inside a repeating row's button meaning *that row's* field.
- **`%{...}` ability calls, Compendium drops, and API scripts (TokenMod etc.) aren't supported.** A sheet's own `translation.json` works; live `getTranslationByKey()` lookups against Roll20's i18n service don't.
- **Multiple worker `<script>` blocks** are joined into one script; if that doesn't parse (e.g. 13th Age's `const` redeclared per block), each block gets its own `{ }` scope, and a block that is itself broken is skipped with a `console.error`.
- **Roll20's Pictos icon font isn't available** (it's commercial), so icons sheets draw with it show as their plain letters (`y`, `t`, `&`, ...). A per-sheet CSS patch can swap them for Unicode symbols (see `patches/bladesinthedark.css`).
- `CardAPI.js`'s `Properties.Init`/`Properties.Add` are fire-and-forget over WebRTC, so awaiting them only waits for the send. There's a narrow, never-observed race between creating a new list property and its first read (see `usePropertyListV2.js`).
