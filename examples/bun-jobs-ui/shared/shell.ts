import type { UiConfig } from "@kingsleyweb/bun-jobs-ui";
import { UI_CONFIG_ELEMENT_ID } from "@kingsleyweb/bun-jobs-ui";

/**
 * Reading the HTML shell `jobsUi()` serves, the way a test would.
 *
 * The shell is one fixed page per mount. Everything the React app needs is in
 * it: the configuration as a `<script type="application/json">`, one module
 * `<script>` and zero or more stylesheet `<link>`s, all under the same
 * per-request nonce. These helpers pull those parts out with plain regular
 * expressions — no DOM needed — so an example can assert on them.
 *
 * ```ts
 * const response = await app.fetch("/jobs/queues/mail");
 * const shell = parseShell(await response.text());
 * shell.config.apiBase;   // "/jobs-api"
 * shell.script.src;       // "/jobs/assets/main-<hash>.js"
 * ```
 */

/** What a shell page references, pulled out of its HTML. */
export interface ParsedShell {
  /** The whole page. */
  html: string;
  /** The `<title>` text, still HTML-escaped. */
  title: string;
  /** The configuration the page hands the app, parsed. */
  config: UiConfig;
  /** The nonce on the configuration `<script>`. */
  configNonce: string;
  /** The module `<script>`: its `src`, SRI `integrity` and `nonce`. */
  script: { src: string; integrity: string; nonce: string };
  /** Every stylesheet `<link>`: its `href` and SRI `integrity`. */
  styles: { href: string; integrity: string }[];
}

/** The value of one attribute in a tag's source, or `""`. */
function attribute(tag: string, name: string): string {
  return new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1] ?? "";
}

/**
 * Pulls the configuration, the module script and the stylesheets out of a
 * shell page. Throws, naming the missing part, when the page is not a shell.
 */
export function parseShell(html: string): ParsedShell {
  // The configuration element: `id` is the exported UI_CONFIG_ELEMENT_ID.
  const configMatch = new RegExp(
    `(<script type="application/json" id="${UI_CONFIG_ELEMENT_ID}"[^>]*>)([\\s\\S]*?)</script>`,
  ).exec(html);
  if (!configMatch) {
    throw new Error("not a shell: no configuration <script>");
  }

  const scriptTag = /<script type="module"[^>]*>/.exec(html)?.[0];
  if (!scriptTag) {
    throw new Error("not a shell: no module <script>");
  }

  return {
    html,
    title: /<title>([\s\S]*?)<\/title>/.exec(html)?.[1] ?? "",
    config: JSON.parse(configMatch[2]!) as UiConfig,
    configNonce: attribute(configMatch[1]!, "nonce"),
    script: {
      src: attribute(scriptTag, "src"),
      integrity: attribute(scriptTag, "integrity"),
      nonce: attribute(scriptTag, "nonce"),
    },
    styles: [...html.matchAll(/<link rel="stylesheet"[^>]*>/g)].map(
      ([tag]) => ({
        href: attribute(tag, "href"),
        integrity: attribute(tag, "integrity"),
      }),
    ),
  };
}

/** Something that answers a request without a socket: an adapter or a router. */
export interface Fetches {
  /** Runs one request through the real pipeline. */
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
}

/** Fetches `path` and parses the shell it answers with. */
export async function fetchShell(
  app: Fetches,
  path: string,
  init?: RequestInit,
): Promise<{ response: Response; shell: ParsedShell }> {
  const response = await app.fetch(path, init);
  return { response, shell: parseShell(await response.text()) };
}

/**
 * The directives of a `Content-Security-Policy` header, by name.
 *
 * `"script-src 'self' 'nonce-abc'"` becomes `{ "script-src": ["'self'", "'nonce-abc'"] }`.
 */
export function cspDirectives(header: string | null): Record<string, string[]> {
  const directives: Record<string, string[]> = {};
  for (const part of (header ?? "").split(";")) {
    const [name, ...sources] = part.trim().split(/\s+/);
    if (name) {
      directives[name] = sources;
    }
  }
  return directives;
}
