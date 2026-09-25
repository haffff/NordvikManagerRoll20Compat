// Pure, DOM-free string transforms for turning a raw Roll20 sheet's HTML/CSS
// into what this addon's runtime shim expects. Used by the importer view
// (card_sources/roll20compat-importer/src/roll20Assembly.js's
// transformUpload) in the GM's browser, and by scripts/smoke.mjs and the
// sandbox checks in Node — one implementation for both.
//
// Every function here is pure (string in, string/object out) — no fs, no
// DOM, no browser-only API — so it works unmodified in both Node and a
// browser/Vite bundle. See scripts/smoke.mjs for the test fixtures (pulled
// from real corpus HTML) these are validated against.

// Matches Roll20's own worker-script convention: <script type="text/worker">
// (case/whitespace-tolerant on the attribute, since real corpus sheets vary).
// Most sheets author exactly one of these, but 58 corpus sheets author more
// than one, so this collects ALL matches — see joinWorkerBlocks() below for
// how they're combined into the single workerJs the runtime loads.
const WORKER_SCRIPT_RE = /<script\s+type\s*=\s*["']text\/worker["'][^>]*>([\s\S]*?)<\/script>/gi;

// Compile-only syntax check (new Function never runs the code). Only a real
// SyntaxError counts as "doesn't parse" — anything else (e.g. an EvalError
// from a browser CSP without 'unsafe-eval') means "can't tell", which must
// keep today's plain-join behavior rather than flip every sheet onto the
// fallback path below.
function parsesAsJs(code) {
  try {
    new Function(code);
    return true;
  } catch (err) {
    return !(err instanceof SyntaxError);
  }
}

// Plain newline-join is what 53 of the 58 multi-block corpus sheets need —
// 13 of those appear to share top-level const/let names ACROSS blocks, which
// only works when the blocks end up in one shared scope, so plain joining
// stays the default. It only falls back when the joined result doesn't
// parse, which in the corpus comes from two causes:
//   - the same top-level const/let redeclared in more than one block
//     (13th Age Glorantha: `const buttonlist` in all 4 blocks, which killed
//     the WHOLE worker, not just the duplicate) — fixed by wrapping each
//     block in its own { } scope, so lexical names stop colliding while
//     var/function declarations still reach the shared global scope;
//   - a block that is itself syntactically broken (Dragon Ball Universe,
//     Paradigm's RWBY) — replaced by a runtime console.error so the rest of
//     the sheet's blocks still run and the failure stays visible.
function joinWorkerBlocks(blocks) {
  const joined = blocks.join("\n\n");
  if (blocks.length < 2 || parsesAsJs(joined)) return joined;

  return blocks
    .map((block, i) => {
      if (parsesAsJs(block)) return `{\n${block}\n}`;
      let reason = "SyntaxError";
      try {
        new Function(block);
      } catch (err) {
        reason = String(err);
      }
      const message = `roll20compat: sheet worker block ${i + 1} of ${blocks.length} has a syntax error and was skipped (${reason})`;
      return `console.error(${JSON.stringify(message)});`;
    })
    .join("\n\n");
}

/**
 * Splits a sheet's raw HTML into {mainHtml, workerJs}. mainHtml has every
 * worker <script> block removed (nothing else changed — see this file's
 * header on why). workerJs is those blocks combined into one script (see
 * joinWorkerBlocks), or null if the sheet has none (the ~35% of the corpus
 * that's pure HTML/CSS with zero worker JS).
 */
export function splitWorkerScript(rawHtml) {
  const workerBlocks = [];
  let match;
  WORKER_SCRIPT_RE.lastIndex = 0;
  while ((match = WORKER_SCRIPT_RE.exec(rawHtml)) !== null) {
    workerBlocks.push(match[1].trim());
  }
  const mainHtml = rawHtml.replace(WORKER_SCRIPT_RE, "").trim();
  const nonEmptyBlocks = workerBlocks.filter(Boolean);
  const workerJs = workerBlocks.length > 0 ? joinWorkerBlocks(nonEmptyBlocks) : null;
  return { mainHtml, workerJs };
}

// <rolltemplate class="sheet-rolltemplate-X">...</rolltemplate> blocks
// define a sheet's CUSTOM chat roll templates (matched by &{template:X} in
// roll formulas) — Mustache-like {{name}}/{{#allprops()}} placeholder
// syntax meant to be rendered only when a roll actually happens, never as
// part of the character sheet's own page layout. <rolltemplate> isn't a
// real HTML element, so a browser treats it like an unknown inline element
// (same as a stray <foo>) and renders its {{...}} text content literally —
// confirmed live: 13th Age Glorantha's 9 rolltemplate blocks (one per
// named color) showed up as raw "{{name}}" / "{{#allprops()...}}" text
// directly on the installed card. This runtime doesn't implement Roll20's
// own roll-template rendering for generically-imported sheets (see
// rollButtons.js's own documented scope boundary on the same point) — so
// rather than show broken placeholder syntax, these blocks are stripped
// entirely rather than partially/incorrectly rendered. If a future pass
// adds real template rendering, this is the extraction point to build on.
const ROLLTEMPLATE_RE = /<rolltemplate[^>]*>[\s\S]*?<\/rolltemplate>/gi;

/** Removes every <rolltemplate>...</rolltemplate> block from a sheet's HTML. */
export function stripRollTemplates(html) {
  return html.replace(ROLLTEMPLATE_RE, "").trim();
}

// Roll20 does NOT auto-prefix HTML class attributes with "sheet-" — tested
// and falsified. The initial version of this function assumed it did
// (a real popout of Cyberpunk RED raycw showed `class="sheet-character"`
// against corpus HTML with bare `class="character"`), applied a blanket
// prefix, and it broke Blades in the Dark badly live in the sandbox
// (1661px -> 17254px): Blades' OWN css intentionally matches BARE class
// names for its hide/show mechanisms (`.hider[value="0"] + div`, `.type`,
// `.settings`, `.light-hider`, ...) against equally bare HTML — prefixing
// those broke every one of them at once, un-hiding huge swaths of content.
// The real explanation for the raycw popout: its inline style block is
// 45382 bytes against the corpus checkout's 43452 (1501 diff lines) — a
// LATER revision of that author's own sheet where they fixed their own
// HTML/CSS mismatch themselves, not a platform transform.
//
// So the actual bug some corpus sheets have (raycw, and very likely
// Cyberpunk Red Tabbed — 129 ".sheet-" CSS selectors, 8 of 937 HTML class
// attributes prefixed) is a plain AUTHORING inconsistency: their CSS
// expects "sheet-X" but their HTML still says "X". The fix has to be aware
// of what a SPECIFIC sheet's OWN css actually expects, not a blind global
// rule — a class token only gets prefixed when doing so would make it
// match a selector the sheet's own CSS actually declares, and NEVER when
// the bare form is already meaningfully referenced (Blades' ".hider" etc.
// must stay bare).
const NEVER_PREFIX_CLASSES = new Set(["ui-dialog", "charsheet", "charactersheet", "sheetform", "tab-pane"]);
const CLASS_ATTR_RE = /\bclass\s*=\s*(["'])([^"']*)\1/gi;
// Naive, comment/string-unaware class-selector extraction — good enough to
// build a set of "this sheet's CSS references class X" / "...sheet-X",
// not parsed for anything correctness-critical beyond that membership test.
const CSS_CLASS_SELECTOR_RE = /\.(sheet-)?([a-zA-Z][a-zA-Z0-9_-]*)/g;

/**
 * Rewrites class="..."/class='...' attributes in a sheet's raw HTML
 * fragment, prefixing a bare class token with "sheet-" ONLY when: the
 * sheet's own CSS never references that bare token as a selector (so
 * nothing depends on it staying bare), AND the sheet's own CSS DOES
 * reference the "sheet-"-prefixed form (so the rewrite actually connects
 * to a real rule, not a guess). Anything not meeting both conditions is
 * left untouched — see the comment above for why erring toward no-op is
 * required, not just cautious. Must run BEFORE wrapCharsheet() so this
 * runtime's own added .ui-dialog/.charsheet chrome (and any
 * already-embedded copy in a standalone-preview sheet) is never touched.
 */
export function prefixSheetClasses(html, css) {
  const bareSelectors = new Set();
  const prefixedSelectors = new Set();
  let m;
  CSS_CLASS_SELECTOR_RE.lastIndex = 0;
  while ((m = CSS_CLASS_SELECTOR_RE.exec(css ?? "")) !== null) {
    (m[1] ? prefixedSelectors : bareSelectors).add(m[2]);
  }

  return html.replace(CLASS_ATTR_RE, (fullMatch, quote, classList) => {
    const tokens = classList.split(/\s+/).filter(Boolean);
    const rewritten = tokens.map((token) => {
      if (token.startsWith("sheet-") || NEVER_PREFIX_CLASSES.has(token)) return token;
      if (bareSelectors.has(token)) return token;
      if (prefixedSelectors.has(token)) return `sheet-${token}`;
      return token;
    });
    return `class=${quote}${rewritten.join(" ")}${quote}`;
  });
}

// Many sheets write empty elements XML-style: <span name="attr_str" />,
// <button type="roll" ... />, <textarea ... />. In HTML the "/" is ignored
// on a non-void element, so the tag stays OPEN and swallows everything
// after it — Imperium Maledictum's whole characteristics grid collapsed
// into one <span>, and a self-closed <button> nests the rest of the sheet
// inside a button. Roll20 renders these as empty elements (confirmed
// against Imperium Maledictum's own sheet.png preview), and 296 of 1378
// corpus sheets use them (6315 self-closed <button>s alone).
//
// But not every "<x/>" is meant empty: Classic Traveller writes
// <select name="attr_service" />, then its <option>s, then a real
// </select> — and Roll20 renders a working dropdown (its own preview
// again). So per tag name, open/close tags are paired up in document order:
// a close tag pairs with the nearest still-open REAL opener, and only when
// none is left does it claim the nearest self-closed tag, which then stays
// an opener. Every self-closed tag left unclaimed is expanded to
// <x ...></x>. Void elements (<input/>, <br/>) are never touched.
// Attribute values are matched quote-aware, since roll formulas put ">"
// and "/" inside them (value="[[1d20>15]]"). <script>/<style> contents
// are skipped.
const VOID_ELEMENTS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr",
]);
const TAG_RE = /<(\/?)([a-zA-Z][\w-]*)((?:\s(?:[^<>"']|"[^"]*"|'[^']*')*?)?)\s*(\/?)>/g;
const RAW_TEXT_BLOCK_RE = /(<(script|style)\b[^>]*>[\s\S]*?<\/\2\s*>)/gi;

function expandSelfClosingInMarkup(html) {
  const tags = [...html.matchAll(TAG_RE)].map((m) => ({
    index: m.index,
    length: m[0].length,
    isClose: m[1] === "/",
    name: m[2].toLowerCase(),
    rawName: m[2],
    attrs: m[3],
    isSelfClosed: m[4] === "/",
  }));

  const openStacks = new Map(); // tag name -> stack of { tag, real }
  for (const tag of tags) {
    if (VOID_ELEMENTS.has(tag.name)) continue;
    const stack = openStacks.get(tag.name) ?? openStacks.set(tag.name, []).get(tag.name);
    if (!tag.isClose) {
      stack.push({ tag, real: !tag.isSelfClosed });
      continue;
    }
    let pairIdx = -1;
    for (let i = stack.length - 1; i >= 0; i--) {
      if (stack[i].real) {
        pairIdx = i;
        break;
      }
    }
    if (pairIdx < 0) pairIdx = stack.length - 1; // no real opener left: claim the nearest self-closed one
    if (pairIdx >= 0) {
      stack[pairIdx].tag.claimedAsOpener = true;
      stack.splice(pairIdx, 1);
    }
  }

  let out = "";
  let cursor = 0;
  for (const tag of tags) {
    if (tag.isClose || !tag.isSelfClosed || tag.claimedAsOpener || VOID_ELEMENTS.has(tag.name)) continue;
    out += html.slice(cursor, tag.index) + `<${tag.rawName}${tag.attrs}></${tag.rawName}>`;
    cursor = tag.index + tag.length;
  }
  return out + html.slice(cursor);
}

/**
 * Rewrites every self-closed non-void element meant as empty (<span .../>)
 * as <span ...></span>, leaving ones the author closes later as openers.
 */
export function expandSelfClosingTags(html) {
  return html
    .split(RAW_TEXT_BLOCK_RE)
    .map((part, i) => {
      // split() with 2 capture groups yields [text, block, tagName, text, ...]
      if (i % 3 !== 0) return i % 3 === 1 ? part : "";
      return expandSelfClosingInMarkup(part);
    })
    .join("");
}

// Roll20 serves a sheet's CSS with every selector scoped under .charsheet:
// the real served CSS of Cyberpunk RED (raycw) (sandbox/reference/) turns
// the source's `input:focus, textarea:focus, button:focus` into
// `.charsheet input:focus,.charsheet textarea:focus,.charsheet button:focus`.
// Besides scoping, that adds one class of specificity to every sheet rule,
// and sheets are tuned against it: Warhammer Fantasy Roleplay 4e Official
// opens with a `.ui-dialog .charsheet * { display: unset; ... }` reset
// (0,2,0) that, unscoped, beat every one of its own single-class rules
// (0,1,0) — so its hidden "compendium drop" overlay covered the whole sheet
// and its grids fell back to display:block.
//
// A selector that already mentions .charsheet is left alone (about 1000
// corpus sheets write it themselves), as are :root/html/body selectors
// (scoping those would only disable a sheet's own CSS variables — inside
// this card's iframe they hold nothing but the sheet anyway). Rules inside
// @media/@supports/@container/@layer are scoped too; every other at-rule
// (@keyframes, @font-face, @import, ...) is copied verbatim.
const CHARSHEET_SCOPE = ".charsheet";
const MENTIONS_CHARSHEET_RE = /\.charsheet(?![\w-])/;
const DOCUMENT_LEVEL_SELECTOR_RE = /^(?::root|html|body)(?![\w-])/i;
const NESTING_AT_RULE_RE = /^@(?:media|supports|container|layer|document|-moz-document)\b/i;

// Splits a selector list on top-level commas (not inside (), [] or strings).
function splitSelectorList(selectorText) {
  const parts = [];
  let depth = 0;
  let quote = null;
  let start = 0;
  for (let i = 0; i < selectorText.length; i++) {
    const ch = selectorText[i];
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") depth--;
    else if (ch === "," && depth === 0) {
      parts.push(selectorText.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(selectorText.slice(start));
  return parts;
}

function scopeSelectorList(selectorText) {
  return splitSelectorList(selectorText)
    .map((raw) => {
      const selector = raw.trim();
      if (!selector || MENTIONS_CHARSHEET_RE.test(selector) || DOCUMENT_LEVEL_SELECTOR_RE.test(selector)) return raw;
      const lead = raw.slice(0, raw.indexOf(selector));
      return `${lead}${CHARSHEET_SCOPE} ${selector}`;
    })
    .join(",");
}

// Index just past the "}" matching the "{" at openIdx, skipping comments
// and strings.
function blockEnd(css, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < css.length; i++) {
    const ch = css[i];
    if (ch === "/" && css[i + 1] === "*") {
      const end = css.indexOf("*/", i + 2);
      i = end < 0 ? css.length : end + 1;
    } else if (ch === '"' || ch === "'") {
      for (i++; i < css.length && css[i] !== ch; i++) if (css[i] === "\\") i++;
    } else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return i + 1;
  }
  return css.length;
}

/** Scopes every rule's selectors under .charsheet the way Roll20 serves sheet CSS. */
export function scopeSheetCss(css) {
  let out = "";
  let i = 0;
  while (i < css.length) {
    // Copy whitespace and comments through unchanged.
    const ws = /^(?:\s+|\/\*[\s\S]*?(?:\*\/|$))+/.exec(css.slice(i));
    if (ws) {
      out += ws[0];
      i += ws[0].length;
      continue;
    }
    // Prelude: everything up to the next top-level "{" or ";".
    let j = i;
    let quote = null;
    for (; j < css.length; j++) {
      const ch = css[j];
      if (quote) {
        if (ch === "\\") j++;
        else if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'") quote = ch;
      else if (ch === "/" && css[j + 1] === "*") j = Math.max(j, css.indexOf("*/", j + 2) + 1 || css.length);
      else if (ch === "{" || ch === ";" || ch === "}") break;
    }
    const prelude = css.slice(i, j);
    if (j >= css.length || css[j] === ";" || css[j] === "}") {
      // Statement at-rule (@import ...;) or stray text — copied verbatim.
      out += css.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    const end = blockEnd(css, j);
    const body = css.slice(j + 1, end - 1);
    if (prelude.trim().startsWith("@")) {
      out += NESTING_AT_RULE_RE.test(prelude.trim())
        ? `${prelude}{${scopeSheetCss(body)}}`
        : css.slice(i, end);
    } else {
      out += `${scopeSelectorList(prelude)}{${body}}`;
    }
    i = end;
  }
  return out;
}

// A sheet authored as a standalone preview page (13th Age Glorantha, the
// 13th Age neovatar src/ build — 79 such <link> tags across the corpus)
// links its own stylesheets by relative path: <link href="base.css">. None
// of those paths exist once installed — Resources are addressed by addon-
// prefixed key, not by relative file path, and the sheet's own CSS is
// already delivered separately (the manifest's additionalResources, or
// sheetCss for a runtime import) — so each one is just a guaranteed 404
// (ERR_FILE_NOT_FOUND in the sandbox). Only RELATIVE hrefs are removed:
// an absolute/protocol-relative/data: link (e.g. a Google Fonts sheet, 22
// in the corpus) still resolves and stays.
const LINK_TAG_RE = /<link\b[^>]*>/gi;
const LINK_HREF_RE = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;
const NON_RELATIVE_HREF_RE = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;

/** Removes every <link> tag whose href is a relative path. */
export function stripLocalLinks(html) {
  return html.replace(LINK_TAG_RE, (tag) => {
    const hrefMatch = LINK_HREF_RE.exec(tag);
    if (!hrefMatch) return tag;
    const href = (hrefMatch[1] ?? hrefMatch[2] ?? hrefMatch[3]).trim();
    return NON_RELATIVE_HREF_RE.test(href) ? tag : "";
  });
}

// Roll20's real client always wraps a sheet's authored markup in
// <div class="ui-dialog"><div class="charsheet">...</div></div> before
// rendering it — confirmed against a real captured Roll20 page AND Roll20's
// own charsheet.css (the platform's base stylesheet, not part of any
// sheet's own files): every layout/base rule in it is scoped
// ".ui-dialog .charsheet ..." (a compound selector, not bare ".charsheet"),
// e.g. ".ui-dialog .charsheet .sheet-3colrow .sheet-col". "legacy" sheets
// (942 of 1416 in the corpus, per each sheet's own sheet.json) rely on
// BOTH this base stylesheet AND their own CSS being scoped the same way —
// Numenera.css's ".charsheet input[type=text]" for example — without ever
// including either class in their own HTML. Without this wrapper, none of
// a legacy sheet's own CSS can match at all, AND none of roll20-base.css's
// layout primitives apply either (exactly what surfaced when Numenera was
// first installed with only a bare .charsheet wrapper — inputs looked
// styled since .charsheet-scoped rules matched, but .sheet-3colrow's
// column layout didn't, since roll20-base.css's rule additionally requires
// .ui-dialog). Non-legacy sheets (e.g. 13th Age Glorantha's own
// author-authored ".sheet-13G" wrapper div) don't reference either class,
// so adding both is a no-op ancestor for them — confirmed no sheet CSS in
// the corpus uses a body>/html> direct-child combinator that extra wrapper
// levels could break. Always wrapping, rather than detecting legacy vs.
// modern, is therefore both correct and simpler.
const ALREADY_WRAPPED_RE = /class=["'][^"']*\bui-dialog\b[^"']*["']/i;

export function wrapCharsheet(html) {
  const wrap = (content) => `<div class="ui-dialog"><div class="charsheet">${content}</div></div>`;

  const bodyMatch = html.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  if (bodyMatch) {
    const [fullMatch, bodyContent] = bodyMatch;
    // Some corpus files (13th Age Glorantha, confirmed) are full standalone
    // preview documents that already embed the sheet author's own copy of
    // Roll20's real dialog chrome (.ui-dialog > ... > .charsheet, with an
    // explicit width:868px) for local testing outside Roll20 — not a bare
    // fragment like Numenera's. Wrapping that again produced a doubled
    // .ui-dialog/.charsheet nesting that visibly broke this sheet's own
    // absolute-positioned header layout (its logo overlapping the tab bar) —
    // confirmed live against a real Roll20 screenshot, where the same sheet
    // renders with a clean, non-overlapping logo. If the body already has
    // its own ui-dialog wrapper, use it as-is instead of wrapping again.
    if (ALREADY_WRAPPED_RE.test(bodyContent) && bodyContent.includes("charsheet")) {
      return html;
    }
    return html.replace(fullMatch, fullMatch.replace(bodyContent, wrap(bodyContent)));
  }
  // No <body> tag at all — a bare body-fragment sheet (Numenera's own
  // convention: no <html>/<head>/<body>, just the sheet's content divs
  // directly). Wrapping in .ui-dialog/.charsheet divs alone isn't enough
  // here — CardPanel.js's CSS injection only has two targets to try,
  // `</head>` then `<body`, with NO fallback if neither exists (unlike its
  // JS injection, which appends to the end of the string either way). A
  // fragment with no <head>/<body> at all means every additionalResources
  // CSS <link> tag silently fails to insert — confirmed live: this is
  // exactly why Numenera rendered with zero styling even after
  // roll20-base.css was bundled and the .ui-dialog/.charsheet wrapper
  // was added. A real, minimal document shell guarantees CardPanel.js
  // always has a `</head>` to inject into, for every sheet, not just the
  // ones the corpus happened to author as full documents.
  return `<html><head></head><body>${wrap(html)}</body></html>`;
}

/**
 * Builds the inline <script>window.Roll20CompatConfig = {...}</script> tag
 * that carries a sheet's translation bundle into the sandboxed iframe —
 * the only way bootstrap.js/translationFill.js learn about it.
 *
 * The bundle's actual CONTENT is embedded here too (translationBundle), not
 * just its resource key — confirmed live: a worker script that calls
 * getTranslationByKey() synchronously at its own top level (Blades in the
 * Dark's dataSetup(), see translationFill.js's header) can lose the race
 * against the real app's actual Resources.Global.Read() RPC latency, even
 * though every earlier test against this passed — because the SANDBOX's
 * fake CardAPI resolves that same call near-instantly, masking the exact
 * race a real postMessage round trip hits. Embedding the bundle directly
 * removes the race entirely: translationFill.js can read it synchronously,
 * no fetch (real or fake) required at all. This is safe/cheap because
 * translation.json is small, sheet-authored, and static — nothing here
 * needs a live network read.
 * @param {object} opts
 * @param {string} opts.translationResourceKey
 * @param {object} opts.translationBundle - parsed translation.json content
 */
export function buildTranslationConfigScript({ translationResourceKey, translationBundle }) {
  // Translation strings can contain arbitrary author-supplied HTML
  // (confirmed live: Blades in the Dark's own bundle has "<strong>Assist
  // </strong> a teammate") — a literal "</script>" inside one would
  // otherwise prematurely terminate this inline script tag and corrupt
  // the page. Escaping every "<" to its unicode escape keeps the JSON
  // valid while making that sequence impossible to form in the raw HTML
  // text (same technique frameworks like Next.js use for inlined JSON;
  // simpler and UTF-8-safe than the CardPanel.js's own base64/atob()
  // pattern would be here, which mangles multi-byte characters — the
  // exact bug this file is not going to reintroduce).
  const configJson = JSON.stringify({ translationResourceKey, translationBundle }).replace(/</g, "\\u003c");
  return `<script>window.Roll20CompatConfig = ${configJson};</script>`;
}

/**
 * Injects a config <script> before </head> (or before <body if no </head>
 * exists) — same insertion point CardPanel.js's own CSS <link> injection
 * targets, so it's guaranteed to run before every additionalResources
 * script (same ordering guarantee bootstrap.js's own header describes for
 * the runtime bundle itself).
 */
export function injectConfigScript(html, configScript) {
  return html.includes("</head>")
    ? html.replace("</head>", configScript + "\n</head>")
    : html.replace("<body", configScript + "\n<body");
}
