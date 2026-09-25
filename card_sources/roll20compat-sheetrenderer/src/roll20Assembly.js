// The "assemble one renderable document" half of what used to be
// roll20compat-importer/src/roll20Assembly.js — moved here because it's the
// cloned Template's job now, not the importer View's (see that file's own
// header). Runs inside the sandboxed Card iframe, in whichever player's
// browser opened this specific character card.
//
// The 7 shared runtime files, in a fixed load order — order is load-bearing (see
// bootstrap.js's own header: it must run AFTER the sheet's own body markup
// already exists in the DOM, and BEFORE the sheet's own worker script).
// Static `?raw` imports, not a loop over a filename array, because ES
// module import specifiers must be static string literals; adding a runtime
// file means adding both its import and its place in the ORDER array below.
import { scopeSheetCss } from "../../roll20compat-shared/tools/sheetTransform.mjs";
import attrBindingJs from "../../roll20compat-shared/runtime/attrBinding.js?raw";
import repeatingBindingJs from "../../roll20compat-shared/runtime/repeatingBinding.js?raw";
import translationFillJs from "../../roll20compat-shared/runtime/translationFill.js?raw";
import sheetWorkerShimJs from "../../roll20compat-shared/runtime/sheetWorkerShim.js?raw";
import rollDispatchJs from "../../roll20compat-shared/runtime/rollDispatch.js?raw";
import rollButtonsJs from "../../roll20compat-shared/runtime/rollButtons.js?raw";
import bootstrapJs from "../../roll20compat-shared/runtime/bootstrap.js?raw";
import roll20BaseCss from "../../roll20compat-shared/runtime/roll20-base.css?raw";

// Every CSS-only per-sheet patch (see patches/bladesinthedark.css for a
// concrete example), keyed by filename without extension — i.e. the same
// `key` an imported sheet was given. Adding a new patch file needs NO change
// here: eager+glob picks it up at the next addon build automatically, and —
// because matching happens at render time, not at import time — it applies
// to sheets imported before the patch shipped too, next time they're opened.
const patchModules = import.meta.glob("../../roll20compat-shared/patches/*.css", {
  query: "?raw",
  import: "default",
  eager: true,
});
const patches = Object.fromEntries(
  Object.entries(patchModules).map(([path, css]) => {
    const filename = path.split("/").pop();
    return [filename.replace(/\.css$/, ""), css];
  })
);

// UTF-8-safe base64 — plain btoa() only handles Latin1 and mangles
// multi-byte characters (real sheet content has them — accented names,
// smart quotes, etc.).
function toBase64Utf8(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function dataUri(mimeType, text) {
  return `data:${mimeType};base64,${toBase64Utf8(text)}`;
}

/**
 * Builds one complete, renderable HTML document from a stored sheet record
 * ({mainHtml, workerJs, sheetCss, key} — see roll20compat-importer's
 * transformUpload for the shape) — the same technique CardPanel.js uses
 * for a card's resources (CSS/JS inlined as base64 data: URIs, loaded via
 * <link>/<script src>), just done client-side at open-time. Deliberately NOT
 * inline <script>/<style> content: the GM-supplied worker JS is untrusted
 * third-party text that could contain a literal "</script>" (in a string or
 * comment) and break out of an inline block. data: URIs have no such risk.
 */
export function assembleRenderableDocument({ mainHtml, workerJs, sheetCss, key }) {
  const patchCss = key ? patches[key] : undefined;

  const cssLinks = [
    `<link rel="stylesheet" href="${dataUri("text/css", roll20BaseCss)}">`,
    // Scoped at render time (not import time) so already-imported sheets pick
    // up any change to how Roll20's CSS scoping is reproduced — see
    // scopeSheetCss.
    sheetCss ? `<link rel="stylesheet" href="${dataUri("text/css", scopeSheetCss(sheetCss))}">` : "",
    patchCss ? `<link rel="stylesheet" href="${dataUri("text/css", patchCss)}">` : "",
  ]
    .filter(Boolean)
    .join("\n");

  // Fixed load order — sheetWorkerShim.js only when a worker is present, and
  // the worker script itself always comes LAST (bootstrap.js's
  // SheetWorkerShim.install() must define on()/getAttrs()/etc. as globals
  // before the worker script's own top-level code can call them).
  const scripts = [
    attrBindingJs,
    repeatingBindingJs,
    translationFillJs,
    ...(workerJs ? [sheetWorkerShimJs] : []),
    rollDispatchJs,
    rollButtonsJs,
    bootstrapJs,
    ...(workerJs ? [workerJs] : []),
  ];
  const scriptTags = scripts.map((s) => `<script src="${dataUri("text/javascript", s)}"></script>`).join("\n");

  let html = mainHtml.includes("</head>")
    ? mainHtml.replace("</head>", cssLinks + "\n</head>")
    : mainHtml.replace("<body", cssLinks + "\n<body");

  html = html.includes("</body>") ? html.replace("</body>", scriptTags + "\n</body>") : html + scriptTags;

  return html;
}

/**
 * Swaps the assembled sheet into the CURRENT document (this card's own
 * sandboxed iframe) in place: <html>/<body> attributes and <head>/<body>
 * contents are replaced, and every <script> is recreated so it runs.
 *
 * Deliberately NOT document.open()/write(): document.open() erases every
 * event listener on window, including the CardAPI bridge's own "message"
 * listener (NordvikManagerFrontEnd's cardSandbox.js), which is how every
 * CardAPI reply and property event reaches this iframe. The window.CardAPI
 * object survived, so the sheet rendered — but every Properties.Get/Init
 * then waited forever and no subscription ever fired: page switches,
 * sheet-worker calculations and repeating-row adds all silently did
 * nothing, on every imported sheet.
 *
 * Script order: src scripts get async = false, so they execute in
 * insertion order (runtime files, then bootstrap.js, then the sheet's
 * worker — see assembleRenderableDocument). An inline script runs as soon
 * as it's inserted, which is what the translation-config script in <head>
 * needs (it must exist before any runtime file runs).
 */
export function renderDocument(html) {
  const next = new DOMParser().parseFromString(html, "text/html");

  const copyAttributes = (from, to) => {
    for (const attr of [...to.attributes]) to.removeAttribute(attr.name);
    for (const attr of from.attributes) to.setAttribute(attr.name, attr.value);
  };
  copyAttributes(next.documentElement, document.documentElement);
  copyAttributes(next.body, document.body);

  const liveScript = (parsed) => {
    const script = document.createElement("script");
    for (const attr of parsed.attributes) script.setAttribute(attr.name, attr.value);
    if (parsed.src) script.async = false;
    else script.textContent = parsed.textContent;
    return script;
  };
  const adopt = (parsedParent, liveParent) => {
    liveParent.replaceChildren();
    for (const node of [...parsedParent.childNodes]) {
      liveParent.appendChild(node.nodeName === "SCRIPT" ? liveScript(node) : document.importNode(node, true));
    }
  };
  adopt(next.head, document.head);
  // Scripts nested deeper than <body>'s direct children would stay inert
  // after importNode — recreate those in place too.
  adopt(next.body, document.body);
  for (const parsed of [...document.body.querySelectorAll("script")]) {
    if (parsed.parentNode !== document.body) parsed.replaceWith(liveScript(parsed));
  }
}
