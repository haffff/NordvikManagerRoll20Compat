import * as React from "react";
import { parseQueries, resolveQueries } from "./rollQuery.js";

/**
 * Client-side `?{Prompt|default}` / `?{Prompt|opt1|opt2}` prompt. Renders
 * nothing if `formula` has no queries — callers don't need to branch on
 * hasQueries() themselves before mounting this.
 *
 * @param {object} props
 * @param {string} props.formula - the raw, not-yet-resolved dice/roll formula
 * @param {(resolvedFormula: string) => void} props.onResolve
 * @param {() => void} props.onCancel
 */
const defaultAnswers = (queries) =>
  Object.fromEntries(
    queries.map((q) => [q.raw, q.kind === "select" ? q.options[0]?.value ?? "" : q.default ?? ""])
  );

export const RollQueryModal = ({ formula, onResolve, onCancel }) => {
  const queries = React.useMemo(() => parseQueries(formula), [formula]);
  const [answers, setAnswers] = React.useState(() => defaultAnswers(queries));

  // Reset answers whenever `formula` (and so `queries`) changes — not just
  // on mount. A caller that keeps one RollQueryModal instance around and
  // swaps `formula` between rolls (rather than remounting it) would
  // otherwise keep stale answer keys from the previous formula, leaving the
  // new one's ?{...} tokens unresolved and answers[q.raw] undefined
  // (uncontrolled inputs). The redundant reset on the very first run (same
  // values the useState initializer above already set) is harmless.
  React.useEffect(() => {
    setAnswers(defaultAnswers(queries));
  }, [queries]);

  if (queries.length === 0) return null;

  const submit = (e) => {
    e.preventDefault();
    onResolve(resolveQueries(formula, answers));
  };

  return (
    <div className="r20c-query-modal-overlay" role="dialog" aria-modal="true">
      <form className="r20c-query-modal" onSubmit={submit}>
        {queries.map((q) => (
          <label key={q.raw} className="r20c-query-field">
            <span className="r20c-query-label">{q.prompt}</span>
            {q.kind === "select" ? (
              <select
                value={answers[q.raw]}
                onChange={(e) => setAnswers((prev) => ({ ...prev, [q.raw]: e.target.value }))}
              >
                {q.options.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            ) : (
              <input
                type="text"
                value={answers[q.raw]}
                onChange={(e) => setAnswers((prev) => ({ ...prev, [q.raw]: e.target.value }))}
                autoFocus={queries[0].raw === q.raw}
              />
            )}
          </label>
        ))}
        <div className="r20c-query-actions">
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit">Roll</button>
        </div>
      </form>
    </div>
  );
};

export default RollQueryModal;
