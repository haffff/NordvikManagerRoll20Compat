// sandbox/cardSandboxFrame.mjs
//
// Loads an assembled card page inside an <iframe sandbox="allow-scripts">,
// the same sandbox flags the real platform gives every card (see
// NordvikManagerFrontEnd's CardPanel.js), and returns that iframe's
// Playwright Frame. A Frame has the same fill/click/locator/evaluate API
// as a Page, so checks drive it exactly like one.
//
// Why not just page.goto() the card directly: a top-level page has none of
// the sandbox's restrictions, so anything the sandbox blocks passes here
// and then silently fails in the real app. That's how the importer's
// <form>-based Import button got through: without 'allow-forms' Chrome
// blocks the submission before the submit event even fires, so the button
// did nothing in-game while every sandbox check still passed.
//
// The context's addInitScript mocks (window.CardAPI etc.) run in every
// frame, the sandboxed iframe included, so existing mocks keep working.
import path from "node:path";
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export async function openInCardSandbox(page, cardHtmlPath) {
  const hostPath = cardHtmlPath.replace(/\.html$/, "_host.html");
  writeFileSync(
    hostPath,
    '<!doctype html><html><body style="margin:0">' +
      `<iframe id="card" sandbox="allow-scripts" src="${path.basename(cardHtmlPath)}" ` +
      'style="border:0;width:100%;height:100vh"></iframe>' +
      "</body></html>"
  );
  await page.goto(pathToFileURL(hostPath).href);
  const frameElement = await page.waitForSelector("#card");
  return frameElement.contentFrame();
}
