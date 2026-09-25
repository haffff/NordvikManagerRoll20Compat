// Vanilla-JS (no bundler, no ES modules) — loaded as a plain <script> tag
// directly inside a card's sandboxed iframe alongside the ported sheet's own
// HTML/CSS/worker JS (see CardPanel.js's additionalResources mechanism).
// Every runtime/*.js file attaches to the shared window.Roll20Compat
// namespace instead of import/export, so the packager can reference each
// file as its own <script src> with no build step.
//
// attrBinding.js: two-way binds every `name="attr_*"` input OUTSIDE a
// repeating_ fieldset (those are repeatingBinding.js's job) to
// window.CardAPI.Properties. Also detects and recomputes Roll20's
// "autocalc" fields — disabled inputs whose value is itself an @{attr}
// formula rather than stored data.
(function (global) {
  "use strict";
  const Roll20Compat = (global.Roll20Compat = global.Roll20Compat || {});

  // ── Pure logic (Node-testable — no DOM) ───────────────────────────────────

  const ATTR_REF_RE = /@\{([^{}]+)\}/g;

  /** Every @{attrName} reference in a formula string, de-duplicated. */
  function parseAutocalcRefs(formula) {
    const names = new Set();
    ATTR_REF_RE.lastIndex = 0;
    let m;
    while ((m = ATTR_REF_RE.exec(formula)) !== null) names.add(m[1]);
    return Array.from(names);
  }

  // Only +, -, *, /, parens, digits, decimal points, whitespace survive
  // substitution — anything else means the formula wasn't purely arithmetic
  // (or an attribute value smuggled something unexpected in), so evaluation
  // is refused rather than risking Function() on unvalidated input.
  const SAFE_ARITHMETIC_RE = /^[\d+\-*/().\s]+$/;

  /**
   * Substitutes @{attr} with numeric values from `attrValues` (missing or
   * non-numeric attrs coerce to 0, matching Roll20's loose numeric coercion)
   * and evaluates the result as arithmetic. Returns null if the formula
   * doesn't reduce to a safe arithmetic expression or fails to evaluate —
   * never throws, since a malformed sheet formula shouldn't break the card.
   */
  function evaluateAutocalc(formula, attrValues) {
    const substituted = formula.replace(ATTR_REF_RE, (match, name) => {
      const raw = attrValues?.[name];
      const num = typeof raw === "string" ? parseFloat(raw) : raw;
      return Number.isFinite(num) ? String(num) : "0";
    });

    if (!SAFE_ARITHMETIC_RE.test(substituted)) return null;

    try {
      // eslint-disable-next-line no-new-func -- substituted is validated
      // above to contain only arithmetic characters, no identifiers.
      const result = new Function(`"use strict"; return (${substituted});`)();
      return Number.isFinite(result) ? result : null;
    } catch {
      return null;
    }
  }

  /**
   * Classifies a `name="attr_*"` input from a plain descriptor (not a live
   * DOM element, so this is unit-testable without jsdom).
   * @param {{tagName:string, type?:string, value?:string, disabled?:boolean}} el
   * @returns {"autocalc"|"checkbox"|"value"|"display"}
   */
  function classifyInput(el) {
    // <span name="attr_x"> etc. — display-only, found in the corpus used to
    // show a derived value with no corresponding form control. Read-only:
    // never gets an input/change listener, only ever written to via Get/
    // Subscribe (see bindAttrs).
    const isFormEl = el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT";
    if (!isFormEl) return "display";

    const isCheckable = el.tagName === "INPUT" && el.type === "checkbox";
    if (!isCheckable && el.disabled && typeof el.value === "string" && el.value.includes("@{")) {
      return "autocalc";
    }
    if (isCheckable) return "checkbox";
    return "value";
  }

  Roll20Compat.AttrLogic = { parseAutocalcRefs, evaluateAutocalc, classifyInput, SAFE_ARITHMETIC_RE };

  // ── DOM glue (not unit-tested directly — thin orchestration only) ────────

  const attrName = (el) => {
    const name = el.getAttribute("name") || "";
    return name.startsWith("attr_") ? name.slice(5) : null;
  };

  // Word-boundary-safe — `closest("fieldset[class*='repeating_']")` would
  // also match a class like "sheet-norepeating_x" (substring match, no
  // boundary). Walked manually since CSS attribute selectors can't express
  // the boundary that repeatingBinding.js's REPEATING_CLASS_RE already relies on.
  const REPEATING_FIELDSET_RE = /(?:^|\s)repeating_[a-zA-Z0-9_-]+(?:\s|$)/;
  const isInsideRepeating = (el) => {
    for (let node = el.parentElement; node; node = node.parentElement) {
      if (node.tagName === "FIELDSET" && REPEATING_FIELDSET_RE.test(node.className || "")) return true;
    }
    return false;
  };

  // Reads the attribute (not the live DOM property, which defaults to "on"
  // for every checkbox regardless of markup) so a sheet's explicit
  // value="on" checkbox round-trips as "on", not silently normalized to "1"
  // the same as a bare checkbox with no value attribute at all.
  //
  // Unchecked returns "0", NOT "" — confirmed against dozens of real,
  // browser-saved Roll20 examples (Blades in the Dark's own
  // attr_setting_dc_action alone has 30+ paired "hider" companions all
  // showing value="0" for an unchecked state). This matters beyond cosmetics:
  // a checkbox commonly shares its bare attr_ name with a `type="hidden"
  // class="hider"` companion element whose OWN CSS keys off the LITERAL
  // string "0" (`.hider[value="0"] + div { display: none }`) — writing ""
  // there instead of "0" means that selector can never match again once
  // the checkbox has been toggled even once, which is exactly why Blades'
  // settings panel could be opened but never closed again (confirmed live).
  function readCheckable(el) {
    if (!el.checked) return "0";
    const explicit = el.getAttribute("value");
    return explicit !== null ? explicit : "1";
  }

  // A <textarea>'s real default is its own text-node content (mirrored by
  // the .value DOM property) — a `value="..."` HTML ATTRIBUTE on a
  // textarea is invalid and browsers silently ignore it. Confirmed live in
  // a real corpus sheet (D&D5E Character Scrolls) authoring exactly that
  // mistake — `<textarea name="attr_appearance" value="Hair, eyes, skin,
  // scars, etc."></textarea>`, no actual text content — which would
  // otherwise lose that authored default to the sheet's own markup error.
  // Falls back to the (non-standard but observed) attribute only when the
  // real content is empty, so a textarea with genuine authored body text
  // is never overridden by a stray value= attribute someone also left on it.
  function readFieldDefault(el) {
    if (el.tagName === "TEXTAREA" && !el.value && el.hasAttribute("value")) {
      return el.getAttribute("value");
    }
    return el.value;
  }

  // Also mirrors the write onto the HTML `value` ATTRIBUTE, not just the
  // DOM .value property — browsers never reflect a .value property write
  // back onto the attribute, but a huge fraction of the corpus's own CSS
  // depends on the attribute directly via sibling/self attribute selectors
  // (Roll20's extremely common "hider" convention: `.hider[value="0"] +
  // div { display: none }`, and its many variants — light-hider,
  // heavy-hider, claimhider, custom-action-toggle, tab-toggles, ...).
  // Confirmed live: Blades in the Dark's settings gear is exactly this —
  // `<input type="checkbox" name="attr_show_settings">` (the visible
  // toggle) and `<input type="hidden" class="hider" name="attr_show_settings"
  // value="0">` (the CSS-matched one) share the same attr_ name, so toggling
  // the checkbox correctly updated Properties and this SAME hidden input's
  // .value property, but its `value` ATTRIBUTE — the only thing
  // `.hider[value="0"]`'s selector ever reads — never changed, so the
  // settings panel could open but never close again.
  function writeElementValue(el, kind, value) {
    if (kind === "display") {
      el.textContent = value ?? "";
    } else if (kind === "checkbox") {
      // Checked exactly when the GROUP's resolved value matches THIS
      // checkbox's own value attribute — the same rule the radio branch
      // below already uses, not a generic "is value truthy" check. Needed
      // for a second, equally common Roll20 pattern beyond the simple
      // boolean toggle (show_settings, one checkbox, value="1" when
      // checked): several checkboxes sharing ONE bare name with DIFFERENT
      // static values, acting as a "fake radio" (confirmed live: Blades'
      // own attr_hunt/study/survey/tinker dice-rating tracks — 6 checkboxes
      // each, class="fakeradio", values "0".."5"). A truthy check would
      // check EVERY member simultaneously once any one of them resolves
      // non-empty; matching against each element's own value, exactly like
      // a real radio, checks only the one whose value equals the resolved
      // group value, exactly reproducing the intended single-select
      // behavior without needing to special-case which pattern applies.
      const ownValue = el.getAttribute("value") ?? "1";
      el.checked = String(value ?? "0") === String(ownValue);
    } else if (el.type === "radio") {
      el.checked = String(el.value) === String(value ?? "");
    } else {
      el.value = value ?? "";
      el.setAttribute("value", value ?? "");
    }
  }

  // Roll20 sheets bake real default data into attr_* fields' own HTML —
  // not just placeholder text. Two confirmed real cases: `<input
  // type="label" name="attr_STR-label" value="Strength" readonly>` (a
  // Roll20-specific convention for a per-character-overridable label —
  // "Strength" IS the field's actual data, not a hint) and ordinary
  // starting-stat defaults (e.g. `value="10"` on an ability score). Init()
  // only creates the property if it doesn't already exist server-side
  // (see repeatingBinding.js's own Properties.Init(name, "[]") for the
  // same primitive used the same way) — so the first client to ever open
  // this card seeds the real starting value, and every later open/client
  // just reads back whatever's already there (this seed, or a genuine
  // edit). Without this, the FIRST Properties.Get() on a fresh property
  // resolves to undefined, and every field with an authored default
  // (label text included) gets blanked to "" the instant it binds —
  // confirmed live: 13th Age Glorantha's six ability-score labels
  // ("Strength", "Constitution", ...) rendered as empty text for exactly
  // this reason.
  async function seedAndGet(cardApi, name, defaultValue) {
    await cardApi.Properties.Init(name, defaultValue);
    const prop = await cardApi.Properties.Get(name);
    return prop?.value ?? defaultValue;
  }

  /**
   * Binds every non-repeating attr_* input under `root` to `cardApi`.
   * Returns a cleanup function.
   */
  function bindAttrs(root, cardApi) {
    const cleanups = [];
    const autocalcEls = []; // { el, name, formula, refs: string[] }
    const attrValueCache = {};

    const inputs = Array.from(root.querySelectorAll("[name^='attr_']")).filter(
      (el) => !isInsideRepeating(el)
    );

    // Group radios by name — they share one property, not one per <input>.
    const radioGroups = new Map();

    // The same attr_ name can appear on more than one element (a display
    // span mirroring an editable input elsewhere in the sheet, or the same
    // field repeated across tabs — both real in the corpus). Grouped by
    // name and seeded ONCE per group below: calling seedAndGet once per
    // ELEMENT would fire concurrent Properties.Init() calls for the same
    // name, and since Init's "does it already exist" check races its own
    // Add (fire-and-forget send, not a round trip), two elements sharing a
    // name could each create the property, duplicating it server-side.
    const fieldGroups = new Map(); // name -> [{ el, kind }]

    for (const el of inputs) {
      const name = attrName(el);
      if (!name) continue;

      const descriptor = { tagName: el.tagName, type: el.type, value: el.value, disabled: el.disabled };
      const kind = classifyInput(descriptor);

      if (kind === "autocalc") {
        autocalcEls.push({ el, name, formula: el.value, refs: parseAutocalcRefs(el.value) });
        continue;
      }

      if (el.type === "radio") {
        if (!radioGroups.has(name)) radioGroups.set(name, []);
        radioGroups.get(name).push(el);
        continue;
      }

      if (!fieldGroups.has(name)) fieldGroups.set(name, []);
      fieldGroups.get(name).push({ el, kind });
    }

    for (const [name, group] of fieldGroups.entries()) {
      const isPureDisplay = group.every((g) => g.kind === "display");

      if (isPureDisplay) {
        // Read-only: no listener, just keeps text in sync with the server.
        // Seeded from the first element's initial text (see seedAndGet's
        // comment) — a display span commonly ships a real baked-in value
        // (e.g. a button's <span name="attr_ws">31</span>), not a hint.
        // Trimmed since pretty-printed source HTML can leave stray
        // whitespace/newlines as a display span's textContent.
        const displayDefault = (group[0].el.textContent ?? "").trim();
        seedAndGet(cardApi, name, displayDefault).then((value) => {
          attrValueCache[name] = value;
          for (const { el, kind } of group) writeElementValue(el, kind, value);
        });
        const onServerChange = (prop) => {
          const value = prop?.value ?? "";
          attrValueCache[name] = value;
          for (const { el, kind } of group) writeElementValue(el, kind, value);
        };
        cardApi.Properties.Subscribe(name, onServerChange);
        cleanups.push(() => cardApi.Properties.Unsubscribe(name, onServerChange));
        continue;
      }

      // At least one editable element shares this name — the authored
      // default comes from the first EDITABLE element whose OWN default is
      // non-empty, captured BEFORE anything touches it. Not just "the
      // first editable element": the same attr_ name can legitimately
      // appear twice for two different roles with only one of them
      // actually carrying the real default — confirmed live in two real
      // corpus sheets (Dungeon World's attr_HP appears both on an NPC
      // block with no value and on the PC tracker with value="0"; 13th Age
      // Glorantha's attr_custom-label-1 appears both as a readonly
      // placeholder-only header and as the real customizable value="Title"
      // field elsewhere) — picking whichever happens to be first in DOM
      // order silently picked the empty one in both cases. Falls back to
      // the first editable element if none of them have a non-empty
      // default (nothing to prefer in that case).
      // For "checkbox" kind, checked itself (not readCheckable()'s return
      // value) is what signals "this one actually matters" — readCheckable
      // always returns something non-empty now ("0" for unchecked, not
      // ""; see its own header for why), so an unchecked "fakeradio"
      // sibling (Blades' own attr_hunt: 6 checkboxes sharing this name,
      // only one meant to ever be checked) would otherwise satisfy this
      // "non-empty" test just as much as the genuinely-checked one,
      // breaking primary selection whenever the checked option isn't the
      // very first one in DOM order.
      const editableGroup = group.filter((g) => g.kind !== "display");
      const primary =
        editableGroup.find((g) => {
          if (g.kind === "checkbox") return g.el.checked;
          return readFieldDefault(g.el) !== "";
        }) ?? editableGroup[0];
      const fieldDefault = primary.kind === "checkbox" ? readCheckable(primary.el) : readFieldDefault(primary.el);

      for (const { el, kind } of group) {
        if (kind === "display") continue;
        const onInput = () => {
          const value = kind === "checkbox" ? readCheckable(el) : el.value;
          attrValueCache[name] = value;
          cardApi.Properties.Set(name, value);
        };
        el.addEventListener(kind === "checkbox" ? "change" : "input", onInput);
        cleanups.push(() => el.removeEventListener(kind === "checkbox" ? "change" : "input", onInput));
      }

      seedAndGet(cardApi, name, fieldDefault).then((value) => {
        attrValueCache[name] = value;
        for (const { el, kind } of group) writeElementValue(el, kind, value);
      });

      // Skips the currently-focused element — a server echo of this user's
      // own edit, or another client's concurrent edit, would otherwise reset
      // the caret mid-keystroke on the exact field being typed into.
      const onServerChange = (prop) => {
        const value = prop?.value ?? "";
        attrValueCache[name] = value;
        for (const { el, kind } of group) {
          if (document.activeElement !== el) writeElementValue(el, kind, value);
        }
      };
      cardApi.Properties.Subscribe(name, onServerChange);
      cleanups.push(() => cardApi.Properties.Unsubscribe(name, onServerChange));
    }

    for (const [name, radios] of radioGroups.entries()) {
      // The authored default is whichever radio the sheet marked checked
      // (if any) — same seedAndGet reasoning as the other binding paths.
      const radioDefault = radios.find((r) => r.checked)?.value ?? "";

      const onChange = () => {
        const checked = radios.find((r) => r.checked);
        const value = checked?.value ?? "";
        attrValueCache[name] = value;
        cardApi.Properties.Set(name, value);
      };
      radios.forEach((r) => r.addEventListener("change", onChange));
      cleanups.push(() => radios.forEach((r) => r.removeEventListener("change", onChange)));

      seedAndGet(cardApi, name, radioDefault).then((value) => {
        attrValueCache[name] = value;
        radios.forEach((r) => writeElementValue(r, "radio", value));
      });

      const onServerChange = (prop) => {
        const value = prop?.value ?? "";
        attrValueCache[name] = value;
        radios.forEach((r) => writeElementValue(r, "radio", value));
      };
      cardApi.Properties.Subscribe(name, onServerChange);
      cleanups.push(() => cardApi.Properties.Unsubscribe(name, onServerChange));
    }

    // Autocalc fields recompute whenever any @{ref} they depend on changes —
    // never written to Properties themselves, purely derived/displayed.
    //
    // An autocalc field can itself be another autocalc field's @{ref} (a
    // derived-from-derived chain) — its name is never a real Properties row,
    // so the per-refName Get/Subscribe below resolves it to "" and would
    // stay stuck there with a single pass. Multiple bounded passes let each
    // pass's freshly-computed result feed the next, resolving chains up to
    // MAX_PASSES deep without needing a real topological sort. A pass count
    // beyond that just re-settles on whatever a cyclic formula converges to
    // (or doesn't) — it never throws or loops unboundedly.
    if (autocalcEls.length > 0) {
      const MAX_PASSES = 5;
      const recompute = () => {
        for (let pass = 0; pass < MAX_PASSES; pass++) {
          for (const entry of autocalcEls) {
            const result = evaluateAutocalc(entry.formula, attrValueCache);
            if (result !== null) {
              entry.el.value = String(result);
              attrValueCache[entry.name] = String(result);
            }
          }
        }
      };
      const allRefs = new Set(autocalcEls.flatMap((e) => e.refs));
      const subs = [];
      for (const refName of allRefs) {
        const onChange = (prop) => {
          attrValueCache[refName] = prop?.value ?? "";
          recompute();
        };
        cardApi.Properties.Subscribe(refName, onChange);
        subs.push(() => cardApi.Properties.Unsubscribe(refName, onChange));
        cardApi.Properties.Get(refName).then((prop) => {
          attrValueCache[refName] = prop?.value ?? "";
          recompute();
        });
      }
      cleanups.push(...subs);
    }

    return () => cleanups.forEach((fn) => fn());
  }

  Roll20Compat.AttrBinding = { bindAttrs };
})(typeof window !== "undefined" ? window : globalThis);
