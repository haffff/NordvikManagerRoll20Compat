import React from "react";
import { transformUpload } from "./roll20Assembly";
import { loadCatalog, fetchSheetFiles, pollResource } from "./githubCatalog";
import "./App.css";

// Roll20 Sheet Importer — a View (GM tool), always just the import form.
// Importing (either by upload or by picking a sheet from Roll20's own public
// GitHub corpus) does NOT create a card of its own. Instead it:
//   1. Fires the "roll20compat/create_imported_template" Action, which clones
//      the internal "Roll20 Sheet (internal)" seed Template into a brand new
//      Template card (see addon_files/Actions/create_imported_template.json)
//      and tags it with a `roll20compat_content_id` property.
//   2. Polls a game-scoped resource for that new Template's id (FireAction is
//      fire-and-forget — this is the only way to learn the result).
//   3. Stores the transformed sheet content directly as a game-scoped
//      CardAPI.Resources.Global entry keyed by that id.
// The new Template then shows up in the GM's normal Template list (the
// Action makes the GM its owner — see create_imported_template.json), and
// character cards are created from it like from any other Template.
// This view holds no state of its own between imports; it's just the form.
const KEY_RE = /^[a-zA-Z0-9_-]+$/;

async function readFileText(file) {
  if (!file) return null;
  return await file.text();
}

function slugifyKey(name) {
  return name.toLowerCase().replace(/[^a-z0-9_-]/g, "");
}

export const App = ({ Api }) => {
  const [phase, setPhase] = React.useState("form"); // "form" | "submitting" | "success"
  const [error, setError] = React.useState(null);
  const [mode, setMode] = React.useState("upload"); // "upload" | "browse"
  const [key, setKey] = React.useState("");
  const [displayName, setDisplayName] = React.useState("");
  const [createdName, setCreatedName] = React.useState(null);

  // Upload-mode state
  const [htmlFile, setHtmlFile] = React.useState(null);
  const [cssFile, setCssFile] = React.useState(null);
  const [translationFile, setTranslationFile] = React.useState(null);

  // Browse-mode state
  const [catalog, setCatalog] = React.useState(null);
  const [catalogLoading, setCatalogLoading] = React.useState(false);
  const [catalogError, setCatalogError] = React.useState(null);
  const [query, setQuery] = React.useState("");
  const [picked, setPicked] = React.useState(null); // { sheet, fetching, fetchedFiles, fetchError }

  const loadCatalogNow = React.useCallback(
    async (forceRefresh) => {
      setCatalogLoading(true);
      setCatalogError(null);
      try {
        const sheets = await loadCatalog(Api, { forceRefresh });
        setCatalog(sheets);
      } catch (e) {
        setCatalogError(e?.message ?? String(e));
      } finally {
        setCatalogLoading(false);
      }
    },
    [Api]
  );

  const handlePick = async (sheet) => {
    setKey(slugifyKey(sheet.folder));
    setDisplayName(sheet.folder);
    setPicked({ sheet, fetching: true, fetchedFiles: null, fetchError: null });
    try {
      const files = await fetchSheetFiles(Api, sheet);
      setPicked({ sheet, fetching: false, fetchedFiles: files, fetchError: null });
    } catch (e) {
      setPicked({ sheet, fetching: false, fetchedFiles: null, fetchError: e?.message ?? String(e) });
    }
  };

  const uploadReady = mode === "upload" && !!htmlFile;
  const browseReady = mode === "browse" && !!picked?.fetchedFiles;
  const canSubmit = phase === "form" && (uploadReady || browseReady) && KEY_RE.test(key) && displayName.trim().length > 0;

  const finishImport = async ({ rawHtml, ownCss, translationJsonText }) => {
    const { mainHtml, workerJs, sheetCss } = transformUpload({ rawHtml, ownCss, translationJsonText });
    const name = displayName.trim();
    const jobId = crypto.randomUUID().replace(/-/g, "");

    Api.FireAction("roll20compat/create_imported_template", { name, jobId });

    const templateId = await pollResource(Api, `roll20compat_create_result_${jobId}`, { timeoutMs: 20000 });
    if (!templateId) {
      throw new Error(
        "Timed out waiting for the new Template to be created. If this keeps happening, the Roll20 Compat addon may need a full uninstall + reinstall (a stale duplicate install is the most common cause)."
      );
    }

    const stored = { key, displayName: name, mainHtml, workerJs, sheetCss };
    await Api.Resources.Global.Upsert(
      `roll20compat_sheet_${templateId}`,
      JSON.stringify(stored),
      "sheet.json",
      "application/json"
    );

    setCreatedName(name);
    setPhase("success");
  };

  // No <form>/type="submit" anywhere in this View: cards run in an iframe
  // with sandbox="allow-scripts" only (CardPanel.js), and without
  // allow-forms Chrome blocks a form submission BEFORE the submit event is
  // dispatched ("Blocked form submission ... 'allow-forms' permission is not
  // set") — so an onSubmit handler, preventDefault() included, never runs
  // and the button silently does nothing. Plain type="button" + onClick.
  const handleImport = async () => {
    if (!canSubmit) return;
    setPhase("submitting");
    setError(null);
    try {
      if (mode === "upload") {
        const [rawHtml, ownCss, translationJsonText] = await Promise.all([
          readFileText(htmlFile),
          readFileText(cssFile),
          readFileText(translationFile),
        ]);
        await finishImport({ rawHtml, ownCss, translationJsonText });
      } else {
        await finishImport(picked.fetchedFiles);
      }
    } catch (err) {
      setError(err?.message ?? String(err));
      setPhase("form");
    }
  };

  const startAnotherImport = () => {
    setKey("");
    setDisplayName("");
    setHtmlFile(null);
    setCssFile(null);
    setTranslationFile(null);
    setPicked(null);
    setCreatedName(null);
    setError(null);
    setPhase("form");
  };

  if (phase === "success") {
    return (
      <div className="roll20importer_container">
        <div className="roll20importer_title">Import Roll20 Sheet</div>
        <div className="roll20importer_status">
          ✓ "{createdName}" imported as a Template — you can now create character cards from it.
        </div>
        <div className="roll20importer_form">
          <button type="button" onClick={startAnotherImport}>Import another sheet</button>
        </div>
      </div>
    );
  }

  const filteredCatalog =
    catalog && query.trim()
      ? catalog.filter((s) => s.folder.toLowerCase().includes(query.trim().toLowerCase()))
      : catalog;

  return (
    <div className="roll20importer_container">
      <div className="roll20importer_title">Import Roll20 Sheet</div>
      <div className="roll20importer_subtitle">
        Upload a sheet's own files, or pick one from Roll20's public community-sheets corpus on GitHub. Importing
        creates a reusable Template — it does not create a character card by itself.
      </div>

      <div className="roll20importer_tabs">
        <button
          type="button"
          className={mode === "upload" ? "roll20importer_tab_active" : "roll20importer_tab"}
          onClick={() => setMode("upload")}
          disabled={phase === "submitting"}
        >
          Upload files
        </button>
        <button
          type="button"
          className={mode === "browse" ? "roll20importer_tab_active" : "roll20importer_tab"}
          onClick={() => {
            setMode("browse");
            if (!catalog && !catalogLoading) loadCatalogNow(false);
          }}
          disabled={phase === "submitting"}
        >
          Browse GitHub
        </button>
      </div>

      <div className="roll20importer_form">
        {mode === "upload" ? (
          <>
            <label className="roll20importer_field">
              <span>Sheet HTML (required)</span>
              <input
                type="file"
                accept=".html"
                onChange={(e) => setHtmlFile(e.target.files?.[0] ?? null)}
                disabled={phase === "submitting"}
              />
            </label>
            <label className="roll20importer_field">
              <span>Sheet CSS (optional)</span>
              <input
                type="file"
                accept=".css"
                onChange={(e) => setCssFile(e.target.files?.[0] ?? null)}
                disabled={phase === "submitting"}
              />
            </label>
            <label className="roll20importer_field">
              <span>translation.json (optional)</span>
              <input
                type="file"
                accept=".json"
                onChange={(e) => setTranslationFile(e.target.files?.[0] ?? null)}
                disabled={phase === "submitting"}
              />
            </label>
          </>
        ) : (
          <div className="roll20importer_browse">
            {catalogLoading && <div className="roll20importer_status">Fetching catalog from GitHub…</div>}
            {catalogError && (
              <div className="roll20importer_error">
                {catalogError}{" "}
                <button type="button" onClick={() => loadCatalogNow(false)}>
                  Retry
                </button>
              </div>
            )}
            {catalog && (
              <>
                <input
                  className="roll20importer_search"
                  placeholder={`Search ${catalog.length} sheets…`}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  disabled={phase === "submitting"}
                />
                <div className="roll20importer_catalog_list">
                  {filteredCatalog.slice(0, 150).map((sheet) => (
                    <button
                      type="button"
                      key={sheet.folder}
                      className={
                        picked?.sheet.folder === sheet.folder
                          ? "roll20importer_catalog_item_active"
                          : "roll20importer_catalog_item"
                      }
                      onClick={() => handlePick(sheet)}
                      disabled={phase === "submitting"}
                    >
                      {sheet.folder}
                    </button>
                  ))}
                  {filteredCatalog.length > 150 && (
                    <div className="roll20importer_field_hint">
                      {filteredCatalog.length - 150} more — refine your search.
                    </div>
                  )}
                </div>
                {picked?.fetching && <div className="roll20importer_status">Fetching "{picked.sheet.folder}"…</div>}
                {picked?.fetchError && <div className="roll20importer_error">{picked.fetchError}</div>}
                {picked?.fetchedFiles && (
                  <div className="roll20importer_status">✓ "{picked.sheet.folder}" ready to import below.</div>
                )}
                <button type="button" onClick={() => loadCatalogNow(true)} disabled={catalogLoading}>
                  Refresh catalog
                </button>
              </>
            )}
          </div>
        )}

        <label className="roll20importer_field">
          <span>Key</span>
          <input
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder="e.g. bladesinthedark"
            disabled={phase === "submitting"}
          />
          {key.length > 0 && !KEY_RE.test(key) && (
            <span className="roll20importer_field_hint">Letters, numbers, "_" and "-" only.</span>
          )}
        </label>

        <label className="roll20importer_field">
          <span>Display Name</span>
          <input
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="e.g. Blades in the Dark"
            disabled={phase === "submitting"}
          />
        </label>

        {error && <div className="roll20importer_error">Error: {error}</div>}

        <button type="button" onClick={handleImport} disabled={!canSubmit || phase === "submitting"}>
          {phase === "submitting" ? "Importing…" : "Import Sheet"}
        </button>
      </div>
    </div>
  );
};

export default App;
