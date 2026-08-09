// Pure parser/renderer for Roll20's <rolltemplate> markup pattern — the
// subset actually used by sheets that define custom template HTML rather
// than relying on Roll20's built-in default table rendering.
//
// Supported: `{{key}}` value substitution and `{{#key}}...{{/key}}` truthy
// conditional blocks (shown only when fields[key] is a non-empty string).
// Deliberately NOT supported: Roll20's comparison-function conditionals
// (`{{#rollGreater() a 5}}...{{/rollGreater() a 5}}`, `rollLess()`,
// `rollBetween()`) — neither of this addon's two porting candidates
// (Blades in the Dark, Fate Core) use them, and `{{#IDENTIFIER}}` only
// matches a bare word, so a function-call block simply falls through as
// literal `{{...}}` text in the output — a visible, easy-to-spot failure
// during porting rather than a silent misrender.
//
// templateHtml is expected to be trusted, author-bundled markup (extracted
// from the original Roll20 sheet at port time), not runtime user input —
// only the substituted field VALUES come from live data, and those are
// HTML-escaped before insertion.

const TOKEN_RE = /\{\{#(\w+)\}\}|\{\{\/(\w+)\}\}|\{\{(\w+)\}\}/g;

const escapeHtml = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[c]));

/**
 * Tokenizes templateHtml into a tree of
 *   { type: "text", value } | { type: "var", key } | { type: "block", key, children }
 */
export function parseRollTemplate(templateHtml) {
  const root = { type: "root", children: [] };
  const stack = [root];
  let lastIndex = 0;
  let match;

  TOKEN_RE.lastIndex = 0;
  while ((match = TOKEN_RE.exec(templateHtml)) !== null) {
    const [full, openKey, closeKey, varKey] = match;
    const literal = templateHtml.slice(lastIndex, match.index);
    if (literal) stack[stack.length - 1].children.push({ type: "text", value: literal });
    lastIndex = match.index + full.length;

    if (openKey) {
      const block = { type: "block", key: openKey, children: [] };
      stack[stack.length - 1].children.push(block);
      stack.push(block);
    } else if (closeKey) {
      // Pop until we find a matching open block, in case of a stray/mismatched
      // close tag — keeps a malformed template from wedging the whole parse.
      const idx = [...stack].reverse().findIndex((n) => n.type === "block" && n.key === closeKey);
      if (idx !== -1) stack.length = stack.length - idx - 1;
    } else if (varKey) {
      stack[stack.length - 1].children.push({ type: "var", key: varKey });
    }
  }
  const tail = templateHtml.slice(lastIndex);
  if (tail) stack[stack.length - 1].children.push({ type: "text", value: tail });

  return root;
}

/** Renders a parsed tree against `fields` into an HTML string. */
export function renderRollTemplate(node, fields) {
  switch (node.type) {
    case "root":
      return node.children.map((c) => renderRollTemplate(c, fields)).join("");
    case "text":
      return node.value;
    case "var":
      return escapeHtml(fields?.[node.key]);
    case "block": {
      const value = fields?.[node.key];
      if (value === undefined || value === null || value === "") return "";
      return node.children.map((c) => renderRollTemplate(c, fields)).join("");
    }
    default:
      return "";
  }
}

/** Convenience: parse + render in one call. */
export function renderRollTemplateHtml(templateHtml, fields) {
  return renderRollTemplate(parseRollTemplate(templateHtml), fields);
}
