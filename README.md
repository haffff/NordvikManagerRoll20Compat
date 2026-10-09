# Roll20 Compatibility Layer for NordvikManager

Play NordvikManager games with community **Roll20 character sheets**, unmodified. Import a sheet once as the GM, and every character card created from it behaves like it does on Roll20: fields, repeating sections, sheet-worker calculations and roll buttons all work.

No sheets ship with this addon. You bring them, either by uploading a sheet's files or by picking one from [Roll20's public sheet repository](https://github.com/Roll20/roll20-character-sheets) on GitHub.

Addon key: `roll20compat`

## Installing

The addon is listed in the NordvikManager addon registry as **Roll20 Compatibility Layer**. Install and enable it from the addons screen in your game.

## Importing a sheet

1. As the GM, open **Addons → Roll20 Compat Tools → Import Roll20 Sheet**.
2. Choose where the sheet comes from:
   - **Upload files**: the sheet's HTML (required), plus its CSS and `translation.json` if it has them.
   - **Browse GitHub**: pick a sheet from Roll20's public repository, and its files are fetched for you.
3. Give it a **Display Name** (e.g. *Blades in the Dark*) and a **Key**, which can use letters, numbers, `_` and `-` (e.g. `bladesinthedark`).
4. Click **Import Sheet**.

The sheet becomes a new **Template**, owned by the GM, and you create character cards from it like any other template. Improvements to this addon's runtime reach already-imported sheets automatically. There's no need to import them again.

## What works

- Every `attr_*` field is stored as a property on the card, and changes sync to everyone viewing it.
- Repeating sections (`repeating_*`) let you add and edit rows. Like Roll20, a row's delete button shows after you click **Modify** under the section; click **Done** to finish.
- Sheet workers (`on("change:…")`, `getAttrs`, `setAttrs`, `getSectionIDs`, …) run the sheet's own calculations.
- Roll buttons and `?{…}` roll queries go to the game's dice and chat. With the platform's roll API, results are posted using the sheet's own `<rolltemplate>`.
- A sheet's own `translation.json` fills its labels.

## Known limitations

- **Roll20-only services don't exist here.** These are:
  - the Compendium: compendium-driven auto-fill, like Warhammer 4e's species skills, doesn't happen, but the rest of the sheet works
  - API scripts such as TokenMod
  - `%{…}` ability calls
  - live lookups against Roll20's i18n service
- **Some parts of roll messages aren't supported:**
  - whisper prefixes (`/w gm …`): the roll is posted publicly
  - `[label](~ability)` reroll links: shown, but inert
  - `@{field}` inside a repeating row's button, when it means *that row's* field
- **Dice modifiers are translated to NordvikManager's dice engine.**
  - `cs`/`cf` critical ranges highlight crits and fumbles but don't change the total.
  - Target numbers (`5d6>4`) become success counting.
  - `k`/`d` become `kh`/`dl`.
  - Rerolls (`r`, `ro`), failure counting (`f`) and sorting are passed through unchanged.
- **Roll20's Pictos icon font isn't available** (it's commercial). Its common icons are shown as similar Unicode symbols instead (check mark, plus, gear, info, pencil, …); less common ones show as the plain letter the sheet wrote. Icons a sheet draws through CSS (`::before`/`::after`) aren't reached that way; a per-sheet CSS patch can swap those, `patches/bladesinthedark.css` is an example.
- **Sheets imported before roll templates were stored** use Roll20's default template until you re-import them.

---

## Development

### How it works

A Roll20 sheet is HTML and CSS, plus an optional sheet-worker script written against Roll20's host API. This addon provides that host API inside a sandboxed card:

- A small plain-JS runtime binds `attr_*` fields and repeating sections to card properties.
- It runs the sheet's worker script against a shim of Roll20's API.
- It routes roll buttons to the platform's dice and chat.

The importer transforms a sheet once (`tools/sheetTransform.mjs`). Each Template's render shell then inlines the *current* runtime whenever a card opens, which is why runtime fixes reach existing sheets.

### Structure

```
addon_files/                         # the addon as installed (manifest, Actions, Views, Templates, Resources)
  info.json
  Actions/                           # install, create_menus, open_roll20_importer,
                                     # create_imported_template, fetch_github_tree/file
  Views/roll20_importer_view.json    # "Roll20 Sheet Importer"
  Templates/roll20sheet_template.json  # render shell every imported Template is cloned from
  Resources/                         # the two cards' HTML shells (built JS/CSS is added by pack)
card_sources/
  roll20compat-shared/               # not built on its own; imported by the cards and scripts
    runtime/                         # plain <script> runtime loaded into every sheet (window.Roll20Compat):
      propertyStore.js               #   local copy of the card's properties: batched Init/Set, Get answered locally
      attrBinding.js                 #   attr_* fields <-> card properties
      repeatingBinding.js            #   fieldset.repeating_* sections <-> list properties
      sheetWorkerShim.js             #   Roll20 worker API (on/getAttrs/setAttrs/getSectionIDs/...)
      rollDispatch.js                #   Roll20 formula -> platform /roll command, result correlation
      rollButtons.js                 #   type="roll"/type="action" buttons, ?{...} query dialog
      translationFill.js             #   data-i18n fill from a sheet's own translation.json
      pictosFallback.js              #   Pictos icon-font glyphs -> Unicode symbols
      bootstrap.js                   #   entry point wiring the above together
      roll20-base.css                #   the layout primitives Roll20's platform CSS normally supplies
    tools/rollTemplateEngine.mjs     # roll messages -> one server batch of inline rolls -> the sheet's <rolltemplate> in chat
    tools/sheetTransform.mjs         # pure HTML/CSS transforms (worker split, class prefixing, rolltemplate
                                     # + local <link> stripping, .ui-dialog/.charsheet wrapping, translation config)
    components/rollQuery.js          # ?{...} roll-query parsing and resolution
    components/rollTemplateParser.js # <rolltemplate> rendering logic
    dice/roll20FormulaTranslator.js  # Roll20 dice syntax -> platform dice syntax
    patches/<key>.css                # per-sheet CSS fixes, applied by the key the GM gives on import
  roll20compat-importer/             # the Roll20 Sheet Importer view (React)
  roll20compat-sheetrenderer/        # render shell cloned into every imported Template
scripts/
  pack-cards.mjs                     # builds every card, collects JS+CSS into packed/Resources, zips
  smoke.mjs                          # plain-Node checks for all pure logic
sandbox/                             # Playwright harness that imports + renders sheets without the real app
```

### Building

```bash
pnpm install
pnpm run pack
```

The result is `packed/` and `packed.zip`.

- **Card build requirements:** every card under `card_sources/` (except `roll20compat-shared`) needs its own `package.json`, with a `build` script that produces a single-chunk Vite bundle in `dist/assets/`. That means no `manualChunks` and no dynamic imports, because the packer only picks up the first `.js` and first `.css` file per card.
- **If `pnpm install` fails:** delete that card's `node_modules` and run it again. This happens inside a card after a pnpm upgrade or after moving the repo (`ERR_PNPM_PACKAGE_MANAGER_REMOVE_MODULES_DIR`, or pnpm refusing to purge `node_modules` without a TTY).

### Testing

```bash
pnpm run smoke               # pure logic: transforms, formula translation, query parsing, worker shim parsing
pnpm run sandbox:check       # imports + renders 12 reference sheets (or: sandbox:check <key|corpus folder> ...)
                             # — console errors, authored defaults, dead CSS selectors, screenshots in sandbox/output/
pnpm run sandbox:importer    # importer view end to end: upload + GitHub-browse -> Template -> render shell
pnpm run sandbox:rollquery   # ?{...} roll-query dialog: answer, cancel, Enter
pnpm run sandbox:interact    # page switching, sheet-script calculations, repeating rows (incl. Modify mode
                             # and grid layout), and a cap on CardAPI calls per sheet open (performance guard)
pnpm run sandbox:pictos      # Pictos icon glyphs shown as Unicode symbols, also in rows added later
pnpm run sandbox:inspect <key> "<JS expression>"        # ad-hoc query against a rendered sheet
pnpm run sandbox:compare <key> <savedRoll20Popout.html> # structural diff vs a real saved Roll20 page
```

Every `sandbox:*` check uses the built cards, so run `pnpm run pack` after any change.

**Where the sheets come from:** `sandbox:check`, `sandbox:rollquery`, `sandbox:inspect` and `sandbox:compare` read sheets from a local clone of [roll20-character-sheets](https://github.com/Roll20/roll20-character-sheets).
- Set `ROLL20_SHEETS_DIR` to point at it. The default suits the NordvikManager workspace layout: `../../../roll20-analysis/roll20-character-sheets-master/roll20-character-sheets-master`, relative to this repo.
- Each sheet goes through the importer's own `transformUpload()` and the built render shell (`sandbox/importedSheet.mjs`), the same path a real import takes.
- The 12 default sheets are listed in `DEFAULT_SHEETS` there.

**The fake CardAPI:** `sandbox/fakeCardApi.mjs` counts every call in `window.__apiCounts`. In the real app each call is a round trip to the host, and a lookup of a missing property always hits the server, so watch these counts when you change the runtime.

**The iframe sandbox:** all sandbox checks load the card in an `<iframe sandbox="allow-scripts">` (`sandbox/cardSandboxFrame.mjs`), with the same flags the real `CardPanel.js` uses. Because there's no `allow-forms` or `allow-modals`, the sandbox silently blocks `<form>` submission and `prompt`/`alert`/`confirm`. **Don't use any of them in card or runtime code.**

**When `sandbox:check` fails:** it exits non-zero on any console error or missing authored default, but not every hit is a bug.
- A sheet's worker can legitimately rewrite a field on load (e.g. Cyberpunk Red's `version` migration).
- Some sheets have malformed defaults in their own HTML.
- Dead selectors are often CSS for modes or tabs that aren't currently shown.

### Implementation notes

- **Worker scripts:** multiple worker `<script>` blocks are joined into one. If that fails to parse (e.g. 13th Age redeclares a `const` in each block), each block gets its own `{ }` scope. A block that is broken on its own is skipped with a `console.error`.
- **Fire-and-forget writes:** `CardAPI`'s `Properties.Init`/`Properties.Add` are fire-and-forget over WebRTC, so awaiting them only waits for the send. `repeatingBinding.js` retries briefly to cover the gap between creating a list property and its first use.

## License

MIT, see [LICENSE](LICENSE).
