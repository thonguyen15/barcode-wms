import { test } from "node:test";
import assert from "node:assert/strict";
import { WATCHER_PAGE_HTML } from "../src/watcher_page.mjs";

function makeEsc() {
  const document = {
    createElement() {
      const el = {};
      let text = "";
      Object.defineProperty(el, "textContent", {
        set(value) {
          text = String(value);
        },
      });
      Object.defineProperty(el, "innerHTML", {
        get() {
          return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
        },
      });
      return el;
    },
  };
  const source = WATCHER_PAGE_HTML.match(/function esc\(text\) \{[\s\S]*?\n\}/)[0];
  return new Function("document", `${source}; return esc;`)(document);
}

test('esc renders a quote-based attribute breakout inert', () => {
  const esc = makeEsc();
  const out = esc('" onmouseover="alert(1)');
  assert.equal(out, "&quot; onmouseover=&quot;alert(1)");
  assert.ok(!out.includes('"'));
  const titleAttr = `<div class="v" title="${esc('" onmouseover="alert(1)')}">x</div>`;
  assert.ok(!/" onmouseover/.test(titleAttr));
});
