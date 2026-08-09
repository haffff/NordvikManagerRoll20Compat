import * as React from "react";

// Controlled-input helper for a single field's value, committed on blur.
// Deliberately NOT `defaultValue` (uncontrolled) — an already-mounted input
// needs to pick up server-side changes (another player editing the same row,
// a broadcast round-trip) instead of silently keeping whatever the user last
// typed and re-committing it stale on the next blur.
export const useFieldInput = (value, onCommit) => {
  const [local, setLocal] = React.useState(value ?? "");

  React.useEffect(() => {
    setLocal(value ?? "");
  }, [value]);

  const onChange = React.useCallback((e) => setLocal(e.target.value), []);

  const onBlur = React.useCallback(() => {
    if (local !== (value ?? "")) onCommit(local);
  }, [local, value, onCommit]);

  return { value: local, onChange, onBlur };
};

export default useFieldInput;
