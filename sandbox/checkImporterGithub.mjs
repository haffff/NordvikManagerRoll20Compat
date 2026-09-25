#!/usr/bin/env node
// sandbox/checkImporterGithub.mjs
//
// End-to-end Playwright check of the "Browse GitHub" tab in the "Roll20
// Sheet Importer" View (see githubCatalog.js). Uses a SYNTHETIC GitHub tree
// + file content (never hits the real GitHub API) so this stays hermetic,
// fast, and doesn't burn real rate-limit quota just from running the test
// suite — the fetch_github_tree/fetch_github_file Actions themselves
// (SendRequest+SetResource against real GitHub URLs) aren't exercised here;
// this only proves the CARD's own logic (parsing a tree response, filtering
// to valid sheet folders, driving FireAction with the right args, polling
// for the result) feeding into the same create_imported_template flow
// sandbox/checkImporter.mjs already validates for the upload path — the
// View shows a success message, it does not render a sheet itself anymore.
//
// Usage: node scripts/pack-cards.mjs && node sandbox/checkImporterGithub.mjs
import { chromium } from "playwright";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync, mkdirSync } from "node:fs";
import { FAKE_CARD_API_SCRIPT } from "./fakeCardApi.mjs";
import { openInCardSandbox } from "./cardSandboxFrame.mjs";
import { assembleCardHtml, loadPackedManifest } from "./importedSheet.mjs";

const sandboxDir = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(sandboxDir, "output");

// A minimal, plausible GitHub Git Trees API response: one valid sheet
// folder ("Fake Sheet", one .html + one .css — matches parseTree()'s
// "exactly one .html per folder" filter) plus deliberate noise entries
// that must NOT show up as pickable sheets: a root-level file (no folder),
// a folder with zero .html files, and a folder with two .html files.
const FAKE_TREE = JSON.stringify({
  tree: [
    { path: "README.md", type: "blob" },
    { path: "Fake Sheet/Fake Sheet.html", type: "blob" },
    { path: "Fake Sheet/Fake Sheet.css", type: "blob" },
    { path: "No Html Folder/notes.txt", type: "blob" },
    { path: "Two Html Folder/a.html", type: "blob" },
    { path: "Two Html Folder/b.html", type: "blob" },
  ],
});
const FAKE_SHEET_HTML = '<div class="charsheet"><input name="attr_hp" value="10"></div>';
const FAKE_SHEET_CSS = ".charsheet { color: red; }";
const FAKE_TEMPLATE_ID = "e2e-fake-template-id-github";

const MOCK_CARDAPI_SCRIPT =
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
  if (action === 'roll20compat/fetch_github_tree') {
    globalStore['roll20compat_github_tree'] = ${JSON.stringify(FAKE_TREE)};
    return;
  }
  if (action === 'roll20compat/fetch_github_file') {
    var content = args.url.indexOf('.css') !== -1 ? ${JSON.stringify(FAKE_SHEET_CSS)} : ${JSON.stringify(FAKE_SHEET_HTML)};
    globalStore[args.resourceKey] = content;
    return;
  }
  if (action === 'roll20compat/create_imported_template') {
    globalStore['roll20compat_create_result_' + args.jobId] = ${JSON.stringify(FAKE_TEMPLATE_ID)};
    return;
  }
  console.warn('unhandled FireAction in test', action, args);
};
window.addEventListener('DOMContentLoaded', () => {
  setTimeout(() => window.dispatchEvent(new Event('cardapi:ready')), 0);
});
`;

async function main() {
  const viewManifest = loadPackedManifest("Views", "roll20_importer_view.json");
  mkdirSync(outDir, { recursive: true });
  const assembledHtml = assembleCardHtml(viewManifest);
  const assembledPath = path.join(outDir, "roll20importerview_github.html");
  writeFileSync(assembledPath, assembledHtml);

  const browser = await chromium.launch();
  const context = await browser.newContext();
  await context.addInitScript(MOCK_CARDAPI_SCRIPT);
  const page = await context.newPage();
  const consoleErrors = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("pageerror", (err) => consoleErrors.push(String(err)));

  let failures = 0;
  const check = (label, cond) => {
    if (cond) console.log(`ok   ${label}`);
    else {
      failures++;
      console.error(`FAIL ${label}`);
    }
  };

  const view = await openInCardSandbox(page, assembledPath);
  await view.waitForSelector(".roll20importer_container", { timeout: 5000 });

  await view.click("text=Browse GitHub");
  await view.waitForSelector(".roll20importer_catalog_list", { timeout: 5000 });

  const items = await view.locator(".roll20importer_catalog_item, .roll20importer_catalog_item_active").allTextContents();
  check('catalog lists the one valid sheet ("Fake Sheet")', items.includes("Fake Sheet"));
  check("catalog excludes a folder with zero .html files", !items.includes("No Html Folder"));
  check("catalog excludes a folder with more than one .html file", !items.includes("Two Html Folder"));

  await view.click("text=Fake Sheet");
  await view.waitForSelector('text=ready to import', { timeout: 5000 });
  check('picking a sheet auto-fills Key from its folder name', (await view.inputValue('input[placeholder="e.g. bladesinthedark"]')) === "fakesheet");
  check(
    "picking a sheet auto-fills Display Name from its folder name",
    (await view.inputValue('input[placeholder="e.g. Blades in the Dark"]')) === "Fake Sheet"
  );

  const submitButton = view.locator("button", { hasText: "Import Sheet" });
  check("submit enables once the GitHub-fetched sheet is ready", await submitButton.isEnabled());
  await submitButton.click();

  await view.waitForSelector("text=imported as a Template", { timeout: 5000 });
  check('View shows a success message ("imported as a Template") for the GitHub-sourced sheet too', true);

  const captured = await view.evaluate(() => window.__captured);
  const upsert = captured.globalUpserts.find((u) => u.key === `roll20compat_sheet_${FAKE_TEMPLATE_ID}`);
  check("View stored the GitHub-sourced sheet under roll20compat_sheet_<newTemplateId>", !!upsert);
  if (upsert) {
    const stored = JSON.parse(upsert.data);
    check("stored payload contains the real GitHub-fetched HTML", stored.mainHtml?.includes('name="attr_hp"'));
  }

  check(`no console errors across the whole flow (${consoleErrors.length} found)`, consoleErrors.length === 0);
  if (consoleErrors.length) consoleErrors.forEach((e) => console.error(`  - ${e}`));

  await browser.close();
  console.log(failures === 0 ? "\nAll GitHub-browse checks passed." : `\n${failures} GitHub-browse check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
