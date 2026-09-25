#!/usr/bin/env node
// sandbox/inspect.mjs
//
// Ad-hoc devtools-style query against an assembled sheet, driven by
// Playwright instead of asking someone to paste a devtools snippet by
// hand and report back the result — the round trip this whole sandbox
// exists to shortcut. The expression runs inside the page via
// page.evaluate() and its return value is printed as JSON.
//
// Usage:
//   node sandbox/inspect.mjs <key-or-corpus-folder> "<JS expression>"
//
// The expression runs inside the imported sheet's sandboxed frame (see
// importedSheet.mjs). Needs "pnpm run pack" first.
//
// Example (the Blades in the Dark settings-panel mystery):
//   node sandbox/inspect.mjs bladesinthedark \
//     "(() => { const h = document.querySelector('input.hider[name=\"attr_show_settings\"]'); return { attrValue: h.getAttribute('value'), domValue: h.value, settingsDisplay: getComputedStyle(h.nextElementSibling).display }; })()"
import { chromium } from "playwright";
import { resolveSheet, importedPayload, openImportedSheet } from "./importedSheet.mjs";

async function main() {
  const [key, expression] = process.argv.slice(2);
  if (!key || !expression) {
    console.error('Usage: node sandbox/inspect.mjs <key-or-corpus-folder> "<JS expression>"');
    process.exit(1);
  }
  const { key: sheetKey, folder } = resolveSheet(key);

  const browser = await chromium.launch();
  const { frame, consoleErrors } = await openImportedSheet(browser, importedPayload(sheetKey, folder));
  consoleErrors.forEach((e) => console.error("[console.error]", e));

  const result = await frame.evaluate(expression);
  console.log(JSON.stringify(result, null, 2));

  await browser.close();
}

main();
