// Mirrors the real CardAPI.Resources interface (card-scoped store, plus a
// separate game-scoped Global store) so App.jsx can run in `pnpm run dev`
// without a server connection. In-memory only — resets on every page
// reload, which is fine for local iteration.
const store = new Map();
const globalStore = new Map();

// The real fetch_github_tree/fetch_github_file Actions run server-side
// (SendRequest is proxied through the GM backend — see those Actions'
// own files). There's no backend here in dev mode, so FireAction fakes
// them with a REAL browser fetch() instead — dev-only convenience so the
// "Browse GitHub" tab is actually testable via `pnpm run dev` without a
// live NordvikManager instance. Never runs in production (main.jsx only
// loads this file when import.meta.env.DEV).
async function mockFireAction(action, args) {
  if (action === "roll20compat/create_imported_template") {
    // Real Action clones the seed Template + tags it — here, just fabricate
    // a plausible-looking id so the dev-mode poll resolves.
    const fakeTemplateId = "dev-template-" + Math.random().toString(36).slice(2);
    globalStore.set(`roll20compat_create_result_${args.jobId}`, { data: fakeTemplateId });
    return;
  }
  if (action === "roll20compat/fetch_github_tree") {
    const res = await fetch("https://api.github.com/repos/Roll20/roll20-character-sheets/git/trees/master?recursive=1");
    globalStore.set("roll20compat_github_tree", { data: await res.text() });
    return;
  }
  if (action === "roll20compat/fetch_github_file") {
    const res = await fetch(args.url);
    globalStore.set(args.resourceKey, { data: await res.text() });
    return;
  }
  console.warn("ApiMock.FireAction (unhandled)", action, args);
}

export const ApiMock = {
  Resources: {
    Create: async (key, data, name, mimeType) => {
      if (store.has(key)) throw new Error("Resource with that key already exists.");
      store.set(key, { data, name, mimeType });
      return "mock-resource-id";
    },
    Read: async (key) => {
      return store.get(key)?.data ?? null;
    },
    Update: async (key, data, mimeType) => {
      const existing = store.get(key) ?? {};
      store.set(key, { ...existing, data, mimeType: mimeType ?? existing.mimeType });
    },
    Delete: async (key) => {
      store.delete(key);
    },
    Upsert: async (key, data, name, mimeType) => {
      store.set(key, { data, name, mimeType });
      return "mock-resource-id";
    },
    Global: {
      Read: async (key) => {
        return globalStore.get(key)?.data ?? null;
      },
    },
  },
  FireAction: (action, args) => {
    mockFireAction(action, args).catch((e) => console.error("ApiMock.FireAction failed", action, e));
  },
};

export default ApiMock;
