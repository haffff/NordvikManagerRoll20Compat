#!/usr/bin/env node
// sandbox/checkInteractions.mjs
//
// Drives an imported sheet the way a player does — switch pages, type a
// value the sheet's own script calculates from, add a repeating row — through
// the real importer transform and render shell (see importedSheet.mjs), and
// guards how many CardAPI calls opening the sheet costs. In the real app
// every CardAPI call is a round trip to the host and many become server
// requests; one call per field used to mean thousands per open (see
// runtime/propertyStore.js).
//
// Uses Imperium Maledictum: tabs driven by clicked: handlers + a hidden
// attr_tab, a characteristics grid computed by change: handlers, and
// repeating sections.
//
// Usage: node sandbox/checkInteractions.mjs   (needs "pnpm run pack" first)
import { chromium } from "playwright";
import { importedPayload, openImportedSheet } from "./importedSheet.mjs";

let failures = 0;
function check(label, ok, detail) {
  if (ok) console.log(`ok   ${label}`);
  else {
    failures++;
    console.error(`FAIL ${label}${detail !== undefined ? `\n  got: ${JSON.stringify(detail)}` : ""}`);
  }
}

// Opening a sheet should cost a handful of host calls regardless of how many
// fields it has (GetProperties, one InitMany, a SetMany or two, the render
// shell's own content lookup). Imperium Maledictum used to make ~530.
const MAX_CALLS_TO_OPEN = 10;

async function main() {
  const browser = await chromium.launch();
  const { page, frame, consoleErrors } = await openImportedSheet(
    browser,
    importedPayload("imperiummaledictum", "ImperiumMaledictum")
  );
  await page.waitForTimeout(700);

  const counts = await frame.evaluate(() => ({ ...window.__apiCounts }));
  const totalCalls = Object.entries(counts)
    .filter(([k]) => !k.startsWith("server request"))
    .reduce((sum, [, n]) => sum + n, 0);
  check(`opening the sheet takes at most ${MAX_CALLS_TO_OPEN} CardAPI calls (took ${totalCalls})`, totalCalls <= MAX_CALLS_TO_OPEN, counts);
  check(
    "opening the sheet makes at most one lookup of a missing property",
    (counts["server request: lookup of missing property"] ?? 0) <= 1,
    counts
  );

  const view = () =>
    frame.evaluate(() => {
      const tab = document.querySelector('input[name="attr_tab"]');
      const str = document.querySelector('input[name="attr_starting_str"]');
      return { tab: tab.value, page1Visible: !!(str.offsetWidth || str.offsetHeight), prop: window.__sandboxProps.tab };
    });

  await frame.click('button[name="act_page2"]');
  await page.waitForTimeout(300);
  let v = await view();
  check("clicking Page 2 switches pages (tab property, hidden input and visible page)", v.tab === "page2" && v.prop === "page2" && !v.page1Visible, v);

  await frame.click('button[name="act_page1"]');
  await page.waitForTimeout(300);
  v = await view();
  check("clicking Page 1 switches back", v.tab === "page1" && v.page1Visible, v);

  const input = frame.locator('input[name="attr_starting_str"]').first();
  await input.fill("34");
  await input.press("Tab");
  await page.waitForTimeout(600);
  const calc = await frame.evaluate(() => ({
    props: { str: window.__sandboxProps.str, str_bonus: window.__sandboxProps.str_bonus, athletics: window.__sandboxProps.athletics },
    dom: {
      str: document.querySelector('span[name="attr_str"]')?.textContent,
      athletics: document.querySelector('span[name="attr_athletics"]')?.textContent,
    },
  }));
  check(
    "typing Starting Str 34 runs the sheet's calculations: str 34, str_bonus 3, athletics 34 (properties and page)",
    String(calc.props.str) === "34" && String(calc.props.str_bonus) === "3" && String(calc.props.athletics) === "34" &&
      calc.dom.str === "34" && calc.dom.athletics === "34",
    calc
  );

  const rows = frame.locator('.repcontainer[data-groupname="repeating_specialisations"] .repitem');
  const rowsBefore = await rows.count();
  await frame.click('.repcontrol[data-groupname="repeating_specialisations"] .repcontrol_add');
  await page.waitForTimeout(400);
  const rowsAfter = await rows.count();
  check("clicking +Add adds a repeating row", rowsAfter === rowsBefore + 1, { rowsBefore, rowsAfter });

  check(`no console errors (${consoleErrors.length} found)`, consoleErrors.length === 0, consoleErrors);

  // An action button inside a row added AFTER load must reach the sheet's
  // script with that row's context (Roll20's clicked:repeating_X:name). The
  // sheet's own handler then rolls a roll template, which isn't supported
  // yet — so this step runs after the console-error check above.
  await frame.evaluate(() => on("clicked:repeating_specialisations:action", (e) => (window.__rowClick = e)));
  await rows.last().locator('button[type="action"][name="act_action"]').click();
  await page.waitForTimeout(300);
  const rowClick = await frame.evaluate(() => window.__rowClick ?? null);
  const rowId = await rows.last().getAttribute("data-reprowid");
  check(
    "an action button in a row added after load fires clicked:repeating_specialisations:action with that row's id",
    rowClick?.sourceAttribute === `repeating_specialisations_${rowId}_action`,
    { rowClick, rowId }
  );

  await browser.close();
  if (failures > 0) {
    console.error(`\n${failures} interaction check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll interaction checks passed.");
}

main();
