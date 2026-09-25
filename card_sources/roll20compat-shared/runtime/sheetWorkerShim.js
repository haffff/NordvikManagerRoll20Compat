// See attrBinding.js's header for the loading model (plain <script>,
// window.Roll20Compat namespace, no bundler).
//
// sheetWorkerShim.js: installs Roll20's sheet-worker host API as globals
// (`on`, `getAttrs`, `setAttrs`, `getSectionIDs`, `generateRowID`,
// `removeRepeatingRow`, `getTranslationByKey`, `$20`) so a sheet's own
// extracted worker script — loaded as the next <script> tag after this one,
// completely unmodified — runs exactly as it did against real Roll20,
// calling these as ambient functions rather than an imported module.
//
// Takes an already-built {attrCleanup, repeating} (bootstrap.js's own
// bindAttrs()/bindRepeating() calls) rather than creating them itself. This
// used to own both internally, but that meant a worker-less sheet — where
// this whole file is never even loaded (the render shell omits it when
// the sheet has no worker) — got NO attr/repeating binding at all: bootstrap.js
// only reached bindAttrs()/bindRepeating() through this file's install(),
// so every worker-less sheet (Numenera included) silently had zero
// two-way sync, invisible to a purely visual check (an unbound empty input
// and a bound-but-empty one look identical). bootstrap.js now binds
// unconditionally and passes the result in here — one source of truth for
// "what changed" (user typing, another client's edit, or setAttrs()) still
// holds, it's just built once by bootstrap.js instead of by this file.
(function (global) {
  "use strict";
  const Roll20Compat = (global.Roll20Compat = global.Roll20Compat || {});

  // ── Pure logic (Node-testable — no DOM) ───────────────────────────────────

  // Roll20 field keys used by getAttrs/setAttrs/on are the BARE name (no
  // "attr_" prefix — that's an HTML markup-only convention). A repeating
  // field key is "repeating_<section>_<rowId>_<field>". Both the section
  // name and the row id may themselves contain underscores, so the split is
  // ambiguous from the string alone (e.g. "repeating_hp_tracker_-abc_max"
  // could be section "hp" or "hp_tracker"). Matched against the sheet's own
  // known section names instead of guessed — the longest matching name wins
  // so a shorter name never shadows a longer one that's also a prefix of it.
  function parseRepeatingKey(key, knownSectionNames) {
    if (typeof key !== "string" || !key.startsWith("repeating_")) return null;
    const rest = key.slice("repeating_".length);

    const section = knownSectionNames
      .filter((s) => rest === s || rest.startsWith(s + "_"))
      .sort((a, b) => b.length - a.length)[0];
    if (!section) return null;

    const remainder = rest.slice(section.length + 1);
    const sep = remainder.indexOf("_");
    if (sep < 0) return null;

    const rowId = remainder.slice(0, sep);
    const field = remainder.slice(sep + 1);
    if (!rowId || !field) return null;
    return { section, rowId, field };
  }

  // Parses on()'s event-spec string (space-separated multi-spec is Roll20's
  // own documented shorthand, e.g. "change:hp change:hp_max"). Covers the 5
  // shapes that account for 94.7% of real corpus on() calls; anything else
  // comes back as {type:"unknown"} so callers can ignore it rather than the
  // parser throwing on a sheet using an obscure/undocumented form.
  function parseEventSpec(specString) {
    return String(specString)
      .split(/\s+/)
      .filter(Boolean)
      .map((spec) => {
        if (spec === "sheet:opened") return { type: "sheet:opened", raw: spec };
        if (spec.startsWith("clicked:")) {
          return { type: "clicked", action: spec.slice("clicked:".length), raw: spec };
        }
        if (spec.startsWith("remove:repeating_")) {
          return { type: "remove", section: spec.slice("remove:repeating_".length), raw: spec };
        }
        if (spec.startsWith("change:repeating_")) {
          const rest = spec.slice("change:repeating_".length); // "section" or "section:attr"
          const [section, attr] = rest.split(":");
          return { type: "change", section, attr: attr || null, raw: spec };
        }
        if (spec.startsWith("change:")) {
          return { type: "change", attr: spec.slice("change:".length), raw: spec };
        }
        return { type: "unknown", raw: spec };
      });
  }

  // A generated row id only needs to be unique within this sheet session —
  // the server is the actual authority on uniqueness (AddPropertyListItemCommand
  // rejects a collision rather than silently reassigning one). Must stay
  // inside the server's accepted charset/length (^[A-Za-z0-9_-]{1,64}$,
  // see AddPropertyListItemCommandHandler.cs) — the whole point of a
  // client-supplied id is defeated if it can't reach the server as sent.
  const ROWID_RE = /^[A-Za-z0-9_-]{1,64}$/;
  let rowIdCounter = 0;
  function generateRowID() {
    rowIdCounter += 1;
    return `-local${Date.now().toString(36)}${rowIdCounter.toString(36)}`;
  }

  Roll20Compat.SheetWorkerLogic = { parseRepeatingKey, parseEventSpec, generateRowID, ROWID_RE };

  // ── DOM glue ───────────────────────────────────────────────────────────

  // Minimal jQuery-subset — the narrow real usage found in the corpus
  // (6.8% of worker sheets, almost entirely these six calls against the
  // sheet's own CSS classes). Not a jQuery bundle; not chainable beyond
  // what these methods themselves return for convenience.
  function make$20(root) {
    return function $20(selector) {
      const els = Array.from(root.querySelectorAll(selector));
      const api = {
        // No "sheet-" prefixing here, deliberately — there is no platform
        // auto-prefix step to replicate (see sheetTransform.mjs's
        // prefixSheetClasses() header for how that theory was tested and
        // falsified). A worker's addClass/removeClass argument is used
        // as-is, same as every other class token in this runtime; a sheet
        // whose CSS expects "sheet-hidden" needs to pass exactly that.
        addClass: (cls) => (els.forEach((el) => el.classList.add(cls)), api),
        removeClass: (cls) => (els.forEach((el) => el.classList.remove(cls)), api),
        show: () => (els.forEach((el) => (el.style.display = "")), api),
        hide: () => (els.forEach((el) => (el.style.display = "none")), api),
        attr: (name, value) => {
          if (value === undefined) return els[0]?.getAttribute(name) ?? undefined;
          els.forEach((el) => el.setAttribute(name, value));
          return api;
        },
        val: (value) => {
          if (value === undefined) return els[0]?.value;
          els.forEach((el) => (el.value = value));
          return api;
        },
        // Real jQuery event binding (not the sheet-worker on() global) —
        // confirmed live (Cyberpunk RED raycw): `$20('input[...]').on('click', fn)`
        // to react to a raw DOM click, separate from and in addition to
        // attrBinding.js's own change listener on the same input.
        on: (eventName, handler) => {
          els.forEach((el) => el.addEventListener(eventName, handler));
          return api;
        },
      };
      return api;
    };
  }

  /**
   * Installs the full sheet-worker host API as globals on `global`, on top
   * of the already-bound `attrCleanup`/`repeating`/`translationApi`
   * bootstrap.js built via AttrBinding.bindAttrs()/
   * RepeatingBinding.bindRepeating()/TranslationFill.install() (see this
   * file's header for why those are no longer created in here).
   * @param {Function} attrCleanup - bindAttrs()'s own return value
   * @param {{sections: object, destroy: Function}} repeating - bindRepeating()'s own return value
   * @param {{ready: Promise, getTranslationByKey: Function}} translationApi - TranslationFill.install()'s own return value
   * @returns {{dispatchClicked, destroy}} — dispatchClicked is an internal
   * hook for rollButtons.js (deliverable A's next file) to fire
   * `clicked:name` listeners on a button[type="action"] click; not part of
   * the sheet-facing global API. remove: listeners fire on their own, from
   * this function's internal repeating-section diffing — no external
   * trigger needed.
   */
  function install(root, cardApi, attrCleanup, repeating, translationApi) {
    const $20 = make$20(root);

    // Declared up front, in the order they're referenced, so it's
    // structurally obvious that `on()` (called by the worker script AFTER
    // install() returns and assigns global.on) can safely close over all of
    // it — nothing here depends on install() having run any further.
    let sheetOpenedFired = false;
    const listeners = { change: [], clicked: [], remove: [], "sheet:opened": [] };

    // ── change: / remove: dispatch ──────────────────────────────────────
    //
    // Driven entirely by the same server broadcasts AttrBinding/RepeatingBinding
    // already subscribe to (never by intercepting setAttrs directly) — one
    // source of truth for "did this actually change", matching the plan's
    // framing. Known approximation: because firing waits for the broadcast
    // round-trip, a non-silent setAttrs()'s change events land a tick later
    // than real Roll20's synchronous dispatch — acceptable per the plan's
    // "known approximation" section; revisit only if deliverable C
    // validation shows worker logic that depends on synchronous ordering.
    //
    // Subscriptions are created lazily, the first time `on()` registers a
    // listener that needs them — NOT eagerly here. `on()` is only ever
    // called by the worker script's own top-level code, which runs strictly
    // AFTER install() has returned (it's the next <script> tag, loaded once
    // this file has finished executing and assigned global.on). Building
    // the subscription set from `listeners` before any `on()` call has
    // happened would see permanently empty arrays.
    const lastFired = {}; // "name" | "section/rowId/field" -> last-seen value

    function fireChange(key, value, eventInfo) {
      if (lastFired[key] === value) return;
      lastFired[key] = value;
      for (const { spec, cb } of listeners.change) {
        const matches =
          spec.section != null
            ? spec.section === eventInfo.section && (spec.attr == null || spec.attr === eventInfo.name)
            : spec.attr === eventInfo.name && eventInfo.section == null;
        if (matches) cb(eventInfo);
      }
    }

    const subscribedPlainNames = new Set();
    function ensurePlainChangeSubscription(name) {
      if (subscribedPlainNames.has(name)) return;
      subscribedPlainNames.add(name);

      // Seeds lastFired from the current value so the FIRST real change
      // (not the initial load) is what fires — guarded by `in` so a
      // setAttrs({silent:true}) pre-seed (below) that resolves first isn't
      // clobbered by this Get() resolving after it.
      cardApi.Properties.Get(name).then((prop) => {
        if (!(name in lastFired)) lastFired[name] = prop?.value ?? "";
      });
      cardApi.Properties.Subscribe(name, (prop) => {
        fireChange(name, prop?.value ?? "", { name, sourceAttribute: name, section: null });
      });
    }

    // Repeating changes: independently subscribed to the SAME list property
    // RepeatingBinding renders from — diffs old vs new items itself for
    // event-firing purposes, entirely separate from RepeatingBinding's own
    // DOM-rendering subscription (both are valid simultaneous subscribers).
    const prevItemsBySection = {};
    const subscribedSections = new Set();
    function ensureSectionDiffSubscription(section) {
      if (subscribedSections.has(section)) return;
      const sectionApi = repeating.sections[section];
      if (!sectionApi) return;
      subscribedSections.add(section);

      const diff = (items) => {
        const prevById = new Map((prevItemsBySection[section] || []).map((i) => [i.id, i]));
        const nextById = new Map(items.map((i) => [i.id, i]));

        for (const [id, item] of nextById) {
          const prevItem = prevById.get(id);
          for (const [field, value] of Object.entries(item.fields || {})) {
            const key = `${section}/${id}/${field}`;
            if (!prevItem || prevItem.fields?.[field] !== value) {
              fireChange(key, value, { name: field, sourceAttribute: field, section, rowId: id });
            }
          }
        }
        for (const [id] of prevById) {
          if (!nextById.has(id)) {
            for (const { spec, cb } of listeners.remove) {
              if (spec.section === section) cb({ section, rowId: id });
            }
          }
        }
        prevItemsBySection[section] = items;
      };

      cardApi.Properties.Get(section).then((prop) => {
        try {
          prevItemsBySection[section] = JSON.parse(prop?.value || "[]");
        } catch {
          prevItemsBySection[section] = [];
        }
      });
      cardApi.Properties.Subscribe(section, (prop) => {
        try {
          diff(JSON.parse(prop?.value || "[]"));
        } catch {
          /* malformed list JSON — skip this broadcast's diff, DOM binding handles display separately */
        }
      });
    }

    function on(specString, cb) {
      for (const spec of parseEventSpec(specString)) {
        if (spec.type === "sheet:opened" && sheetOpenedFired) {
          // Registered after the event already fired (e.g. dynamically
          // loaded worker code) — still gets its one call, matching the
          // "fires once, no matter when you subscribed" contract a worker
          // script relying on `on('sheet:opened', ...)` expects.
          cb({});
          continue;
        }

        if (spec.type === "change") {
          if (spec.section != null) ensureSectionDiffSubscription(spec.section);
          else ensurePlainChangeSubscription(spec.attr);
        } else if (spec.type === "remove") {
          ensureSectionDiffSubscription(spec.section);
        }

        (listeners[spec.type] || (listeners.unknown = listeners.unknown || [])).push({ spec, cb });
      }
    }

    // ── getAttrs / setAttrs ─────────────────────────────────────────────

    async function getAttrs(names, cb) {
      const knownSections = Object.keys(repeating.sections);
      const result = {};
      await Promise.all(
        names.map(async (key) => {
          const parsed = parseRepeatingKey(key, knownSections);
          if (parsed) {
            const sectionApi = repeating.sections[parsed.section];
            if (!sectionApi) {
              result[key] = "";
              return;
            }
            await sectionApi.whenReady();
            const item = sectionApi.getItem(parsed.rowId);
            result[key] = item?.fields?.[parsed.field] ?? "";
          } else {
            const prop = await cardApi.Properties.Get(key);
            result[key] = prop?.value ?? "";
          }
        })
      );
      cb(result);
    }

    async function setAttrs(values, optsOrCb, maybeCb) {
      const isOptsFn = typeof optsOrCb === "function";
      const opts = isOptsFn ? {} : optsOrCb || {};
      const cb = isOptsFn ? optsOrCb : maybeCb;
      const knownSections = Object.keys(repeating.sections);

      const plain = {};
      const bySection = new Map(); // section -> Map(rowId -> fields)
      for (const [key, value] of Object.entries(values)) {
        const parsed = parseRepeatingKey(key, knownSections);
        if (!parsed) {
          plain[key] = value;
          continue;
        }
        if (!bySection.has(parsed.section)) bySection.set(parsed.section, new Map());
        const rows = bySection.get(parsed.section);
        if (!rows.has(parsed.rowId)) rows.set(parsed.rowId, {});
        rows.get(parsed.rowId)[parsed.field] = value;
      }

      // silent: true pre-seeds lastFired so the broadcast this write causes
      // gets diffed away as "no change" instead of firing change: listeners.
      // Deliberately NOT a network-wide suppression — it only silences this
      // client's own reaction, matching what "silent" means in real Roll20
      // (each browser's sheet-worker instance decides for itself).
      if (opts.silent) {
        for (const [key, value] of Object.entries(values)) {
          const parsed = parseRepeatingKey(key, knownSections);
          lastFired[parsed ? `${parsed.section}/${parsed.rowId}/${parsed.field}` : key] = value;
        }
      }

      await Promise.all(
        Object.entries(plain).map(([name, value]) => cardApi.Properties.Set(name, value))
      );

      for (const [section, rows] of bySection) {
        const sectionApi = repeating.sections[section];
        if (!sectionApi) continue;
        await sectionApi.whenReady();
        for (const [rowId, fields] of rows) {
          const existing = sectionApi.getItem(rowId);
          if (existing) {
            sectionApi.updateItem(rowId, fields);
          } else {
            // Honors a generateRowID() id the worker script already handed
            // out before this row existed server-side (Roll20's real
            // contract). Known narrow race: two setAttrs() calls for a
            // brand-new row's id, back-to-back before the first Add
            // round-trips, will both see "not found" here and both attempt
            // Add — the second is silently dropped server-side (List.Add is
            // fire-and-forget, so there's no rejection to catch and recover
            // from at this layer). Not fixable without making List.Add a
            // real request/response call; a single setAttrs() call per new
            // row (the overwhelmingly common pattern) is unaffected.
            await sectionApi.addItem(fields, rowId);
          }
        }
      }

      if (cb) cb();
    }

    function getSectionIDs(sectionName, cb) {
      const sectionApi = repeating.sections[sectionName];
      if (!sectionApi) {
        cb([]);
        return;
      }
      sectionApi.whenReady().then(() => cb(sectionApi.getSectionIDs()));
    }

    function removeRepeatingRow(rowId) {
      const knownSections = Object.keys(repeating.sections);
      const parsed = parseRepeatingKey(rowId, knownSections);
      if (parsed) {
        repeating.sections[parsed.section]?.removeItem(parsed.rowId);
        return;
      }
      // Bare row id (Roll20's other documented form) — search every section.
      for (const sectionApi of Object.values(repeating.sections)) {
        if (sectionApi.getItem(rowId)) {
          sectionApi.removeItem(rowId);
          return;
        }
      }
    }

    // getTranslationByKey is synchronous in real Roll20, so the bundle must
    // already be loaded by the time a worker script can call it — gated
    // behind the same readiness gate as sheet:opened. Loading itself is
    // owned by translationFill.js now (bootstrap.js builds it once,
    // unconditionally, and passes it in here) rather than duplicated in
    // this file — that used to mean a SECOND fetch of the same
    // translationResourceKey whenever a worker was present, and, more
    // importantly, meant nothing outside this file (worker-less sheets;
    // translationFill.js's own [data-i18n] DOM fill) ever got a real
    // bundle at all, since bootstrap.js never actually passed
    // translationResourceKey down to this install() call in the first
    // place — confirmed live: getTranslationByKey() had never resolved a
    // real translation in the actual app, only identity fallbacks.
    const { ready: translationReady, getTranslationByKey } = translationApi;

    // Real Roll20 API, undocumented in the plan's own research pass (missed
    // because it doesn't appear in an on()/getAttrs()/setAttrs() call — the
    // shapes that pass counted) — surfaced live by a real corpus sheet
    // (Blades in the Dark) whose worker script calls it directly:
    // `["fr","es","ko","pt"].includes(getTranslationLanguage())`. No real
    // language-selection mechanism exists in this runtime (translation is
    // explicitly out of scope per the plan), so this always reports "en" —
    // sheets checking for a non-English language degrade to their English
    // behavior, same as an English Roll20 campaign would see.
    function getTranslationLanguage() {
      return "en";
    }

    // ── sheet:opened / clicked / remove dispatch (internal hooks too) ────

    function dispatchSheetOpened() {
      if (sheetOpenedFired) return;
      sheetOpenedFired = true;
      listeners["sheet:opened"].forEach(({ cb }) => cb({}));
    }
    Promise.all([
      translationReady,
      ...Object.values(repeating.sections).map((s) => s.whenReady()),
    ]).then(dispatchSheetOpened);

    // `extra` lets rollButtons.js (deliverable A's next file) pass
    // {sourceAttribute, section, rowId} for a repeating-row action button —
    // the only way a `clicked:` handler can know WHICH row's button fired,
    // matching real Roll20's eventinfo shape for repeating buttons.
    function dispatchClicked(actionName, extra) {
      for (const { spec, cb } of listeners.clicked) {
        if (spec.action === actionName) cb({ triggerName: actionName, ...extra });
      }
    }

    // ── install globals ──────────────────────────────────────────────────

    global.on = on;
    global.getAttrs = getAttrs;
    global.setAttrs = setAttrs;
    global.getSectionIDs = getSectionIDs;
    // Real Roll20 API — logs to the browser console, purely a debugging
    // aid. Surfaced live by a real corpus sheet (Blades in the Dark) whose
    // worker script calls it directly, e.g. log(finalAttrs) with an object,
    // not just a string — console.log already accepts either.
    global.log = (...args) => console.log(...args);
    global.getTranslationLanguage = getTranslationLanguage;
    global.generateRowID = generateRowID;
    global.removeRepeatingRow = removeRepeatingRow;
    global.getTranslationByKey = getTranslationByKey;
    global.$20 = $20;

    return {
      dispatchClicked,
      destroy: () => {
        attrCleanup();
        repeating.destroy();
      },
    };
  }

  Roll20Compat.SheetWorkerShim = { install };
})(typeof window !== "undefined" ? window : globalThis);
