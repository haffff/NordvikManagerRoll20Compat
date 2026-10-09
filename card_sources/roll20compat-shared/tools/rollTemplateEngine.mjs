// Roll20 roll messages and roll templates, as pure string functions (no DOM),
// so the same code runs in the sheet's card (via the render shell, which
// exposes it as window.Roll20Compat.RollTemplateEngine) and in Node tests.
//
// A roll message is what a roll button's value or a sheet script's
// startRoll() carries:
//
//   &{template:imtest} {{name=@{character_name}}} {{result=[[1d100]]}} ...
//
// Pipeline, in Roll20's own order:
//   1. resolveAttributeRefs  — @{attr} substituted (inside [[...]] a missing
//                              attribute is 0, elsewhere it's empty)
//   2. (roll queries ?{...}  — resolved by the caller's dialog)
//   3. parseRollMessage      — template name + ordered {{key=value}} fields
//   4. extractInlineRolls    — every [[formula]] replaced by a placeholder
//                              token and listed for ONE server-side batch
//   5. renderRollTemplate    — the sheet's <rolltemplate> HTML filled in
//
// Rendered HTML never contains roll numbers: each inline roll becomes an empty
// <span data-roll-key="rN"> that the chat renderer fills from the server-held
// results (see NordvikManagerFrontEnd's HtmlChatTemplate.js). Only the sheet
// script's finishRoll() computed values are client-provided — by design, the
// same as Roll20.

const ROLL_TOKEN_RE = /\u0000roll:([A-Za-z0-9_]+)\u0000/g;
const rollToken = (id) => `\u0000roll:${id}\u0000`;

export const escapeHtml = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// Roll message text may carry HTML character references — Blades in the
// Dark writes the commas inside its ?{} options as &#44; so the query
// doesn't split on them — and Roll20's chat shows them as the character.
// Those are kept; every other & is escaped, like escapeHtml.
const escapeText = (value) =>
  String(value ?? "")
    .replace(/&(?!#[0-9]+;|#x[0-9a-f]+;|[a-z][a-z0-9]*;)/gi, "&amp;")
    .replace(/[<>"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// ── 1. attribute references ───────────────────────────────────────────────

const ATTR_REF_RE = /@\{([^{}]+)\}/g;

/** Names of every @{attr} reference in `text`, deduplicated. */
export function attributeRefs(text) {
  return [...new Set([...String(text).matchAll(ATTR_REF_RE)].map((m) => m[1]))];
}

/**
 * Substitutes @{attr} references from `values` (name -> value). Inside an
 * inline roll a missing value becomes 0 so the formula still evaluates;
 * anywhere else it becomes an empty string (a missing character name must not
 * read "0"). Repeats a few times so an attribute whose value is itself a
 * formula with @{...} refs (common in Roll20 sheets) gets resolved too.
 */
export function resolveAttributeRefs(text, values, { maxDepth = 5 } = {}) {
  let out = String(text);
  for (let depth = 0; depth < maxDepth && ATTR_REF_RE.test(out); depth++) {
    ATTR_REF_RE.lastIndex = 0;
    let rollDepth = 0;
    let result = "";
    for (let i = 0; i < out.length; ) {
      if (out.startsWith("[[", i)) { rollDepth++; result += "[["; i += 2; continue; }
      if (out.startsWith("]]", i) && rollDepth > 0) { rollDepth--; result += "]]"; i += 2; continue; }
      if (out.startsWith("@{", i)) {
        const end = out.indexOf("}", i + 2);
        if (end > 0) {
          const name = out.slice(i + 2, end);
          const value = values[name];
          result += value == null || value === "" ? (rollDepth > 0 ? "0" : "") : String(value);
          i = end + 1;
          continue;
        }
      }
      result += out[i++];
    }
    out = result;
  }
  ATTR_REF_RE.lastIndex = 0;
  return out;
}

// ── 3. message parsing ────────────────────────────────────────────────────

const TEMPLATE_RE = /&\{template:([^}]+)\}/;

/**
 * Parses a roll message into its template name (null if none) and its
 * {{key=value}} fields, in order. Values may themselves contain braces
 * (^{translation}, [label](~ability), leftover {...}) — each field runs to
 * its matching "}}" by brace depth. A bare {{flag}} is a field whose value is
 * its own name, so {{#flag}} sections see it as set. Text outside fields is
 * returned as `text` (a message with no template is just text + inline rolls).
 */
export function parseRollMessage(message) {
  const source = String(message ?? "");
  const templateMatch = TEMPLATE_RE.exec(source);
  const template = templateMatch ? templateMatch[1].trim() : null;
  const body = templateMatch ? source.replace(templateMatch[0], "") : source;

  const fields = [];
  let text = "";
  let i = 0;
  while (i < body.length) {
    if (!body.startsWith("{{", i)) {
      text += body[i++];
      continue;
    }
    let depth = 0;
    let j = i + 2;
    for (; j < body.length; j++) {
      if (body[j] === "{") depth++;
      else if (body[j] === "}") {
        if (depth === 0 && body[j + 1] === "}") break;
        depth = Math.max(0, depth - 1);
      }
    }
    const inner = body.slice(i + 2, j);
    const eq = inner.indexOf("=");
    const key = (eq < 0 ? inner : inner.slice(0, eq)).trim();
    const value = eq < 0 ? key : inner.slice(eq + 1).trim();
    if (key) {
      const existing = fields.findIndex((f) => f.key === key);
      if (existing >= 0) fields[existing] = { key, value };
      else fields.push({ key, value });
    }
    i = j + 2;
  }
  return { template, fields, text: text.trim() };
}

// ── 4. inline rolls ───────────────────────────────────────────────────────

/**
 * Replaces every outermost [[formula]] in the field values (and in `text`)
 * with a placeholder token, and lists the formulas as rolls r0, r1, ... in
 * order. `fieldRolls` maps each field key to its FIRST inline roll id — what
 * Roll20's startRoll results and the roll-template helpers refer to.
 */
export function extractInlineRolls({ fields, text = "" }) {
  const rolls = [];
  const fieldRolls = {};
  const replace = (value, fieldKey) => {
    let out = "";
    let i = 0;
    while (i < value.length) {
      if (!value.startsWith("[[", i)) {
        out += value[i++];
        continue;
      }
      let depth = 1;
      let j = i + 2;
      for (; j < value.length && depth > 0; j++) {
        if (value.startsWith("[[", j)) { depth++; j++; }
        else if (value.startsWith("]]", j)) { depth--; if (depth === 0) break; j++; }
      }
      const formula = value.slice(i + 2, j).trim();
      const id = `r${rolls.length}`;
      rolls.push({ id, formula, fieldKey });
      if (fieldKey != null && !(fieldKey in fieldRolls)) fieldRolls[fieldKey] = id;
      out += rollToken(id);
      i = j + 2;
    }
    return out;
  };
  return {
    fields: fields.map((f) => ({ key: f.key, value: replace(f.value, f.key) })),
    text: replace(text, null),
    rolls,
    fieldRolls,
  };
}

// ── 4b. Roll20 dice modifiers the platform reads differently ─────────────
//
// Roll20's "cs"/"cf" only say which rolls count as a critical success or
// failure (Warhammer Fantasy Roleplay 4e: 1d100cs<5cf>96 — 01-05 and 96-100)
// and never change the total; the platform's dice engine reads cs/cf as
// success COUNTING, so the total became 0 or 1. Roll20's own success
// counting is a bare target number after the dice — 5d6>4 counts dice
// showing 4 or more — which the platform writes as cs>3. Roll20 comparisons
// are inclusive (Warhammer's own bands confirm it).
//
// splitRollModifiers rewrites a formula for the platform and returns the
// critical ranges separately, for rollWasCrit/rollWasFumble and the chip
// highlighting. Keep/drop shorthand (4d6k3, 4d6d1) becomes kh/dl. Anything
// else (rerolls, sorting, ...) is left as-is for the platform to accept or
// reject visibly.
const DICE_TERM_RE = /(\d*d(?:\d+|F))((?:k[hl]?\d+|d[hl]?\d+|!{1,2}p?(?:[<>]?\d+)?|ro?[<>]?\d+|c[sf](?:[<>=]?\d+)?|[<>]\d+|f[<>=]?\d+|s[ad]?|mt?\d*)*)/gi;
const MODIFIER_RE = /k[hl]?\d+|d[hl]?\d+|!{1,2}p?(?:[<>]?\d+)?|ro?[<>]?\d+|c[sf](?:[<>=]?\d+)?|[<>]\d+|f[<>=]?\d+|s[ad]?|mt?\d*/gi;

export function splitRollModifiers(formula) {
  const crit = { success: [], fail: [] };
  const out = String(formula).replace(DICE_TERM_RE, (_, dice, modifiers) => {
    const kept = (modifiers.match(MODIFIER_RE) ?? []).map((m) => {
      const critRange = /^c([sf])([<>=]?)(\d+)$/i.exec(m);
      if (critRange) {
        (critRange[1].toLowerCase() === "s" ? crit.success : crit.fail).push({ cmp: critRange[2] || "=", value: Number(critRange[3]) });
        return "";
      }
      const target = /^([<>])(\d+)$/.exec(m);
      if (target) return target[1] === ">" ? `cs>${Number(target[2]) - 1}` : `cs<${Number(target[2]) + 1}`;
      const keep = /^k(\d+)$/i.exec(m);
      if (keep) return `kh${keep[1]}`;
      const drop = /^d(\d+)$/i.exec(m);
      if (drop) return `dl${drop[1]}`;
      return m;
    });
    return dice + kept.join("");
  });
  return { formula: out, crit: crit.success.length || crit.fail.length ? crit : null };
}

const inRange = (value, ranges) =>
  ranges.some(({ cmp, value: n }) => (cmp === ">" ? value >= n : cmp === "<" ? value <= n : value === n));

// Crit/fumble for one roll: its own ranges if the formula gave any (Roll20:
// a cs range replaces the default), else a die's max / a 1. Kept dice only.
function critState(roll) {
  const dice = (roll?.dice ?? []).filter((d) => d.kept !== false && d.sides > 1);
  const success = roll?.crit?.success ?? [];
  const fail = roll?.crit?.fail ?? [];
  return {
    crit: dice.some((d) => (success.length ? inRange(d.result, success) : d.result === d.sides)),
    fumble: dice.some((d) => (fail.length ? inRange(d.result, fail) : d.result === 1)),
  };
}

// ── 5. rendering ──────────────────────────────────────────────────────────

// Roll20's own inline-roll markup — sheets' template CSS targets these
// classes. The crit/fumble class is decided here from the server results
// (this renders after Rolls.Start) and the roll's own critical ranges; only
// the number itself is left for the chat renderer to fill in, from the
// server's copy.
const rollPlaceholder = (id, rolls) => {
  const { crit, fumble } = critState(rolls?.[id]);
  const cls = crit && fumble ? " importantroll" : crit ? " fullcrit" : fumble ? " fullfail" : "";
  return `<span class="inlinerollresult showtip tipsy-n-right${cls}" data-roll-key="${id}"></span>`;
};

const LINK_RE = /\[([^\]]*)\]\((~[^)\s]*)\)/g;
const TRANSLATION_RE = /\^\{([^{}]+)\}/g;

/**
 * Renders a field value as HTML: text escaped, inline rolls as placeholders,
 * ^{key} translated, [label](~ability) as an inert link (clicking an ability
 * link isn't supported; Roll20 sheets style them via a[href^="~"]).
 */
function renderValue(value, translate, rolls) {
  let out = escapeText(String(value).replace(TRANSLATION_RE, (_, key) => translate?.(key) ?? key));
  out = out.replace(LINK_RE, (_, label, href) => `<a href="${href}">${label}</a>`);
  return out.replace(ROLL_TOKEN_RE, (_, id) => rollPlaceholder(id, rolls));
}

const renderComputed = (value) =>
  `<span class="inlinerollresult showtip tipsy-n-right">${escapeHtml(value)}</span>`;

// {{#x}} {{#^x}} {{^x}} {{/x}} {{x}} — x may be a plain key, computed::key,
// or a helper call like rollGreater() computed::result 95.
const TAG_RE = /\{\{\s*(#\^|#|\^|\/)?\s*([^{}]*?)\s*\}\}/g;
const normalizeExpr = (expr) => expr.replace(/\s+/g, " ").trim();

function parseTemplate(html) {
  const root = { children: [] };
  const stack = [root];
  let last = 0;
  TAG_RE.lastIndex = 0;
  for (const m of html.matchAll(TAG_RE)) {
    if (m.index > last) stack[stack.length - 1].children.push({ type: "text", value: html.slice(last, m.index) });
    last = m.index + m[0].length;
    const [, sigil, rawExpr] = m;
    const expr = normalizeExpr(rawExpr);
    if (sigil === "/") {
      // Close the nearest open section with the same expression; an
      // unmatched close is ignored rather than breaking the whole template.
      // An inverted section may be closed as {{/^expr}} (Roll20's own form
      // for helpers, e.g. {{/^rollWasCrit() attack}}) or {{/expr}}.
      const closing = expr.replace(/^\^\s*/, "");
      const at = stack.map((n) => n.expr).lastIndexOf(closing);
      if (at > 0) stack.length = at;
      continue;
    }
    if (sigil) {
      const section = { type: "section", expr, inverted: sigil !== "#", children: [] };
      stack[stack.length - 1].children.push(section);
      stack.push(section);
    } else {
      stack[stack.length - 1].children.push({ type: "var", expr });
    }
  }
  if (last < html.length) root.children.push({ type: "text", value: html.slice(last) });
  return root;
}

const templateCache = new Map(); // template html -> parsed tree
function parsedTemplate(html) {
  if (!templateCache.has(html)) {
    if (templateCache.size > 200) templateCache.clear();
    templateCache.set(html, parseTemplate(html));
  }
  return templateCache.get(html);
}

function evaluate(node, ctx, scope) {
  let out = "";
  for (const child of node.children) {
    if (child.type === "text") out += child.value;
    else if (child.type === "var") out += renderVar(child.expr, ctx, scope);
    else {
      const allprops = /^allprops\(\)\s*(.*)$/.exec(child.expr);
      if (allprops && !child.inverted) {
        const excluded = new Set(allprops[1].split(/\s+/).filter(Boolean));
        for (const field of ctx.fields) {
          if (excluded.has(field.key)) continue;
          out += evaluate(child, ctx, { key: field.key, value: field.value });
        }
        continue;
      }
      const truthy = testSection(child.expr, ctx);
      if (truthy !== child.inverted) out += evaluate(child, ctx, scope);
    }
  }
  return out;
}

function renderVar(expr, ctx, scope) {
  if (scope && expr === "key") return escapeHtml(scope.key);
  if (scope && expr === "value") return renderValue(scope.value, ctx.translate, ctx.rolls);
  if (expr.startsWith("computed::")) {
    const key = expr.slice("computed::".length);
    if (key in ctx.computed) return renderComputed(ctx.computed[key]);
    const field = ctx.fieldMap.get(key);
    return field ? renderValue(field, ctx.translate, ctx.rolls) : "";
  }
  const field = ctx.fieldMap.get(expr);
  return field == null ? "" : renderValue(field, ctx.translate, ctx.rolls);
}

// A helper operand is a field key (optionally computed::) or a number. Its
// numeric value is, in order: the computed value, the field's inline roll
// total, or the field's text read as a number.
function operandValue(token, ctx) {
  if (/^-?\d+(\.\d+)?$/.test(token)) return Number(token);
  const isComputed = token.startsWith("computed::");
  const key = isComputed ? token.slice("computed::".length) : token;
  if (isComputed && key in ctx.computed) return Number(ctx.computed[key]);
  const rollId = ctx.fieldRolls[key];
  if (rollId && ctx.rolls[rollId]) return Number(ctx.rolls[rollId].result);
  const field = ctx.fieldMap.get(key);
  if (field == null) return NaN;
  return Number(String(field).replace(ROLL_TOKEN_RE, ""));
}

function fieldCritState(token, ctx) {
  const key = token.replace(/^computed::/, "");
  return critState(ctx.rolls[ctx.fieldRolls[key]]);
}

function testSection(expr, ctx) {
  const helper = /^(rollWasCrit|rollWasFumble|rollTotal|rollGreater|rollLess|rollBetween)\(\)\s*(.*)$/.exec(expr);
  if (!helper) {
    if (expr.startsWith("computed::")) {
      const key = expr.slice("computed::".length);
      return key in ctx.computed && String(ctx.computed[key]) !== "";
    }
    const field = ctx.fieldMap.get(expr);
    return field != null && String(field) !== "";
  }
  const [, name, rest] = helper;
  const args = rest.split(/\s+/).filter(Boolean);
  switch (name) {
    case "rollWasCrit":
      return fieldCritState(args[0] ?? "", ctx).crit;
    case "rollWasFumble":
      return fieldCritState(args[0] ?? "", ctx).fumble;
    case "rollTotal":
      return operandValue(args[0], ctx) === operandValue(args[1], ctx);
    case "rollGreater":
      return operandValue(args[0], ctx) > operandValue(args[1], ctx);
    case "rollLess":
      return operandValue(args[0], ctx) < operandValue(args[1], ctx);
    case "rollBetween": {
      const v = operandValue(args[0], ctx);
      return v >= operandValue(args[1], ctx) && v <= operandValue(args[2], ctx);
    }
    default:
      return false;
  }
}

/**
 * Renders a roll template.
 * @param {string} templateHtml  the <rolltemplate>'s inner HTML
 * @param {object} opts
 * @param {string} opts.name     template name — output is wrapped in
 *                               <div class="sheet-rolltemplate-NAME">, like Roll20
 * @param {{key:string,value:string}[]} opts.fields  from extractInlineRolls
 * @param {Object<string,string>} opts.fieldRolls     field key -> roll id
 * @param {Object<string,{result:number,dice:{sides:number,result:number,kept?:boolean}[],crit?:object}>} opts.rolls
 *        server results by roll id, with each roll's critical ranges from
 *        splitRollModifiers (for the section helpers and crit highlighting)
 * @param {Object<string,*>} [opts.computed]  finishRoll's computed values
 * @param {(key:string)=>string} [opts.translate]  ^{key} lookup
 */
export function renderRollTemplate(templateHtml, { name, fields, fieldRolls = {}, rolls = {}, computed = {}, translate }) {
  const ctx = {
    fields,
    fieldMap: new Map(fields.map((f) => [f.key, f.value])),
    fieldRolls,
    rolls,
    computed: computed ?? {},
    translate,
  };
  const safeName = String(name).replace(/[^A-Za-z0-9_-]/g, "");
  const body = prefixClasses(fillTranslations(evaluate(parsedTemplate(templateHtml), ctx, null), translate));
  return `<div class="sheet-rolltemplate-${safeName}">${body}</div>`;
}

// Roll20 prefixes a roll template's classes with "sheet-" AFTER filling it
// in, so a class built from a field is prefixed too: Blades in the Dark's
// class="holder {{type}}" with type=action is styled as .sheet-action, and
// class="header{{#charimage}} narrow{{/charimage}}" as .sheet-header. The
// importer can only prefix the template's literal classes. Roll20's own chat
// classes (the inline roll chip's) and ones already prefixed are left alone.
const ROLL20_CHAT_CLASSES = new Set(["inlinerollresult", "showtip", "tipsy-n-right", "fullcrit", "fullfail", "importantroll"]);
const CLASS_ATTR_RE = /(\sclass=")([^"]*)"/g;
function prefixClasses(html) {
  return html.replace(CLASS_ATTR_RE, (_, open, list) => {
    const classes = list
      .split(/\s+/)
      .filter(Boolean)
      .map((c) => (c.startsWith("sheet-") || c.startsWith("userscript-") || ROLL20_CHAT_CLASSES.has(c) ? c : `sheet-${c}`));
    return `${open}${classes.join(" ")}"`;
  });
}

// Roll20 fills a roll template's data-i18n elements (and data-i18n-alt,
// -title, -placeholder, -aria-label attributes) from the sheet's
// translations, the same as on the sheet — Blades in the Dark's
// "Zero Dice — take the lowest result above" note and its title images'
// alt text. A key with no translation is left alone.
const I18N_TEXT_RE = /(<([a-z][a-z0-9]*)\b[^>]*?\sdata-i18n="([^"]+)"[^>]*>)(\s*)(<\/\2>)/gi;
const I18N_ATTR_RE = /\sdata-i18n-(alt|title|placeholder|aria-label)="([^"]+)"/gi;
function fillTranslations(html, translate) {
  if (!translate) return html;
  const lookup = (key) => {
    const value = translate(key);
    return value == null || value === key ? null : value;
  };
  return html
    .replace(I18N_TEXT_RE, (all, open, _tag, key, space, close) => {
      const value = lookup(key);
      return value == null ? all : open + escapeHtml(value) + close;
    })
    .replace(I18N_ATTR_RE, (all, attr, key) => {
      const value = lookup(key);
      return value == null ? all : `${all} ${attr}="${escapeHtml(value)}"`;
    });
}

// Roll20's chat gives every message `padding: 5px 5px 4px 45px` (the left
// 45px is the avatar's), and sheet templates are written to cancel exactly
// that: Blades in the Dark's .sheet-holder has margin: 0 -5px -4px -45px,
// the corpus's most common convention. The platform's chat has no such box,
// so without it those templates shift 45px left and are clipped. The padding
// is inline because the template CSS is stored per import — this way sheets
// imported earlier get it too.
/** A sheet's own roll template inside Roll20's chat message box. */
export function wrapInRoll20Message(html) {
  return `<div class="textchatcontainer"><div class="message rollresult" style="padding:5px 5px 4px 45px">${html}</div></div>`;
}

/** A roll message with no template: its text with inline rolls, like a Roll20 chat line. */
export function renderPlainRollMessage(text, translate, rolls = {}) {
  return `<div class="sheet-rolltemplate-plain">${renderValue(text, translate, rolls)}</div>`;
}

// Roll20's built-in "default" template (not part of any sheet): a caption
// from {{name}} and one row per other field.
export const DEFAULT_TEMPLATE_HTML =
  '<table><caption>{{name}}</caption>' +
  '{{#allprops() name}}<tr><td class="sheet-default-key">{{key}}</td><td>{{value}}</td></tr>{{/allprops() name}}</table>';

// Styles Roll20's chat itself provides and sheet templates rely on: inline
// roll chips with crit/fumble borders, and the default template. Appended to
// every sheet's extracted template CSS (see extractRollTemplateCss).
export const ROLL20_CHAT_BASE_CSS = `
body { font: 13px/1.4 "Helvetica Neue", Helvetica, Arial, sans-serif; }
.inlinerollresult { display: inline-block; min-width: 1.2em; padding: 0 3px; background: #fef68e; border: 2px solid #fef68e; border-radius: 3px; font-weight: bold; text-align: center; cursor: help; }
.inlinerollresult.fullcrit { border-color: #3fb315; }
.inlinerollresult.fullfail { border-color: #b31515; }
.inlinerollresult.importantroll { border-color: #4a57ed; }
a[href^="~"] { color: inherit; }
.sheet-rolltemplate-default table { width: 100%; border: 1px solid #ccc; border-collapse: collapse; background: #fff; }
.sheet-rolltemplate-default caption { background: #7e2d40; color: #fff; font-weight: bold; padding: 4px; text-align: left; }
.sheet-rolltemplate-default td { padding: 3px 5px; border-top: 1px solid #e5e5e5; vertical-align: top; }
.sheet-rolltemplate-default .sheet-default-key { font-weight: bold; white-space: nowrap; }
.sheet-rolltemplate-plain { padding: 4px 6px; }
`;
