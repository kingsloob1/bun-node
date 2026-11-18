/**
 * Page-side accessibility and layout checks for the security UI's e2e
 * (PR-U6), as scripts `Bun.WebView.evaluate` runs. Each returns the
 * problems it found as lines naming the element, so a failure points at
 * the fix. What they check:
 *
 * - **Landmarks and headings**: one `main`, a `nav`, a banner (`header`),
 *   one visible `h1`.
 * - **Names**: every visible form control has an accessible name (a label,
 *   `aria-label`, `aria-labelledby` or `title`; a placeholder is a hint and
 *   never counts as one); every button and link has
 *   a name; an `svg` with `role="img"` and an `img` have one too; no id is
 *   used twice.
 * - **Contrast** (WCAG 2.2 AA): each visible text's colour against the
 *   background it sits on, 4.5:1, or 3:1 for large text (24 px, or 18.66 px
 *   bold); disabled controls are exempt, as WCAG says.
 * - **Placeholders** (BU-placeholders): every visible text field shows an
 *   example placeholder, and every select that can be empty an empty first
 *   option ("Choose a …", or an "Any" choice); one that always holds a value
 *   is marked `data-always-set` and shows none, but must hold a value;
 *   checkboxes, dates and files take none.
 * - **Focus**: no positive `tabindex` (it breaks the reading order), and a
 *   focused element shows a visible indicator (an outline or a box shadow).
 * - **Layout**: the page never scrolls sideways (`scrollWidth <=
 *   innerWidth`); the elements sticking out are named.
 */

/** Page-side: a short description of an element, for a problem line. */
const DESCRIBE = `(el) => {
  const id = el.id ? "#" + el.id : "";
  const test = el.getAttribute("data-testid") ? "[data-testid=" + el.getAttribute("data-testid") + "]" : "";
  const cls = !id && !test && typeof el.className === "string" && el.className.trim() !== "" ? "." + el.className.trim().split(/\\s+/).slice(0, 2).join(".") : "";
  const text = (el.textContent || "").trim().replace(/\\s+/g, " ").slice(0, 40);
  return el.tagName.toLowerCase() + id + test + cls + (text ? " “" + text + "”" : "");
}`;

/** Page-side: whether an element is shown (laid out and not hidden). */
const VISIBLE = `(el) => {
  if (el.closest("[hidden],[aria-hidden=true]")) return false;
  const style = getComputedStyle(el);
  if (style.visibility === "hidden" || style.display === "none") return false;
  const rects = el.getClientRects();
  return rects.length > 0 && [...rects].some((r) => r.width > 0 && r.height > 0);
}`;

/** Page-side: an element's accessible name, approximately (the cases the app uses). */
const NAME = `(el) => {
  const labelled = el.getAttribute("aria-labelledby");
  if (labelled) {
    const text = labelled.split(/\\s+/).map((id) => document.getElementById(id)?.textContent ?? "").join(" ").trim();
    if (text) return text;
  }
  const aria = el.getAttribute("aria-label");
  if (aria && aria.trim()) return aria.trim();
  if (el.labels && el.labels.length > 0) {
    const text = [...el.labels].map((l) => l.textContent).join(" ").trim();
    if (text) return text;
  }
  const tag = el.tagName.toLowerCase();
  if (tag === "button" || tag === "a" || el.getAttribute("role") === "button" || el.getAttribute("role") === "tab" || tag === "summary") {
    const text = (el.textContent || "").trim();
    if (text) return text;
    const img = el.querySelector("img[alt], svg[aria-label]");
    if (img) return img.getAttribute("alt") || img.getAttribute("aria-label") || "";
  }
  if (tag === "img") return el.getAttribute("alt") ?? "";
  if (tag === "svg") return el.querySelector(":scope > title")?.textContent?.trim() ?? "";
  if (el.getAttribute("title")) return el.getAttribute("title").trim();
  if ((el.type === "submit" || el.type === "button") && el.value) return el.value;
  return "";
}`;

/** Page-side: the structure and names checks. */
export const CHECK_STRUCTURE = `(() => {
  const describe = ${DESCRIBE};
  const visible = ${VISIBLE};
  const name = ${NAME};
  const out = [];
  const mains = [...document.querySelectorAll("main,[role=main]")];
  if (mains.length !== 1) out.push("landmark: " + mains.length + " main regions (want 1)");
  if (document.querySelectorAll("nav,[role=navigation]").length === 0) out.push("landmark: no nav");
  if (document.querySelectorAll("header,[role=banner]").length === 0) out.push("landmark: no banner (header)");
  const h1 = [...document.querySelectorAll("h1")].filter(visible);
  if (h1.length !== 1) out.push("heading: " + h1.length + " visible h1 (want 1)");
  for (const el of document.querySelectorAll("input,select,textarea")) {
    if (el.type === "hidden" || !visible(el)) continue;
    if (name(el)) continue;
    // A placeholder is a hint, never the label: it goes as soon as one types.
    if (el.getAttribute("placeholder")) out.push("name: a placeholder stands in for a label: " + describe(el) + " (placeholder “" + el.getAttribute("placeholder") + "”)");
    else out.push("name: a " + el.tagName.toLowerCase() + (el.type ? "[type=" + el.type + "]" : "") + " has no label: " + describe(el));
  }
  // Every text field shows an example, and every select says what to choose
  // (BU-placeholders); checkboxes, radios, dates, times and files take none.
  const noPlaceholder = new Set(["checkbox", "radio", "file", "date", "datetime-local", "time", "month", "week", "hidden", "range", "color", "submit", "button", "reset", "image"]);
  for (const el of document.querySelectorAll("input,textarea")) {
    if (!visible(el) || (el.tagName === "INPUT" && noPlaceholder.has(el.type))) continue;
    if (!(el.getAttribute("placeholder") ?? "").trim()) out.push("placeholder: none on " + describe(el));
  }
  for (const el of document.querySelectorAll("select")) {
    if (!visible(el) || el.multiple) continue;
    // An always-set select (a sort, a page size) shows no "Choose a …" entry,
    // but must then hold a value: marked always set and empty is a lie.
    if (el.hasAttribute("data-always-set")) {
      if (el.value === "") out.push("select: marked always set, yet empty: " + describe(el));
      continue;
    }
    if (![...el.options].some((option) => option.value === "")) out.push("select: no empty option: " + describe(el));
  }
  for (const el of document.querySelectorAll("button,a[href],[role=button],[role=tab],summary")) {
    if (!visible(el)) continue;
    if (!name(el)) out.push("name: a control has no name: " + describe(el));
  }
  for (const el of document.querySelectorAll("svg[role=img],img")) {
    if (!visible(el)) continue;
    if (!name(el)) out.push("name: an image has no text alternative: " + describe(el));
  }
  const ids = new Map();
  for (const el of document.querySelectorAll("[id]")) ids.set(el.id, (ids.get(el.id) ?? 0) + 1);
  for (const [id, count] of ids) if (count > 1) out.push("id: “" + id + "” is used " + count + " times");
  for (const el of document.querySelectorAll("[tabindex]")) {
    if (Number(el.getAttribute("tabindex")) > 0) out.push("focus: a positive tabindex breaks the order: " + describe(el));
  }
  return out;
})()`;

/** Page-side: the contrast check of every visible text against what it sits on. */
export const CHECK_CONTRAST = `(() => {
  const describe = ${DESCRIBE};
  const visible = ${VISIBLE};
  const parse = (value) => {
    const m = /rgba?\\(([^)]+)\\)/.exec(value);
    if (!m) return null;
    const parts = m[1].split(/[\\s,/]+/).filter(Boolean).map(Number);
    return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
  };
  const over = (top, under) => ({
    r: top.r * top.a + under.r * (1 - top.a),
    g: top.g * top.a + under.g * (1 - top.a),
    b: top.b * top.a + under.b * (1 - top.a),
    a: 1,
  });
  const background = (el) => {
    const layers = [];
    for (let at = el; at; at = at.parentElement) {
      const style = getComputedStyle(at);
      if (style.backgroundImage && style.backgroundImage !== "none") return null;
      const color = parse(style.backgroundColor);
      if (color && color.a > 0) {
        layers.push(color);
        if (color.a >= 1) break;
      }
    }
    let base = { r: 255, g: 255, b: 255, a: 1 };
    for (const layer of layers.reverse()) base = over(layer, base);
    return base;
  };
  const luminance = (c) => {
    const ch = [c.r, c.g, c.b].map((v) => {
      const s = v / 255;
      return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
  };
  const ratio = (a, b) => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };
  const out = [];
  const seen = new Set();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (!node.textContent.trim()) continue;
    const el = node.parentElement;
    if (!el || seen.has(el) || !visible(el)) continue;
    seen.add(el);
    if (el.closest("button:disabled,input:disabled,select:disabled,textarea:disabled,[aria-disabled=true],option,script,style,noscript")) continue;
    const style = getComputedStyle(el);
    const color = parse(style.color);
    const under = background(el);
    if (!color || !under) continue;
    const fg = over({ ...color, a: color.a * Number(style.opacity || 1) }, under);
    const size = parseFloat(style.fontSize);
    const bold = Number(style.fontWeight) >= 700;
    const large = size >= 24 || (size >= 18.66 && bold);
    const need = large ? 3 : 4.5;
    const got = ratio(fg, under);
    if (got + 0.005 < need) out.push("contrast: " + got.toFixed(2) + ":1 (want " + need + ":1) " + style.color + " on rgb(" + [under.r, under.g, under.b].map(Math.round).join(", ") + "): " + describe(el));
  }
  return out;
})()`;

/** Page-side: the focused element's description, and whether it shows a visible focus indicator. */
export const FOCUSED = `(() => {
  const describe = ${DESCRIBE};
  const el = document.activeElement;
  if (!el || el === document.body) return null;
  const style = getComputedStyle(el);
  const outline = style.outlineStyle !== "none" && parseFloat(style.outlineWidth) > 0;
  const shadow = style.boxShadow && style.boxShadow !== "none";
  return { at: describe(el), visible: outline || shadow, inDialog: !!el.closest("dialog[open],[role=dialog],[role=alertdialog]") };
})()`;

/** Page-side: whether the page scrolls sideways, and what sticks out. */
export const CHECK_WIDTH = `(() => {
  const describe = ${DESCRIBE};
  const viewport = window.innerWidth;
  const scrollWidth = document.scrollingElement.scrollWidth;
  if (scrollWidth <= viewport) return [];
  const clipped = (el) => {
    for (let at = el.parentElement; at; at = at.parentElement) {
      if (/(auto|scroll|hidden|clip)/.test(getComputedStyle(at).overflowX)) return true;
    }
    return false;
  };
  const out = ["width: the page is " + scrollWidth + "px wide in a " + viewport + "px viewport"];
  for (const el of document.body.querySelectorAll("*")) {
    const r = el.getBoundingClientRect();
    if (r.right > viewport + 1 && !clipped(el)) {
      out.push("width: sticks out to " + Math.round(r.right) + "px: " + describe(el));
      if (out.length > 12) break;
    }
  }
  return out;
})()`;

/**
 * Page-side: plants one problem of each kind (the negative controls). The
 * styles go through the CSSOM: the UI's strict CSP drops `style` attributes.
 */
export const PLANT = `(() => {
  const main = document.querySelector("main");
  const box = document.createElement("div");
  box.id = "planted";
  const add = (tag, planted, text, style = {}) => {
    const el = document.createElement(tag);
    el.setAttribute("data-planted", planted);
    if (text) el.textContent = text;
    Object.assign(el.style, style);
    box.append(el);
    return el;
  };
  add("input", "unlabelled");
  add("input", "placeholder-only").placeholder = "e.g. checkout-api";
  const pick = add("select", "no-empty-option");
  pick.setAttribute("aria-label", "A planted select");
  pick.append(new Option("A", "a"));
  // Marked always set, yet empty: a select's checks must still catch it.
  const lying = add("select", "always-set-empty");
  lying.setAttribute("aria-label", "A planted always-set select");
  lying.setAttribute("data-always-set", "");
  lying.append(new Option("Pick", ""), new Option("B", "b"));
  lying.value = "";
  // The control: marked always set, and holding a value, passes.
  const honest = add("select", "always-set-honest");
  honest.setAttribute("aria-label", "A planted honest select");
  honest.setAttribute("data-always-set", "");
  honest.append(new Option("C", "c"));
  add("button", "nameless");
  add("p", "faint", "faint text", { color: "#bbbbbb", backgroundColor: "#ffffff" });
  const order = add("a", "tabindex", "order");
  order.href = "#";
  order.tabIndex = 3;
  add("div", "wide", "", { width: "3000px", height: "4px" });
  add("button", "no-focus", "no focus ring", { outline: "none", boxShadow: "none" });
  main.prepend(box);
  return true;
})()`;
