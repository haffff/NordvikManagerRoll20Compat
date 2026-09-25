#!/usr/bin/env node
// sandbox/checkWarhammer.mjs
//
// Warhammer Fantasy Roleplay 4e (Official), imported through the real importer
// transform and render shell (see importedSheet.mjs). Two things it depends
// on that other sheets didn't exercise:
//   - Roll20's full change eventInfo: on("change:species", e =>
//     changeSpecies(e.newValue)) threw without newValue;
//   - Roll20 dice modifiers the platform reads differently: its rolls are
//     [[1d100cs<5cf>96]], where cs/cf are Roll20 critical ranges (01-05 and
//     96-100), not the platform's success counting — every roll showed 0.
//
// Usage: node sandbox/checkWarhammer.mjs   (needs "pnpm run pack" first)
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

async function main() {
  const browser = await chromium.launch();
  const { page, frame, consoleErrors } = await openImportedSheet(
    browser,
    importedPayload("wfrp4official", "Warhammer Fantasy Roleplay 4e Official")
  );
  await page.waitForTimeout(500);

  // The heaviest reference sheet (2000+ fields): opening it must stay a
  // handful of CardAPI calls. In the real app a fallback to one call per
  // field meant ~1200 QueryProperties requests timing out over WebRTC.
  const counts = await frame.evaluate(() => ({ ...window.__apiCounts }));
  const calls = Object.entries(counts).filter(([k]) => !k.startsWith("server request")).reduce((n, [, v]) => n + v, 0);
  check(`opening the sheet takes at most 10 CardAPI calls (took ${calls})`, calls <= 10, counts);
  check(
    `a brand-new card's first open doesn't store the sheet's defaults (${counts["server request: Add (websocket)"] || 0} Adds, ${counts["server request: QueryProperties"] || 0} QueryProperties)`,
    (counts["server request: Add (websocket)"] || 0) < 200 && (counts["server request: QueryProperties"] || 0) <= 10,
    counts
  );

  // A change listener sees Roll20's eventInfo fields.
  await frame.evaluate(() => on("change:species", (e) => (window.__speciesEvent = e)));
  await frame.selectOption('select[name="attr_species"]', { index: 1 });
  await page.waitForTimeout(500);
  const speciesEvent = await frame.evaluate(() => window.__speciesEvent ?? null);
  check(
    "changing Species fires change:species with Roll20's eventInfo (newValue, previousValue, sourceType, triggerName, sourceAttribute)",
    !!speciesEvent?.newValue && "previousValue" in speciesEvent && speciesEvent.sourceType === "player" &&
      speciesEvent.triggerName === "species" && speciesEvent.sourceAttribute === "species",
    speciesEvent
  );

  // Weapon Skill: @{...} and ?{...} resolved, then ONE batch whose d100 has
  // no cs/cf left for the platform to misread.
  await frame.click('button[name="roll_weapon_skill"]');
  const dialog = frame.locator(".r20c-query-overlay");
  await dialog.waitFor({ timeout: 5000 });
  await dialog.locator("button", { hasText: "Roll" }).click();
  let finished = null;
  for (let i = 0; i < 30 && !finished; i++) {
    finished = await frame.evaluate(() => window.__sandboxLog.find((e) => e.kind === "Rolls.Finish")?.detail ?? null);
    if (!finished) await page.waitForTimeout(100);
  }
  const started = await frame.evaluate(() => window.__sandboxLog.find((e) => e.kind === "Rolls.Start")?.detail ?? null);
  const d100 = started?.find((f) => /1d100/.test(f.formula));
  check(
    "rolling Weapon Skill sends the platform a plain 1d100 — Roll20's cs<5/cf>96 critical ranges stripped, not read as success counting",
    d100?.formula === "1d100",
    started
  );
  check(
    "the roll is posted with the sheet's own wfrp template and its roll placeholder",
    !!finished && finished.html.startsWith('<div class="sheet-rolltemplate-wfrp">') && finished.html.includes("data-roll-key="),
    finished && finished.html.slice(0, 200)
  );

  check(`no console errors (${consoleErrors.length} found)`, consoleErrors.length === 0, consoleErrors);

  // Warhammer 4e Character Sheet (the unofficial one, 3500+ fields) on a
  // brand-new card. Saving every field's default made its first open 3542
  // websocket Adds, and the server's backlog timed out the QueryProperties
  // requests behind it. The fake host counts both like the real one does.
  {
    const other = await openImportedSheet(browser, importedPayload("wh4", "Warhammer 4e Character Sheet"));
    await other.page.waitForTimeout(1500);
    const c = await other.frame.evaluate(() => ({ ...window.__apiCounts }));
    const adds = c["server request: Add (websocket)"] || 0;
    const queries = c["server request: QueryProperties"] || 0;
    check(
      `first open of Warhammer 4e Character Sheet creates only what its scripts compute, not every default (${adds} Adds, ${queries} QueryProperties)`,
      adds < 500 && queries <= 10,
      c
    );
    await other.page.close();
  }

  await browser.close();
  if (failures > 0) {
    console.error(`\n${failures} Warhammer check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll Warhammer checks passed.");
}

main();
