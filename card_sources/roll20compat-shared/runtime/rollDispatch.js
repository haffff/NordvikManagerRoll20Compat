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

    if (f.includes("[[")) {
      throw new Roll20FormulaError(
        `translateFormula: "${formula}" contains a nested inline roll ("[[...]]") this translator doesn't support.`
      );
    }

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
      const translated = translateFormula(formula, resolvedAttrs);
      const nonce = generateNonce();
      const result = new Promise((resolve, reject) => {
        pending.set(nonce, { resolve, reject });
      });
      cardApi.SendChatMessage(buildRollCommand(translated, nonce));
      return result;
    }

    // startRoll(formula, cb) — Roll20's real cb receives a Roll20-internal
    // "results" structure this platform doesn't produce (see the plan's
    // "known approximation" section). Approximated here as the backend's own
    // RollDefinition shape directly, plus rollId for finishRoll to echo back —
    // close enough for a worker script that reads .result / .rolled / .dices,
    // not a byte-for-byte match of Roll20's internal roll1/roll2 keying.
    function startRoll(formula, cb) {
      fireRoll(formula)
        .then((roll) => cb(roll))
        .catch((err) => console.error("startRoll: roll failed", err));
    }

    // finishRoll(rollId, output) — real Roll20 uses `output` to customize the
    // roll-template shown in chat (e.g. "3 successes" derived from the raw
    // dice, replacing the raw total). This platform's chat rendering has no
    // per-call template override hook, so the raw roll from fireRoll() is
    // already displayed and can't be replaced after the fact. Rather than
    // silently discarding a worker script's computed output (wrong number
    // shown, no indication anything was lost), a non-empty `output` posts a
    // second, clearly-labeled chat line — visibly incomplete beats silently
    // wrong. Revisit if deliverable C validation finds a sheet that leans on
    // this pattern heavily enough to warrant an actual template-override hook.
    function finishRoll(_rollId, output) {
      if (!output || typeof output !== "object" || Object.keys(output).length === 0) return;
      const summary = Object.entries(output)
        .map(([key, value]) => `${key}: ${value}`)
        .join(", ");
      cardApi.SendChatMessage(`${summary}`);
    }

    global.startRoll = startRoll;
    global.finishRoll = finishRoll;

    return {
      fireRoll,
      destroy: () => {
        cardApi.UnsubscribeWebSocket(onMessage);
        pending.clear();
      },
    };
  }

  Roll20Compat.RollDispatch = { install };
})(typeof window !== "undefined" ? window : globalThis);
