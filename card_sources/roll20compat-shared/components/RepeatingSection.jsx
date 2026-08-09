import * as React from "react";
import { usePropertyListV2 } from "../hooks/usePropertyListV2.js";
import { useFieldInput } from "../hooks/useFieldInput.js";

// A single field's input within the default row renderer. Not exported —
// renderRow-based custom rows are expected to use useFieldInput directly.
const DefaultFieldInput = ({ field, value, onCommit }) => {
  const input = useFieldInput(value, onCommit);
  if (field.type === "textarea") {
    return <textarea className="r20c-field-input" rows={2} {...input} />;
  }
  if (field.type === "checkbox") {
    // Stored as the string "1"/"" — properties are always strings, and this
    // keeps the on-wire representation consistent with Roll20's own
    // attr_ convention for checkbox fields. Deliberately commits on every
    // click rather than going through useFieldInput's blur-commit — a
    // checkbox has no "blur while mid-edit" state to protect against, so
    // there's no reason to defer it the way a text field's keystrokes are.
    return (
      <input
        type="checkbox"
        className="r20c-field-checkbox"
        checked={value === "1"}
        onChange={(e) => onCommit(e.target.checked ? "1" : "")}
      />
    );
  }
  return <input type={field.type === "number" ? "number" : "text"} className="r20c-field-input" {...input} />;
};

const DefaultRow = ({ item, fields, index, count, onFieldCommit, onRemove, onMoveUp, onMoveDown, reorderable }) => (
  <div className="r20c-repeating-row" data-row-id={item.id}>
    {reorderable && (
      <div className="r20c-repeating-row-handle">
        <button type="button" disabled={index === 0} onClick={onMoveUp} aria-label="Move up">
          ▲
        </button>
        <button type="button" disabled={index === count - 1} onClick={onMoveDown} aria-label="Move down">
          ▼
        </button>
      </div>
    )}
    {fields.map((field) => (
      <label key={field.key} className="r20c-field">
        <span className="r20c-field-label">{field.label}</span>
        <DefaultFieldInput
          field={field}
          value={item.fields?.[field.key]}
          onCommit={(v) => onFieldCommit(field.key, v)}
        />
      </label>
    ))}
    <button type="button" className="r20c-repeating-row-remove" onClick={onRemove} aria-label="Remove row">
      ✕
    </button>
  </div>
);

/**
 * Generic repeating-row UI backed by usePropertyListV2 — the direct
 * replacement for Roll20's `repeating_<section>_<rowid>_<field>` pattern.
 *
 * Two ways to render a row:
 *  - `fields` (array of {key, label, type}) for the built-in label+input
 *    layout (type: "text" | "number" | "textarea" | "checkbox", default "text").
 *  - `renderRow(item, helpers)` for full custom markup — `helpers` exposes
 *    `setField(key, value)`, `remove()`, `moveUp()`, `moveDown()`, `index`,
 *    `count`, so a ported sheet can lay out a row however its original
 *    template did while still going through the same list operations.
 *
 * @param {object} props
 * @param {object} props.Api - CardAPI instance
 * @param {string} props.propertyName - the list property's name, e.g. "repeating_ability"
 * @param {Array<{key:string,label:string,type?:string}>} [props.fields]
 * @param {(item:object, helpers:object) => React.ReactNode} [props.renderRow]
 * @param {string} [props.addButtonLabel]
 * @param {string} [props.emptyLabel]
 * @param {boolean} [props.reorderable]
 * @param {object} [props.defaultFields] - fields a newly-added row starts with
 */
export const RepeatingSection = ({
  Api,
  propertyName,
  fields,
  renderRow,
  addButtonLabel = "Add row",
  emptyLabel = "No rows yet.",
  reorderable = true,
  defaultFields = {},
}) => {
  const { items, loaded, addItem, removeItem, updateItem, reorder } = usePropertyListV2(Api, propertyName);

  const move = (itemId, direction) => {
    const ids = items.map((i) => i.id);
    const idx = ids.indexOf(itemId);
    const swapIdx = idx + direction;
    if (swapIdx < 0 || swapIdx >= ids.length) return;
    [ids[idx], ids[swapIdx]] = [ids[swapIdx], ids[idx]];
    reorder(ids);
  };

  if (!loaded) return null;

  return (
    <div className="r20c-repeating-section" data-property={propertyName}>
      {items.length === 0 && <div className="r20c-repeating-empty">{emptyLabel}</div>}

      {items.map((item, index) =>
        renderRow ? (
          <React.Fragment key={item.id}>
            {renderRow(item, {
              index,
              count: items.length,
              setField: (key, value) => updateItem(item.id, { [key]: value }),
              remove: () => removeItem(item.id),
              moveUp: () => move(item.id, -1),
              moveDown: () => move(item.id, 1),
            })}
          </React.Fragment>
        ) : (
          <DefaultRow
            key={item.id}
            item={item}
            fields={fields ?? []}
            index={index}
            count={items.length}
            reorderable={reorderable}
            onFieldCommit={(key, value) => updateItem(item.id, { [key]: value })}
            onRemove={() => removeItem(item.id)}
            onMoveUp={() => move(item.id, -1)}
            onMoveDown={() => move(item.id, 1)}
          />
        )
      )}

      <button type="button" className="r20c-repeating-add" onClick={() => addItem(defaultFields)}>
        {addButtonLabel}
      </button>
    </div>
  );
};

export default RepeatingSection;
