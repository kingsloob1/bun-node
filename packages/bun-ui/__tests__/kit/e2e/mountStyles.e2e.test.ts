/**
 * End-to-end, the mount stylesheet (embedding.md §4) in headless Chrome
 * (`Bun.WebView`): every UI's real stylesheets, built by the kit, applied to
 * the same kit markup in four pages, and the computed styles compared.
 *
 * - **The same inside the root**: the kit markup inside a
 *   `[data-bun-ui="<ui>"]` element with the mount stylesheet computes what it
 *   does on the UI's own page with the page stylesheet.
 * - **No leak in**: the same, on a host page with an aggressive stylesheet of
 *   its own (`*` and element rules) linked first, the native `<dialog>` and
 *   form controls included; the control removes the guard rule and the
 *   host's rules reach in.
 * - **The edge of the guard**: a host rule more specific than it, around the
 *   root (`.host-wrap p`), still reaches in (documented in the guides), with
 *   the control of the same page without the wrapper.
 * - **`rem`** is the reader's size, not the host's: a host with
 *   `html { font-size: 62.5% }` and `* { font: 20px }` leaves the UI's sizes
 *   as on its page, with the control of the stylesheet's `rem` left as is.
 *   The root here is a plain wrapper element; the mount function that
 *   creates it, and sets `--bun-ui-rem` from the reader's default size,
 *   arrives in EM-3 (16px until then).
 * - **SVG** keeps its presentation attributes: the guard leaves it out, and
 *   the control applies the guard to it too and the chart's shape loses
 *   its size and colour.
 * - **No leak out**: the host's own elements compute the same with the mount
 *   stylesheet linked as without it, kit class names included.
 * - **Keyframes**: a host's `@keyframes spin` does not replace the UI's
 *   (a keyframes name is global, the last stylesheet defining it winning),
 *   linked before the mount stylesheet or after it, with a negative control
 *   that puts the UI's unprefixed name back and links the host's after it.
 *
 * Skips visibly without Chrome (`BUN_CHROME_PATH` overrides the search).
 */
import { existsSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { buildAssets, uiEntry } from "../../../lib/kit/assets";
import { mountGuardRule } from "../../../lib/kit/scopeCss";
import { chromeProfile } from "../../jobs/e2e/profile";

/** Where Chrome may be, in search order. */
const CHROME_CANDIDATES = [
  process.env.BUN_CHROME_PATH,
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].filter((path): path is string => typeof path === "string" && path !== "");

const chromePath = CHROME_CANDIDATES.find((path) => existsSync(path));

/** The UIs under test. */
const UIS = ["jobs", "security", "docs"] as const;

/** One UI's two stylesheets. */
interface Sheets {
  /** The page's entry stylesheet. */
  page: string;
  /** The mount stylesheet. */
  mount: string;
}

/** The kit markup every page holds, each probe with an id. */
const MARKUP = `
<div class="screen" id="screen">
  <h1 class="screen-title" id="title">Title</h1>
  <p id="p">Text with <a href="#x" id="a">a link</a> and <code id="code">code</code>.</p>
  <button type="button" class="btn btn-primary" id="btn">Primary</button>
  <button type="button" class="btn btn-ghost btn-sm" id="ghost">Ghost</button>
  <span class="badge" id="badge">badge</span>
  <input class="input" id="input" value="v">
  <div class="card" id="card"><div class="card-header" id="card-header">Card</div></div>
  <div class="table-wrap"><table class="table" id="table"><thead><tr><th id="th">H</th></tr></thead><tbody><tr><td id="td">cell</td></tr></tbody></table></div>
  <span class="spinner" id="spinner"></span>
  <select class="input select" id="select"><option>one</option></select>
  <div class="checkbox"><input type="checkbox" id="check"></div>
  <textarea class="input" id="textarea">t</textarea>
  <dialog class="dialog dialog-sm" id="dialog" open><div class="dialog-panel" id="dialog-panel"><h2 class="dialog-title" id="dialog-title">Dialog</h2></div></dialog>
  <svg id="svg" width="40" height="20" viewBox="0 0 40 20"><rect id="rect" x="1" y="2" width="30" height="10" fill="rgb(1, 2, 3)"></rect></svg>
</div>`;

/** The probes' ids, inside the UI's markup. */
const PROBES = [
  "screen",
  "title",
  "p",
  "a",
  "code",
  "btn",
  "ghost",
  "badge",
  "input",
  "card",
  "card-header",
  "table",
  "th",
  "td",
  "spinner",
  "select",
  "check",
  "textarea",
  "dialog",
  "dialog-panel",
  "dialog-title",
];

/** The host's own markup, outside the UI: plain elements and kit class names. */
const HOST_MARKUP = `
<header id="host-header"><p id="host-p">Host <a href="#h" id="host-a">link</a></p>
<button type="button" class="btn" id="host-btn">Host button</button>
<table class="table" id="host-table"><tr><td id="host-td">host</td></tr></table>
<div class="screen card" id="host-screen">host screen</div></header>`;

/** The host probes' ids. */
const HOST_PROBES = [
  "host-header",
  "host-p",
  "host-a",
  "host-btn",
  "host-table",
  "host-td",
  "host-screen",
];

/** A deliberately aggressive host stylesheet (embedding.md §9): universal, element and kit-named rules. */
const HOST_CSS = `
html { font-size: 62.5%; }
* { font: 20px serif; color: rgb(9, 9, 9); margin: 3px; box-sizing: content-box; letter-spacing: 2px; }
button { background: rgb(255, 0, 0); padding: 9px; border: 4px dotted rgb(0, 255, 0); }
table { width: 200px; border-collapse: separate; }
td, th { padding: 11px; }
a { color: rgb(0, 255, 0); text-decoration: none; }
code { font-family: fantasy; }
p { line-height: 3; }
input { border: 6px solid rgb(0, 0, 255); }
@keyframes spin { from { opacity: 0.5; } to { opacity: 0.5; } }`;

/** A host rule more specific than the guard, around the root: what still reaches in. */
const WRAP_CSS = `.host-wrap p { color: rgb(200, 0, 0); }`;

/** The properties compared. */
const PROPERTIES = [
  "font-size",
  "font-family",
  "font-weight",
  "line-height",
  "letter-spacing",
  "color",
  "background-color",
  "margin-top",
  "padding-top",
  "padding-left",
  "border-top-width",
  "border-top-style",
  "border-top-color",
  "border-radius",
  "box-sizing",
  "text-decoration-line",
  "display",
  "animation-name",
];

/**
 * Reads `ids`' computed `PROPERTIES`, by id, as JSON. A keyframes name is
 * read without the mount stylesheet's `bun-ui-<ui>-` prefix, the one
 * difference meant.
 */
function readStyles(ids: readonly string[]): string {
  return `(() => {
    const out = {};
    for (const id of ${JSON.stringify(ids)}) {
      const element = document.getElementById(id);
      if (!element) { out[id] = "missing"; continue; }
      const style = getComputedStyle(element);
      out[id] = Object.fromEntries(${JSON.stringify(PROPERTIES)}.map((name) => [name, style.getPropertyValue(name).replace(/bun-ui-[a-z]+-/g, "")]));
    }
    return JSON.stringify(out);
  })()`;
}

/** The chart probe: the rectangle's box and fill, as JSON. */
const READ_SVG = `(() => {
  const rect = document.getElementById("rect");
  const box = rect.getBoundingClientRect();
  return JSON.stringify({ width: box.width, height: box.height, fill: getComputedStyle(rect).fill });
})()`;

/** The spinner's running animation's keyframes, as Chrome resolved them. */
const SPINNER_KEYFRAMES = `(() => {
  const animation = document.getElementById("spinner").getAnimations()[0];
  return animation ? JSON.stringify(animation.effect.getKeyframes().map((frame) => ({ transform: frame.transform, opacity: frame.opacity }))) : "none";
})()`;

/** A page around `body`, linking `sheets` (each a served path) in order. */
function page(sheets: readonly string[], body: string, root = ""): string {
  const links = sheets
    .map((href) => `<link rel="stylesheet" href="${href}">`)
    .join("");
  return `<!doctype html><html${root}><head><meta charset="utf-8">${links}</head><body>${body}</body></html>`;
}

describe.skipIf(chromePath === undefined)(
  `the mount stylesheet in Chrome${chromePath === undefined ? " — SKIPPED: no Chrome found (set BUN_CHROME_PATH)" : ""}`,
  () => {
    const sheets = new Map<string, Sheets>();
    let server: ReturnType<typeof Bun.serve> | undefined;
    let origin = "";
    let view: Bun.WebView | undefined;
    let profile: ReturnType<typeof chromeProfile> | undefined;

    beforeAll(async () => {
      for (const ui of UIS) {
        const assets = await buildAssets({
          entry: uiEntry(ui),
          sourcemap: "none",
          mount: ui,
        });
        const text = (name: string) =>
          new TextDecoder().decode(assets.files.get(name)!.body);
        sheets.set(ui, {
          page: text(assets.entry.css[0]),
          mount: text(assets.mount!.css[0]),
        });
      }
      const css = (body: string) =>
        new Response(body, { headers: { "content-type": "text/css" } });
      const html = (body: string) =>
        new Response(body, { headers: { "content-type": "text/html" } });
      server = Bun.serve({
        port: 0,
        fetch(req) {
          const [, kind, ui] = new URL(req.url).pathname.split("/");
          const own = sheets.get(ui ?? "");
          if (kind === "host.css") return css(HOST_CSS);
          if (kind === "wrap.css") return css(WRAP_CSS);
          if (own === undefined) return new Response("no", { status: 404 });
          const root = `<div data-bun-ui="${ui}" id="root">${MARKUP}</div>`;
          switch (kind) {
            case "page.css":
              return css(own.page);
            case "mount.css":
              return css(own.mount);
            case "unrenamed.css":
              return css(own.mount.replaceAll(`bun-ui-${ui}-spin`, "spin"));
            case "unrem.css":
              return css(
                own.mount.replace(
                  /calc\((-?[\d.]+)\*var\(--bun-ui-rem,16px\)\)/g,
                  "$1rem",
                ),
              );
            case "host-unrem":
              return html(
                page(["/host.css/", `/unrem.css/${ui}`], HOST_MARKUP + root),
              );
            case "unguarded.css":
              return css(own.mount.slice(mountGuardRule(ui).length));
            case "svg-guarded.css":
              return css(
                `[data-bun-ui="${ui}"]{all:initial;display:block}[data-bun-ui="${ui}"] *{all:revert}${own.mount.slice(mountGuardRule(ui).length)}`,
              );
            case "shell":
              return html(page([`/page.css/${ui}`], MARKUP));
            case "clean":
              return html(page([`/mount.css/${ui}`], root));
            case "host":
              return html(
                page(["/host.css/", `/mount.css/${ui}`], HOST_MARKUP + root),
              );
            case "host-unguarded":
              return html(
                page(
                  ["/host.css/", `/unguarded.css/${ui}`],
                  HOST_MARKUP + root,
                ),
              );
            case "wrapped":
              return html(
                page(
                  ["/host.css/", "/wrap.css/", `/mount.css/${ui}`],
                  `<div class="host-wrap">${root}</div>`,
                ),
              );
            case "svg-guarded":
              return html(page([`/svg-guarded.css/${ui}`], root));
            case "host-only":
              return html(page(["/host.css/"], HOST_MARKUP));
            case "host-mounted":
              return html(
                page(["/host.css/", `/mount.css/${ui}`], HOST_MARKUP),
              );
            case "clash":
              return html(page(["/host.css/", `/mount.css/${ui}`], root));
            case "clash-after":
              return html(page([`/mount.css/${ui}`, "/host.css/"], root));
            case "clash-unrenamed":
              return html(page([`/unrenamed.css/${ui}`, "/host.css/"], root));
            default:
              return new Response("no", { status: 404 });
          }
        },
      });
      origin = `http://127.0.0.1:${server.port}`;
      profile = chromeProfile("mount-styles");
      view = new Bun.WebView({
        backend: {
          type: "chrome",
          url: false,
          path: chromePath!,
          argv: ["--use-gl=disabled"],
        },
        dataStore: profile.dataStore,
        width: 1280,
        height: 900,
      });
    }, 120_000);

    afterAll(async () => {
      view?.close();
      await profile?.remove();
      await server?.stop(true);
    });

    /** Opens `path` and evaluates `script` there once its stylesheets loaded. */
    async function read<T>(path: string, script: string): Promise<T> {
      await view!.navigate(`${origin}${path}`);
      await view!.evaluate<boolean>(
        `new Promise((resolve) => document.readyState === "complete" ? resolve(true) : addEventListener("load", () => resolve(true)))`,
      );
      return view!.evaluate<T>(script);
    }

    /** A page's probes, parsed. */
    async function styles(
      path: string,
      ids: readonly string[] = PROBES,
    ): Promise<Record<string, Record<string, string>>> {
      return JSON.parse(await read<string>(path, readStyles(ids))) as Record<
        string,
        Record<string, string>
      >;
    }

    for (const ui of UIS) {
      describe(ui, () => {
        it("computes the page's styles inside the mount root", async () => {
          const shell = await styles(`/shell/${ui}`);
          expect(await styles(`/clean/${ui}`)).toEqual(shell);
        });

        it("keeps a host's universal and element rules out, dialog and form controls included", async () => {
          const shell = await styles(`/shell/${ui}`);
          const hosted = await styles(`/host/${ui}`);
          expect(hosted).toEqual(shell);
          // Control: without the guard, the host's rules reach in.
          const unguarded = await styles(`/host-unguarded/${ui}`);
          expect(unguarded.p["font-family"]).toBe("serif");
          expect(unguarded.p["letter-spacing"]).toBe("2px");
          expect(unguarded).not.toEqual(shell);
        });

        it("keeps its sizes when the host's html is 62.5% (rem is the reader's size)", async () => {
          const shell = await styles(`/shell/${ui}`);
          const hosted = await styles(`/host/${ui}`);
          for (const id of PROBES) {
            expect(hosted[id]["font-size"]).toBe(shell[id]["font-size"]);
            expect(hosted[id]["padding-top"]).toBe(shell[id]["padding-top"]);
          }
          // Control: with rem left as it is, the UI scales with the host.
          const unrem = await styles(`/host-unrem/${ui}`);
          expect(unrem.p["font-size"]).not.toBe(shell.p["font-size"]);
        });

        it("lets a host rule more specific than the guard reach in (the documented edge)", async () => {
          const wrapped = await styles(`/wrapped/${ui}`, ["p"]);
          expect(wrapped.p.color).toBe("rgb(200, 0, 0)");
          // Control: the same host without the wrapper does not.
          const hosted = await styles(`/host/${ui}`, ["p"]);
          expect(hosted.p.color).not.toBe("rgb(200, 0, 0)");
        });

        it("keeps SVG's presentation attributes (the guard leaves SVG out)", async () => {
          const svg = async (path: string) =>
            JSON.parse(await read<string>(path, READ_SVG)) as unknown;
          const shell = await svg(`/shell/${ui}`);
          expect(shell).toEqual({
            width: 30,
            height: 10,
            fill: "rgb(1, 2, 3)",
          });
          expect(await svg(`/clean/${ui}`)).toEqual(shell);
          expect(await svg(`/host/${ui}`)).toEqual(shell);
          // Control: a guard over SVG too drops them.
          expect(await svg(`/svg-guarded/${ui}`)).not.toEqual(shell);
        });

        it("keeps the host's elements as they were, kit class names included", async () => {
          expect(await styles(`/host-mounted/${ui}`, HOST_PROBES)).toEqual(
            await styles(`/host-only/${ui}`, HOST_PROBES),
          );
        });

        it("keeps its spinner's keyframes when the host defines its own spin", async () => {
          for (const path of [`/clash/${ui}`, `/clash-after/${ui}`]) {
            const ours = await read<string>(path, SPINNER_KEYFRAMES);
            expect(ours).toContain("rotate");
            expect(ours).not.toContain("0.5");
          }
          // Negative control: with the UI's name unprefixed, the host's wins.
          const replaced = await read<string>(
            `/clash-unrenamed/${ui}`,
            SPINNER_KEYFRAMES,
          );
          expect(replaced).toContain("0.5");
        });
      });
    }
  },
);
