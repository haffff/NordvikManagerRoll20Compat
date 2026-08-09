import * as React from "react";
import { renderRollTemplateHtml } from "./rollTemplateParser.js";

/**
 * Renders a Roll20-style roll result. Two modes:
 *
 *  - No `templateHtml`: Blades-style "CSS-table-only" default rendering — one
 *    row per field, with `sheet-{key}` / `key-{key}` classes on
 *    `.sheet-rolltemplate-{templateName}` for the ported sheet's own CSS to
 *    hook into. This is a best-effort generic table, not a byte-for-byte
 *    reproduction of Roll20's internal default template DOM — expect to
 *    adjust the sheet's CSS selectors to match when porting (Blades' own
 *    `.sheet-rolltemplate-bitd table/th/td/.sheet-result` selectors, for
 *    instance, assume Roll20's exact internal markup, not this one).
 *
 *  - With `templateHtml` (a sheet's own extracted `<rolltemplate>...
 *    </rolltemplate>` inner HTML, ported as a JS template string constant):
 *    substitutes `{{key}}` / `{{#key}}...{{/key}}` against `fields` — see
 *    rollTemplateParser.js for exactly what's supported.
 *
 * @param {object} props
 * @param {string} props.templateName - used as the `sheet-rolltemplate-{name}` class
 * @param {Record<string,string>} props.fields
 * @param {string} [props.templateHtml]
 */
export const RollTemplate = ({ templateName, fields, templateHtml }) => {
  // Hooks must run unconditionally regardless of which mode this render is
  // in, so the memo is computed here (a no-op when templateHtml is absent)
  // rather than inside the branch below.
  const html = React.useMemo(
    () => (templateHtml ? renderRollTemplateHtml(templateHtml, fields) : null),
    [templateHtml, fields]
  );

  if (templateHtml) {
    return (
      <div
        className={`sheet-rolltemplate-${templateName}`}
        // eslint-disable-next-line react/no-danger -- templateHtml is trusted,
        // porter-bundled markup; only the substituted field values (escaped
        // in rollTemplateParser.js) come from live data.
        dangerouslySetInnerHTML={{ __html: html }}
      />
    );
  }

  const entries = Object.entries(fields ?? {}).filter(([, v]) => v !== undefined && v !== null && v !== "");

  return (
    <div className={`sheet-rolltemplate-${templateName}`}>
      <table>
        <tbody>
          {entries.map(([key, value]) => (
            <tr key={key} className={`sheet-${key}`}>
              <td className={`key-${key}`}>{value}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

export default RollTemplate;
