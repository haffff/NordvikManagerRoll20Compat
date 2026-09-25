// The upload-time transform pipeline. Runs inside the sandboxed Card iframe, in the GM's own browser.
//
// This card (the "Roll20 Sheet Importer" View) only ever produces the
// transformed {mainHtml, workerJs, sheetCss} pieces and hands them off —
// via CardAPI.Resources.Global.Upsert, see App.jsx's finishImport — to a
// freshly-created Template card. Assembling those pieces into one renderable
// document (inlining the shared runtime shim, matching a CSS patch by key,
// rendering the result) is the CLONED TEMPLATE's job, not the
// View's — see card_sources/roll20compat-sheetrenderer/src/roll20Assembly.js
// for that half, which used to live in this file when a single card did both
// jobs.
import {
  splitWorkerScript,
  expandSelfClosingTags,
  extractRollTemplates,
  extractRollTemplateCss,
  stripRollTemplates,
  stripLocalLinks,
  prefixSheetClasses,
  wrapCharsheet,
  buildTranslationConfigScript,
  injectConfigScript,
} from "../../roll20compat-shared/tools/sheetTransform.mjs";
import { ROLL20_CHAT_BASE_CSS } from "../../roll20compat-shared/tools/rollTemplateEngine.mjs";

/**
 * Runs the upload-time transform pipeline
 * (splitWorkerScript -> expandSelfClosingTags -> prefixSheetClasses -> stripRollTemplates -> stripLocalLinks ->
 * wrapCharsheet -> translation-config injection), against a GM-uploaded
 * sheet's raw HTML/CSS/translation.json text. Returns the pieces that get
 * persisted via CardAPI.Resources.Global — NOT yet inlined with the shared
 * runtime shim or a matched patch; that inlining happens fresh on every
 * render (in the cloned Template's own render shell), so an addon update to
 * the shared runtime/patches applies to already-imported sheets
 * automatically on next open, without the GM re-importing anything.
 */
export function transformUpload({ rawHtml, ownCss, translationJsonText }) {
  const { mainHtml: splitHtml, workerJs } = splitWorkerScript(rawHtml);
  const expandedHtml = expandSelfClosingTags(splitHtml);
  let mainHtml = wrapCharsheet(stripLocalLinks(stripRollTemplates(prefixSheetClasses(expandedHtml, ownCss ?? ""))));

  // Roll templates leave the sheet markup but are kept for chat rolls (see
  // rollTemplateEngine.mjs), along with just their CSS — stored once per
  // sheet as its own resource, so chat messages reference it by key instead
  // of each carrying the whole sheet stylesheet.
  const rollTemplates = extractRollTemplates(expandedHtml, ownCss ?? "");
  const rollTemplateCss = extractRollTemplateCss(ownCss ?? "", ROLL20_CHAT_BASE_CSS);

  if (translationJsonText) {
    const translationBundle = JSON.parse(translationJsonText);
    // translationResourceKey is never actually fetched when a preloaded
    // bundle is present (see translationFill.js's own install()) — its
    // only remaining job is gating whether the [data-i18n] DOM-fill walk
    // runs at all, so any truthy string works.
    const configScript = buildTranslationConfigScript({
      translationResourceKey: "inline",
      translationBundle,
    });
    mainHtml = injectConfigScript(mainHtml, configScript);
  }

  return { mainHtml, workerJs, sheetCss: ownCss || null, rollTemplates, rollTemplateCss };
}
