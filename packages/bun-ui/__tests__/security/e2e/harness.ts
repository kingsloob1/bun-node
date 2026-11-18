/**
 * The security UI's e2e harness (PR-U6): the REAL app (`app/security/main.tsx`,
 * built in memory) served by `securityUi()` beside a real
 * `createSecurityApi()` on a bun-common adapter bound to port 0, driven in
 * headless Chrome through `Bun.WebView`.
 *
 * The host is what a real one would be:
 *
 * - **Operators** come from an `op` cookie (`alice` by default; `bob` is the
 *   second operator an approval needs), both owners on `global`.
 * - **Step-up** is the host's own page, `/step-up`: it sets a one-time
 *   `stepped` cookie, posts `bun-security:step-up` to the opener and closes,
 *   as `stepUp.ts` documents; the API's `stepUp.verify` takes each value
 *   once, so every step-up is a fresh one.
 * - **Two-person approvals** are on: a dangerous change waits for the other
 *   operator.
 * - **Agents** are served (an ephemeral store is allowed), and **alerts**
 *   deliver in process; `/hook` is a loopback webhook that records what it
 *   receives.
 *
 * Skips visibly when no Chrome is found (`BUN_CHROME_PATH` overrides the
 * search).
 */
import type { SecurityApi } from "@kingsleyweb/bun-security/control";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunHttpAdapter, noopLogger } from "@kingsleyweb/bun-common";
import { DEFAULT_ENTRY } from "../../../lib/security/assets";
import { createSecurityUi } from "../../../lib/security/securityUi";
import { chromeProfile } from "../../jobs/e2e/profile";
import { memorySecurityApi } from "../server/helpers";

/** Where Chrome may be, in search order. */
const CHROME_CANDIDATES = [
  process.env.BUN_CHROME_PATH,
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].filter((path): path is string => typeof path === "string" && path !== "");

/** The first Chrome that exists, if any. */
export const chromePath = CHROME_CANDIDATES.find((path) => existsSync(path));

/** A dialog: the kit's are native `<dialog>` elements. */
export const DIALOG = "dialog[open],[role=dialog],[role=alertdialog]";

/** The suite's name, saying when it skips. */
export function suiteName(name: string): string {
  return `${name}${chromePath === undefined ? " — SKIPPED: no Chrome found (set BUN_CHROME_PATH)" : ""}`;
}

/** The page the API's `401 step_up_required` names; the host's own. */
const STEP_UP_PAGE = `<!doctype html><meta charset="utf-8"><title>Step-up</title>
<p>Second factor verified.</p>
<script>
document.cookie = "stepped=" + crypto.randomUUID() + "; path=/; SameSite=Strict";
window.opener && window.opener.postMessage({ type: "bun-security:step-up", ok: true }, location.origin);
setTimeout(() => window.close(), 50);
</script>`;

/** A call's answer, or a throw naming it when its status is not `2xx`. */
export function ok<T extends { status: number; body: any }>(
  answer: T,
  what: string,
): T {
  if (answer.status < 200 || answer.status > 299) {
    throw new Error(`${what}: ${answer.status} ${JSON.stringify(answer.body)}`);
  }
  return answer;
}

/** A cookie's value from a request. */
function cookieOf(header: string | null, name: string): string | undefined {
  for (const part of (header ?? "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return undefined;
}

/** What the webhook received. */
export interface HookCall {
  /** The headers, lower-cased. */
  readonly headers: Record<string, string>;
  /** The body. */
  readonly body: string;
}

/** A running host and a browser on it. */
export interface Host {
  /** The origin, `http://127.0.0.1:<port>`. */
  readonly origin: string;
  /** The API. */
  readonly api: SecurityApi;
  /** The active view. */
  readonly view: () => Bun.WebView;
  /** Makes the view of width `width` the active one. */
  readonly at: (width: number) => void;
  /** What the loopback webhook received. */
  readonly hook: HookCall[];
  /** The step-ups taken so far. */
  readonly stepUps: () => number;
  /** The page's console so far. */
  readonly console: string[];
  /** An operator's call to the API (server-side, as `op`; `stepped`: with a fresh step-up). */
  readonly call: (
    method: string,
    path: string,
    body?: unknown,
    op?: string,
    stepped?: boolean,
  ) => Promise<{ status: number; body: any }>;
  /** Signs the browser in as `op` (the cookie). */
  readonly as: (op: string) => Promise<void>;
  /** Opens `path` under the UI and waits for `selector`. */
  readonly open: (
    path: string,
    selector: string,
    text?: string,
  ) => Promise<void>;
  /** Waits for `selector` (with `text`), or fails with the page's console. */
  readonly waitFor: (
    selector: string,
    text?: string,
    ms?: number,
  ) => Promise<void>;
  /** Waits until no element matches `selector`. */
  readonly waitGone: (selector: string, ms?: number) => Promise<void>;
  /** Clicks `selector`. */
  readonly click: (selector: string) => Promise<void>;
  /** Clicks the button (or link) named `name`, inside `within` when given ({@link DIALOG} for a dialog). */
  readonly clickButton: (name: string, within?: string) => Promise<void>;
  /** Replaces the text of the input `selector` with `text`, typed. */
  readonly fill: (selector: string, text: string) => Promise<void>;
  /** Picks `value` in the select `selector`. */
  readonly pick: (selector: string, value: string) => Promise<void>;
  /** Evaluates `script` in the page. */
  readonly evaluate: <T>(script: string) => Promise<T>;
  /** Stops everything. */
  readonly close: () => Promise<void>;
}

/** Page-side: resolves `true` once `selector` exists (with `text`), `false` after `ms`. */
function waitForScript(selector: string, ms: number, text: string): string {
  return `new Promise((resolve) => {
    const deadline = Date.now() + ${ms};
    const check = () => {
      const element = [...document.querySelectorAll(${JSON.stringify(selector)})]
        .find((el) => ${JSON.stringify(text)} === "" || el.textContent.includes(${JSON.stringify(text)}));
      if (element) return resolve(true);
      if (Date.now() > deadline) return resolve(false);
      setTimeout(check, 50);
    };
    check();
  })`;
}

/** Starts the host and a browser on it. */
export async function startHost(
  label: string,
  options: {
    /** The viewport sizes, one view each (the first is active). Default 1280 × 900. */
    sizes?: readonly (readonly [number, number])[];
  } = {},
): Promise<Host> {
  const used = new Set<string>();
  let stepUps = 0;
  const artefacts = mkdtempSync(join(tmpdir(), "bun-ui-sec-e2e-art-"));
  const api = await memorySecurityApi({
    basePath: "/sec-api",
    owners: ["alice", "bob"],
    allowWithoutStepUp: undefined,
    approvals: "two-person",
    authenticate: (req) => {
      const op = cookieOf(req.request.headers.get("cookie"), "op") ?? "alice";
      return { id: op, name: op[0]!.toUpperCase() + op.slice(1) };
    },
    stepUp: {
      verify: (req) => {
        const value = cookieOf(req.request.headers.get("cookie"), "stepped");
        if (value === undefined || used.has(value)) return false;
        used.add(value);
        stepUps++;
        return true;
      },
      challenge: () => "/step-up",
    },
    agents: { allowEphemeralStore: true, artefacts: { dir: artefacts } },
    alerts: {},
  });
  const hook: HookCall[] = [];
  const app = new BunHttpAdapter(0, { logger: noopLogger });
  app.use(api.basePath, api.router);
  app.get("/step-up", (_req, res) => {
    res
      .status(200)
      .set("content-type", "text/html; charset=utf-8")
      .send(STEP_UP_PAGE);
  });
  // A plain page of the host's, to set cookies on before the app loads.
  app.get("/blank", (_req, res) => {
    res
      .status(200)
      .set("content-type", "text/html; charset=utf-8")
      .send("<!doctype html><title>blank</title>");
  });
  app.post("/hook", (req, res) => {
    const headers: Record<string, string> = {};
    req.request.headers.forEach((value, key) => {
      headers[key] = value;
    });
    // bun-common has read the body already: its parsed form is kept.
    hook.push({
      headers,
      body:
        typeof req.body === "string"
          ? req.body
          : JSON.stringify(req.body ?? null),
    });
    res.status(204).send("");
  });
  const ui = createSecurityUi(
    {
      api,
      basePath: "/security",
      title: "Security e2e",
      dev: true,
      logger: noopLogger,
    },
    { entry: DEFAULT_ENTRY },
  );
  app.use(ui.basePath, ui.router);
  const server = await app.listen(0);
  const origin = `http://127.0.0.1:${server.port}`;
  const warm = await fetch(`${origin}/security`);
  if (warm.status !== 200) throw new Error(`the shell answered ${warm.status}`);
  const pageConsole: string[] = [];
  const sizes = options.sizes ?? [[1280, 900]];
  // One view per size: this Chrome has no device-metrics override, so a
  // view keeps the size it was made with.
  const profiles = sizes.map(([width]) =>
    chromeProfile(`security-${label}-${width}`),
  );
  const views = sizes.map(
    ([width, height], index) =>
      new Bun.WebView({
        backend: {
          type: "chrome",
          url: false,
          path: chromePath,
          argv: ["--use-gl=disabled"],
        },
        dataStore: profiles[index]!.dataStore,
        width,
        height,
        console: (type, ...args) => {
          pageConsole.push(`${type}: ${args.map(String).join(" ")}`);
        },
      }),
  );
  let view = views[0]!;
  const waitFor = async (selector: string, text = "", ms = 20_000) => {
    if (!(await view.evaluate<boolean>(waitForScript(selector, ms, text)))) {
      const shown = await view.evaluate<string>(
        "document.querySelector('main')?.textContent?.slice(0, 600) ?? document.body.textContent.slice(0, 600)",
      );
      throw new Error(
        `${selector}${text === "" ? "" : ` with “${text}”`} never appeared at ${view.url}\nshown: ${shown}\nconsole:\n${pageConsole.slice(-20).join("\n")}`,
      );
    }
  };
  const call: Host["call"] = async (
    method,
    path,
    body,
    op = "alice",
    stepped = false,
  ) => {
    const response = await fetch(`${origin}${api.basePath}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        "x-bun-security-csrf": "1",
        cookie: `op=${op}${stepped ? `; stepped=${crypto.randomUUID()}` : ""}`,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    let parsed: unknown = text;
    try {
      parsed = text === "" ? undefined : JSON.parse(text);
    } catch {
      // Not JSON: kept as text.
    }
    return { status: response.status, body: parsed };
  };
  return {
    origin,
    api,
    view: () => view,
    at: (width) => {
      const index = sizes.findIndex(([w]) => w === width);
      if (index === -1) throw new Error(`no view ${width} px wide`);
      view = views[index]!;
    },
    hook,
    stepUps: () => stepUps,
    console: pageConsole,
    call,
    as: async (op) => {
      // Every view has a profile of its own, so each gets the cookie.
      for (const each of views) {
        await each.navigate(`${origin}/blank`);
        await each.evaluate(
          `document.cookie = "op=${op}; path=/; SameSite=Strict"`,
        );
      }
    },
    open: async (path, selector, text) => {
      await view.navigate(`${origin}/security${path}`);
      await waitFor(selector, text);
    },
    waitFor,
    waitGone: async (selector, ms = 20_000) => {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) {
        if (
          (await view.evaluate<number>(
            `document.querySelectorAll(${JSON.stringify(selector)}).length`,
          )) === 0
        )
          return;
        await Bun.sleep(50);
      }
      throw new Error(`${selector} never went at ${view.url}`);
    },
    click: async (selector) => {
      await waitFor(selector);
      // Scrolled to the middle first: a control below the fold is not
      // "actionable" to the view until it is in sight.
      const at = await view.evaluate<{ x: number; y: number }>(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        el.scrollIntoView({ block: "center" });
        const r = el.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      })()`);
      await view.click(at.x, at.y);
    },
    clickButton: async (name, within) => {
      const find = `(() => {
        const roots = ${JSON.stringify(within ?? "")} === "" ? [document] : [...document.querySelectorAll(${JSON.stringify(within ?? "")})];
        for (const root of roots) {
          for (const el of root.querySelectorAll("button, a, [role=button], [role=tab]")) {
            if (el.textContent.trim() !== ${JSON.stringify(name)} && el.getAttribute("aria-label") !== ${JSON.stringify(name)}) continue;
            if (el.disabled) continue;
            el.scrollIntoView({ block: "center" });
            const r = el.getBoundingClientRect();
            return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
          }
        }
        return null;
      })()`;
      const deadline = Date.now() + 20_000;
      let at: { x: number; y: number } | null = null;
      while (at === null && Date.now() < deadline) {
        at = await view.evaluate<{ x: number; y: number } | null>(find);
        if (at === null) await Bun.sleep(50);
      }
      if (at === null) {
        throw new Error(
          `no enabled button “${name}”${within === undefined ? "" : ` in ${within}`} at ${view.url}\nconsole:\n${pageConsole.slice(-20).join("\n")}`,
        );
      }
      await view.click(at.x, at.y);
    },
    fill: async (selector, text) => {
      await waitFor(selector);
      await view.evaluate(
        `(() => { const el = document.querySelector(${JSON.stringify(selector)}); el.focus(); el.select?.(); })()`,
      );
      if (text === "") await view.press("Backspace");
      else await view.type(text);
    },
    pick: async (selector, value) => {
      await waitFor(selector);
      await view.evaluate(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set;
        set.call(el, ${JSON.stringify(value)});
        el.dispatchEvent(new Event("change", { bubbles: true }));
      })()`);
    },
    evaluate: (script) => view.evaluate(script),
    close: async () => {
      for (const each of views) each.close();
      api.live.close();
      for (const profile of profiles) await profile.remove();
      await app.close();
      api.close();
      rmSync(artefacts, { recursive: true, force: true });
    },
  };
}
