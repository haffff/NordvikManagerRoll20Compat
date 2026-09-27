// sandbox/importedSheet.mjs
//
// Renders a Roll20 corpus sheet the way a real user gets it: the sheet's
// own files (read from a local checkout of Roll20's roll20-character-sheets
// repo) go through the importer's own transformUpload(), and the result is
// rendered by the built roll20sheet render shell inside an
// <iframe sandbox="allow-scripts"> — the same shell and sandbox flags as a
// Template created by the "Roll20 Sheet Importer" view. Nothing here is a
// sandbox-only reimplementation of the import or render path.
//
// Needs `pnpm run pack` first (the render shell is read from packed/).
//
// Corpus location: $ROLL20_SHEETS_DIR, or the default sibling checkout
// below. Clone https://github.com/Roll20/roll20-character-sheets anywhere
// and point the variable at it.
import path from "node:path";
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { transformUpload } from "../card_sources/roll20compat-importer/src/roll20Assembly.js";
import { FAKE_CARD_API_SCRIPT } from "./fakeCardApi.mjs";
import { openInCardSandbox } from "./cardSandboxFrame.mjs";

const sandboxDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(sandboxDir, "..");
export const outDir = path.join(sandboxDir, "output");

export const CORPUS_DIR =
  process.env.ROLL20_SHEETS_DIR ??
  path.resolve(repoRoot, "../../../roll20-analysis/roll20-character-sheets-master/roll20-character-sheets-master");

// The sheets `sandbox:check` runs by default: key (what a GM would type in
// the importer, and what per-sheet patches are matched on) -> corpus folder.
export const DEFAULT_SHEETS = {
  bladesinthedark: "Blades in the Dark",
  classictraveller: "Classic_Traveller",
  cthulhu7e: "Call_of_Cthulhu_7th_Ed",
  cyberpunkred: "Cyberpunk Red",
  cyberpunkredraycw: "CyberpunkRED_raycw",
  cyberpunkredtabbed: "Cyberpunk Red Tabbed",
  dnd5escrolls: "DnD5E Character Scrolls",
  dungeonworld: "Dungeon World by Roll20",
  fatecore: "Fate_Core",
  numenera: "Numenera",
  thirteenthage: "13th Age Glorantha",
  vampire: "CWOD-Vampire",
};

/** Resolves a key from DEFAULT_SHEETS, or treats the argument as a corpus folder name. */
export function resolveSheet(keyOrFolder) {
  if (DEFAULT_SHEETS[keyOrFolder]) return { key: keyOrFolder, folder: DEFAULT_SHEETS[keyOrFolder] };
  return { key: keyOrFolder.toLowerCase().replace(/[^a-z0-9_-]/g, ""), folder: keyOrFolder };
}

/**
 * Reads a corpus sheet folder with the same file selection as the
 * importer's GitHub catalog (githubCatalog.js): the folder's single .html,
 * its first .css, and translation.json if present.
 */
export function readCorpusSheet(folder) {
  const dir = path.join(CORPUS_DIR, folder);
  if (!existsSync(dir)) {
    throw new Error(`Corpus folder not found: ${dir} (set ROLL20_SHEETS_DIR to your roll20-character-sheets checkout)`);
  }
  const files = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name);
  const htmlFiles = files.filter((f) => f.toLowerCase().endsWith(".html"));
  if (htmlFiles.length !== 1) {
    throw new Error(`Expected exactly one .html in ${dir}, found ${htmlFiles.length}`);
  }
  const cssFile = files.find((f) => f.toLowerCase().endsWith(".css"));
  const translationFile = files.find((f) => f.toLowerCase() === "translation.json");
  const read = (f) => (f ? readFileSync(path.join(dir, f), "utf8") : null);
  return { rawHtml: read(htmlFiles[0]), ownCss: read(cssFile), translationJsonText: read(translationFile) };
}

/** The exact payload the importer view stores for this sheet (see App.jsx's finishImport). */
export function importedPayload(key, folder) {
  const { mainHtml, workerJs, sheetCss, rollTemplates, rollTemplateCss } = transformUpload(readCorpusSheet(folder));
  return { key, displayName: folder, mainHtml, workerJs, sheetCss, rollTemplates, rollTemplateCss };
}

// ── Built-card assembly (reads packed/, pack-cards.mjs's output) ──────────

const packedDir = path.join(repoRoot, "packed");
const ADDON_KEY_PREFIX = "roll20compat_";

function resourceFilePath(resourceKey) {
  if (!resourceKey.startsWith(ADDON_KEY_PREFIX)) throw new Error(`Unexpected resource key shape: "${resourceKey}"`);
  return path.join(packedDir, "Resources", resourceKey.slice(ADDON_KEY_PREFIX.length));
}

export function loadPackedManifest(subdir, filename) {
  const p = path.join(packedDir, subdir, filename);
  if (!existsSync(p)) {
    console.error(`Not found: ${p} — run "pnpm run pack" first.`);
    process.exit(1);
  }
  return JSON.parse(readFileSync(p, "utf8"));
}

/**
 * Reproduces CardPanel.js's card-HTML assembly (NordvikManagerFrontEnd's
 * game/panels/CardPanel.js) against local files: additional CSS/JS
 * resources are inlined as base64 data: URIs, CSS before </head> and JS
 * before </body> — byte-for-byte what the real iframe would receive.
 */
export function assembleCardHtml(manifest) {
  const rawHtml = readFileSync(resourceFilePath(manifest.mainResource), "utf8");
  const metas = (manifest.additionalResources ?? []).map((resKey) => {
    const filePath = resourceFilePath(resKey);
    const mimeType = filePath.endsWith(".css") ? "text/css" : filePath.endsWith(".js") ? "text/javascript" : null;
    return { mimeType, data: readFileSync(filePath).toString("base64") };
  });
  const cssStyles = metas
    .filter((m) => m.mimeType === "text/css" && m.data)
    .map((m) => `<link rel="stylesheet" href="data:text/css;base64,${m.data}">`)
    .join("\n");
  const jsScripts = metas
    .filter((m) => m.mimeType === "text/javascript" && m.data)
    .map((m) => `<script src="data:text/javascript;base64,${m.data}"></script>`)
    .join("\n");
  let html = cssStyles
    ? rawHtml.includes("</head>")
      ? rawHtml.replace("</head>", cssStyles + "\n</head>")
      : rawHtml.replace("<body", cssStyles + "\n<body")
    : rawHtml;
  html = html.includes("</body>") ? html.replace("</body>", jsScripts + "\n</body>") : html + jsScripts;
  return html;
}

// ── Rendering an imported sheet ───────────────────────────────────────────

const CONTENT_ID = "sandbox-imported-template";

function rendererInitScript(payload) {
  return (
    FAKE_CARD_API_SCRIPT.replace(/^<script>/, "").replace(/<\/script>$/, "") +
    `
window.__sandboxProps['roll20compat_content_id'] = ${JSON.stringify(CONTENT_ID)};
const __originalGlobal = window.CardAPI.Resources.Global;
window.CardAPI.Resources.Global = Object.assign({}, __originalGlobal, {
  Read: async (key) =>
    key === ${JSON.stringify(`roll20compat_sheet_${CONTENT_ID}`)} ? ${JSON.stringify(JSON.stringify(payload))} : __originalGlobal.Read(key),
});
window.addEventListener('DOMContentLoaded', () => {
  setTimeout(() => window.dispatchEvent(new Event('cardapi:ready')), 0);
});
`
  );
}

/**
 * Opens `payload` (see importedPayload) in the built render shell inside a
 * card-sandboxed iframe. Returns { context, page, frame, consoleErrors };
 * the caller closes `context`. Resolves once the sheet has been written
 * into the frame and the runtime has had a moment to settle.
 */
export async function openImportedSheet(browser, payload, { viewport = { width: 900, height: 1400 } } = {}) {
  mkdirSync(outDir, { recursive: true });
  const shellPath = path.join(outDir, `${payload.key}_shell.html`);
  writeFileSync(shellPath, assembleCardHtml(loadPackedManifest("Templates", "roll20sheet_template.json")));

  const context = await browser.newContext({ viewport });
  await context.addInitScript(rendererInitScript(payload));
  const page = await context.newPage();
  const consoleErrors = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("pageerror", (err) => consoleErrors.push(String(err)));

  const frame = await openInCardSandbox(page, shellPath);
  await frame.waitForSelector(".charsheet", { timeout: 10000 });
  // bootstrap.js's Properties.Init/Get round trips and repeatingBinding's
  // whenReady chain resolve through Promises — let them settle.
  await page.waitForTimeout(300);
  return { context, page, frame, consoleErrors };
}
