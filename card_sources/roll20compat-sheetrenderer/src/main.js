import { assembleRenderableDocument, renderDocument } from "./roll20Assembly.js";
import * as RollTemplateEngine from "../../roll20compat-shared/tools/rollTemplateEngine.mjs";

// Render shell cloned into every Template a GM imports via the "Roll20 Sheet
// Importer" view (see addon_files/Actions/create_imported_template.json) —
// and, from then on, into every character card created from that Template
// too, since AddCardCommandHandler copies a template's Properties onto every
// clone. Both cases read the SAME property/resource pair, so this one shell
// is all either card type ever needs.
const CONTENT_ID_PROPERTY = "roll20compat_content_id";

function showMessage(text) {
  document.body.innerHTML =
    '<div style="padding:24px;font-family:sans-serif;color:#a0a0a0;text-align:center;">' + text + "</div>";
}

async function run(Api) {
  showMessage("Loading…");

  let contentId;
  try {
    const prop = await Api.Properties.Get(CONTENT_ID_PROPERTY);
    contentId = prop?.value;
  } catch (e) {
    showMessage("Error reading this card's properties: " + (e?.message ?? e));
    return;
  }

  if (!contentId) {
    // Only reachable by opening the raw seed Template directly, or a
    // successfully-created Template whose content upload never completed.
    showMessage("No sheet content yet — import a sheet via the \"Roll20 Sheet Importer\" view.");
    return;
  }

  let raw;
  try {
    raw = await Api.Resources.Global.Read("roll20compat_sheet_" + contentId);
  } catch (e) {
    showMessage("Error reading the stored sheet content: " + (e?.message ?? e));
    return;
  }

  if (!raw) {
    showMessage('No sheet content found — re-import via the "Roll20 Sheet Importer" view.');
    return;
  }

  let stored;
  try {
    stored = JSON.parse(raw);
  } catch (e) {
    showMessage("Stored sheet content is corrupted: " + (e?.message ?? e));
    return;
  }

  // The runtime's chat-roll pipeline (runtime/rollDispatch.js) reads these —
  // window globals survive renderDocument's in-place swap. Sheets imported
  // before roll templates were kept have no rollTemplates: their rolls use
  // Roll20's default template, unstyled by sheet CSS, until re-imported.
  const Roll20Compat = (window.Roll20Compat = window.Roll20Compat || {});
  Roll20Compat.RollTemplateEngine = RollTemplateEngine;
  Roll20Compat.SheetInfo = {
    rollTemplates: stored.rollTemplates ?? {},
    rollTemplateCssKey: stored.rollTemplates ? "roll20compat_rtcss_" + contentId : null,
  };

  renderDocument(assembleRenderableDocument(stored));
}

window.addEventListener("cardapi:ready", () => run(window.CardAPI), { once: true });
