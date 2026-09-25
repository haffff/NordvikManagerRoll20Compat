#!/usr/bin/env node
// sandbox/compareReference.mjs
//
// A/B comparison between an imported sheet (rendered the same way
// check.mjs does, see importedSheet.mjs) and a REAL Roll20 popout, saved via the
// browser's "Save Page As... > Webpage, Complete" into a folder this
// script is pointed at directly — the same shape as the "Frecypha
// Isiy.html" + "Frecypha Isiy_files/" and "cyberpunkred.html" +
// "cyberpunkred_files/" bundles used earlier this session by hand. This
// formalizes that manual "here's an image, please compare" round trip:
// both pages load in the same Playwright run, get screenshotted, and get
// their class usage diffed automatically — no image needs to change hands
// for a first pass.
//
// Usage:
//   node sandbox/compareReference.mjs <key-or-corpus-folder> <pathToReferenceHtml>
//
// <pathToReferenceHtml> is the saved .html file itself (its sibling
// "..._files/" folder is expected alongside it, same as the browser wrote
// it — nothing here touches or copies those files).
//
// Deliberately NOT attempted here: pixel-diffing the two screenshots.
// Different characters (different names, stats, item counts) legitimately
// produce different pixels even on a byte-identical layout — a pixel diff
// would be mostly noise. Structural signal (element count, page height,
// which CSS classes exist on one side and not the other) survives that
// noise; eyeballing the two screenshots side by side is still the right
// tool for genuine visual/layout differences.
import { chromium } from "playwright";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { mkdirSync, existsSync } from "node:fs";
import { resolveSheet, importedPayload, openImportedSheet, outDir } from "./importedSheet.mjs";

// Tried in order against each page — the first one that matches AND has at
// least one child element wins as the "real content" root. Real Roll20
// popouts nest the sheet under .ui-dialog/.charsheet (see roll20-base.css's
// own header for why that ancestor chain is load-bearing); a from-scratch
// saved page may also carry unrelated Roll20 app chrome outside it, which
// this scoping is what keeps out of the class-diff.
const ROOT_CANDIDATES = [".ui-dialog .charsheet", ".charsheet", "body"];

async function scopedSnapshot(pageOrFrame) {
  return pageOrFrame.evaluate((candidates) => {
    let root = null;
    for (const sel of candidates) {
      const el = document.querySelector(sel);
      if (el && el.children.length > 0) {
        root = el;
        break;
      }
    }
    if (!root) root = document.body;

    const classes = new Set();
    const all = root.querySelectorAll("*");
    all.forEach((el) => {
      el.classList.forEach((c) => classes.add(c));
    });

    return {
      rootSelector: root === document.body ? "body" : (root.className || root.tagName),
      elementCount: all.length,
      classes: [...classes].sort(),
    };
  }, ROOT_CANDIDATES);
}

async function main() {
  const [key, referencePath] = process.argv.slice(2);
  if (!key || !referencePath) {
    console.error("Usage: node sandbox/compareReference.mjs <key-or-corpus-folder> <pathToReferenceHtml>");
    process.exit(1);
  }
  if (!existsSync(referencePath)) {
    console.error(`Reference file not found: ${referencePath}`);
    process.exit(1);
  }

  mkdirSync(outDir, { recursive: true });

  const { key: sheetKey, folder } = resolveSheet(key);
  const browser = await chromium.launch();

  const ours = await openImportedSheet(browser, importedPayload(sheetKey, folder));
  const oursSnapshot = await scopedSnapshot(ours.frame);
  const oursScreenshot = path.join(outDir, `${key}_ours.png`);
  const oursHeight = await ours.frame.evaluate(() => document.documentElement.scrollHeight);
  await ours.page.evaluate((h) => { document.getElementById("card").style.height = h + "px"; }, oursHeight);
  await ours.page.screenshot({ path: oursScreenshot, fullPage: true });
  await ours.context.close();

  const refPage = await browser.newPage({ viewport: { width: 900, height: 1400 } });
  await refPage.goto(pathToFileURL(path.resolve(referencePath)).href);
  await refPage.waitForTimeout(300);
  const refSnapshot = await scopedSnapshot(refPage);
  const refScreenshot = path.join(outDir, `${key}_reference.png`);
  await refPage.screenshot({ path: refScreenshot, fullPage: true });
  const refHeight = await refPage.evaluate(() => document.documentElement.scrollHeight);
  await refPage.close();

  await browser.close();

  const oursSet = new Set(oursSnapshot.classes);
  const refSet = new Set(refSnapshot.classes);
  const missingFromOurs = refSnapshot.classes.filter((c) => !oursSet.has(c));
  const extraInOurs = oursSnapshot.classes.filter((c) => !refSet.has(c));

  console.log(`\n=== ${key} vs ${path.basename(referencePath)} ===`);
  console.log(`Root scope — ours: "${oursSnapshot.rootSelector}", reference: "${refSnapshot.rootSelector}"`);
  console.log(`Screenshots: ${path.relative(process.cwd(), oursScreenshot)} | ${path.relative(process.cwd(), refScreenshot)}`);
  console.log(`Page height — ours: ${oursHeight}px, reference: ${refHeight}px${Math.abs(oursHeight - refHeight) > 200 ? "  <-- notably different" : ""}`);
  console.log(`Element count — ours: ${oursSnapshot.elementCount}, reference: ${refSnapshot.elementCount}`);
  console.log(`Distinct classes — ours: ${oursSnapshot.classes.length}, reference: ${refSnapshot.classes.length}`);

  if (missingFromOurs.length) {
    console.log(`\nClasses reference uses that ours never renders (${missingFromOurs.length}):`);
    console.log(`  ${missingFromOurs.slice(0, 40).join(", ")}${missingFromOurs.length > 40 ? ", ..." : ""}`);
  } else {
    console.log("\nNo classes present in reference but missing from ours.");
  }

  if (extraInOurs.length) {
    console.log(`\nClasses ours renders that reference never uses (${extraInOurs.length}):`);
    console.log(`  ${extraInOurs.slice(0, 40).join(", ")}${extraInOurs.length > 40 ? ", ..." : ""}`);
  } else {
    console.log("\nNo classes present in ours but missing from reference.");
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main();
}
