#!/usr/bin/env node
// sandbox/checkPictos.mjs
//
// Roll20's Pictos icon font isn't bundled (it's commercial), so text set in
// it showed as raw letters ("y" for a gear, "3" for a check mark).
// runtime/pictosFallback.js swaps known glyphs for Unicode symbols. Two ways
// sheets ask for Pictos:
//   - Shadowrun Sixth World: <span class="pictos">…</span> with its own
//     font-family: pictos rule, including inside repeating rows;
//   - an inline style or a plain span the sheet's CSS sets in Pictos (also
//     on Shadowrun Sixth World).
// Blades in the Dark's per-sheet patch already redraws its settings gear, so
// the runtime must leave that one alone.
//
// Usage: node sandbox/checkPictos.mjs   (needs "pnpm run pack" first)
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

// Leaf elements still showing a mapped glyph in the Pictos font.
const RAW_GLYPHS = () =>
  Array.from(document.querySelectorAll("body *"))
    .filter((el) => el.children.length === 0 && !(el.getAttribute("name") || "").startsWith("attr_"))
    .filter((el) => /^\s*[3&+xyip_]{1,3}\s*$/.test(el.textContent))
    .filter((el) => /^\s*["']?pictos["']?\s*(,|$)/i.test(getComputedStyle(el).fontFamily))
    .map((el) => el.outerHTML.slice(0, 120));

async function main() {
  const browser = await chromium.launch();

  {
    const { page, frame } = await openImportedSheet(
      browser,
      importedPayload("shadowrunsixthworld", "Shadowrun Sixth World")
    );
    await page.waitForTimeout(700);
    const result = await frame.evaluate(`(() => {
      const mapped = Array.from(document.querySelectorAll("[data-r20c-pictos]"));
      return {
        raw: (${RAW_GLYPHS.toString()})(),
        mapped: mapped.length,
        sample: mapped.slice(0, 5).map((el) => [el.getAttribute("data-r20c-pictos"), el.textContent]),
      };
    })()`);
    check(
      `Shadowrun Sixth World: its Pictos glyphs show as symbols (${result.mapped} replaced), none left as raw letters`,
      result.mapped > 0 && result.raw.length === 0,
      result
    );

    // Most of its glyphs are in repeating rows, drawn only once a row exists.
    await frame.evaluate(() => document.querySelectorAll(".repcontrol_add").forEach((b) => b.click()));
    await page.waitForTimeout(1500);
    const afterRows = await frame.evaluate(`(() => ({
      raw: (${RAW_GLYPHS.toString()})(),
      rows: document.querySelectorAll(".repitem").length,
      mapped: document.querySelectorAll("[data-r20c-pictos]").length,
      shown: Array.from(new Set(Array.from(document.querySelectorAll("[data-r20c-pictos]"), (el) => el.getAttribute("data-r20c-pictos") + "=" + el.textContent))),
    }))()`);
    check(
      `Shadowrun Sixth World: glyphs in rows added later are replaced too (${afterRows.rows} rows, ${afterRows.mapped} replaced in all)`,
      afterRows.rows > 0 && afterRows.mapped > result.mapped && afterRows.raw.length === 0,
      afterRows
    );
    const EXPECTED = { "3": "✓", "&": "+", "+": "⊕", x: "⚒", y: "⚙", i: "ℹ", p: "✎", _: "−" };
    check(
      `Shadowrun Sixth World: each glyph shows its symbol, not garbled text (${afterRows.shown.join(" ")})`,
      afterRows.shown.length > 0 && afterRows.shown.every((s) => { const [g, sym] = s.split("="); return EXPECTED[g] === sym; }),
      afterRows.shown
    );
    await page.close();
  }

  {
    const { page, frame } = await openImportedSheet(browser, importedPayload("bladesinthedark", "Blades in the Dark"));
    await page.waitForTimeout(700);
    const gear = await frame.evaluate(() => {
      const el = document.querySelector(".settings-checkbox span");
      return el && {
        text: el.textContent,
        original: el.getAttribute("data-r20c-pictos"),
        fontSize: getComputedStyle(el).fontSize,
        before: getComputedStyle(el, "::before").content,
      };
    });
    check(
      "Blades in the Dark: its patch still draws the settings gear (::before ⚙) and the runtime leaves the patched span alone — one gear, not two",
      gear?.text === "y" && gear?.original === null && gear?.fontSize === "0px" && gear?.before === '"⚙"',
      gear
    );
    await page.close();
  }

  await browser.close();
  console.log(failures === 0 ? "\nAll Pictos checks passed." : `\n${failures} Pictos check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
