// See attrBinding.js's header for the loading model (plain <script>,
// window.Roll20Compat namespace, no bundler).
//
// translationFill.js: loads a sheet's translation.json bundle (if it has
// one) and fills every [data-i18n] element whose OWN text content is empty
// from it. This runtime doesn't implement Roll20's real i18n engine
// (language switching, etc. — explicitly out of scope per the plan), but
// it must do at least this much: a real corpus sheet (Blades in the Dark)
// authors almost all of its static labels as bare `<div data-i18n="name">
// </div>` with NO fallback text of its own baked into the HTML at all —
// unlike most other sheets, where data-i18n is a supplementary hint over
// literal baked-in text. Without this fill, those divs render permanently
// empty, and since a sheet's own layout commonly assumes they'll contain
// text, that cascades into what looks like broken columns/spacing, not
// just missing labels — confirmed live by comparing against a real,
// browser-saved Roll20 character-sheet popout of this exact sheet.
//
// Called unconditionally from bootstrap.js, regardless of whether the
// sheet has worker JS — sheetWorkerShim.js (worker-only) reuses this same
// loaded bundle for its own getTranslationByKey() global instead of
// fetching translationResourceKey a second time.
(function (global) {
  "use strict";
  const Roll20Compat = (global.Roll20Compat = global.Roll20Compat || {});

  /**
   * @param {Element} root
   * @param {*} cardApi
   * @param {string|undefined} translationResourceKey
   * @param {object|undefined} preloadedBundle - the packager's own embedded
   *   copy (window.Roll20CompatConfig.translationBundle), when present —
   *   see below for why this is the path actually used now.
   * @returns {{ready: Promise<void>, getTranslationByKey: (key:string)=>string}}
   */
  function install(root, cardApi, translationResourceKey, preloadedBundle) {
    // preloadedBundle, when present, is assigned SYNCHRONOUSLY, before
    // `ready` is even constructed — no microtask, no fetch, real or fake,
    // ever happens for this path. That's required, not just an
    // optimization: a worker script that calls getTranslationByKey() at
    // its own top level (Blades in the Dark's dataSetup()) can lose the
    // race against the real app's actual Resources.Global.Read() RPC
    // latency, even though this exact path was verified working against
    // the validation sandbox — the sandbox's fake CardAPI resolves that
    // same call near-instantly (a plain resolved Promise, whose .then()
    // still happens to flush before the next <script> tag runs), masking
    // the race a real postMessage round trip hits. Resolving synchronously
    // here removes the race entirely rather than depending on that
    // between-script-tags microtask-flush timing at all. The importer
    // now embeds the bundle's own content directly into the sheet HTML
    // for exactly this reason; Resources.Global.Read stays as a fallback
    // for any caller that builds a Template by hand without going through
    // that packager step.
    let bundle = preloadedBundle || {};
    const ready = preloadedBundle
      ? Promise.resolve()
      : translationResourceKey
      ? cardApi.Resources.Global.Read(translationResourceKey)
          .then((raw) => {
            bundle = raw ? JSON.parse(raw) : {};
          })
          .catch(() => {
            bundle = {};
          })
      : Promise.resolve();

    // Sheets with no translationResourceKey (the overwhelming majority —
    // see the plan's "not applicable" note on Roll20's i18n service) get
    // an identity fallback: the key itself, when the bundle has no entry.
    function getTranslationByKey(key) {
      return bundle[key] ?? key;
    }

    ready.then(() => {
      if (!translationResourceKey) return; // nothing to fill, skip the DOM walk entirely
      for (const el of root.querySelectorAll("[data-i18n]")) {
        // A sheet author's own fallback text (baked directly into the
        // HTML) is never overridden — only a genuinely empty element gets
        // filled, matching Roll20's own "translation replaces placeholder
        // content" behavior without risking clobbering real authored text
        // on a sheet with no matching translation key.
        if ((el.textContent ?? "").trim() !== "") continue;
        const key = el.getAttribute("data-i18n");
        const translated = bundle[key];
        if (!translated) continue;
        // innerHTML, not textContent — confirmed live (Blades in the Dark's
        // own translation.json): real translation strings intentionally
        // embed HTML ("<strong>Assist</strong> a teammate", "Mercenaries,
        // Thugs & Killers" with a literal unescaped &), meaning Roll20's
        // own i18n engine injects these as markup, not plain text. Safe to
        // do the same here — translation.json ships as part of the sheet's
        // own bundled resources, the same trust boundary this pipeline
        // already grants the sheet's own HTML/CSS (injected unmodified
        // elsewhere in this runtime), not third-party/user-generated input.
        el.innerHTML = translated;
      }
    });

    return { ready, getTranslationByKey };
  }

  Roll20Compat.TranslationFill = { install };
})(typeof window !== "undefined" ? window : globalThis);
