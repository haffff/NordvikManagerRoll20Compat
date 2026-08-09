// Translates the *common* Roll20 dice-formula subset into the backend dice
// engine's syntax (DndOnePlaceManager.Application/Services/Dice) — which
// already speaks the same NdM / kh,kl,dh,dl / ! / cs>,cf< / dF modifiers
// Roll20 uses, so most formulas need no real "translation", just cleanup:
// stripping Roll20's `[[...]]` inline-roll wrapper and `[comment]`
// annotations, and resolving `@{attrName}` references against the character's
// own property values.
//
// Deliberately does NOT attempt Roll20's hairiest nested-bracket pool
// formulas — grouped rolls (`{Xd6, Yd6}kh1`) or further-nested `[[...]]`
// inside the expression. Blades in the Dark's real formulas are exactly this
// case; the intended pattern (per the compatibility plan) is for the ported
// card's own JS to compute the effective pool size first, then call this
// translator on a plain resulting formula like "4d6kh1cf<3" — see the
// {[[[[{@{hunt}+?{Extra|0}+d0}<0]]*2]]d6skl1cf<3, ...}kh1] class of formula
// in Blades' source for what this is deliberately not trying to parse.
//
// Callers are expected to have already resolved any `?{...}` roll-query
// tokens (see rollQuery.js / RollQueryModal.jsx) before calling this —
// a leftover `?{` in the formula is treated as an unresolved-query error,
// not attempted here.

const OUTER_WRAP_RE = /^\[\[([\s\S]*)\]\]$/;
const COMMENT_RE = /\[[^[\]]*\]/g;
const ATTR_RE = /@\{([^{}]+)\}/g;

class Roll20FormulaError extends Error {
  constructor(message) {
    super(message);
    this.name = "Roll20FormulaError";
  }
}

/**
 * @param {string} formula - Roll20-syntax formula, with any ?{} queries already resolved
 * @param {Record<string,string|number>} attributes - attrName (or "attrName|suffix") -> value
 * @returns {string} a formula the backend DiceEngine can evaluate directly
 * @throws {Roll20FormulaError} on unresolved queries, missing attributes, or unsupported constructs
 */
export function translateFormula(formula, attributes = {}) {
  if (typeof formula !== "string" || !formula.trim()) {
    throw new Roll20FormulaError("translateFormula: empty formula.");
  }

  let f = formula.trim();

  if (f.includes("?{")) {
    throw new Roll20FormulaError(
      `translateFormula: unresolved roll query in "${formula}" — resolve ?{...} tokens (RollQueryModal) before translating.`
    );
  }

  const wrapped = f.match(OUTER_WRAP_RE);
  if (wrapped) f = wrapped[1].trim();

  // Reject remaining nested inline-rolls BEFORE comment-stripping — COMMENT_RE
  // is a single-bracket pattern ([^[\]]*) that can't tell a genuine
  // "[Attack Roll]" comment from the inner "[2d6]" of an unsupported
  // "1d20+[[2d6]]" nested roll (that "[[" fails to match as one token, but
  // the regex just re-tries and matches the inner "[2d6]" as if it were a
  // comment, silently mangling the formula to "1d20+[]" instead of rejecting
  // it). Checking here, on the untouched string, avoids that trap entirely.
  if (f.includes("[[")) {
    throw new Roll20FormulaError(
      `translateFormula: "${formula}" contains a nested inline roll ("[[...]]") this translator doesn't support. ` +
        `Compute the effective formula in JS first and pass a plain supported dice string instead.`
    );
  }

  // Roll20 comment annotations, e.g. "1d20 [Attack Roll]" -> "1d20". Safe now
  // that we know no "[[" is present.
  f = f.replace(COMMENT_RE, "").trim();

  // Attribute substitution happens BEFORE the curly-brace check below —
  // @{attrName} legitimately contains a "{", so checking for bare "{" first
  // would misflag every ordinary attribute reference.
  f = f.replace(ATTR_RE, (match, attrName) => {
    if (!(attrName in attributes)) {
      throw new Roll20FormulaError(`translateFormula: missing attribute "@{${attrName}}" in "${formula}".`);
    }
    return String(attributes[attrName]);
  });

  if (f.includes("{") || f.includes(",")) {
    throw new Roll20FormulaError(
      `translateFormula: "${formula}" uses a Roll20 construct this translator doesn't support ` +
        `(grouped/pool syntax, or comma-separated rolls). ` +
        `Compute the effective formula in JS first and pass a plain supported dice string instead.`
    );
  }

  return f.trim();
}

export { Roll20FormulaError };
export default translateFormula;
