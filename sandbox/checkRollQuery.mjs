#!/usr/bin/env node
// sandbox/checkRollQuery.mjs
//
// End-to-end check of rollButtons.js's ?{...} roll-query dialog, run inside
// the real card sandbox flags (sandbox="allow-scripts", see
// cardSandboxFrame.mjs). This used to be a window.prompt() call, which the
// sandbox silently ignores (no allow-modals): prompt() returned null, so
// every query took its default and the player was never asked. A plain
// top-level page.goto() can't catch that, since prompt() works there.
//
// Uses Classic Traveller's Brawling Attack button:
//   value="[[(2d6 + @{brawling} + ?{Modifier|0})]]"
//
// Imported through the real importer transform + render shell (see
// importedSheet.mjs). Needs "pnpm run pack" first.
//
// Usage: node sandbox/checkRollQuery.mjs
import { chromium } from "playwright";
import { importedPayload, openImportedSheet, DEFAULT_SHEETS } from "./importedSheet.mjs";

let failures = 0;
function check(label, ok, detail) {
  if (ok) console.log(`ok   ${label}`);
  else {
    failures++;
    console.error(`FAIL ${label}${detail !== undefined ? `\n  got: ${JSON.stringify(detail)}` : ""}`);
  }
}

const rollMessages = (frame) =>
  frame.evaluate(() =>
    window.__sandboxLog
      .filter((e) => e.kind === "SendChatMessage" && String(e.detail).startsWith("/roll"))
      .map((e) => String(e.detail))
  );

async function main() {
  const browser = await chromium.launch();
  const payload = importedPayload("classictraveller", DEFAULT_SHEETS.classictraveller);
  const { page, frame, consoleErrors } = await openImportedSheet(browser, payload);
  await frame.waitForSelector('button[name="roll_BrawlingAttack"]', { timeout: 5000 });
  await frame.fill('input[name="attr_brawling"]', "1");
  await frame.locator('input[name="attr_brawling"]').blur();

  // 1. Answer the query: the chosen value must reach the roll.
  await frame.click('button[name="roll_BrawlingAttack"]');
  const dialog = frame.locator(".r20c-query-overlay");
  await dialog.waitFor({ timeout: 5000 });
  check("clicking a roll button with a ?{...} query shows the in-page dialog", true);
  check(
    "the dialog shows the query's prompt and default",
    (await dialog.textContent()).includes("Modifier") &&
      (await dialog.locator("input").inputValue()) === "0"
  );
  await dialog.locator("input").fill("3");
  await dialog.locator("button", { hasText: "Roll" }).click();
  await dialog.waitFor({ state: "detached", timeout: 5000 });

  let rolls = [];
  for (let i = 0; i < 20 && rolls.length === 0; i++) {
    rolls = await rollMessages(frame);
    if (rolls.length === 0) await page.waitForTimeout(100);
  }
  check("the answered value (3) is substituted into the fired roll", rolls.length === 1 && /2d6\+1\+3/.test(rolls[0]), rolls);

  // 2. Cancel: no roll at all.
  await frame.click('button[name="roll_BrawlingAttack"]');
  await dialog.waitFor({ timeout: 5000 });
  await dialog.locator("button", { hasText: "Cancel" }).click();
  await dialog.waitFor({ state: "detached", timeout: 5000 });
  await page.waitForTimeout(300);
  check("Cancel closes the dialog without firing a roll", (await rollMessages(frame)).length === 1);

  // 3. Keyboard: Enter submits with the default.
  await frame.click('button[name="roll_BrawlingAttack"]');
  await dialog.waitFor({ timeout: 5000 });
  await dialog.locator("input").press("Enter");
  await dialog.waitFor({ state: "detached", timeout: 5000 });
  await page.waitForTimeout(300);
  const afterEnter = await rollMessages(frame);
  check("Enter submits the dialog with the default answer", afterEnter.length === 2 && /2d6\+1\+0/.test(afterEnter[1]), afterEnter);

  // 4. Keyboard: Enter on a focused Cancel button cancels, not submits.
  await frame.click('button[name="roll_BrawlingAttack"]');
  await dialog.waitFor({ timeout: 5000 });
  await dialog.locator("button", { hasText: "Cancel" }).press("Enter");
  await dialog.waitFor({ state: "detached", timeout: 5000 });
  await page.waitForTimeout(300);
  check("Enter on a focused Cancel button cancels instead of rolling", (await rollMessages(frame)).length === 2);

  check(`no console errors (${consoleErrors.length} found)`, consoleErrors.length === 0, consoleErrors);

  await browser.close();
  if (failures > 0) {
    console.error(`\n${failures} roll-query check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll roll-query checks passed.");
}

main();
