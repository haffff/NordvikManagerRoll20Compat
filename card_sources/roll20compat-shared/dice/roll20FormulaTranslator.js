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
// tokens (see components/rollQuery.js) before calling this —
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
const INNERMOST_INLINE_ROLL_RE = /\[\[([^[\]]*(?:\[[^[\]]*\][^[\]]*)*)\]\]/;

export function flattenNestedInlineRolls(f) {
  let prev;
  do {
    prev = f;
    f = f.replace(INNERMOST_INLINE_ROLL_RE, (_, inner) => "(" + inner.trim() + ")");
  } while (f !== prev);
  return f;
}

export function translateFormula(formula, attributes = {}) {
  if (typeof formula !== "string" || !formula.trim()) {
    throw new Roll20FormulaError("translateFormula: empty formula.");
  }

  let f = formula.trim();

  if (f.includes("?{")) {
    throw new Roll20FormulaError(
      `translateFormula: unresolved roll query in "${formula}" — resolve ?{...} tokens (rollQuery.js) before translating.`
    );
  }

  const wrapped = f.match(OUTER_WRAP_RE);
  if (wrapped) f = wrapped[1].trim();

  // A nested inline roll (Cyberpunk 2020: [[1d10!! + [[@{Ref}]] ]]) is
  // rolled first in Roll20 and its total added in — the same total as
  // rolling it as a parenthesised part of the outer formula. Flattened
  // BEFORE comment-stripping: COMMENT_RE is single-bracket and would read
  // the inner "[2d6]" of "1d20+[[2d6]]" as a comment.
  f = flattenNestedInlineRolls(f);

  // Roll20 comment annotations, e.g. "1d20 [Attack Roll]" -> "1d20". Safe now
  // that nested rolls are flattened.
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
