<!-- Source: https://nordvikmanager.pl/ai/AGENTS.md. Refresh this file from there when the platform changes. -->

# Building NordvikManager addons: guide for AI assistants

You are helping someone build an addon for **NordvikManager**, a web app for tabletop RPGs (a GM's server, players in the browser). Addons add **cards** (sheets, notes, tools), **actions** (server-side automation) and **themes**. Follow this file; when it doesn't answer something, read the linked page. **Never guess an API name, step, hook or field. If it isn't here or in the docs, it doesn't exist.**

Full docs: https://nordvikmanager.pl/addon-guide/
Starter template (copy it): https://github.com/haffff/NordvikManager-Addons/tree/main/template

## 1. What an addon is

An addon is a zip of the `addon_files/` folder:

```
addon_files/
  info.json      key, name, version            schema: addon.json
  Templates/     one JSON per card template    schema: card.json
  Views/         one JSON per view             schema: card.json
  Actions/       one JSON per action           schema: action.json
  Resources/     pages, built JS/CSS, token files, data; installed as "<key>_<file name>"
```

Source code lives outside `addon_files/` (e.g. `card_sources/<card>/`, a Vite project per card). `pnpm run pack` builds the cards, copies each bundle into `Resources/` and zips everything into `packed.zip`.

Kinds of addons: **cards** (templates/views + actions), **actions only** (automation), **themes** (one stylesheet, turned on by an install action).

## 2. Fixed rules

- **`key`** in `info.json`: lowercase letters and digits only (`^[a-z0-9]+$`). It prefixes every resource (`myaddon_index.html`) and action (`myaddon/roll_check`). **Never change it after a release.**
- **Resource names:** a file `Resources/x.js` is the resource `<key>_x.js`. Templates, views and actions refer to it by that name.
- **Action names:** called as `<key>/<name>`. An action file's `prefix` is replaced with the key on install.
- **`version`** in `info.json`: `MAJOR.MINOR.PATCH`. **Raise it with every release**, or games won't see the update.
- **`$schema` first in every JSON file**, so editors and you can check it:
  - `info.json`: `https://raw.githubusercontent.com/haffff/NordvikManager-Addons/refs/heads/main/schemas/addon.json`
  - Templates and views: `.../schemas/card.json`
  - Actions: `.../schemas/action.json`
  - Token files: `.../schemas/token.json`
  The schemas reject unknown fields. Fix the field; don't remove `$schema`.
- **Property values are strings.** In JSON write `"value": "10"`, never `10`. A number fails the install.
- Enums are numbers: permissions are flags (`None=0, Read=1, Execute=2, Control=4, Edit=8, Remove=16, All=31`), hooks are numbers (section 5).

## 3. Cards

Docs: https://nordvikmanager.pl/addon-guide/cards/overview, https://nordvikmanager.pl/addon-guide/cards/building-a-card

- A **template** is the blueprint (page + scripts + default `properties`); each **card** made from it copies the properties and keeps its own values. A **view** is a single page (settings, wizard), opened by the **ShowView** step.
- The page runs in a **sandboxed iframe** with a null origin. It reaches the app only through `window.CardAPI`.
- How the page is put together: `mainResource` (HTML) → every `.css` from `additionalResources` into `<head>` → the Card API script → every `.js` from `additionalResources` at the end of `<body>` → `cardapi:ready` fires.
- **Scripts are added as classic `<script>` tags, not modules.** Build each card to **one self-contained file**: Vite with `build.rollupOptions.output.format: 'iife'`, `build.modulePreload: false`, `build.cssCodeSplit: false`. No code splitting, no dynamic `import()` and no top-level `await` in production code.
- Only `.css` and `.js` resources are added to the page. Read images, fonts, JSON with `CardAPI.Resources.Global.Read('<key>_<file>')` (a `blob:` URL for images, `JSON.parse` for JSON), or embed small ones as `data:` URLs.
- **Start from `cardapi:ready`.** `CardAPI.cardId` is `null` until then:
  ```js
  if (window.CardAPI?.cardId) start(window.CardAPI);
  else window.addEventListener('cardapi:ready', (e) => start(e.detail), { once: true });
  ```
- **All state lives in properties.** The page can reload at any time (moving a panel does it) and `cardapi:ready` fires again. Anything only in memory is lost.
- **Your own `Set` comes back** through `Subscribe`. Render from the property; ignore the echo while the user is typing.
- `Set` with an unchanged value does nothing. Create defaults with `Init` (only creates missing properties).
- The app's look: template property `app_styles` = `"true"` gives `--nordvik-*` colour variables (`--nordvik-surface`, `--nordvik-text-color`, `--nordvik-font`, ...) and the GM's theme. Always use a fallback: `var(--nordvik-surface, #1e1e1e)`. Don't remove the `nm-app-base` / `nm-app-theme` elements in `<head>`.
- Special properties: `token` (token file for the map, e.g. `"myaddon_token_character.json"`), `app_styles`, `additionalArguments` (value handed to the page; a view opened with ShowView `Data` gets that instead).
- Pages are small and resizable; make them work at narrow widths.

## 4. Card API cheat sheet

Docs: https://nordvikmanager.pl/addon-guide/cards/card-api. Every call that returns something returns a **Promise**.

| Group | Members |
|---|---|
| Identity | `cardId`, `additionalArguments` |
| `Properties` (this card) | `Get(name)` → `{ id, name, value, parentId }` or null, `GetMany(names)`, `GetProperties()`, `Set(name, value)`, `SetMany([{name, value}])`, `Init(name, value)`, `InitMany(...)`, `Remove(name)`, `Subscribe(name, cb)`, `Unsubscribe(name, cb)`; `cb(property)` or `cb(null)` on removal |
| `Properties.List` | Rows `{ id, fields }` in one property's JSON value: `Add(name, fields, itemId?)`, `Update(name, itemId, fields)`, `Remove(name, itemId)`, `Reorder(name, ids)`. `Init(name, "[]")` first. |
| `Properties.Global` | Same methods with `parentId` first (game, map, element, other card). The server checks Read/Edit. |
| `Resources` / `Resources.Global` | `Create(key, data, name?, mimeType?)` → id (rejects an existing key), `Read(key)` → string (text/JSON), Blob or null, `Update`, `Delete`, `Upsert`. Card keys are scoped to the card; Global keys aren't. |
| `ClientMediator.sendCommandAsync(panel, command, data)` | **Only:** `Game.GetGameId`, `Game.GetIsGM` (owner or co-GM with Edit on the game; `Game.GetCanEditGame` is the same), `Game.GetPlayers`, `Game.GetCurrentPlayer`, `BattleMap.GetSelectedMap`, `TurnOrder.GetState`, `Chat.SendMessage`, and `addon_*` panels. Anything else rejects. |
| `ClientMediator.register(name, handlers)` | Name must start with `addon_`; resolves to `addon_<cardId>_<rest>`. Callable by actions (RunClientCommand) and other cards. `unregister(name)`. |
| Chat and actions | `SendChatMessage(text)` (a leading `/` runs a chat command, e.g. `/r 1d20+5`), `FireAction('<key>/<name>', args)` (the action also gets `cardId`), `SendCustomCommandToServer` (only `chat_push`, `execute_action`; prefer the two above) |
| `Rolls` | `Start([{ key, formula }])` → `{ rollId, results: [{ key, roll: { result, dices } }] }` (server rolls, posts nothing); `Finish({ rollId, html, title?, cssResourceKey? })` posts one chat message; elements with `data-roll-key="<key>"` show that roll. Up to 50 formulas, html ≤ 64 KB. |
| Events | `SubscribeWebSocket(cb)` / `UnsubscribeWebSocket(cb)`: `cb({ command, data })` for `chat_`, `turnorder_`, `action_`, `property_`, `custom_` events |
| `Close()` | Closes the card's panel |

Errors: refused calls reject with an `Error` that says why. Calls time out after 30 s (Resources: 5 min).

**Develop without the app** with the template's `ApiMock.js` (`createApiMock({ properties, globals, isGM, actions })`): same members and rules as `CardAPI`. When the card starts using a new API member, check that the mock has it.

## 5. Actions

Docs: https://nordvikmanager.pl/addon-guide/actions/overview, step reference: https://nordvikmanager.pl/addon-guide/actions/steps

Actions run on the GM's server, so they're the place for anything authoritative: rolls, changing other entities, creating cards, calling web APIs.

```json
{
  "$schema": "https://raw.githubusercontent.com/haffff/NordvikManager-Addons/refs/heads/main/schemas/action.json",
  "name": "roll_check",
  "hook": 0,
  "gmPermission": 31,
  "content": [
    { "Type": "GetPropertyValue", "Data": { "ParentId": "%cardId%", "PropertyName": "name", "Output": "cardName", "DefaultValue": "Someone" } },
    { "Type": "RollDice", "Data": { "DiceString": "1d20", "PrintToChat": true, "ChatTitle": "%cardName%: check" } }
  ]
}
```

- Steps: `{ "Type": "<step>", "Data": { ... } }`, exact casing. Existing step types: AddElement, AddMapTool, AddMenuItem, AddPropertyListItem, AddToolbarButton, AddToTurnOrder, ChangeMap, CreateCard, Delay, DeleteCard, DeleteElement, DeleteProperty, DeleteResource, ExecuteAction, Exit, Find, FireClientMediator, ForEach, GetConnectedPlayers, GetPropertyValue, GetTurnOrder, If, Log, MoveElement, NextTurn, PausePlaylist, PlayPlaylist, PlaySound, PreviousTurn, ReadResource, RemoveFromTurnOrder, RemovePropertyListItem, RequestTargets, RequestUserInput, RequirePermission, ResetTurnOrder, RollDice, RunClientCommand, RunScript, SendChat, SendRequest, SetInitiative, SetProperties, SetProperty, SetResource, SetVariable, ShowMarker, ShowView, SortTurnOrder, SpawnToken, StopPlaylist, StopSound, UpdatePropertyListItem, UpdateResource. Look up each step's `Data` fields in the step reference; don't invent them. GetData, GetDetail, SetDetail, Calculate, FilterCollection, QueryData, QueryProperties and SendCommand no longer exist.
- Blocks: **If** `{ Condition, Then: [steps], Else: [steps] }` and **ForEach** `{ Collection, ItemName, Do: [steps] }` hold their steps inline. Blocks share the action's variables (what they set is there after them); **Exit** in a block stops the action. **ExecuteAction** runs another action on a *copy* of the variables: use it only for actions several others share.
- Finding things: **Find** `{ What: tokens|elements|cards|maps|battleMaps|players|actions|layouts, Id, Name, Property, MapId, AllMaps, WithCard, Near, Radius, IncludeTemplates, First, Output }`. Tokens are `[{ id, name, x, y (centre, px), w, h, cardId, mapId }]`; cards `[{ id, name, key, isTemplate, isHidden }]`. `Near` is a point (`%position%`) or a token id, `Radius` in squares. An empty `MapId` means the map the player is looking at.
- Properties: GetPropertyValue/SetProperty/SetProperties/DeleteProperty and the list-item steps take `Of`: empty (the entity in `ParentId`), `tokenCard` (the card of the token in `ParentId`, where a token's stats live), `map`, `game`.
- Asking players: **RequestTargets** `{ Player, Message, Min, Max, Candidates, Timeout, StopIfCancelled, Output }` lets a player click tokens on the map (output like Find tokens). **RequestUserInput** takes `Options` (one per line, shown as buttons). Both stop the action when cancelled unless `StopIfCancelled` is false.
- Map from the server (no browser needed): **SpawnToken** `{ CardId | Token + Image, X, Y (top-left), MapId, Output }`, **AddElement** (saved shape) and **ShowMarker** (temporary, `Duration` s or `UntilActionEnds`): `{ Shape: circle|rect|text, X, Y (centre), Radius/Width/Height (squares), Color, Text, MapId, Output }`.
- Menus and tools (AddMenuItem, AddToolbarButton, AddMapTool): `OnlyTriggeringPlayer` (just the player who triggered the action, e.g. from Player Load) and `GmOnly`. GmOnly only hides the entry: guard GM actions with **RequirePermission** (Edit on `%gameId%`).
- Variables: a step's `Output` stores a result; later steps read it with tokens. Built-ins: `gameId`, `gmId`, `actionId`, `actionName`, `actionPrefix`, `playerId`, `playerName`, `playerColor`, `playerIsOwner`, `playerIsGm`, `battleMapId`/`mapId` (the player's current battle map, when run from their screen), plus hook variables and the caller's arguments (built-ins always win). Right-click and map-tool actions get `position` (`{x, y}`), `elementId`, `elementIds`.
- Tokens, two forms only: `%name%` / `%name.path[0].x%` (a variable or a value inside it; lists and objects come out as JSON; text holding JSON is read as JSON), and `%q:type[name].prop%` (a property of the entity with that name; type: card, map, player, game, action, resource; e.g. `%q:card[Goblin].hp%`, `%q:resource[myaddon_x.css].id%`), `%q:{var}.prop%` / `%q:{var.field}.prop%` / `%q:<guid>.prop%` (by id). `.id` / `.name` give the entity's own; only cards, maps, elements and the game have other properties. Write names exactly; a miss gives empty text. All tokens are filled in in one pass: a value is never read as tokens again. There is no `%v:` or `%dto:`.
- For calculations, use one **RunScript** step (JavaScript, `vars` in, return an object out; 5 s, 200 `game` calls, 16 MB, no network or files, no `eval`), not long chains of steps. Scripts can act through `game`: `find(what, options)`, `getProperty(id, name, fallback)`, `setProperty(id, name, value)`, `roll(formula)`, `chat(text, { title, to })`, `log`, `moveElement`, `deleteElement`, `spawnToken`, `showMarker`, `addElement`, `createCard`, `step(type, data)`; they run as the system and can't ask players. `Include` puts shared JS resources (keys) before the script.
- Errors stop the action and go to the game's event log with the step. Use **Log** to inspect values.
- In addon files, `isEnabled` is ignored (addon actions are always enabled) and `prefix` is replaced by the key.

Hooks (`hook` number): 0 none (called by name), 1 Install, 2 Uninstall, 3 Player Join, 4 Player Leave, 5 Player Load, 6 Element Added, 7 Element Updated, 8 Element Moved, 9 Element Removed, 10 Property Added, 11 Property Updated, 12 Property Removed, 13 Map Added, 14 Map Updated, 15 Map Removed, 16 Map Changed, 17 Game Updated, 18 Chat Message, 19 Chat Command, 20 Card Added, 21 Card Updated, 22 Card Deleted, 23 Turn Changed. Docs: https://nordvikmanager.pl/addon-guide/actions/hooks

## 6. Themes

One stylesheet resource plus an install action (hook 1) that adds its id to the game's `customStylesheets` (find it with `%q:resource[<key>_theme.css].id%`, keep existing entries). Embed fonts and textures as `data:` URIs: the app strips `url()` pointing outside the game. Cards are sandboxed and keep their own look. Example: https://github.com/haffff/NordvikManager-Themes

## 7. Development loop

1. Copy the template; set `key`, `name`, `author`, `repositoryUrl` in `info.json`, and rename `myaddon` everywhere (resource names, action names, the card folder).
2. `pnpm install` in the root; then `pnpm install` and `pnpm dev` in `card_sources/<card>/`: the card runs with `ApiMock.js` in a normal browser tab.
3. `pnpm test` in the root (the mock's tests; add your own for logic).
4. `pnpm run pack` → `packed.zip`.
5. In the game: *Addons → Addons → Install*, pick `packed.zip`. To install a new build of the same version, uninstall first (*Installed* tab).
6. Check the browser console: a blocked request names the host or the rule (Content-Security-Policy).
7. Release: raise `version`, merge, run the repository's **Release** workflow. The first release is added to the registry by a pull request to https://github.com/haffff/NordvikManager-Addons (`addons.json`); later releases are picked up automatically. Docs: https://nordvikmanager.pl/addon-guide/cards/packaging

## 8. Don't

| Don't | Do instead |
|---|---|
| Use `localStorage`, `sessionStorage`, IndexedDB or cookies in a card | Properties (small values) or Resources (files) |
| Use `alert`, `confirm`, `prompt`, `window.open`, `target="_blank"`, form posts, downloads | Your own dialog in the page; show links or text for copying; store a resource |
| Load scripts from a CDN (`<script src="https://...">`) | Bundle them into the card's single JS file |
| `fetch` arbitrary hosts from a card | Only the GM's server and the hosts the GM allowed (by default GitHub raw/API and Google Fonts). Otherwise a **SendRequest** step in an action |
| Touch `window.parent`, `window.top` or `postMessage` the app | `CardAPI` only |
| Call mediator panels that aren't in the list, or `Properties`/`Resources`/`Rolls` through the mediator | The `CardAPI` groups; actions for everything else |
| Send `custom_*` or other server commands | `SendChatMessage`, `FireAction` |
| Roll dice or decide results in card code (`Math.random()` for game results) | `Rolls.Start`/`Finish`, or an action with **RollDice** |
| Trust the card for permissions or hide data in it | The server checks every call; GM-only data goes in protected properties or GM-only entities |
| Put API keys, tokens or secrets in addon files or properties | Nothing in an addon is secret; players can read what they can open |
| Store numbers or objects as property values | Strings; `JSON.stringify` / `JSON.parse` |
| Use ES modules, code splitting or top-level `await` in the built card | One IIFE bundle (see section 3) |
| Rename `key`, or release without raising `version` | Keep the key forever; raise the version every release |
| Commit `packed/`, `packed.zip`, `dist/`, `node_modules/` | `.gitignore` them; the Release workflow builds the zip |
| Use a GitHub "Source code" zip as `releaseUrl` | The release asset: `https://github.com/<you>/<repo>/releases/download/<tag>/<file>.zip` |
| Invent CardAPI methods, step types, step fields, hooks or JSON fields | This file, the docs and the schemas; ask the user if something is missing |
| Change the platform (app or server) to make an addon work | Solve it inside the addon: actions, views, cards, RunScript. Suggest a platform change to the user only when there's no addon-level way |
