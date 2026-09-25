// See attrBinding.js's header for the loading model (plain <script>,
// window.Roll20Compat namespace, no bundler).
//
// rollDispatch.js: implements startRoll/finishRoll by translating a Roll20
// formula and firing it through the platform's existing chat/roll pipeline
// (the SAME "/roll" command a human types in chat — ChatHandler.cs's
// ParseCommand, DiceEngine.Evaluate), then correlating the async broadcast
// result back to the caller.
//
// FormulaTranslation below is a deliberate, verbatim duplicate of
// roll20compat-shared/dice/roll20FormulaTranslator.js's logic (including its
// two already-fixed ordering bugs — see that file's own comments), not a
// reference to it: that file is a real ES module (import/export), built for
// the React hand-porting path via a bundler. This runtime path has no
// bundler — every runtime/*.js file is a plain <script> attaching to
// window.Roll20Compat (see attrBinding.js's header for why). A shared
// ES-module file can't be loaded as a plain <script> tag (the `export`
// keyword is a syntax error outside module context), so keeping one
// implementation and switching the packager's script-tag type was the other
// option; the plan settled on this file staying self-contained like its
// runtime/*.js siblings rather than being the one exception.
(function (global) {
  "use strict";
  const Roll20Compat = (global.Roll20Compat = global.Roll20Compat || {});

  // ── FormulaTranslation (verbatim duplicate — see header) ────────────────

  const OUTER_WRAP_RE = /^\[\[([\s\S]*)\]\]$/;
  const COMMENT_RE = /\[[^[\]]*\]/g;
  const ATTR_RE = /@\{([^{}]+)\}/g;

  class Roll20FormulaError extends Error {
    constructor(message) {
      super(message);
      this.name = "Roll20FormulaError";
    }
  }

  const INNERMOST_INLINE_ROLL_RE = /\[\[([^\[\]]*(?:\[[^\[\]]*\][^\[\]]*)*)\]\]/;
  function flattenNestedInlineRolls(f) {
    let prev;
    do {
      prev = f;
      f = f.replace(INNERMOST_INLINE_ROLL_RE, (_, inner) => "(" + inner.trim() + ")");
    } while (f !== prev);
    return f;
  }

  function translateFormula(formula, attributes) {
    attributes = attributes || {};
    if (typeof formula !== "string" || !formula.trim()) {
      throw new Roll20FormulaError("translateFormula: empty formula.");
    }

    let f = formula.trim();

    if (f.includes("?{")) {
      throw new Roll20FormulaError(
        `translateFormula: unresolved roll query in "${formula}" — resolve ?{...} tokens before translating.`
      );
    }

    const wrapped = f.match(OUTER_WRAP_RE);
    if (wrapped) f = wrapped[1].trim();

    // A nested inline roll (Cyberpunk 2020: [[1d10!! + [[@{Ref}]] ]]) is
    // rolled first in Roll20 and its total added in — the same total as
    // rolling it as a parenthesised part of the outer formula.
    f = flattenNestedInlineRolls(f);

    f = f.replace(COMMENT_RE, "").trim();

    f = f.replace(ATTR_RE, (match, attrName) => {
      if (!(attrName in attributes)) {
        throw new Roll20FormulaError(`translateFormula: missing attribute "@{${attrName}}" in "${formula}".`);
      }
      return String(attributes[attrName]);
    });

    if (f.includes("{") || f.includes(",")) {
      throw new Roll20FormulaError(
        `translateFormula: "${formula}" uses a Roll20 construct this translator doesn't support ` +
          `(grouped/pool syntax, or comma-separated rolls).`
      );
    }

    return f.trim();
  }

  Roll20Compat.FormulaTranslation = { translateFormula, Roll20FormulaError };

  // ── Pure logic ────────────────────────────────────────────────────────

  // The "/roll <formula> <template>" chat command (ChatHandler.cs's
  // ParseCommand) splits the WHOLE message on plain spaces with no quoting —
  // so BOTH the formula and the template argument must be space-free to
  // survive the split intact. translateFormula doesn't guarantee a
  // space-free result (real sheets write "1d20 + 5" with spaces around
  // operators, and only comment-stripping/@{} substitution run before this
  // — neither removes deliberate spacing), so whitespace is stripped here,
  // not left to the caller to remember.
  //
  // The nonce rides in borderColor, not title/message — every other
  // ChatTemplate field renders as visible text in RollChatTemplate.js
  // (title as a label, message as an italic note); borderColor only ever
  // feeds a CSS borderColor style prop, so a nonce there is, at worst, a
  // harmlessly-invalid color value the browser ignores — never garbage text
  // shown to every player in the game.
  function buildRollCommand(translatedFormula, nonce) {
    const compact = translatedFormula.replace(/\s+/g, "");
    return `/roll ${compact} ${JSON.stringify({ borderColor: nonce })}`;
  }

  // A "chat_push" broadcast's data is parsedMsg.Data re-serialized by
  // ChatService.ParseRollFromUser — a JSON string of a RollChatTemplate
  // (camelCase: title, roll, message, color, borderColor). Plain chat text
  // (not a roll) isn't JSON at all, so a parse failure here just means "this
  // broadcast isn't a roll result" — never an error to surface.
  function parseRollBroadcast(rawData) {
    let parsed;
    try {
      parsed = typeof rawData === "string" ? JSON.parse(rawData) : rawData;
    } catch {
      return null;
    }
    if (!parsed || typeof parsed !== "object" || !parsed.roll) return null;
    return parsed;
  }

  Roll20Compat.RollDispatchLogic = { buildRollCommand, parseRollBroadcast };

  // ── DOM/runtime glue ─────────────────────────────────────────────────

  let nonceCounter = 0;
  function generateNonce() {
    nonceCounter += 1;
    return `r20n${Date.now().toString(36)}${nonceCounter.toString(36)}`;
  }

  /**
   * Installs startRoll/finishRoll as globals, backed by the platform's real
   * "/roll" chat pipeline. Independent of sheetWorkerShim.js's install() —
   * takes cardApi directly rather than reusing its AttrBinding/RepeatingBinding
   * instances, since roll dispatch doesn't touch attr_/repeating_ DOM state.
   * @returns {{fireRoll, destroy}} — fireRoll is an internal hook rollButtons.js
   * uses for button[type="roll"] clicks (same pipeline, no worker-script
   * callback involved for those).
   */
  function install(cardApi) {
    const pending = new Map(); // nonce -> {resolve, reject}

    const onMessage = ({ command, data }) => {
      if (command !== "chat_push") return;
      const broadcast = parseRollBroadcast(data);
      const nonce = broadcast?.borderColor;
      if (!nonce || !pending.has(nonce)) return;
      // rollId is attached here (not read back off the broadcast, which has
      // no such field) so callers get the SAME nonce they'd need to pass to
      // finishRoll — the one piece of correlation state this dispatch layer
      // owns that the backend's RollDefinition doesn't carry.
      pending.get(nonce).resolve({ ...broadcast.roll, rollId: nonce });
      pending.delete(nonce);
    };
    cardApi.SubscribeWebSocket(onMessage);

    // Extracts @{name} refs from `formula` (reusing AttrBinding's
    // already-tested extractor rather than a third copy of that regex — see
    // this file's own header on why the translator itself IS duplicated;
    // the ref-parsing regex is small and stable enough not to warrant the
    // same treatment) and resolves each against the current property values.
    // AttrLogic is expected to already be attached by the time this runs —
    // attrBinding.js loads earlier in the render shell's script order (see
    // roll20compat-sheetrenderer's roll20Assembly.js) — but degrades to "no refs resolved"
    // rather than throwing if it's ever used standalone, since a formula
    // with no @{} refs works fine either way.
    async function resolveFormulaAttrs(formula) {
      const refs = global.Roll20Compat?.AttrLogic?.parseAutocalcRefs(formula) ?? [];
      const attrs = {};
      await Promise.all(
        refs.map(async (name) => {
          const prop = await cardApi.Properties.Get(name);
          attrs[name] = prop?.value ?? "0";
        })
      );
      return attrs;
    }

    // Translates `formula`, fires it through chat, and resolves with the
    // backend's RollDefinition ({result, rolled, dices, successCount,
    // failureCount} — see RollDefinition.cs) once the correlated broadcast
    // arrives. `attributes` is optional — omit it to auto-resolve every
    // @{name} ref in the formula against current property values (the
    // common sheet-worker case); pass it explicitly when the caller already
    // has fresher values in hand (e.g. rollButtons.js, mid-getAttrs).
    // No network-level timeout: a dropped broadcast (disconnect mid-roll)
    // leaves the promise pending rather than rejecting — same "degrade,
    // don't guess" choice as the rest of this runtime. Callers needing a
    // bound should race this against their own timeout.
    async function fireRoll(formula, attributes) {
      const resolvedAttrs = attributes ?? (await resolveFormulaAttrs(formula));
      // Same Roll20-vs-platform dice modifier translation as roll messages
      // (a plain 1d20cs>19 button would otherwise post a success count) —
      // applied after @{attr} substitution, so a range like cs>@{crit} counts.
      const E = global.Roll20Compat?.RollTemplateEngine;
      const substituted = translateFormula(formula, resolvedAttrs);
      const translated = E ? E.splitRollModifiers(substituted).formula : substituted;
      const nonce = generateNonce();
      const result = new Promise((resolve, reject) => {
        pending.set(nonce, { resolve, reject });
      });
      cardApi.SendChatMessage(buildRollCommand(translated, nonce));
      return result;
    }

    // ── Roll messages: templates, several inline rolls, startRoll/finishRoll ──
    //
    // "&{template:x} {{a=[[1d20]]}} {{b=[[2d6]]}}" — Roll20's roll message —
    // goes through the roll template engine (tools/rollTemplateEngine.mjs,
    // exposed by the render shell) and the platform's roll-now-post-later API:
    // every inline roll of the message is evaluated in ONE CardAPI.Rolls.Start
    // call, and CardAPI.Rolls.Finish posts one chat message whose numbers the
    // server fills in from its own results. Without the engine or that API (an
    // older platform), everything falls back to the single-formula /roll path.
    const MAX_PENDING_ROLLS = 50;
    const pendingRolls = new Map(); // server rollId -> prepared message, until finishRoll
    const engine = () => global.Roll20Compat?.RollTemplateEngine;
    const sheetInfo = () => global.Roll20Compat?.SheetInfo ?? {};
    const canRollMessages = () => !!(engine() && cardApi.Rolls);
    const translate = (key) => {
      const value = typeof global.getTranslationByKey === "function" ? global.getTranslationByKey(key) : null;
      return value || key;
    };

    // The backend's RollDefinition, reduced to what the template helpers and
    // a sheet script need.
    const toEngineRoll = (roll) => ({
      result: roll?.result ?? 0,
      dice: (roll?.dices ?? []).map((d) => ({ sides: d.diceValue, result: d.result, kept: d.kept !== false })),
    });

    async function prepareRollMessage(message) {
      const E = engine();
      const values = {};
      await Promise.all(
        E.attributeRefs(message).map(async (name) => {
          const prop = await cardApi.Properties.Get(name);
          values[name] = prop?.value;
        })
      );
      let text = E.resolveAttributeRefs(message, values);
      const ask = global.Roll20Compat?.RollQueries?.ask;
      if (ask) {
        text = await ask(text);
        if (text === null) return null; // the player cancelled a ?{...} question
      }

      const parsed = E.parseRollMessage(text);
      const extracted = E.extractInlineRolls(parsed);
      // Rolls.Finish needs a roll session even for a message with no inline
      // rolls (plain template text), so such a message rolls a constant 0.
      // Roll20 cs/cf critical ranges and >N target numbers mean something
      // else to the platform's dice engine — see splitRollModifiers.
      const critById = {};
      const formulas = extracted.rolls.length
        ? extracted.rolls.map((r) => {
            const split = E.splitRollModifiers(r.formula);
            critById[r.id] = split.crit;
            return { key: r.id, formula: translateFormula(split.formula, {}) };
          })
        : [{ key: "none", formula: "0" }];
      const started = await cardApi.Rolls.Start(formulas);

      const rolls = {};
      for (const { key, roll } of started.results ?? []) rolls[key] = { ...toEngineRoll(roll), crit: critById[key] ?? null };
      const prepared = { rollId: started.rollId, parsed, extracted, rolls, formulas };

      if (pendingRolls.size >= MAX_PENDING_ROLLS) pendingRolls.delete(pendingRolls.keys().next().value);
      pendingRolls.set(started.rollId, prepared);
      return prepared;
    }

    // Roll20's startRoll callback shape: results keyed by FIELD name (the
    // field's first inline roll), e.g. results.results.result.result.
    function scriptResults(prepared) {
      const results = {};
      for (const [fieldKey, id] of Object.entries(prepared.extracted.fieldRolls)) {
        const roll = prepared.rolls[id];
        const formula = prepared.extracted.rolls.find((r) => r.id === id)?.formula;
        if (!roll) continue;
        results[fieldKey] = {
          result: roll.result,
          dice: roll.dice.filter((d) => d.kept).map((d) => d.result),
          expression: formula,
        };
      }
      return { rollId: prepared.rollId, results };
    }

    async function postRollMessage(prepared, computed) {
      pendingRolls.delete(prepared.rollId);
      const E = engine();
      const info = sheetInfo();
      const { template } = prepared.parsed;
      let html;
      if (template) {
        const own = info.rollTemplates?.[template];
        html = E.renderRollTemplate(own ?? E.DEFAULT_TEMPLATE_HTML, {
          name: own ? template : "default",
          fields: prepared.extracted.fields,
          fieldRolls: prepared.extracted.fieldRolls,
          rolls: prepared.rolls,
          computed: computed ?? {},
          translate,
        });
      } else {
        html = E.renderPlainRollMessage(prepared.extracted.text, translate, prepared.rolls);
      }
      await cardApi.Rolls.Finish({
        rollId: prepared.rollId,
        html,
        cssResourceKey: info.rollTemplateCssKey || undefined,
      });
    }

    /** A roll button's whole value (template and/or several inline rolls): roll and post. */
    async function rollMessage(message) {
      const prepared = await prepareRollMessage(message);
      if (prepared) await postRollMessage(prepared, {});
    }

    // startRoll(message, cb) — evaluates every inline roll of the message on
    // the server WITHOUT posting, then hands the sheet script Roll20-shaped
    // results: { rollId, results: { <field>: { result, dice, expression } } }.
    function startRoll(message, cb) {
      if (!canRollMessages()) {
        fireRoll(message)
          .then((roll) => cb(roll))
          .catch((err) => console.error("startRoll: roll failed", err));
        return;
      }
      prepareRollMessage(message)
        .then((prepared) => {
          if (prepared) cb(scriptResults(prepared));
        })
        .catch((err) => console.error("startRoll: roll failed", err));
    }

    // finishRoll(rollId, computed) — posts the roll's template with the
    // script's computed values ({{computed::key}} in the template). The dice
    // numbers shown are the server's, whatever the script computed.
    function finishRoll(rollId, computed) {
      const prepared = pendingRolls.get(rollId);
      if (prepared) {
        postRollMessage(prepared, computed).catch((err) => console.error("finishRoll: posting the roll failed", err));
        return;
      }
      // A roll made through the fallback /roll path: it's already in chat,
      // so computed values can only follow as a plain line.
      if (!computed || typeof computed !== "object" || Object.keys(computed).length === 0) return;
      const summary = Object.entries(computed)
        .map(([key, value]) => `${key}: ${value}`)
        .join(", ");
      cardApi.SendChatMessage(`${summary}`);
    }

    global.startRoll = startRoll;
    global.finishRoll = finishRoll;

    return {
      fireRoll,
      rollMessage: (message) => (canRollMessages() ? rollMessage(message) : null),
      destroy: () => {
        cardApi.UnsubscribeWebSocket(onMessage);
        pending.clear();
        pendingRolls.clear();
      },
    };
  }

  Roll20Compat.RollDispatch = { install };
})(typeof window !== "undefined" ? window : globalThis);
