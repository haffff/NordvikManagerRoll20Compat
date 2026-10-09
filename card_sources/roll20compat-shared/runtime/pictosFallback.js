// See attrBinding.js's header for the loading model (plain <script>,
// window.Roll20Compat namespace, no bundler).
//
// pictosFallback.js: Roll20 ships a "Pictos" icon font that draws icons for
// plain ASCII characters, and sheets use it everywhere (529 sheets in the
// corpus): <span class="pictos">y</span> is a gear, "3" a check mark. Pictos
// is commercial (pictos.cc), so it isn't bundled, and without it those
// elements showed the raw letters. This swaps known glyphs for Unicode
// symbols in any element set in Pictos, including rows added later.
//
// The meanings come from the sheets' own comments ("3 in Pictos is a check
// mark", "& in Pictos is a + sign, while + is a plus inside a circle",
// "x in Pictos is a crossed hammer and wrench", "y = Pictos font Gear icon")
// and from how sheets use them (i on info popups, p on edit-mode toggles,
// _ as the open state where & is the closed one). Anything else is left as
// authored rather than guessed. Not reached: glyphs drawn with CSS content
// (::before/::after) — those need a per-sheet patch (patches/<key>.css).
(function (global) {
  "use strict";
  const Roll20Compat = (global.Roll20Compat = global.Roll20Compat || {});

  // ── Pure logic (Node-testable — no DOM) ───────────────────────────────────
  const GLYPHS = {
    "3": "✓",
    "&": "+",
    "+": "⊕",
    x: "⚒",
    y: "⚙",
    i: "ℹ",
    p: "✎",
    _: "−",
  };
  const MAX_GLYPHS = 3;

  /** Whether a computed font-family asks for Pictos first (not pictos-three/-custom, other fonts). */
  function isPictosFont(fontFamily) {
    const first = String(fontFamily ?? "").split(",")[0].trim().replace(/^["']|["']$/g, "");
    return first.toLowerCase() === "pictos";
  }

  /** The Unicode symbols for a short run of known Pictos glyphs, or null to leave the text alone. */
  function mapText(text) {
    const glyphs = Array.from(String(text ?? "").trim());
    if (glyphs.length === 0 || glyphs.length > MAX_GLYPHS) return null;
    if (!glyphs.every((g) => Object.prototype.hasOwnProperty.call(GLYPHS, g))) return null;
    return glyphs.map((g) => GLYPHS[g]).join("");
  }

  Roll20Compat.PictosLogic = { isPictosFont, mapText };

  // ── DOM ───────────────────────────────────────────────────────────────────
  const DONE_ATTR = "data-r20c-pictos";
  // Fonts that carry these symbols on Windows, Linux and macOS.
  const SYMBOL_FONTS = '"Segoe UI Symbol", "Noto Sans Symbols 2", "Apple Symbols", system-ui, sans-serif';

  function replaceGlyphs(el) {
    if (el.hasAttribute(DONE_ATTR) || el.children.length > 0) return;
    // A bound field's text is the sheet's data, rewritten on every change.
    if ((el.getAttribute("name") || "").startsWith("attr_")) return;
    const mapped = mapText(el.textContent);
    if (mapped === null) return;
    if (!isPictosFont(global.getComputedStyle(el).fontFamily)) return;
    el.setAttribute(DONE_ATTR, el.textContent);
    el.textContent = mapped;
    el.style.fontFamily = SYMBOL_FONTS;
  }

  function scan(node) {
    if (node.nodeType === 3) node = node.parentElement;
    if (!node || node.nodeType !== 1) return;
    replaceGlyphs(node);
    for (const el of node.querySelectorAll("*")) replaceGlyphs(el);
  }

  /** Replaces Pictos glyphs under root now and in anything added later (repeating rows). */
  function install(root) {
    scan(root);
    if (typeof global.MutationObserver !== "function") return () => {};
    const observer = new global.MutationObserver((mutations) => {
      for (const m of mutations) for (const node of m.addedNodes) scan(node);
    });
    observer.observe(root, { childList: true, subtree: true });
    return () => observer.disconnect();
  }

  Roll20Compat.PictosFallback = { install };
})(typeof window !== "undefined" ? window : globalThis);
