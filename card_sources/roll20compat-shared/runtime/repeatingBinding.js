// See attrBinding.js's header for the loading model (plain <script>,
// window.Roll20Compat namespace, no bundler).
//
// repeatingBinding.js: binds `<fieldset class="repeating_X">` sections to
// window.CardAPI.Properties.List.* (the backend's stable-id list property —
// see usePropertyListV2.js, the React equivalent of this same logic).
//
// Roll20's authored HTML contains exactly ONE template row per repeating_X
// fieldset (Roll20's own client clones it at render time — confirmed via the
// project's corpus research); this file does the same cloning, driven by our
// own list-property data instead of Roll20's.
//
// Add/remove row controls are NOT present in a sheet's source HTML — Roll20
// auto-injects them at render time. Confirmed EXACTLY via two real,
// browser-saved Roll20 popouts (Blades in the Dark, Cyberpunk Red raycw):
// immediately after each authored `<fieldset class="repeating_X">...</fieldset>`
// template, Roll20 inserts two sibling elements — a `.repcontainer` div
// (data-groupname="repeating_X") holding one `.repitem` div per row
// (data-reprowid="<id>", each prefixed with an `.itemcontrol` wrapper
// holding `.repcontrol_del`/`.repcontrol_move`), followed by a `.repcontrol`
// div (same data-groupname) holding `.repcontrol_edit`/`.repcontrol_add`
// buttons. The original fieldset itself is left in the DOM (as the
// template source) but is not part of the visible row list. This file
// reproduces that exact structure so a sheet's own CSS — which commonly
// targets these classes directly — applies for free, instead of the plain
// unstyled buttons/rows a from-scratch structure would produce.
//
// Deliberately NOT reproduced: `.repcontrol_edit`'s real "Modify" toggle
// behavior (real Roll20 hides `.itemcontrol` until "Modify" is clicked,
// confirmed via the reference popout's own CSS —
// `.repcontainer.editmode .repitem .itemcontrol:has(+ .light-hider...)`)
// and `.repcontrol_move`'s drag-to-reorder. Both are real Roll20 behaviors
// this runtime doesn't implement (no reordering support at all yet) —
// showing a non-functional "Modify"/drag handle would be more misleading
// than the delete button just always being visible, so this only emits
// `.itemcontrol > .repcontrol_del` and `.repcontrol > .repcontrol_add`.
(function (global) {
  "use strict";
  const Roll20Compat = (global.Roll20Compat = global.Roll20Compat || {});

  // ── Pure logic (Node-testable — no DOM) ───────────────────────────────────

  const REPEATING_CLASS_RE = /(?:^|\s)repeating_([a-zA-Z0-9_-]+)(?:\s|$)/;

  /** Extracts "items" from a fieldset's className "sheet-x repeating_items". */
  function parseRepeatingSectionName(className) {
    const m = REPEATING_CLASS_RE.exec(className || "");
    return m ? m[1] : null;
  }

  /** Groups fieldset descriptors ({className}) by their repeating_X name. */
  function groupBySectionName(fieldsetDescriptors) {
    const groups = {};
    for (const desc of fieldsetDescriptors) {
      const name = parseRepeatingSectionName(desc.className);
      if (!name) continue;
      (groups[name] = groups[name] || []).push(desc);
    }
    return groups;
  }

  Roll20Compat.RepeatingLogic = { parseRepeatingSectionName, groupBySectionName };

  // ── DOM glue ───────────────────────────────────────────────────────────

  const attrFieldName = (el) => {
    const name = el.getAttribute("name") || "";
    return name.startsWith("attr_") ? name.slice(5) : null;
  };

  // Reads the attribute (not the live DOM property, which defaults to "on"
  // for every checkbox) so an explicit value="on" checkbox round-trips as
  // "on" rather than being normalized the same as a bare checkbox.
  // Unchecked returns "0", not "" — see attrBinding.js's own readCheckable
  // for the full evidence (a real, confirmed bug otherwise: a "hider"
  // companion sharing this row field's name keys its CSS off the literal
  // string "0", never "").
  function readCheckable(el) {
    if (!el.checked) return "0";
    const explicit = el.getAttribute("value");
    return explicit !== null ? explicit : "1";
  }

  // Also mirrors onto the HTML `value` ATTRIBUTE, not just the DOM .value
  // property — see attrBinding.js's own writeElementValue for the full
  // story (a real, confirmed bug: a within-row "hider"-style toggle whose
  // CSS matches `[value="0"]` directly would never actually hide/show
  // anything from this path either, same root cause).
  function writeElementValue(el, value) {
    // Matches this checkbox's OWN value attribute, not a generic truthy
    // check — see attrBinding.js's own writeElementValue for the full
    // "fakeradio" evidence (several checkboxes sharing one row-field name
    // with different static values, acting as a single-select).
    if (el.type === "checkbox") {
      const ownValue = el.getAttribute("value") ?? "1";
      el.checked = String(value ?? "0") === String(ownValue);
    } else {
      el.value = value ?? "";
      el.setAttribute("value", value ?? "");
    }
  }

  // Binds every attr_* field inside one cloned row element to `item.fields`,
  // via `onFieldCommit(key, value)`. Scoped entirely to `rowEl` — this is
  // what resolves the cross-section name-collision risk the corpus research
  // found (two different repeating_ sections reusing the same bare field
  // name): lookups never escape the row's own subtree.
  //
  // Text fields commit on "change" (blur/Enter), not "input" (every
  // keystroke) — matches the blur-commit pattern used elsewhere in this
  // library (useFieldInput.js) and avoids firing a List.Update round-trip
  // per character typed.
  function bindRowFields(rowEl, item, onFieldCommit) {
    const cleanups = [];
    const inputs = rowEl.querySelectorAll("[name^='attr_']");
    for (const el of inputs) {
      const key = attrFieldName(el);
      if (!key) continue;

      const isCheckbox = el.type === "checkbox";
      // Captured BEFORE writeElementValue touches it — the template row's
      // own authored default (e.g. a repeating field shipping value="1").
      // Falls back to it via ?? (not `in`/hasOwnProperty) specifically so
      // an EXPLICIT "" in item.fields (a user who deliberately cleared the
      // field) stays cleared — ?? only falls through on null/undefined,
      // which is exactly "this key was never set" (a freshly-added row's
      // Properties.List.Add(name, {}) has no keys at all). Same reasoning
      // as attrBinding.js's seedAndGet, but resolved synchronously — a
      // repeating row's fields are fully specified client-side already, no
      // server round-trip needed to know the fallback.
      const templateDefault = isCheckbox ? readCheckable(el) : el.value;
      writeElementValue(el, item.fields?.[key] ?? templateDefault);

      const onInput = () => onFieldCommit(key, isCheckbox ? readCheckable(el) : el.value);
      el.addEventListener("change", onInput);
      cleanups.push(() => el.removeEventListener("change", onInput));
    }
    return () => cleanups.forEach((fn) => fn());
  }

  // Refreshes an already-bound row's field values from fresh server data
  // WITHOUT touching the DOM subtree, and skips the currently-focused
  // element — otherwise a concurrent edit arriving from another client (or
  // this client's own echo) would reset the caret or discard an in-progress,
  // uncommitted edit the moment any row in the section changes.
  function refreshRowFields(rowEl, item) {
    const inputs = rowEl.querySelectorAll("[name^='attr_']");
    for (const el of inputs) {
      if (el === document.activeElement) continue;
      const key = attrFieldName(el);
      if (!key) continue;
      // Falls back to whatever's currently displayed (not "") when this key
      // is still absent from item.fields — a field a user never touched has
      // no server value to refresh FROM, so a refresh must be a no-op for
      // it, not a re-trigger of the same wipe-to-empty bug bindRowFields'
      // own templateDefault fixes on first render (this function has no
      // access to that original template string, but "leave it as-is" is
      // the correct fallback either way — there's nothing new to show).
      const isCheckbox = el.type === "checkbox";
      const current = isCheckbox ? readCheckable(el) : el.value;
      writeElementValue(el, item.fields?.[key] ?? current);
    }
  }

  /**
   * One repeating_X list, backed by cardApi.Properties.List.*, rendered into
   * every fieldset that shares that section name. Returns a small API that
   * sheetWorkerShim.js also uses (getSectionIDs/generateRowID/removeRepeatingRow).
   */
  function createSection(name, fieldsets, cardApi) {
    // The Properties STORE key is namespaced ("repeating_" + name), kept
    // distinct from `name` itself (used unprefixed everywhere else in this
    // file/sheetWorkerShim.js for JS-level lookups — sections[name],
    // parseRepeatingKey's section matching, etc., all of which must stay
    // bare to match Roll20's own key-parsing convention). Confirmed live:
    // a real corpus sheet (Cyberpunk Red Tabbed) has BOTH a plain
    // `attr_cash` field (value="0") and a `repeating_cash` section — Roll20
    // itself clearly treats these as unrelated (both exist on the same
    // real sheet without issue), but this runtime was storing both under
    // the same bare "cash" property key, so whichever's Init/Set ran last
    // silently corrupted the other's (a repeating list stops being valid
    // JSON-array, and items.map throws in render() the next time anything
    // touches this section — caught by the validation sandbox, not
    // reachable from a purely visual check).
    const propertyKey = "repeating_" + name;
    // Each fieldset gets its own persistent addBtn and a rows Map (id →
    // {wrapper, cleanup}), reused across every render() call instead of
    // being torn down and rebuilt — that's what makes render() below a diff
    // instead of a destroy-and-recreate (see the review note this fixes:
    // the old fieldset.innerHTML = "" per render wiped out whatever row the
    // user was actively editing on every single property_update broadcast,
    // including ones from an entirely different row).
    const groupName = "repeating_" + name;

    const templates = fieldsets.map((fs) => {
      const template = fs.innerHTML;
      fs.innerHTML = "";
      // The authored fieldset stays in the DOM (matches real Roll20 — its
      // own template source is left in place, just not visible) but is no
      // longer the rows container; .repcontainer/.repcontrol are new
      // siblings inserted right after it, exactly where the real platform
      // puts them.
      fs.style.display = "none";

      const repcontainer = document.createElement("div");
      repcontainer.className = "repcontainer";
      repcontainer.setAttribute("data-groupname", groupName);
      fs.parentNode.insertBefore(repcontainer, fs.nextSibling);

      const addBtn = document.createElement("button");
      addBtn.type = "button";
      addBtn.className = "btn repcontrol_add";
      addBtn.textContent = "+Add";
      // Disabled until the section's list property is confirmed to exist
      // server-side — see the Init/Get race note below. Clicking before
      // that would race Properties.Init's fire-and-forget Add.
      addBtn.disabled = true;
      addBtn.addEventListener("click", () => cardApi.Properties.List.Add(propertyKey, {}));

      const repcontrol = document.createElement("div");
      repcontrol.className = "repcontrol";
      repcontrol.setAttribute("data-groupname", groupName);
      repcontrol.appendChild(addBtn);
      repcontainer.parentNode.insertBefore(repcontrol, repcontainer.nextSibling);

      return { fieldset: fs, repcontainer, template, addBtn, rows: new Map() };
    });

    let items = [];

    const render = () => {
      for (const state of templates) {
        const { repcontainer, template, rows } = state;
        const seenIds = new Set(items.map((item) => item.id));

        // Removals run BEFORE reordering. Otherwise a row about to be
        // deleted can still sit between the reconciliation cursor and its
        // next target, forcing an unnecessary insertBefore of an unrelated,
        // still-live row — which drops focus/caret on that row exactly like
        // the destroy-and-recreate bug this replaced (insertBefore moves a
        // node even when it's already attached).
        for (const [id, entry] of rows) {
          if (seenIds.has(id)) continue;
          entry.cleanup();
          entry.wrapper.remove();
          rows.delete(id);
        }

        let prevEl = null;
        for (const item of items) {
          let entry = rows.get(item.id);
          if (!entry) {
            // "repitem" + data-reprowid + a leading .itemcontrol wrapper
            // around .repcontrol_del — the exact structure confirmed live
            // against two real Roll20 popouts (see this file's header).
            const wrapper = document.createElement("div");
            wrapper.className = "repitem";
            wrapper.setAttribute("data-reprowid", item.id);
            wrapper.innerHTML = template;

            const cleanup = bindRowFields(wrapper, item, (key, value) => {
              cardApi.Properties.List.Update(propertyKey, item.id, { [key]: value });
            });

            const itemControl = document.createElement("div");
            itemControl.className = "itemcontrol";
            const delBtn = document.createElement("button");
            delBtn.type = "button";
            // "btn-danger pictos" match the real classes exactly (see this
            // file's header) — no pictos icon font is bundled here, so the
            // "✕" fallback glyph (real Roll20 uses a pictos font ligature)
            // keeps the button legible without it.
            delBtn.className = "btn btn-danger pictos repcontrol_del";
            delBtn.textContent = "✕";
            delBtn.addEventListener("click", () => cardApi.Properties.List.Remove(propertyKey, item.id));
            itemControl.appendChild(delBtn);
            wrapper.insertBefore(itemControl, wrapper.firstChild);

            entry = { wrapper, cleanup };
            rows.set(item.id, entry);
          } else {
            refreshRowFields(entry.wrapper, item);
          }

          // Keyed reconciliation: move a row's wrapper only if it isn't
          // already in the right spot, so unaffected rows (and any field
          // inside them mid-edit) are never detached from the DOM.
          const expectedNext = prevEl ? prevEl.nextSibling : repcontainer.firstChild;
          if (expectedNext !== entry.wrapper) repcontainer.insertBefore(entry.wrapper, expectedNext);
          prevEl = entry.wrapper;
        }
      }
    };

    // Properties.Init(name, "[]") only guarantees the Add was *sent*, not
    // that the server has processed it yet (documented, pre-existing
    // fire-and-forget gap — see usePropertyListV2.js). A user clicking
    // "+ Add" before that lands would hit a property that doesn't exist yet
    // server-side. Since the add button only becomes clickable once this
    // resolves with a real property (see addBtn.disabled below), a short
    // bounded retry closes the gap rather than trusting Init's local "sent"
    // resolution alone.
    const waitForProperty = async (retries = 5, delayMs = 150) => {
      for (let i = 0; i < retries; i++) {
        const prop = await cardApi.Properties.Get(propertyKey);
        if (prop) return prop;
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
      return null;
    };

    // Resolved once, on the first confirmed-real load (or on waitForProperty
    // giving up, which still unblocks callers rather than hanging forever —
    // same "degrade, don't deadlock" choice the disabled-button retry makes).
    // sheetWorkerShim.js awaits this before letting getSectionIDs/getAttrs/
    // setAttrs touch this section, and before firing sheet:opened.
    let readyResolve;
    const readyPromise = new Promise((resolve) => {
      readyResolve = resolve;
    });
    const markReady = () => {
      readyResolve();
      templates.forEach((t) => (t.addBtn.disabled = false));
    };

    cardApi.Properties.Init(propertyKey, "[]").then(async () => {
      const prop = await waitForProperty();
      try {
        items = JSON.parse(prop?.value || "[]");
      } catch {
        items = [];
      }
      markReady();
      render();
    });

    const onChange = (prop) => {
      try {
        items = prop ? JSON.parse(prop.value || "[]") : [];
      } catch {
        items = [];
      }
      // Only a confirmed-existing property should re-enable the add button —
      // a null/removed prop here means the property doesn't exist (or was
      // deleted), which is exactly the state the disabled guard exists to
      // prevent clicking through.
      if (prop) markReady();
      render();
    };
    cardApi.Properties.Subscribe(propertyKey, onChange);

    return {
      whenReady: () => readyPromise,
      getSectionIDs: () => items.map((i) => i.id),
      // itemId is optional — see AddPropertyListItemCommand.ItemId. Used by
      // sheetWorkerShim.js to honor a generateRowID() id the worker script
      // already handed out before the row existed.
      addItem: (fields, itemId) => cardApi.Properties.List.Add(propertyKey, fields || {}, itemId),
      removeItem: (id) => cardApi.Properties.List.Remove(propertyKey, id),
      updateItem: (id, fields) => cardApi.Properties.List.Update(propertyKey, id, fields || {}),
      getItem: (id) => items.find((i) => i.id === id) || null,
      destroy: () => {
        cardApi.Properties.Unsubscribe(propertyKey, onChange);
        templates.forEach((t) => t.rows.forEach((entry) => entry.cleanup()));
      },
    };
  }

  /**
   * Binds every repeating_X fieldset under `root`. Returns
   * { sections: { [name]: sectionApi }, destroy() }.
   */
  function bindRepeating(root, cardApi) {
    const fieldsets = Array.from(root.querySelectorAll("fieldset[class*='repeating_']"));
    const groups = groupBySectionName(
      fieldsets.map((fs) => ({ className: fs.className, __el: fs }))
    );

    const sections = {};
    for (const [name, descs] of Object.entries(groups)) {
      sections[name] = createSection(name, descs.map((d) => d.__el), cardApi);
    }

    return {
      sections,
      destroy: () => Object.values(sections).forEach((s) => s.destroy()),
    };
  }

  Roll20Compat.RepeatingBinding = { bindRepeating };
})(typeof window !== "undefined" ? window : globalThis);
