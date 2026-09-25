#!/usr/bin/env node
// sandbox/check.mjs
//
// Imports Roll20 corpus sheets through the real importer transform and
// render shell (see importedSheet.mjs), in a real Chromium via Playwright,
// and reports console errors + whether every attr_* field with an authored
// default actually shows it after load + dead CSS selectors + a full-page
// screenshot.
//
// Usage: node sandbox/check.mjs [key-or-corpus-folder ...]
//   no arguments = every sheet in importedSheet.mjs's DEFAULT_SHEETS.
//   A key from that list, or any corpus folder name ("Star Wars D6"), works.
// Needs "pnpm run pack" first.
import { chromium } from "playwright";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { writeFileSync, mkdirSync } from "node:fs";
import { DEFAULT_SHEETS, resolveSheet, importedPayload, openImportedSheet, outDir } from "./importedSheet.mjs";

// Every ".sheet-X" class SELECTOR the sheet's own CSS declares (not
// roll20-base.css or the shared runtime CSS — just the sheet's own
// authored stylesheet, since that's where a class-prefixing gap would show
// up). Deliberately naive (no comment/string awareness) — good enough as a
// diagnostic signal, not parsed for correctness-critical logic anywhere
// else. See sheetTransform.mjs's prefixSheetClasses() header for why this
// check exists: a sheet whose CSS assumes "sheet-"-prefixed HTML classes
// that never actually get prefixed produces ZERO console errors and only
// shows up as dead selectors + an anomalously tall page (every
// display:none-by-default section staying visible at once).
const CSS_CLASS_SELECTOR_RE = /\.sheet-[a-zA-Z0-9_-]+/g;

function sheetOwnCssSelectors(css) {
  if (!css) return [];
  const all = css.match(CSS_CLASS_SELECTOR_RE) ?? [];
  // .sheet-rolltemplate-* is always dead by design — stripRollTemplates()
  // deletes the <rolltemplate> blocks those selectors target entirely (see
  // its own header), so counting them here is expected noise, not signal.
  return [...new Set(all.filter((s) => !s.startsWith(".sheet-rolltemplate-")))];
}

async function checkSheet(browser, key, folder) {
  mkdirSync(outDir, { recursive: true });
  const payload = importedPayload(key, folder);
  // The transformed sheet markup exactly as the render shell writes it, for
  // the JS-disabled baseline read below.
  const htmlPath = path.join(outDir, `${key}.html`);
  writeFileSync(htmlPath, payload.mainHtml);

  // A separate, JS-DISABLED page loads the exact same static HTML purely to
  // capture each element's ORIGINAL authored `value` attribute before any
  // script can touch it. attrBinding.js/repeatingBinding.js now correctly
  // mirror a live value onto the HTML attribute too (not just the DOM
  // property — a real, confirmed fix: Roll20's "hider" convention reads
  // that attribute directly via CSS, e.g. `.hider[value="0"] + div`, and
  // never seeing it updated meant a toggle could open a panel but never
  // close it again). That fix means the live page's OWN `getAttribute
  // ("value")` no longer reflects the authored default once the runtime
  // has run — this check needs its baseline from an untouched copy.
  const staticContext = await browser.newContext({ javaScriptEnabled: false });
  const staticPage = await staticContext.newPage();
  await staticPage.goto(pathToFileURL(htmlPath).href);
  const authoredDefaults = await staticPage.evaluate(() => {
    // Excludes repeating-section fields the same way the LIVE page's own
    // loop does (via .repcontainer there) — but the static/unprocessed
    // page never runs repeatingBinding.js, so its original
    // fieldset[class*="repeating_"] template row is still right where it
    // was authored, unemptied. Matching the exclusion on BOTH sides by
    // filtering here too (rather than relying on positional index
    // alignment across two structurally different DOM trees, which a
    // repeating section would break) is what keeps this array's order
    // 1:1 with the live page's own post-filter element list below.
    const isRepeating = (el) => !!el.closest('fieldset[class*="repeating_"]');
    return Array.from(document.querySelectorAll('[name^="attr_"]'))
      .filter((el) => !isRepeating(el))
      .map((el) => ({
        isFormEl: el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT",
        tagName: el.tagName,
        type: el.type,
        disabled: el.disabled,
        value: el.getAttribute("value") || "",
        text: (el.textContent || "").trim(),
      }));
  });
  await staticContext.close();

  // Live copy: rendered by the real render shell inside the real card
  // sandbox flags (see importedSheet.mjs), so anything the sandbox blocks
  // fails here too.
  const { context, page, frame, consoleErrors } = await openImportedSheet(browser, payload);

  // Reads the LIVE DOM value against the ORIGINAL markup's own authored
  // default (captured above, from the untouched JS-disabled copy) — an
  // unbound field and a bound-but-empty one are visually identical in a
  // screenshot, but not against this check.
  const missingDefaults = await frame.evaluate((authoredDefaults) => {
    const missing = [];
    // Filtered FIRST, then indexed — so index i lines up 1:1 with
    // authoredDefaults (built the same way, from the same static markup,
    // on the JS-disabled page above). Cloned repeating rows live inside
    // the .repcontainer sibling repeatingBinding.js inserts after each
    // authored fieldset (matches real Roll20's own DOM structure — see
    // that file's own header), not inside the fieldset itself, which it
    // empties and hides once the template row is extracted — iterating
    // the unfiltered live list here would drift out of alignment with
    // authoredDefaults the moment any repeating section precedes a
    // non-repeating field being checked.
    const liveEls = Array.from(document.querySelectorAll('[name^="attr_"]')).filter(
      (el) => !el.closest(".repcontainer")
    );
    liveEls.forEach((el, i) => {
      const baseline = authoredDefaults[i];
      // More live fields than authored ones: the sheet's own script (or a
      // class toggle) added attr_ elements after load. Positions past the
      // authored list have no baseline to compare against.
      if (!baseline) return;
      const isFormEl = baseline.isFormEl;
      let authoredDefault, liveValue;
      if (!isFormEl) {
        authoredDefault = baseline.text;
        liveValue = (el.textContent || "").trim();
      } else if (el.type === "checkbox" || el.type === "radio") {
        return; // presence-based, not a text default — out of scope here
      } else if (baseline.tagName === "SELECT") {
        return; // a "value" HTML attribute on <select> is never meaningful — selection comes from which <option> has "selected", not this
      } else if (baseline.disabled && baseline.value.includes("@{")) {
        // Autocalc (attrBinding.js's own classifyInput heuristic): a
        // disabled input whose value is itself a formula is EXPECTED to
        // have that formula text replaced by a computed number, not
        // preserved — this is not a "missing default", it's the opposite.
        return;
      } else {
        authoredDefault = baseline.value;
        liveValue = el.value || "";
      }
      if (authoredDefault && liveValue !== authoredDefault) {
        missing.push({ name: el.getAttribute("name"), authoredDefault, liveValue });
      }
    });
    return missing;
  }, authoredDefaults);

  const selectors = sheetOwnCssSelectors(payload.sheetCss);
  const deadSelectors = selectors.length
    ? await frame.evaluate((sels) => sels.filter((s) => document.querySelectorAll(s).length === 0), selectors)
    : [];

  const screenshotPath = path.join(outDir, `${key}.png`);
  const pageHeight = await frame.evaluate(() => document.documentElement.scrollHeight);
  // Grow the iframe to the sheet's full height so the full-page screenshot
  // captures the whole sheet, not just the first viewport of it.
  await page.evaluate((h) => { document.getElementById("card").style.height = h + "px"; }, pageHeight);
  await page.screenshot({ path: screenshotPath, fullPage: true });

  await context.close();
  return { key, consoleErrors, missingDefaults, screenshotPath, selectors, deadSelectors, pageHeight };
}

async function main() {
  const args = process.argv.slice(2);
  const sheets = (args.length > 0 ? args : Object.keys(DEFAULT_SHEETS)).map(resolveSheet);

  const browser = await chromium.launch();
  let hadIssues = false;
  for (const { key, folder } of sheets) {
    const result = await checkSheet(browser, key, folder);
    console.log(`\n=== ${key} ===`);
    console.log(`Screenshot: ${path.relative(process.cwd(), result.screenshotPath)} (page height: ${result.pageHeight}px)`);
    if (result.selectors.length) {
      const ratio = `${result.deadSelectors.length}/${result.selectors.length}`;
      console.log(`Dead .sheet-* selectors (matched 0 elements): ${ratio}`);
      if (result.deadSelectors.length) console.log(`  ${result.deadSelectors.slice(0, 10).join(", ")}${result.deadSelectors.length > 10 ? ", ..." : ""}`);
    }
    if (result.consoleErrors.length) {
      hadIssues = true;
      console.log(`Console errors (${result.consoleErrors.length}):`);
      result.consoleErrors.forEach((e) => console.log(`  - ${e}`));
    } else {
      console.log("Console errors: none");
    }
    if (result.missingDefaults.length) {
      hadIssues = true;
      console.log(`Fields whose authored default isn't showing (${result.missingDefaults.length}):`);
      result.missingDefaults
        .slice(0, 20)
        .forEach((m) => console.log(`  - ${m.name}: expected "${m.authoredDefault}", got "${m.liveValue}"`));
      if (result.missingDefaults.length > 20) {
        console.log(`  ...and ${result.missingDefaults.length - 20} more`);
      }
    } else {
      console.log("Authored defaults: all present");
    }
  }
  await browser.close();
  process.exit(hadIssues ? 1 : 0);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main();
}
