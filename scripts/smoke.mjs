#!/usr/bin/env node
// Plain-Node smoke tests for the pure logic modules in roll20compat-shared
// (translateFormula, rollQuery, rollTemplateParser) — no test framework, no
// build step, so this can run against source directly (`pnpm run smoke`).
// Grounded in real formulas/templates pulled from the actual Roll20 sheets
// this addon ports (Blades in the Dark, Fate Core, Dungeon World).
//
// Does NOT cover the three .jsx components or the two hooks — no test
// runner exists in this repo yet, and standing one up wasn't in scope for
// the shared-library deliverable. That's the gap to close before shipping
// a real card built on top of this library.
import { createRequire } from "node:module";
import vm from "node:vm";
import { translateFormula, Roll20FormulaError } from "../card_sources/roll20compat-shared/dice/roll20FormulaTranslator.js";
import { hasQueries, parseQueries, resolveQueries } from "../card_sources/roll20compat-shared/components/rollQuery.js";
import { renderRollTemplateHtml } from "../card_sources/roll20compat-shared/components/rollTemplateParser.js";
import { splitWorkerScript, wrapCharsheet, stripRollTemplates, stripLocalLinks, expandSelfClosingTags, scopeSheetCss, prefixSheetClasses } from "../card_sources/roll20compat-shared/tools/sheetTransform.mjs";

// runtime/*.js are plain CommonJS scripts (no ES module export — they're
// loaded as <script> tags directly inside a card's sandboxed iframe, see
// attrBinding.js's header), so they're pulled in via require() for their
// side effect of attaching to globalThis.Roll20Compat, same as they would
// attach to window.Roll20Compat in a browser.
const require = createRequire(import.meta.url);
require("../card_sources/roll20compat-shared/runtime/attrBinding.js");
require("../card_sources/roll20compat-shared/runtime/repeatingBinding.js");
require("../card_sources/roll20compat-shared/runtime/translationFill.js");
require("../card_sources/roll20compat-shared/runtime/sheetWorkerShim.js");
require("../card_sources/roll20compat-shared/runtime/rollDispatch.js");
require("../card_sources/roll20compat-shared/runtime/rollButtons.js");
// bootstrap.js has no pure logic to test (it's the DOM/CardAPI orchestration
// entry point — see its own header) — required here only to catch syntax
// errors early. It no-ops safely in Node (no window.CardAPI, no DOM).
require("../card_sources/roll20compat-shared/runtime/bootstrap.js");
const { AttrLogic } = globalThis.Roll20Compat;
const { RepeatingLogic } = globalThis.Roll20Compat;
const { SheetWorkerLogic } = globalThis.Roll20Compat;
const { RollDispatchLogic, FormulaTranslation } = globalThis.Roll20Compat;
const { RollButtonsLogic } = globalThis.Roll20Compat;

let failures = 0;
const check = (label, actual, expected) => {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    failures++;
    console.error(`FAIL ${label}\n  got:      ${a}\n  expected: ${e}`);
  } else {
    console.log(`ok   ${label}`);
  }
};

const expectThrows = (label, fn, ErrorType) => {
  try {
    const result = fn();
    failures++;
    console.error(`FAIL ${label}\n  expected throw, got: ${JSON.stringify(result)}`);
  } catch (e) {
    check(label, e instanceof ErrorType, true);
  }
};

// ── roll20FormulaTranslator ────────────────────────────────────────────────

// Fate Core's real formula: /me rolls [[4dF+8+@{RollModifiers}]] @{Leg1}
check(
  "Fate Core formula translates cleanly",
  translateFormula("[[4dF+8+@{RollModifiers}]]", { RollModifiers: "2" }),
  "4dF+8+2"
);

check("plain NdM+arith with comment stripped", translateFormula("1d20+5 [Attack Roll]", {}), "1d20+5");
check("kh/cs modifiers pass through untouched", translateFormula("4d6kh3", {}), "4d6kh3");

expectThrows(
  "missing attribute throws Roll20FormulaError",
  () => translateFormula("1d20+@{missingAttr}", {}),
  Roll20FormulaError
);

// Blades' real grouped-pool formula must be rejected, not silently mangled
expectThrows(
  "Blades pool formula rejected as unsupported",
  () =>
    translateFormula(
      "[[{[[[[{@{hunt}+2+d0}<0]]*2]]d6skl1cf<3, [[(@{hunt}+2)d1>1]]d6skh1cf<3}kh1]]",
      { hunt: "2" }
    ),
  Roll20FormulaError
);

expectThrows("unresolved ?{} query throws", () => translateFormula("?{Extra|0}d6", {}), Roll20FormulaError);

// Regression: comment-stripping used to run before the "[[" rejection check,
// so a nested inline roll like "1d20+[[2d6]]" would have its inner "[2d6]"
// silently eaten as if it were a Roll20 comment, mangling the formula to
// "1d20+[]" instead of being rejected as unsupported.
expectThrows(
  "nested inline roll rejected, not silently mangled",
  () => translateFormula("1d20+[[2d6]]", {}),
  Roll20FormulaError
);

// ── rollQuery ───────────────────────────────────────────────────────────────

check("hasQueries true", hasQueries("?{Extra|0}d6"), true);
check("hasQueries false", hasQueries("4d6kh3"), false);

const blades = parseQueries("&{template:bitd} {{position=?{Position|Risky|Controlled|Desperate}}} {{extra=?{Extra|0}}}");
check("Blades: two distinct queries found", blades.length, 2);
check("Blades: dropdown query shape", blades[0], {
  raw: "?{Position|Risky|Controlled|Desperate}",
  prompt: "Position",
  kind: "select",
  options: [
    { label: "Risky", value: "Risky" },
    { label: "Controlled", value: "Controlled" },
    { label: "Desperate", value: "Desperate" },
  ],
});
check("Blades: default-value query shape", blades[1], {
  raw: "?{Extra|0}",
  prompt: "Extra",
  kind: "input",
  default: "0",
});

check(
  "resolveQueries substitutes both",
  resolveQueries("pos=?{Position|Risky|Controlled} extra=?{Extra|0}", {
    "?{Position|Risky|Controlled}": "Controlled",
    "?{Extra|0}": "2",
  }),
  "pos=Controlled extra=2"
);

// ── rollTemplateParser (Dungeon World-shaped move template, simplified) ─────

const tpl = `<div class="rt-header">{{movename}}</div>
{{#trigger}}<div class="rt-row">Trigger: {{trigger}}</div>{{/trigger}}
{{#details}}<div class="rt-row">Details: {{details}}</div>{{/details}}`;

check(
  "truthy block renders, falsy block omitted",
  renderRollTemplateHtml(tpl, { movename: "Hack & Slash", trigger: "You attack" }),
  `<div class="rt-header">Hack &amp; Slash</div>\n<div class="rt-row">Trigger: You attack</div>\n`
);

check(
  "field values are HTML-escaped",
  renderRollTemplateHtml("{{name}}", { name: "<script>alert(1)</script>" }),
  "&lt;script&gt;alert(1)&lt;/script&gt;"
);

// ── attrBinding pure logic (real autocalc formulas from the corpus) ─────────

// 13th Age Glorantha's real INI-mod autocalc field:
// <input type="number" name="attr_INI-mod" value="@{level}+@{INI-mod-selected}+@{INI-bonus}-@{INI-penalty}" disabled>
check(
  "parseAutocalcRefs finds all four @{} refs, de-duplicated",
  AttrLogic.parseAutocalcRefs("@{level}+@{INI-mod-selected}+@{INI-bonus}-@{INI-penalty}"),
  ["level", "INI-mod-selected", "INI-bonus", "INI-penalty"]
);

check(
  "evaluateAutocalc computes the real INI-mod formula",
  AttrLogic.evaluateAutocalc("@{level}+@{INI-mod-selected}+@{INI-bonus}-@{INI-penalty}", {
    level: "3",
    "INI-mod-selected": "2",
    "INI-bonus": "1",
    "INI-penalty": "0",
  }),
  6
);

check(
  "evaluateAutocalc coerces a missing/non-numeric attr to 0 rather than throwing",
  AttrLogic.evaluateAutocalc("@{level}+@{missing}", { level: "3" }),
  3
);

check(
  "evaluateAutocalc refuses anything that isn't pure arithmetic after substitution",
  AttrLogic.evaluateAutocalc("@{level}; console.log(1)", { level: "3" }),
  null
);

check(
  "classifyInput: disabled input with an @{} formula value is autocalc",
  AttrLogic.classifyInput({ tagName: "INPUT", type: "number", value: "@{level}/2", disabled: true }),
  "autocalc"
);

check(
  "classifyInput: checkbox is checkbox even with a formula value (13th Age's init_tiebreaker case)",
  AttrLogic.classifyInput({ tagName: "INPUT", type: "checkbox", value: "@{dexterity}/100", disabled: false }),
  "checkbox"
);

check(
  "classifyInput: plain enabled text input is a normal value binding",
  AttrLogic.classifyInput({ tagName: "INPUT", type: "text", value: "10", disabled: false }),
  "value"
);

check(
  "classifyInput: a non-form attr_ element (e.g. <span name='attr_x'>) is display-only",
  AttrLogic.classifyInput({ tagName: "SPAN", value: "10" }),
  "display"
);

// ── repeatingBinding pure logic ──────────────────────────────────────────────

check(
  "parseRepeatingSectionName extracts the section name from a real class list",
  RepeatingLogic.parseRepeatingSectionName("sheet-inventory-row repeating_items sheet-flexrow"),
  "items"
);

check("parseRepeatingSectionName returns null for a non-repeating fieldset", RepeatingLogic.parseRepeatingSectionName("sheet-tab-content"), null);

check(
  "groupBySectionName groups two fieldsets sharing the same repeating_X class (corpus-confirmed pattern)",
  Object.keys(
    RepeatingLogic.groupBySectionName([
      { className: "repeating_motivations sheet-compact" },
      { className: "repeating_motivations sheet-detail" },
      { className: "repeating_wealth" },
    ])
  ).sort(),
  ["motivations", "wealth"]
);

// ── sheetWorkerShim pure logic ───────────────────────────────────────────────

check(
  "parseRepeatingKey splits a repeating field key using known section names, not guessing",
  SheetWorkerLogic.parseRepeatingKey("repeating_weapons_-K1a2b3c_name", ["weapons", "armor"]),
  { section: "weapons", rowId: "-K1a2b3c", field: "name" }
);

check(
  "parseRepeatingKey prefers the longest matching section name over a shorter prefix",
  SheetWorkerLogic.parseRepeatingKey("repeating_hp_tracker_-abc_max", ["hp", "hp_tracker"]),
  { section: "hp_tracker", rowId: "-abc", field: "max" }
);

check(
  "parseRepeatingKey returns null for a plain (non-repeating) attr name",
  SheetWorkerLogic.parseRepeatingKey("strength", ["weapons"]),
  null
);

check(
  "parseRepeatingKey returns null when the section isn't known on this sheet",
  SheetWorkerLogic.parseRepeatingKey("repeating_ghost_-abc_name", ["weapons"]),
  null
);

check(
  "parseEventSpec: plain attr change",
  SheetWorkerLogic.parseEventSpec("change:hp"),
  [{ type: "change", attr: "hp", raw: "change:hp" }]
);

check(
  "parseEventSpec: repeating attr change (real corpus shape, 94.7% of on() calls use one of these 5 forms)",
  SheetWorkerLogic.parseEventSpec("change:repeating_weapons:name"),
  [{ type: "change", section: "weapons", attr: "name", raw: "change:repeating_weapons:name" }]
);

check(
  "parseEventSpec: repeating section change (any field)",
  SheetWorkerLogic.parseEventSpec("change:repeating_weapons"),
  [{ type: "change", section: "weapons", attr: null, raw: "change:repeating_weapons" }]
);

check(
  "parseEventSpec: clicked / sheet:opened / remove, plus space-separated multi-spec",
  SheetWorkerLogic.parseEventSpec("clicked:roll_attack sheet:opened remove:repeating_weapons"),
  [
    { type: "clicked", action: "roll_attack", raw: "clicked:roll_attack" },
    { type: "sheet:opened", raw: "sheet:opened" },
    { type: "remove", section: "weapons", raw: "remove:repeating_weapons" },
  ]
);

check(
  "generateRowID output always satisfies the server's accepted id charset/length (^[A-Za-z0-9_-]{1,64}$)",
  Array.from({ length: 20 }, () => SheetWorkerLogic.ROWID_RE.test(SheetWorkerLogic.generateRowID())).every(Boolean),
  true
);

// ── rollDispatch pure logic ──────────────────────────────────────────────────

check(
  "FormulaTranslation.translateFormula (vanilla duplicate) matches the ES-module version's behavior",
  FormulaTranslation.translateFormula("[[4dF+8+@{RollModifiers}]]", { RollModifiers: "2" }),
  "4dF+8+2"
);

// Real queries from the bundled sheets: Blades' Label,Value dropdown, a
// plain default, a no-default free-text query, and D&D5E Scrolls' dropdown
// with a deliberately empty option value.
const realQueryFormula =
  "?{Position|Risky,position=Risky|Desperate,position=Desperate|Fortune roll,short=short} " +
  "1d20+?{Modifier|0} ?{Notes} ?{Proficient?|No, |Yes,+2} ?{Modifier|0}";
check(
  "RollButtonsLogic.parseQueries (vanilla duplicate) matches rollQuery.js's parseQueries on real sheet queries",
  RollButtonsLogic.parseQueries(realQueryFormula),
  parseQueries(realQueryFormula)
);
check(
  "RollButtonsLogic.resolveQueries (vanilla duplicate) matches rollQuery.js's resolveQueries, including a repeated query answered once",
  RollButtonsLogic.resolveQueries(realQueryFormula, { "?{Modifier|0}": "3", "?{Proficient?|No, |Yes,+2}": "" }),
  resolveQueries(realQueryFormula, { "?{Modifier|0}": "3", "?{Proficient?|No, |Yes,+2}": "" })
);

check(
  "buildRollCommand's template argument is a single space-free token (ChatHandler.ParseCommand does message.Split(\" \") with no quoting — a space inside the template JSON would silently shift splitted[2])",
  RollDispatchLogic.buildRollCommand("1d20+5", "r20n1a2b3c").split(" ").length,
  3
);

check(
  "buildRollCommand shape (nonce rides in borderColor, not a visibly-rendered field)",
  RollDispatchLogic.buildRollCommand("1d20+5", "abc123"),
  '/roll 1d20+5 {"borderColor":"abc123"}'
);

check(
  "buildRollCommand strips whitespace from the translated formula — real sheets write \"1d20 + 5\" with " +
    "spaces around operators, and a stray space would silently shift ChatHandler.ParseCommand's " +
    "splitted[2] (its Split(\" \") has no quoting), dropping the correlation nonce",
  RollDispatchLogic.buildRollCommand("1d20 + 5", "abc123"),
  '/roll 1d20+5 {"borderColor":"abc123"}'
);

check(
  "parseRollBroadcast extracts a real RollChatTemplate-shaped broadcast",
  RollDispatchLogic.parseRollBroadcast(
    JSON.stringify({ borderColor: "abc123", message: "Roll", roll: { result: 15, rolled: "1d20+5", dices: [] } })
  ),
  { borderColor: "abc123", message: "Roll", roll: { result: 15, rolled: "1d20+5", dices: [] } }
);

check(
  "parseRollBroadcast returns null for plain chat text (not a roll result)",
  RollDispatchLogic.parseRollBroadcast("just chatting, not a roll"),
  null
);

// ── rollButtons pure logic ───────────────────────────────────────────────────

check(
  "extractRollFormula pulls the dice formula out of a full roll-template button value",
  RollButtonsLogic.extractRollFormula("&{template:default} {{roll=[[1d20+@{mod}]]}} {{label=Attack}}"),
  "1d20+@{mod}"
);

check(
  "extractRollFormula falls back to the bare value when there's no [[...]] wrapper",
  RollButtonsLogic.extractRollFormula("1d20+@{mod}"),
  "1d20+@{mod}"
);

check(
  "extractRollFormula strips a literal /roll prefix some sheets author directly",
  RollButtonsLogic.extractRollFormula("/roll 1d20+@{mod}"),
  "1d20+@{mod}"
);

check(
  "actionNameFromButtonName strips Roll20's act_ prefix convention",
  RollButtonsLogic.actionNameFromButtonName("act_attack"),
  "attack"
);

check(
  "actionNameFromButtonName passes through a name with no act_ prefix (corpus has a minority of these)",
  RollButtonsLogic.actionNameFromButtonName("attack"),
  "attack"
);

// ── sheetTransform.mjs pure logic ──────────────────────────────────────────────

check(
  "splitWorkerScript extracts a worker block and removes it from the main HTML",
  splitWorkerScript(
    '<html><body><input name="attr_hp"></body>\n' +
      '<script type="text/worker">\n  on("sheet:opened", function(){});\n</script>\n</html>'
  ),
  {
    mainHtml: '<html><body><input name="attr_hp"></body>\n\n</html>',
    workerJs: 'on("sheet:opened", function(){});',
  }
);

check(
  "splitWorkerScript returns workerJs: null for a pure HTML/CSS sheet (Numenera's case — no worker script tag at all; " +
    "Blades in the Dark was wrongly assumed worker-less earlier and actually has one, confirmed against the real corpus checkout)",
  splitWorkerScript('<html><body><input name="attr_hp"></body></html>'),
  { mainHtml: "<html><body><input name=\"attr_hp\"></body></html>", workerJs: null }
);

check(
  "splitWorkerScript concatenates more than one worker block, in document order",
  splitWorkerScript(
    '<script type="text/worker">on("a", f);</script><div></div><script type=\'text/worker\'>on("b", g);</script>'
  ).workerJs,
  'on("a", f);\n\non("b", g);'
);

// Runs a worker script the way the runtime does (one classic script, Roll20
// host API as globals) and returns the on() specs it registered plus any
// console.error messages — so the multi-block checks below prove the output
// actually RUNS, not just that it's a different string.
function runWorker(workerJs) {
  const specs = [];
  const errors = [];
  const context = vm.createContext({
    on: (spec) => specs.push(spec),
    setAttrs: () => {},
    console: { error: (msg) => errors.push(String(msg)) },
  });
  vm.runInContext(workerJs, context);
  return { specs, errors };
}

// 13th Age Glorantha's real shape: every block redeclares the same top-level
// const. Plain-joined, that's a SyntaxError that killed ALL four blocks.
const duplicateConstSheet = [
  'const buttonlist = ["standard","magic"]; buttonlist.forEach(b => on(`clicked:${b}`, () => setAttrs({ sheetAbil: b })));',
  'const buttonlist = ["specials-off","specials-on"]; buttonlist.forEach(b => on(`clicked:${b}`, () => setAttrs({ sheetSpecial: b })));',
]
  .map((js) => `<script type="text/worker">${js}</script>`)
  .join("<div></div>");
check(
  "splitWorkerScript isolates blocks that redeclare the same top-level const (13th Age Glorantha), so every block's handlers still register",
  runWorker(splitWorkerScript(duplicateConstSheet).workerJs),
  { specs: ["clicked:standard", "clicked:magic", "clicked:specials-off", "clicked:specials-on"], errors: [] }
);

// Dragon Ball Universe / Paradigm's RWBY shape: one block is itself broken.
const brokenBlockSheet =
  '<script type="text/worker">on("change:a", () => {</script>' +
  '<script type="text/worker">on("change:b", () => {});</script>';
const brokenBlockResult = runWorker(splitWorkerScript(brokenBlockSheet).workerJs);
check(
  "splitWorkerScript skips a syntactically broken block with a visible console.error, and the other blocks still run",
  {
    specs: brokenBlockResult.specs,
    errorMentionsBlock: brokenBlockResult.errors.length === 1 && brokenBlockResult.errors[0].includes("block 1 of 2"),
  },
  { specs: ["change:b"], errorMentionsBlock: true }
);

check(
  "stripRollTemplates removes a real <rolltemplate> block (13th Age Glorantha's own markup) that would otherwise render its {{...}} placeholder syntax as literal visible text",
  stripRollTemplates(
    '<div class="sheet-core">content</div>' +
      '<rolltemplate class="sheet-rolltemplate-13G_red">' +
      "<table><tr><td>{{name}}</td></tr>" +
      "{{#allprops() character_name character_id name_link usage type text}}" +
      "<tr><td>{{key}}</td><td>{{value}}</td></tr>" +
      "{{/allprops() character_name character_id name_link usage type text}}" +
      "</table></rolltemplate>"
  ),
  '<div class="sheet-core">content</div>'
);

check(
  "stripRollTemplates removes multiple blocks (13th Age Glorantha has 9, one per named color)",
  stripRollTemplates(
    '<rolltemplate class="a"><tr>{{name}}</tr></rolltemplate>' +
      "<div>keep-me</div>" +
      '<rolltemplate class="b"><tr>{{name}}</tr></rolltemplate>'
  ),
  "<div>keep-me</div>"
);

check(
  "expandSelfClosingTags closes self-closed non-void elements (Imperium Maledictum's <span name=\"attr_str\" />, which otherwise swallowed its whole characteristics grid)",
  expandSelfClosingTags('<td><span name="attr_str" /></td><td><button type="roll" name="roll_str" value="[[1d100]]"/></td><textarea name="attr_notes"/>'),
  '<td><span name="attr_str"></span></td><td><button type="roll" name="roll_str" value="[[1d100]]"></button></td><textarea name="attr_notes"></textarea>'
);

check(
  "expandSelfClosingTags leaves void elements alone, and is quote-aware for \">\" and \"/>\" inside attribute values (roll formulas)",
  expandSelfClosingTags(
    `<input type="text" name="attr_a" /><br/><button type="roll" value="[[1d20>15]] {{x=a/>b}}" /><button type='roll' value='&{template:t} {{r=[[2d6>4]]}}'/>`
  ),
  `<input type="text" name="attr_a" /><br/><button type="roll" value="[[1d20>15]] {{x=a/>b}}"></button><button type='roll' value='&{template:t} {{r=[[2d6>4]]}}'></button>`
);

check(
  "expandSelfClosingTags keeps a self-closed tag the author closes later as an opener (Classic Traveller's <select ... /> + <option>s + </select>, a working dropdown on Roll20)",
  expandSelfClosingTags('<td><select name="attr_service" /><option value="Navy">Navy</option><option value="Army">Army</option></select></td>'),
  '<td><select name="attr_service" /><option value="Navy">Navy</option><option value="Army">Army</option></select></td>'
);

check(
  "expandSelfClosingTags pairs a close tag with the enclosing REAL opener first, so a self-closed tag nested inside a same-name element is still expanded",
  expandSelfClosingTags('<span class="sheet-a"><span name="attr_x" /></span><div><div name="attr_y"/></div>'),
  '<span class="sheet-a"><span name="attr_x"></span></span><div><div name="attr_y"></div></div>'
);

check(
  "expandSelfClosingTags never touches <script>/<style> contents, and leaves already-closed markup unchanged",
  expandSelfClosingTags('<style>.a{background:url(x.png)}/* <span/> */</style><script>var s = "<div/>";</script><div class="sheet-a"><span>x</span></div>'),
  '<style>.a{background:url(x.png)}/* <span/> */</style><script>var s = "<div/>";</script><div class="sheet-a"><span>x</span></div>'
);

check(
  "scopeSheetCss scopes each selector in a list under .charsheet — Roll20's real served CSS for Cyberpunk RED (raycw) turns 'input:focus, textarea:focus, button:focus' into exactly this",
  scopeSheetCss(`input:focus, textarea:focus, button:focus {
  outline: none;
}`),
  `.charsheet input:focus, .charsheet textarea:focus, .charsheet button:focus{
  outline: none;
}`
);

check(
  "scopeSheetCss leaves selectors that already mention .charsheet, and :root/html/body, unscoped",
  scopeSheetCss(`.ui-dialog .charsheet * { display: unset; }
.charsheet .sheet-a, .sheet-b { color: red; }
:root { --x: 1px; }
body { margin: 0; }`),
  `.ui-dialog .charsheet * { display: unset; }
.charsheet .sheet-a, .charsheet .sheet-b{ color: red; }
:root { --x: 1px; }
body { margin: 0; }`
);

check(
  "scopeSheetCss scopes inside @media/@supports, copies @import/@keyframes/@font-face and comments verbatim, and ignores braces/commas inside strings and :is()/[attr] groups",
  scopeSheetCss(`@import url("https://x/y.css");
/* a, b { } */
@media (max-width: 600px) { .sheet-a { x: 1; } }
@keyframes spin { from { a: 1; } to { a: 2; } }
@font-face { font-family: "F"; }
.sheet-a[title="x, {y}"], :is(.b, .c) { content: "}"; }`),
  `@import url("https://x/y.css");
/* a, b { } */
@media (max-width: 600px) { .charsheet .sheet-a{ x: 1; } }
@keyframes spin { from { a: 1; } to { a: 2; } }
@font-face { font-family: "F"; }
.charsheet .sheet-a[title="x, {y}"], .charsheet :is(.b, .c){ content: "}"; }`
);

check(
  "stripLocalLinks removes relative-path <link> tags (13th Age Glorantha's own base.css/app.css/sheet css — guaranteed 404s once installed) but keeps absolute, protocol-relative and single-quoted/unquoted remote ones",
  stripLocalLinks(
    "<head>" +
      '<link href="base.css" rel="stylesheet">' +
      "<link rel='stylesheet' href='./files/app.css'>" +
      "<link rel=stylesheet href=13th_Age_Glorantha.css>" +
      '<link href="https://fonts.googleapis.com/css?family=Cinzel" rel="stylesheet">' +
      "<link rel='stylesheet' href='//fonts.googleapis.com/css?family=Lato'>" +
      "</head>"
  ),
  "<head>" +
    '<link href="https://fonts.googleapis.com/css?family=Cinzel" rel="stylesheet">' +
    "<link rel='stylesheet' href='//fonts.googleapis.com/css?family=Lato'>" +
    "</head>"
);

check(
  "prefixSheetClasses prefixes a bare class token only when the sheet's OWN css declares the prefixed form and never references the bare form (Cyberpunk RED raycw's own authoring mismatch: class=\"character-mode\" in html, only .sheet-character-mode in its css)",
  prefixSheetClasses('<div class="character-mode">x</div>', ".sheet-character-mode { display: none; }"),
  '<div class="sheet-character-mode">x</div>'
);

check(
  "prefixSheetClasses leaves a bare class token untouched when the sheet's OWN css matches it bare (Blades in the Dark's real regression: its css targets .hider directly — prefixing broke every hide/show rule in the sheet at once, 1661px -> 17254px in the sandbox)",
  prefixSheetClasses('<div class="hider">x</div>', '.hider[value="0"] + div { display: none; }'),
  '<div class="hider">x</div>'
);

check(
  "prefixSheetClasses leaves a class token untouched when the sheet's css references it in neither bare nor prefixed form (default to no-op, not a guess)",
  prefixSheetClasses('<div class="mystery">x</div>', ".sheet-other { color: red; }"),
  '<div class="mystery">x</div>'
);

check(
  "prefixSheetClasses leaves an already-prefixed token untouched — idempotent, not doubled",
  prefixSheetClasses('<div class="sheet-2col">x</div>', ".sheet-2col { display: flex; }"),
  '<div class="sheet-2col">x</div>'
);

check(
  "prefixSheetClasses evaluates every token in a multi-class attribute independently against the sheet's own css, in order",
  prefixSheetClasses('<div class="action flex sheet-header">x</div>', ".sheet-action{} .flex{}"),
  '<div class="sheet-action flex sheet-header">x</div>'
);

check(
  "prefixSheetClasses handles single-quoted class attributes too (Cyberpunk RED raycw mixes both quote styles in the same file — e.g. its own class='character' tab wrapper)",
  prefixSheetClasses("<div class='character'>x</div>", ".sheet-character{}"),
  '<div class=\'sheet-character\'>x</div>'
);

check(
  "prefixSheetClasses never prefixes Roll20's own platform-chrome class names (ui-dialog/charsheet/charactersheet/sheetform/tab-pane) even if the sheet's own css happens to declare a sheet- prefixed form of one — these stay bare on the real platform (confirmed against Frecypha Isiy's own popout dialog chrome), and wrapCharsheet()'s ALREADY_WRAPPED_RE detection plus roll20-base.css's own base selectors depend on them staying unprefixed",
  prefixSheetClasses(
    '<div class="ui-dialog"><div class="charsheet"><form class="sheetform charactersheet tab-pane custom">x</form></div></div>',
    ".sheet-custom{} .sheet-ui-dialog{} .sheet-charsheet{}"
  ),
  '<div class="ui-dialog"><div class="charsheet"><form class="sheetform charactersheet tab-pane sheet-custom">x</form></div></div>'
);

check(
  "wrapCharsheet builds a real document shell (<html><head></head><body>...) around a bare body-fragment sheet (Numenera's own convention — no <html>/<body> at all), not just .ui-dialog/.charsheet divs — CardPanel.js's CSS <link> injection targets </head> with NO fallback if it's absent, so a fragment with no <head> silently gets zero CSS applied (confirmed live: this is why Numenera rendered completely unstyled even after roll20-base.css was bundled)",
  wrapCharsheet('<div class="sheet-3colrow"><input name="attr_character_name"></div>'),
  '<html><head></head><body><div class="ui-dialog"><div class="charsheet"><div class="sheet-3colrow"><input name="attr_character_name"></div></div></div></body></html>'
);

check(
  "wrapCharsheet wraps only the <body> content of a full-document sheet with no preview chrome of its own, leaving <head> untouched",
  wrapCharsheet('<html><head><title>x</title></head><body style="overflow: visible;"><div class="sheet-13G">hi</div></body></html>'),
  '<html><head><title>x</title></head><body style="overflow: visible;"><div class="ui-dialog"><div class="charsheet"><div class="sheet-13G">hi</div></div></div></body></html>'
);

check(
  "wrapCharsheet leaves body content untouched when it already embeds its own .ui-dialog/.charsheet preview chrome (13th Age Glorantha's real corpus file: a self-contained standalone-preview doc, not a bare fragment) — double-wrapping this shape broke its absolute-positioned header layout live (logo overlapping the tab bar) since Roll20's real platform never wraps an already-wrapped sheet either",
  wrapCharsheet(
    '<html><head></head><body><div class="ui-dialog" style="width:868px;"><div class="charsheet" id="root"><div class="sheet-13G">hi</div></div></div></body></html>'
  ),
  '<html><head></head><body><div class="ui-dialog" style="width:868px;"><div class="charsheet" id="root"><div class="sheet-13G">hi</div></div></div></body></html>'
);

console.log(failures === 0 ? "\nAll smoke checks passed." : `\n${failures} smoke check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
