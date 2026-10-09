// See attrBinding.js's header for the loading model (plain <script>,
// window.Roll20Compat namespace, no bundler).
//
// bootstrap.js: the entry point that actually CALLS install() on the other
// runtime files. Everything else in runtime/ only attaches its exports to
// window.Roll20Compat and waits — this is the one file that runs its own
// logic immediately, synchronously, as soon as it loads.
//
// That immediacy is load-bearing, not incidental. CardPanel.js injects
// SANDBOX_BRIDGE_SCRIPT (which defines window.CardAPI) BEFORE any
// additionalResources script, and additionalResources load as plain,
// synchronous <script> tags in array order — never deferred (verified
// against CardPanel.js directly: the emitted tag has no defer/async
// attribute). The render shell (roll20compat-sheetrenderer's roll20Assembly.js) is
// required to
// place this file's resource key immediately after the other runtime/*.js
// files and immediately BEFORE the sheet's own extracted worker script in
// every Template's additionalResources array — a Roll20 worker script calls
// on()/getAttrs()/setAttrs() as bare globals at its own top level,
// unmodified, so those globals (assigned inside SheetWorkerShim.install(),
// called from here) must already exist by the time that script runs. There
// is no event to wait for that would make this safer AND still run before
// the worker script — waiting for window 'load' or 'cardapi:ready' would
// fire only after every synchronous <script> tag (including the worker
// script) has already executed.
//
// window.CardAPI itself IS safe to use immediately here even though the
// sandbox's INIT handshake (which populates CardAPI.cardId) hasn't happened
// yet: every Properties/Resources/Chat call is a bare postMessage a
// _rpc()-style promise, never gated on cardId being populated (the host
// resolves parentId itself, from the id CardAPIFactory(id) was constructed
// with — see CardPanel.js). Confirmed by reading cardSandbox.js in full:
// _cardId is read only by the cardId getter, never embedded in an outbound
// RPC payload.
(function (global) {
  "use strict";
  const Roll20Compat = (global.Roll20Compat = global.Roll20Compat || {});
  if (!global.CardAPI) {
    console.error("Roll20Compat.bootstrap: window.CardAPI is not defined — SANDBOX_BRIDGE_SCRIPT must load before this file.");
    return;
  }
  // Every runtime piece below talks to the property-store facade, not the
  // raw bridge — see propertyStore.js for why (batched Init/Set, locally
  // answered Get).
  const cardApi = Roll20Compat.PropertyStore ? Roll20Compat.PropertyStore.wrap(global.CardAPI) : global.CardAPI;

  const root = document.body;

  // Bound unconditionally, whether or not this sheet has worker JS —
  // every sheet has attr_*/repeating_* markup to bind regardless. This used
  // to happen only inside SheetWorkerShim.install(), which meant a
  // worker-less sheet (sheetWorkerShim.js isn't even bundled for the ~35%
  // of the corpus with none — see below) got zero attr/repeating binding at
  // all: no seeding, no two-way sync. Invisible to a visual check (an
  // unbound empty input and a bound-but-empty one look identical), found by
  // tracing this file while building the validation sandbox.
  const attrCleanup = Roll20Compat.AttrBinding.bindAttrs(root, cardApi);
  const repeating = Roll20Compat.RepeatingBinding.bindRepeating(root, cardApi);

  // Also bound unconditionally, for the same reason — a sheet's
  // translation.json (when it has one) fills empty [data-i18n] elements
  // regardless of whether a worker exists to also call getTranslationByKey
  // itself. window.Roll20CompatConfig is a tiny inline <script> the
  // importer (sheetTransform.mjs's buildTranslationConfigScript) writes directly into the sheet's own main
  // HTML — the ONLY way this runtime learns its own translationResourceKey
  // at all, since the Template manifest field it comes from is a
  // backend/install-time concept with no other path into the sandboxed
  // iframe. Before this, translationResourceKey was silently never passed
  // to SheetWorkerShim.install() either — getTranslationByKey() had never
  // resolved a real translation bundle in the actual app, worker-having
  // sheets included, only ever the identity fallback.
  const translationApi = Roll20Compat.TranslationFill.install(
    root,
    cardApi,
    global.Roll20CompatConfig?.translationResourceKey,
    global.Roll20CompatConfig?.translationBundle
  );

  // SheetWorkerShim.install() is only present when the imported sheet had
  // worker JS (the packager omits sheetWorkerShim.js's resource entry
  // entirely for the ~35% of the corpus with none) — everything downstream
  // degrades gracefully off a null shim rather than assuming it exists.
  const shim = Roll20Compat.SheetWorkerShim
    ? Roll20Compat.SheetWorkerShim.install(root, cardApi, attrCleanup, repeating, translationApi)
    : null;

  // rollDispatch.js is always present — even a worker-less sheet needs
  // startRoll/finishRoll's dice pipeline for its type="roll" buttons.
  const rollDispatch = Roll20Compat.RollDispatch ? Roll20Compat.RollDispatch.install(cardApi) : null;

  if (Roll20Compat.RollButtons && rollDispatch) {
    Roll20Compat.RollButtons.install(root, rollDispatch, shim);
  }

  // Last, so it sees translated labels and the repeating rows already drawn;
  // rows added later are caught by its own observer.
  const pictosCleanup = Roll20Compat.PictosFallback ? Roll20Compat.PictosFallback.install(root) : null;

  global.Roll20CompatRuntime = { shim, rollDispatch, root, attrCleanup, repeating, translationApi, pictosCleanup };
})(typeof window !== "undefined" ? window : globalThis);
