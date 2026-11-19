/**
 * The mount stylesheet (`lib/kit/scopeCss.ts`, embedding.md §4): every rule
 * of a UI's stylesheet under its mount element, after the guard rule, the
 * page's root mapped onto that element, keyframes renamed. The proof over the
 * real UIs is {@link escapes}, a checker written apart from the scoping
 * code: it finds every selector not starting at the mount root, and a
 * stylesheet not opening with the guard, with negative controls on the
 * unscoped stylesheet and on a planted rule.
 */
import { describe, expect, it } from "bun:test";
import { buildAssets, uiEntry } from "../../../lib/kit/assets";
import {
  MOUNT_REM_PROPERTY,
  mountGuardRule,
  mountKeyframesName,
  mountRootSelector,
  rewriteRem,
  scopeStylesheet,
} from "../../../lib/kit/scopeCss";

/** The stylesheet text of a bundle's file `name`. */
function text(files: ReadonlyMap<string, { body: Uint8Array }>, name: string) {
  return new TextDecoder().decode(files.get(name)!.body);
}

/**
 * What in `css` escapes `ui`'s mount root: a missing guard (the first two
 * rules after any `@charset`/`@import` must be `all: initial` on the root
 * and `all: revert` under it), or a
 * selector not starting at `[data-bun-ui="<ui>"]`. Comments and strings are
 * blanked first (all but `"<ui>"`, the root's value); keyframe selectors
 * (`from`, `50%`) are not page selectors.
 */
function escapes(css: string, ui: string): string[] {
  const root = `[data-bun-ui="${ui}"]`;
  const plain = css
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, (quoted) =>
      // Strings are text, except the root's own attribute value.
      quoted === `"${ui}"` ? quoted : '""',
    );
  const found: string[] = [];
  const guard =
    /^(?:@(?:charset|import)[^;]*;)*([^{]*)\{([^}]*)\}([^{]*)\{([^}]*)\}/.exec(
      plain,
    );
  if (
    !guard ||
    guard[1].trim() !== root ||
    guard[2].trim() !== "all:initial;display:block" ||
    !guard[3].trim().startsWith(`${root} *`) ||
    guard[4].trim() !== "all:revert"
  ) {
    found.push("no guard first");
  }
  /** The open blocks, outermost first: their preludes. */
  const stack: string[] = [];
  let start = 0;
  for (let i = 0; i < plain.length; i += 1) {
    const c = plain[i];
    if (c === ";" || c === "}") {
      if (c === "}") stack.pop();
      start = i + 1;
      continue;
    }
    if (c !== "{") continue;
    const prelude = plain.slice(start, i).trim();
    start = i + 1;
    const inKeyframes = stack.some((open) =>
      /^@(?:-\w+-)?keyframes\b/.test(open),
    );
    stack.push(prelude);
    if (prelude.startsWith("@") || inKeyframes) continue;
    for (const selector of prelude.split(/,(?![^(]*\))/)) {
      if (!selector.trim().startsWith(root)) {
        found.push(`escapes the root: ${selector.trim()}`);
      }
    }
  }
  return found;
}

describe("scopeStylesheet", () => {
  const root = mountRootSelector("jobs");
  /** The guard every jobs mount stylesheet opens with. */
  const guard = mountGuardRule("jobs");

  it("opens with the guard and puts every rule under the root, unlayered", () => {
    expect(scopeStylesheet(".a{color:red}.b .c,.d>e{margin:0}", "jobs")).toBe(
      `${guard}${root} .a{color:red}${root} .b .c,${root} .d>e{margin:0}`,
    );
    expect(root).toBe('[data-bun-ui="jobs"]');
  });

  it("maps the page's root (:root, html, body) onto the mount element", () => {
    expect(
      scopeStylesheet(
        ":root{--a:1}:root[data-theme=dark]{--a:2}html,body{margin:0}:root[data-align=left] .screen{margin:0}",
        "docs",
      ),
    ).toBe(
      `${mountGuardRule("docs")}[data-bun-ui="docs"]{--a:1}[data-bun-ui="docs"][data-theme=dark]{--a:2}[data-bun-ui="docs"]{margin:0}[data-bun-ui="docs"][data-align=left] .screen{margin:0}`,
    );
  });

  it("keeps a selector that only starts like html or body (.htmlish, bodyx) a descendant", () => {
    expect(scopeStylesheet("html-x{a:b}.body{a:b}", "jobs")).toBe(
      `${guard}${root} html-x{a:b}${root} .body{a:b}`,
    );
  });

  it("gives * the element itself and everything in it", () => {
    expect(scopeStylesheet("*,*:before{box-sizing:border-box}", "jobs")).toBe(
      `${guard}${root},${root} *,${root}:before,${root} *:before{box-sizing:border-box}`,
    );
  });

  it("scopes inside @media and @supports, and the page root there too", () => {
    expect(
      scopeStylesheet(
        "@media (prefers-color-scheme:dark){:root:not([data-theme=light]){--a:2}}@supports (display:grid){.g{display:grid}}",
        "jobs",
      ),
    ).toBe(
      `${guard}@media (prefers-color-scheme:dark){${root}:not([data-theme=light]){--a:2}}@supports (display:grid){${root} .g{display:grid}}`,
    );
  });

  it("does not split a selector list inside :is(), :not() or an attribute", () => {
    expect(scopeStylesheet('.a:is(.b,.c),[data-x="1,2"] .d{a:b}', "jobs")).toBe(
      `${guard}${root} .a:is(.b,.c),${root} [data-x="1,2"] .d{a:b}`,
    );
  });

  it("renames its keyframes and the animations using them, not other names or text", () => {
    const out = scopeStylesheet(
      '@keyframes spin{to{transform:rotate(1turn)}}.s{animation:.8s linear infinite spin}.t{animation-name:spin,fade}.u{content:"spin";animation:spin-slow 1s}',
      "jobs",
    );
    expect(mountKeyframesName("jobs", "spin")).toBe("bun-ui-jobs-spin");
    expect(out).toBe(
      `${guard}@keyframes bun-ui-jobs-spin{to{transform:rotate(1turn)}}${root} .s{animation:.8s linear infinite bun-ui-jobs-spin}${root} .t{animation-name:bun-ui-jobs-spin,fade}${root} .u{content:"spin";animation:spin-slow 1s}`,
    );
  });

  it("makes rem the reader's size: calc(N*var(--bun-ui-rem,16px)), in declarations only", () => {
    expect(MOUNT_REM_PROPERTY).toBe("--bun-ui-rem");
    expect(
      rewriteRem(
        'margin:1rem .5rem -2.25rem 0;content:"3rem";width:calc(100% - 12rem);a:x1rem;b:1remx',
      ),
    ).toBe(
      'margin:calc(1*var(--bun-ui-rem,16px)) calc(.5*var(--bun-ui-rem,16px)) calc(-2.25*var(--bun-ui-rem,16px)) 0;content:"3rem";width:calc(100% - calc(12*var(--bun-ui-rem,16px)));a:x1rem;b:1remx',
    );
    expect(
      scopeStylesheet(
        ":root{--text-base:.9375rem}@media (max-width:45rem){.a{padding:2rem}}@keyframes k{to{width:3rem}}",
        "jobs",
      ),
    ).toBe(
      `${guard}${root}{--text-base:calc(.9375*var(--bun-ui-rem,16px))}@media (max-width:45rem){${root} .a{padding:calc(2*var(--bun-ui-rem,16px))}}@keyframes bun-ui-jobs-k{to{width:calc(3*var(--bun-ui-rem,16px))}}`,
    );
  });

  it("keeps @font-face, and @charset and @import ahead of the guard", () => {
    expect(
      scopeStylesheet(
        '@charset "utf-8";@import url(x.css);@font-face{font-family:X;src:url(x.woff2)}.a{font-family:X}',
        "jobs",
      ),
    ).toBe(
      `@charset "utf-8";@import url(x.css);${guard}@font-face{font-family:X;src:url(x.woff2)}${root} .a{font-family:X}`,
    );
  });

  it("reads braces and commas inside strings and comments as text", () => {
    expect(
      scopeStylesheet('/* a { b } */.q:before{content:"{,}"}', "jobs"),
    ).toBe(`${guard}${root} .q:before{content:"{,}"}`);
  });

  it("refuses a stylesheet it cannot read, and a name that is not a UI's", () => {
    expect(() => scopeStylesheet(".a{color:red", "jobs")).toThrow(
      "unbalanced braces",
    );
    expect(() => scopeStylesheet(".a{}}", "jobs")).toThrow("unbalanced braces");
    expect(() => scopeStylesheet('.a{content:"x}', "jobs")).toThrow(
      "unterminated string",
    );
    expect(() => scopeStylesheet(".a{}", 'jobs"]')).toThrow("not a UI name");
  });
});

describe("the escape checker", () => {
  it("passes a scoped stylesheet", () => {
    expect(
      escapes(
        scopeStylesheet(
          ":root{--a:1}.a,.b{c:d}@keyframes k{from{a:b}}",
          "jobs",
        ),
        "jobs",
      ),
    ).toEqual([]);
  });

  it("negative control: finds an unscoped stylesheet's every rule, and no guard", () => {
    expect(escapes(":root{--a:1}.a,.b{c:d}", "jobs")).toEqual([
      "no guard first",
      "escapes the root: :root",
      "escapes the root: .a",
      "escapes the root: .b",
    ]);
  });

  it("negative control: finds a planted rule, a missing guard, another UI's root", () => {
    const scoped = scopeStylesheet(".a{c:d}", "jobs");
    expect(escapes(`${scoped}.leak{c:d}`, "jobs")).toEqual([
      "escapes the root: .leak",
    ]);
    expect(
      escapes(scoped.slice(mountGuardRule("jobs").length), "jobs"),
    ).toEqual(["no guard first"]);
    // A guard that does not revert, or leaves the root inheriting, is no guard.
    expect(
      escapes(scoped.replace("all:revert", "all:inherit"), "jobs"),
    ).toEqual(["no guard first"]);
    expect(escapes(scoped.replace("all:initial;", ""), "jobs")).toEqual([
      "no guard first",
    ]);
    expect(escapes(scoped, "docs").length).toBeGreaterThan(0);
  });
});

describe("every UI's mount stylesheet", () => {
  for (const ui of ["jobs", "security", "docs"]) {
    it(`${ui}: nothing escapes the root, and every keyframes name is the UI's`, async () => {
      const assets = await buildAssets({
        entry: uiEntry(ui),
        sourcemap: "none",
        mount: ui,
      });
      expect(assets.mount?.ui).toBe(ui);
      const css = text(assets.files, assets.mount!.css[0]);
      expect(escapes(css, ui)).toEqual([]);
      const keyframes = [...css.matchAll(/@keyframes ([\w-]+)/g)].map(
        (m) => m[1],
      );
      expect(keyframes.length).toBeGreaterThan(0);
      for (const name of keyframes) expect(name).toStartWith(`bun-ui-${ui}-`);
      // No rem left outside media queries: each became the reader's size.
      const declarations = css.replace(/@media[^{]*/g, "");
      expect(declarations).not.toMatch(/\d\.?\d*rem\b/);
      expect(css).toContain("var(--bun-ui-rem,16px)");
      // Negative control: the page's own stylesheet is all outside.
      const page = text(assets.files, assets.entry.css[0]);
      expect(escapes(page, ui)).toContain("no guard first");
      expect(escapes(page, ui).length).toBeGreaterThan(100);
      expect(page).not.toContain("data-bun-ui");
      // The same rules: one scoped rule per page rule, plus the two guards.
      const blocks = (s: string) => (s.match(/\{/g) ?? []).length;
      expect(blocks(css)).toBe(blocks(page) + 2);
    });
  }
});
