// Browses Roll20's own official, MIT-licensed corpus (github.com/Roll20/
// roll20-character-sheets) entirely through the addon's own backend Action
// system (SendRequest+SetResource — see addon_files/Actions/
// fetch_github_tree.json / fetch_github_file.json) — no new backend code,
// no client-side fetch() to a third party from inside the sandboxed iframe.
//
// Flow: fetch the WHOLE repo's file tree in one GitHub API call (cached as
// a game-wide resource, so every importer card instance in this game reuses
// it instead of re-fetching), filter it client-side into one entry per
// sheet folder ("exactly one .html per folder", the corpus's own
// convention), then — once a GM picks one — fetch just that sheet's
// 1-3 files from the raw-content CDN via the same Action pattern.
const REPO_OWNER = "Roll20";
const REPO_NAME = "roll20-character-sheets";
const REPO_BRANCH = "master";
const TREE_RESOURCE_KEY = "roll20compat_github_tree";

export function rawUrlFor(path) {
  return (
    `https://raw.githubusercontent.com/${REPO_OWNER}/${REPO_NAME}/${REPO_BRANCH}/` +
    path.split("/").map(encodeURIComponent).join("/")
  );
}

/**
 * Polls a game-scoped resource until it appears or timeoutMs elapses.
 * Action execution (SendRequest+SetResource) has no return value/promise
 * back to the calling card — FireAction is fire-and-forget over the WS
 * data channel (see cardSandbox.js's own FireAction) — so this is the only
 * way for the card to know when a fetch Action has actually finished.
 */
export async function pollResource(Api, key, { intervalMs = 500, timeoutMs = 20000 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = await Api.Resources.Global.Read(key);
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return null;
}

/**
 * Parses the GitHub Git Trees API response (`{tree: [{path, type, ...}]}`)
 * into one entry per sheet folder. Only folders exactly one level deep with
 * EXACTLY one .html file qualify (the corpus's own one-sheet-per-folder
 * convention) — anything else (nested subfolders, zero or multiple .html
 * files) is silently excluded from the picker rather than guessed at.
 */
export function parseTree(rawJson) {
  const parsed = JSON.parse(rawJson);
  const blobs = (parsed.tree || []).filter((e) => e.type === "blob" && typeof e.path === "string");

  const byFolder = new Map();
  for (const entry of blobs) {
    const slash = entry.path.indexOf("/");
    if (slash === -1) continue; // repo-root file, not inside any sheet folder
    const folder = entry.path.slice(0, slash);
    const rest = entry.path.slice(slash + 1);
    if (rest.includes("/")) continue; // nested subfolder — outside this pipeline's scope
    if (!byFolder.has(folder)) byFolder.set(folder, []);
    byFolder.get(folder).push({ name: rest, path: entry.path });
  }

  const sheets = [];
  for (const [folder, files] of byFolder) {
    const htmlFiles = files.filter((f) => f.name.toLowerCase().endsWith(".html"));
    if (htmlFiles.length !== 1) continue;
    const cssFiles = files.filter((f) => f.name.toLowerCase().endsWith(".css"));
    const translation = files.find((f) => f.name.toLowerCase() === "translation.json");
    sheets.push({
      folder,
      htmlPath: htmlFiles[0].path,
      cssPath: cssFiles[0]?.path ?? null,
      translationPath: translation?.path ?? null,
    });
  }
  sheets.sort((a, b) => a.folder.localeCompare(b.folder));
  return sheets;
}

/**
 * Returns the parsed catalog, using the cached game resource when present.
 * Pass forceRefresh to re-fetch (e.g. a GM-triggered "Refresh Catalog").
 */
export async function loadCatalog(Api, { forceRefresh = false } = {}) {
  if (!forceRefresh) {
    const cached = await Api.Resources.Global.Read(TREE_RESOURCE_KEY);
    if (cached) return parseTree(cached);
  }
  Api.FireAction("roll20compat/fetch_github_tree", {});
  const raw = await pollResource(Api, TREE_RESOURCE_KEY, { timeoutMs: 20000 });
  if (!raw) throw new Error("Timed out fetching the sheet catalog from GitHub — try again.");
  return parseTree(raw);
}

/**
 * Fetches one sheet's 1-3 files from GitHub's raw-content CDN via the
 * generic fetch_github_file Action, into resource keys scoped to this one
 * fetch (sessionId — a fresh random id per pick, not the card's own id,
 * since that isn't a confirmed part of the sandboxed CardAPI surface) so
 * concurrent imports across multiple importer card instances never
 * collide. Returns the same shape transformUpload() expects.
 */
export async function fetchSheetFiles(Api, sheet) {
  const sessionId = crypto.randomUUID().replace(/-/g, "");
  const jobs = [{ role: "html", path: sheet.htmlPath, mimeType: "text/html", required: true }];
  if (sheet.cssPath) jobs.push({ role: "css", path: sheet.cssPath, mimeType: "text/css", required: false });
  if (sheet.translationPath)
    jobs.push({ role: "translation", path: sheet.translationPath, mimeType: "application/json", required: false });

  for (const job of jobs) {
    job.key = `roll20compat_github_${sessionId}_${job.role}`;
    Api.FireAction("roll20compat/fetch_github_file", {
      url: rawUrlFor(job.path),
      resourceKey: job.key,
      mimeType: job.mimeType,
    });
  }

  const contents = await Promise.all(
    jobs.map(async (job) => {
      const content = await pollResource(Api, job.key);
      if (!content && job.required) throw new Error(`Failed to fetch "${job.path}" from GitHub (timed out).`);
      return [job.role, content];
    })
  );
  const byRole = Object.fromEntries(contents);
  return { rawHtml: byRole.html, ownCss: byRole.css ?? null, translationJsonText: byRole.translation ?? null };
}
