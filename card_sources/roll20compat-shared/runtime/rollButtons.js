// See attrBinding.js's header for the loading model (plain <script>,
// window.Roll20Compat namespace, no bundler).
//
// rollButtons.js: wires the two distinct button semantics the corpus
// research found — button[type="roll"] (68% of buttons, fires a dice roll)
// and button[type="action"] (35%, fires a `clicked:name` sheet-worker
// event) — into rollDispatch.js's fireRoll and sheetWorkerShim.js's
// dispatchClicked respectively.
(function (global) {
  "use strict";
  const Roll20Compat = (global.Roll20Compat = global.Roll20Compat || {});

  // ── Pure logic (Node-testable — no DOM) ───────────────────────────────────

  // A type="roll" button's `value` ranges from a bare formula ("1d20+@{mod}")
  // to a full roll-template chat message
  // ("&{template:default} {{roll=[[1d20+@{mod}]]}} {{label=Attack}}"). This
  // runtime doesn't implement Roll20's own &{template:...} rendering for
  // generic buttons — that's RollTemplate.jsx's job for hand-ported cards,
  // which has actual React state to render into. Here, just the dice
  // formula is extracted and fired through the platform's own generic roll
  // display (the same chat message every human "/roll" produces).
  //
  // Known limitation: only the FIRST [[...]] is extracted. A button value
  // like "{{roll=[[1d20]]}} {{damage=[[2d6]]}}" silently drops the second
  // roll — this runtime fires one roll per button click, not Roll20's
  // multi-roll templates. CONFIRMED live (batch-imported 8 corpus sheets,
  // deliverable C follow-up, not hypothetical): distribution of roll[type=
  // "roll"] buttons whose value embeds more than one [[...]] —
  //   Call of Cthulhu 7e: 846/879 (96%) — its core bonus/penalty-dice
  //     mechanic fires a roll1/roll2 pair on nearly every check, so this
  //     limitation silently breaks almost the whole sheet's rolling, not an
  //     edge case for this system specifically.
  //   Cyberpunk Red: 2/4 (50%). Dungeon World: 4/14 (29%).
  //   Fate Core, Blades in the Dark, Vampire (CWOD), D&D5E Character
  //     Scrolls, Classic Traveller: 0% — single-roll extraction is
  //     sufficient for these, unaffected.
  // Not fixed yet — needs a real design decision (how to represent/fire
  // multiple simultaneous rolls as one chat message, correlate every
  // embedded roll's result back for finishRoll to read), scoped out for
  // now. Revisit before treating Call of Cthulhu 7e (or any sheet with a
  // similarly-shaped multi-roll mechanic) as validated for real play.
  const INLINE_ROLL_RE = /\[\[([\s\S]*?)\]\]/;
  function extractRollFormula(buttonValue) {
    if (typeof buttonValue !== "string") return null;
    const trimmed = buttonValue.trim();
    if (!trimmed) return null;

    const inline = INLINE_ROLL_RE.exec(trimmed);
    if (inline) return inline[1].trim();

    // No [[...]] wrapper — some sheets author a button's value as a literal
    // chat-command string, or a bare formula with no brackets at all.
    return trimmed.replace(/^\/(?:roll|r)\s+/, "");
  }

  // Roll20's convention: a type="action" button is named "act_ButtonName",
  // and a worker script listens via on('clicked:ButtonName', cb) — the
  // "act_" prefix is stripped between the two. A button missing the prefix
  // (found in a minority of the corpus) is used as-is rather than dropped,
  // since Roll20 itself is documented as tolerant of that variance.
  function actionNameFromButtonName(buttonName) {
    if (typeof buttonName !== "string" || !buttonName) return null;
    return buttonName.startsWith("act_") ? buttonName.slice("act_".length) : buttonName;
  }

  // ?{Prompt} / ?{Prompt|Default} / ?{Prompt|Opt1|Opt2|...} roll queries
  // (each option may be "Label,Value"). Like rollQuery.js, a query that
  // itself contains braces (e.g. "?{Bonus|+@{prof}}") isn't matched. A vanilla duplicate of
  // components/rollQuery.js's parseQueries/resolveQueries — this runtime is
  // plain <script>s with no bundler, so it can't import that ES module.
  // scripts/smoke.mjs checks the two stay in agreement, same as
  // FormulaTranslation's own vanilla duplicate.
  const QUERY_RE = /\?\{([^{}]+)\}/g;
  function parseQueries(formula) {
    const seen = new Set();
    const queries = [];
    QUERY_RE.lastIndex = 0;
    let match;
    while ((match = QUERY_RE.exec(formula)) !== null) {
      const raw = match[0];
      if (seen.has(raw)) continue;
      seen.add(raw);
      const [prompt, ...rest] = match[1].split("|").map((s) => s.trim());
      if (rest.length >= 2) {
        const options = rest.map((opt) => {
          const [label, value] = opt.split(",").map((s) => s.trim());
          return { label, value: value ?? label };
        });
        queries.push({ raw, prompt, kind: "select", options });
      } else {
        queries.push({ raw, prompt, kind: "input", default: rest[0] ?? "" });
      }
    }
    return queries;
  }

  function resolveQueries(formula, answers) {
    QUERY_RE.lastIndex = 0;
    return formula.replace(QUERY_RE, (raw) => (raw in answers ? String(answers[raw]) : raw));
  }

  Roll20Compat.RollButtonsLogic = { extractRollFormula, actionNameFromButtonName, parseQueries, resolveQueries };

  // ── DOM glue ───────────────────────────────────────────────────────────

  // Asks every ?{...} query in `formula` at once in an in-page dialog and
  // resolves to the answered formula, or null if the player cancels (no
  // roll, same as cancelling Roll20's own query prompt). A formula with no
  // queries resolves immediately, unchanged.
  //
  // In-page DOM rather than window.prompt: cards run in an iframe with
  // sandbox="allow-scripts" only (CardPanel.js), and without allow-modals
  // Chrome ignores prompt() and returns null — every query silently took
  // its default and the player was never asked. Inline styles, since
  // roll20-base.css is scoped to .ui-dialog .charsheet and this dialog is
  // appended to <body>, outside that wrapper.
  function askQueries(formula) {
    const queries = parseQueries(formula);
    if (queries.length === 0) return Promise.resolve(formula);

    return new Promise((resolve) => {
      const doc = global.document;
      const overlay = doc.createElement("div");
      overlay.className = "r20c-query-overlay";
      overlay.setAttribute("role", "dialog");
      overlay.setAttribute("aria-modal", "true");
      overlay.style.cssText =
        "position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;" +
        "background:rgba(0,0,0,0.4);font:14px sans-serif;";

      const box = doc.createElement("div");
      box.style.cssText =
        "background:#fff;color:#222;padding:16px;border-radius:6px;min-width:240px;max-width:90vw;" +
        "box-shadow:0 4px 16px rgba(0,0,0,0.3);display:flex;flex-direction:column;gap:10px;";
      overlay.appendChild(box);

      const fields = queries.map((q) => {
        const label = doc.createElement("label");
        label.style.cssText = "display:flex;flex-direction:column;gap:4px;";
        const caption = doc.createElement("span");
        caption.textContent = q.prompt;
        label.appendChild(caption);

        let control;
        if (q.kind === "select") {
          control = doc.createElement("select");
          for (const opt of q.options) {
            const option = doc.createElement("option");
            option.value = opt.value;
            option.textContent = opt.label;
            control.appendChild(option);
          }
        } else {
          control = doc.createElement("input");
          control.type = "text";
          control.value = q.default;
        }
        control.style.cssText = "font:inherit;padding:4px;";
        label.appendChild(control);
        box.appendChild(label);
        return { query: q, control };
      });

      const actions = doc.createElement("div");
      actions.style.cssText = "display:flex;justify-content:flex-end;gap:8px;";
      const cancelBtn = doc.createElement("button");
      cancelBtn.type = "button";
      cancelBtn.textContent = "Cancel";
      const rollBtn = doc.createElement("button");
      rollBtn.type = "button";
      rollBtn.textContent = "Roll";
      actions.append(cancelBtn, rollBtn);
      box.appendChild(actions);

      const close = (result) => {
        overlay.remove();
        resolve(result);
      };
      const submit = () => {
        const answers = {};
        for (const { query, control } of fields) {
          // An emptied free-text answer falls back to "0" rather than
          // leaving a hole in the dice formula ("1d20+" won't parse). Not
          // for dropdowns: an empty option value is deliberate there
          // ("?{Proficient?|No, |Yes,+2}").
          const emptyInput = query.kind === "input" && control.value.trim() === "";
          answers[query.raw] = emptyInput ? "0" : control.value;
        }
        close(resolveQueries(formula, answers));
      };
      cancelBtn.addEventListener("click", () => close(null));
      rollBtn.addEventListener("click", submit);
      overlay.addEventListener("keydown", (e) => {
        // Enter on a focused button activates that button (Cancel must
        // cancel), so only intercept it from the fields.
        if (e.key === "Enter" && e.target.tagName !== "BUTTON") {
          e.preventDefault();
          submit();
        } else if (e.key === "Escape") {
          e.preventDefault();
          close(null);
        }
      });

      doc.body.appendChild(overlay);
      fields[0].control.focus();
    });
  }

  // Repeating rows are rendered by repeatingBinding.js as .repitem elements
  // (carrying data-reprowid) inside a .repcontainer whose data-groupname is
  // the section's "repeating_X" name — NOT inside the authored <fieldset>,
  // which is emptied and hidden.
  const REPEATING_ROW_SEL = ".repitem";

  /**
   * Handles clicks on every button[type="roll"] and button[type="action"]
   * under `root` with ONE delegated listener, rather than one per button
   * bound at load: rows added later (saved rows rendering in, "+Add") get
   * working buttons too, and a sheet with hundreds of buttons costs one
   * listener.
   * @param {Element} root
   * @param {{fireRoll: Function}} rollDispatchApi - rollDispatch.js's install() result
   * @param {{dispatchClicked: Function}} shimApi - sheetWorkerShim.js's install() result
   * @returns {{destroy: Function}}
   */
  function install(root, rollDispatchApi, shimApi) {
    const onRoll = (btn) => {
      const formula = extractRollFormula(btn.getAttribute("value"));
      if (!formula) return;
      askQueries(formula)
        .then((resolved) => (resolved === null ? null : rollDispatchApi.fireRoll(resolved)))
        .catch((err) => {
          console.error(`rollButtons: roll failed for button value "${btn.getAttribute("value")}"`, err);
        });
    };

    const onAction = (btn) => {
      const actionName = actionNameFromButtonName(btn.getAttribute("name"));
      if (!actionName) return;
      const rowEl = btn.closest(REPEATING_ROW_SEL);
      if (!rowEl) {
        shimApi.dispatchClicked(actionName);
        return;
      }
      const rowId = rowEl.getAttribute("data-reprowid");
      const groupName = rowEl.closest(".repcontainer")?.getAttribute("data-groupname");
      const section = Roll20Compat.RepeatingLogic?.parseRepeatingSectionName(groupName);
      shimApi.dispatchClicked(actionName, {
        rowId,
        section,
        sourceAttribute: section ? `repeating_${section}_${rowId}_${actionName}` : undefined,
      });
    };

    const onClick = (event) => {
      const btn = event.target.closest?.('button[type="roll"], button[type="action"]');
      if (!btn || !root.contains(btn)) return;
      if (btn.getAttribute("type") === "roll") onRoll(btn);
      // type="action" is meaningless without a worker script to catch the
      // clicked: event it fires — a worker-less sheet (~35% of the corpus, no
      // sheetWorkerShim.js loaded, shimApi undefined) legitimately ignores
      // these, same as real Roll20 with no matching on() handler.
      else if (shimApi) onAction(btn);
    };

    root.addEventListener("click", onClick);
    return { destroy: () => root.removeEventListener("click", onClick) };
  }

  Roll20Compat.RollButtons = { install };
})(typeof window !== "undefined" ? window : globalThis);
