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

  const submit = () => onResolve(resolveQueries(formula, answers));

  // Not a <form>: cards run in an iframe with sandbox="allow-scripts" only
  // (CardPanel.js), and without allow-forms Chrome blocks a submission
  // before the submit event fires — onSubmit would never run. Enter is
  // handled by hand instead, except on a focused button (Cancel must cancel).
  const onKeyDown = (e) => {
    if (e.key === "Enter" && e.target.tagName !== "BUTTON") {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div className="r20c-query-modal-overlay" role="dialog" aria-modal="true">
      <div className="r20c-query-modal" onKeyDown={onKeyDown}>
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
          <button type="button" onClick={submit}>
            Roll
          </button>
        </div>
      </div>
    </div>
  );
};

export default RollQueryModal;
