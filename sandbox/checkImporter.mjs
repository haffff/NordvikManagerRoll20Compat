#!/usr/bin/env node
// sandbox/checkImporter.mjs
//
// End-to-end Playwright check of the two cards that make up the runtime
// import feature:
//   1. card_sources/roll20compat-importer/ — the "Roll20 Sheet Importer"
//      View. Upload form -> FireAction('roll20compat/create_imported_template')
//      -> poll for the new Template's id -> Resources.Global.Upsert the
//      transformed sheet content. This View never renders a sheet itself.
//   2. card_sources/roll20compat-sheetrenderer/ — the shell cloned into that
//      new Template (and, from then on, into any character card created
//      from it). Reads its own `roll20compat_content_id` property, reads the
//      matching Global resource, and renders the assembled sheet in place.
//
// Run as two independent phases against two separately-assembled cards,
// rather than one continuous flow through a real backend — this proves each
// card's own logic in isolation (real transform pipeline, real DOM
// rendering) without needing an actual Action-processing backend. Phase B is
// seeded with the EXACT content Phase A's real transformUpload() pipeline
// produced (captured via a mocked FireAction/Resources.Global.Upsert in
// Phase A), so it's still a genuine, non-trivial correctness check of the
// full mainHtml/workerJs/sheetCss handoff between the two cards, not just
// each one tested against a hand-written fixture.
//
// Usage: node scripts/pack-cards.mjs && node sandbox/checkImporter.mjs
import { chromium } from "playwright";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, writeFileSync, mkdirSync } from "node:fs";
import { FAKE_CARD_API_SCRIPT } from "./fakeCardApi.mjs";
import { openInCardSandbox } from "./cardSandboxFrame.mjs";
import { assembleCardHtml, loadPackedManifest, CORPUS_DIR } from "./importedSheet.mjs";

const sandboxDir = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(sandboxDir, "output");

const corpusRoot = path.join(CORPUS_DIR, "Numenera");
const fixtureHtml = path.join(corpusRoot, "Numenera.html");
const fixtureCss = path.join(corpusRoot, "Numenera.css");

const FAKE_TEMPLATE_ID = "e2e-fake-template-id";

let failures = 0;
const check = (label, cond) => {
  if (cond) {
    console.log(`ok   ${label}`);
  } else {
    failures++;
    console.error(`FAIL ${label}`);
  }
};

async function main() {
  if (!existsSync(fixtureHtml) || !existsSync(fixtureCss)) {
    console.error(`Fixture sheet not found under ${corpusRoot} — set ROLL20_SHEETS_DIR to your roll20-character-sheets checkout.`);
    process.exit(1);
  }
  mkdirSync(outDir, { recursive: true });

  const browser = await chromium.launch();

  // ── Phase A: the Importer View — upload -> create_imported_template -> Upsert ──
  const viewManifest = loadPackedManifest("Views", "roll20_importer_view.json");
  const assembledViewHtml = assembleCardHtml(viewManifest);
  const assembledViewPath = path.join(outDir, "roll20importerview.html");
  writeFileSync(assembledViewPath, assembledViewHtml);

  const VIEW_MOCK_SCRIPT =
    FAKE_CARD_API_SCRIPT.replace(/^<script>/, "").replace(/<\/script>$/, "") +
    `
window.__captured = { fireActions: [], globalUpserts: [] };
const globalStore = {};
window.CardAPI.Resources.Global = {
  Read: async (key) => globalStore[key] ?? null,
  Upsert: async (key, data, name, mimeType) => {
    window.__captured.globalUpserts.push({ key, data, name, mimeType });
    globalStore[key] = data;
    return 'mock-resource-id';
  },
};
window.CardAPI.FireAction = (action, args) => {
  window.__captured.fireActions.push({ action, args });
  if (action === 'roll20compat/create_imported_template') {
    // Simulates create_imported_template.json's real 3 steps (CreateCard +
    // SetProperty + SetResource) — publishes the "result" resource the
    // View's pollResource() call is waiting on.
    globalStore['roll20compat_create_result_' + args.jobId] = ${JSON.stringify(FAKE_TEMPLATE_ID)};
  }
};
window.addEventListener('DOMContentLoaded', () => {
  setTimeout(() => window.dispatchEvent(new Event('cardapi:ready')), 0);
});
`;

  const viewContext = await browser.newContext();
  await viewContext.addInitScript(VIEW_MOCK_SCRIPT);
  const viewPage = await viewContext.newPage();
  const viewConsoleErrors = [];
  viewPage.on("console", (msg) => {
    if (msg.type() === "error") viewConsoleErrors.push(msg.text());
  });
  viewPage.on("pageerror", (err) => viewConsoleErrors.push(String(err)));

  const view = await openInCardSandbox(viewPage, assembledViewPath);
  await view.waitForSelector(".roll20importer_container", { timeout: 5000 });
  check("View renders the import form (never a 'resume previous import' state)", true);

  await view.fill('input[placeholder="e.g. bladesinthedark"]', "numenera_e2e");
  await view.fill('input[placeholder="e.g. Blades in the Dark"]', "Numenera (E2E check)");
  await view.setInputFiles('input[type="file"][accept=".html"]', fixtureHtml);
  await view.setInputFiles('input[type="file"][accept=".css"]', fixtureCss);

  const submitButton = view.locator("button", { hasText: "Import Sheet" });
  check("submit button enables once required fields are filled", await submitButton.isEnabled());
  await submitButton.click();

  await view.waitForSelector("text=imported as a Template", { timeout: 5000 });
  check('View shows a success message ("imported as a Template"), not a rendered sheet', true);

  const captured = await view.evaluate(() => window.__captured);
  check(
    "View fired create_imported_template with the display name",
    captured.fireActions.some(
      (c) => c.action === "roll20compat/create_imported_template" && c.args?.name === "Numenera (E2E check)"
    )
  );

  const upsert = captured.globalUpserts.find((u) => u.key === `roll20compat_sheet_${FAKE_TEMPLATE_ID}`);
  check("View stored the transformed sheet under roll20compat_sheet_<newTemplateId>", !!upsert);

  let storedPayload = null;
  if (upsert) {
    storedPayload = JSON.parse(upsert.data);
    check(
      "stored payload has real transformed HTML content",
      typeof storedPayload.mainHtml === "string" && storedPayload.mainHtml.length > 0
    );
    check("stored payload carries the GM-supplied key (used for patch matching)", storedPayload.key === "numenera_e2e");
  } else {
    failures++;
    console.error("FAIL stored payload has real transformed HTML content (no upsert captured)");
  }

  check(
    `no console errors in the View flow (${viewConsoleErrors.length} found)`,
    viewConsoleErrors.length === 0
  );
  if (viewConsoleErrors.length) viewConsoleErrors.forEach((e) => console.error(`  - ${e}`));

  await viewContext.close();

  // ── Phase B: the sheet-renderer shell — property+resource -> real render ──
  const templateManifest = loadPackedManifest("Templates", "roll20sheet_template.json");
  const assembledRendererHtml = assembleCardHtml(templateManifest);
  const assembledRendererPath = path.join(outDir, "roll20sheet_rendered.html");
  writeFileSync(assembledRendererPath, assembledRendererHtml);

  const RENDERER_MOCK_SCRIPT =
    FAKE_CARD_API_SCRIPT.replace(/^<script>/, "").replace(/<\/script>$/, "") +
    `
window.CardAPI.Properties.Get = async (name) => {
  if (name === 'roll20compat_content_id') return { value: ${JSON.stringify(FAKE_TEMPLATE_ID)} };
  return null;
};
window.CardAPI.Resources.Global = {
  Read: async (key) => (key === ${JSON.stringify(`roll20compat_sheet_${FAKE_TEMPLATE_ID}`)} ? ${JSON.stringify(
    JSON.stringify(storedPayload)
  )} : null),
};
window.addEventListener('DOMContentLoaded', () => {
  setTimeout(() => window.dispatchEvent(new Event('cardapi:ready')), 0);
});
// Stand-in for the REAL CardAPI bridge (NordvikManagerFrontEnd's
// cardSandbox.js), which receives every RPC reply and property event
// through a window "message" listener registered before any card code
// runs. The fake CardAPI above is in-memory and needs no listener, so
// without this canary the sandbox can't see a render step that wipes
// window listeners — document.open() did exactly that, silently breaking
// every property read/write/subscription of every imported sheet live.
window.__bridgeCanary = [];
window.addEventListener('message', (e) => { if (e.data === 'bridge-canary') window.__bridgeCanary.push(e.data); });
`;

  const rendererContext = await browser.newContext();
  await rendererContext.addInitScript(RENDERER_MOCK_SCRIPT);
  const rendererPage = await rendererContext.newPage();
  const rendererConsoleErrors = [];
  rendererPage.on("console", (msg) => {
    if (msg.type() === "error") rendererConsoleErrors.push(msg.text());
  });
  rendererPage.on("pageerror", (err) => rendererConsoleErrors.push(String(err)));

  const renderer = await openInCardSandbox(rendererPage, assembledRendererPath);
  await renderer.waitForSelector('[name^="attr_"]', { timeout: 5000 });
  const attrCount = await renderer.locator('[name^="attr_"]').count();
  check("renderer shell renders the View's stored content with real attr_* bound elements", attrCount > 0);

  const hasCharsheetWrapper = await renderer.locator(".charsheet").count();
  check("wrapCharsheet's .ui-dialog/.charsheet wrapper is present in the rendered document", hasCharsheetWrapper > 0);

  const survivedCardApi = await renderer.evaluate(
    () => typeof window.CardAPI?.Resources?.Global?.Read === "function"
  );
  check("window.CardAPI survives rendering the sheet in the renderer shell", survivedCardApi);

  await renderer.evaluate(() => window.postMessage("bridge-canary", "*"));
  await rendererPage.waitForTimeout(200);
  const canaryHits = await renderer.evaluate(() => window.__bridgeCanary?.length ?? 0);
  check(
    "a window message listener registered before rendering (like the real CardAPI bridge's) still receives messages after the sheet is rendered",
    canaryHits === 1
  );

  check(
    `no console errors in the renderer flow (${rendererConsoleErrors.length} found)`,
    rendererConsoleErrors.length === 0
  );
  if (rendererConsoleErrors.length) rendererConsoleErrors.forEach((e) => console.error(`  - ${e}`));

  await rendererContext.close();

  // ── Phase C: renderer shell with NO content yet — visible message, not blank ──
  const NO_CONTENT_MOCK_SCRIPT =
    FAKE_CARD_API_SCRIPT.replace(/^<script>/, "").replace(/<\/script>$/, "") +
    `
window.CardAPI.Properties.Get = async () => null;
window.CardAPI.Resources.Global = { Read: async () => null };
window.addEventListener('DOMContentLoaded', () => {
  setTimeout(() => window.dispatchEvent(new Event('cardapi:ready')), 0);
});
`;
  const noContentContext = await browser.newContext();
  await noContentContext.addInitScript(NO_CONTENT_MOCK_SCRIPT);
  const noContentPage = await noContentContext.newPage();
  const noContent = await openInCardSandbox(noContentPage, assembledRendererPath);
  await noContent.waitForSelector("text=Roll20 Sheet Importer", { timeout: 5000 });
  check("opening the raw seed Template (no content_id yet) shows a visible message, not a blank page", true);
  await noContentContext.close();

  await browser.close();

  console.log(failures === 0 ? "\nAll importer checks passed." : `\n${failures} importer check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
