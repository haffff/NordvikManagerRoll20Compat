// Pure helpers for Roll20's `?{...}` roll-query syntax — a self-directed,
// client-side, no-round-trip prompt (distinct from NordvikManager's own
// RequestUserInputStepDefinition, which is a server-driven, GM-approval-gated
// prompt to a *specific other player*; wrong shape for this).
//
// Syntax: `?{Prompt}` (free text, no default) | `?{Prompt|Default}` (free
// text/number with a default) | `?{Prompt|Option1|Option2|...}` (dropdown —
// 2+ segments after the prompt). Each dropdown option may itself be
// `Label,Value` to give the option a value distinct from its display label.
// Roll20 queries don't nest further `?{}` inside themselves in practice, so
// this doesn't attempt to handle that.

const QUERY_RE = /\?\{([^{}]+)\}/g;

/** True if `formula` contains at least one `?{...}` token. */
export function hasQueries(formula) {
  QUERY_RE.lastIndex = 0;
  return typeof formula === "string" && QUERY_RE.test(formula);
}

/**
 * Extracts every unique query in `formula`, in first-appearance order.
 * Returns [{ raw, prompt, kind: "input"|"select", default?, options? }]
 * where `raw` is the exact `?{...}` substring (used as a stable key when
 * substituting answers back in — see resolveQueries).
 */
export function parseQueries(formula) {
  const seen = new Set();
  const queries = [];
  QUERY_RE.lastIndex = 0;
  let match;
  while ((match = QUERY_RE.exec(formula)) !== null) {
    const raw = match[0];
    if (seen.has(raw)) continue;
    seen.add(raw);

    const segments = match[1].split("|").map((s) => s.trim());
    const [prompt, ...rest] = segments;

    if (rest.length >= 2) {
      queries.push({
        raw,
        prompt,
        kind: "select",
        options: rest.map((opt) => {
          const [label, value] = opt.split(",").map((s) => s.trim());
          return { label, value: value ?? label };
        }),
      });
    } else {
      queries.push({ raw, prompt, kind: "input", default: rest[0] ?? "" });
    }
  }
  return queries;
}

/**
 * Substitutes every `?{...}` occurrence in `formula` with the caller's
 * answers (a `{ [raw]: value }` map keyed by each query's exact `raw` text,
 * as produced by parseQueries).
 */
export function resolveQueries(formula, answers) {
  QUERY_RE.lastIndex = 0;
  return formula.replace(QUERY_RE, (raw) => (raw in answers ? String(answers[raw]) : raw));
}
