import { assembleRenderableDocument, renderDocument } from "./roll20Assembly.js";

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

  renderDocument(assembleRenderableDocument(stored));
}

window.addEventListener("cardapi:ready", () => run(window.CardAPI), { once: true });
