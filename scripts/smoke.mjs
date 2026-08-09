#!/usr/bin/env node
// Plain-Node smoke tests for the pure logic modules in roll20compat-shared
// (translateFormula, rollQuery, rollTemplateParser) — no test framework, no
// build step, so this can run against source directly (`pnpm run smoke`).
// Grounded in real formulas/templates pulled from the actual Roll20 sheets
// this addon ports (Blades in the Dark, Fate Core, Dungeon World).
//
// Does NOT cover the three .jsx components or the two hooks — no test
// runner exists in this repo yet, and standing one up wasn't in scope for
// the shared-library deliverable. That's the gap to close before shipping
// a real card built on top of this library.
import { translateFormula, Roll20FormulaError } from "../card_sources/roll20compat-shared/dice/roll20FormulaTranslator.js";
import { hasQueries, parseQueries, resolveQueries } from "../card_sources/roll20compat-shared/components/rollQuery.js";
import { renderRollTemplateHtml } from "../card_sources/roll20compat-shared/components/rollTemplateParser.js";

let failures = 0;
const check = (label, actual, expected) => {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    failures++;
    console.error(`FAIL ${label}\n  got:      ${a}\n  expected: ${e}`);
  } else {
    console.log(`ok   ${label}`);
  }
};

const expectThrows = (label, fn, ErrorType) => {
  try {
    const result = fn();
    failures++;
    console.error(`FAIL ${label}\n  expected throw, got: ${JSON.stringify(result)}`);
  } catch (e) {
    check(label, e instanceof ErrorType, true);
  }
};

// ── roll20FormulaTranslator ────────────────────────────────────────────────

// Fate Core's real formula: /me rolls [[4dF+8+@{RollModifiers}]] @{Leg1}
check(
  "Fate Core formula translates cleanly",
  translateFormula("[[4dF+8+@{RollModifiers}]]", { RollModifiers: "2" }),
  "4dF+8+2"
);

check("plain NdM+arith with comment stripped", translateFormula("1d20+5 [Attack Roll]", {}), "1d20+5");
check("kh/cs modifiers pass through untouched", translateFormula("4d6kh3", {}), "4d6kh3");

expectThrows(
  "missing attribute throws Roll20FormulaError",
  () => translateFormula("1d20+@{missingAttr}", {}),
  Roll20FormulaError
);

// Blades' real grouped-pool formula must be rejected, not silently mangled
expectThrows(
  "Blades pool formula rejected as unsupported",
  () =>
    translateFormula(
      "[[{[[[[{@{hunt}+2+d0}<0]]*2]]d6skl1cf<3, [[(@{hunt}+2)d1>1]]d6skh1cf<3}kh1]]",
      { hunt: "2" }
    ),
  Roll20FormulaError
);

expectThrows("unresolved ?{} query throws", () => translateFormula("?{Extra|0}d6", {}), Roll20FormulaError);

// Regression: comment-stripping used to run before the "[[" rejection check,
// so a nested inline roll like "1d20+[[2d6]]" would have its inner "[2d6]"
// silently eaten as if it were a Roll20 comment, mangling the formula to
// "1d20+[]" instead of being rejected as unsupported.
expectThrows(
  "nested inline roll rejected, not silently mangled",
  () => translateFormula("1d20+[[2d6]]", {}),
  Roll20FormulaError
);

// ── rollQuery ───────────────────────────────────────────────────────────────

check("hasQueries true", hasQueries("?{Extra|0}d6"), true);
check("hasQueries false", hasQueries("4d6kh3"), false);

const blades = parseQueries("&{template:bitd} {{position=?{Position|Risky|Controlled|Desperate}}} {{extra=?{Extra|0}}}");
check("Blades: two distinct queries found", blades.length, 2);
check("Blades: dropdown query shape", blades[0], {
  raw: "?{Position|Risky|Controlled|Desperate}",
  prompt: "Position",
  kind: "select",
  options: [
    { label: "Risky", value: "Risky" },
    { label: "Controlled", value: "Controlled" },
    { label: "Desperate", value: "Desperate" },
  ],
});
check("Blades: default-value query shape", blades[1], {
  raw: "?{Extra|0}",
  prompt: "Extra",
  kind: "input",
  default: "0",
});

check(
  "resolveQueries substitutes both",
  resolveQueries("pos=?{Position|Risky|Controlled} extra=?{Extra|0}", {
    "?{Position|Risky|Controlled}": "Controlled",
    "?{Extra|0}": "2",
  }),
  "pos=Controlled extra=2"
);

// ── rollTemplateParser (Dungeon World-shaped move template, simplified) ─────

const tpl = `<div class="rt-header">{{movename}}</div>
{{#trigger}}<div class="rt-row">Trigger: {{trigger}}</div>{{/trigger}}
{{#details}}<div class="rt-row">Details: {{details}}</div>{{/details}}`;

check(
  "truthy block renders, falsy block omitted",
  renderRollTemplateHtml(tpl, { movename: "Hack & Slash", trigger: "You attack" }),
  `<div class="rt-header">Hack &amp; Slash</div>\n<div class="rt-row">Trigger: You attack</div>\n`
);

check(
  "field values are HTML-escaped",
  renderRollTemplateHtml("{{name}}", { name: "<script>alert(1)</script>" }),
  "&lt;script&gt;alert(1)&lt;/script&gt;"
);

console.log(failures === 0 ? "\nAll smoke checks passed." : `\n${failures} smoke check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
