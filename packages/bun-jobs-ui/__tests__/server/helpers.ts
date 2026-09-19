/**
 * Shared helpers for the server tests. They build the UI from a tiny fixture
 * entry (`fixtures/app/entry.ts`) rather than the real app, so nothing here
 * depends on what `app/` renders.
 */
import type { JobsUiInternals } from "../../lib/jobsUi";
import type { UiConfig } from "../../lib/shared/config";
import type { JobsUi, JobsUiOptions } from "../../lib/types";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { noopLogger } from "@kingsleyweb/bun-common";
import { createJobsUi } from "../../lib/jobsUi";
import { UI_CONFIG_ELEMENT_ID } from "../../lib/shared/config";

/** The fixture app entry: one stylesheet, one split chunk. */
export const FIXTURE_ENTRY = join(
  import.meta.dir,
  "fixtures",
  "app",
  "entry.ts",
);

/** An entry that fails to build (it imports a module that does not exist). */
export const BROKEN_ENTRY = join(
  import.meta.dir,
  "fixtures",
  "broken",
  "entry.ts",
);

/** A dist directory that never exists, so the in-memory build is used. */
export const NO_DIST = join(import.meta.dir, "fixtures", "no-dist");

/**
 * The UI over the fixture bundle, built in memory. Options default to
 * `apiUrl: "/jobs-api"` and a silent logger.
 */
export function fixtureUi(
  options: Partial<JobsUiOptions> = {},
  internals: JobsUiInternals = {},
): JobsUi {
  const target =
    options.api !== undefined || options.apiUrl !== undefined
      ? {}
      : { apiUrl: "/jobs-api" };
  return createJobsUi(
    { logger: noopLogger, ...target, ...options } as JobsUiOptions,
    { entry: FIXTURE_ENTRY, distDir: NO_DIST, ...internals },
  );
}

/** A fresh temporary directory, removed by the returned cleanup. */
export function tempDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "bun-jobs-ui-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** What a shell page references, pulled out of its HTML. */
export interface ParsedShell {
  /** The `<title>` text, still HTML-escaped. */
  title: string;
  /** The raw text of the config `<script>`. */
  configText: string;
  /** The config, parsed. */
  config: UiConfig;
  /** The config `<script>`'s nonce. */
  configNonce: string;
  /** The module `<script>`: its `src`, `integrity` and `nonce`. */
  script: { src: string; integrity: string; nonce: string };
  /** Every stylesheet `<link>`: `href` and `integrity`. */
  styles: { href: string; integrity: string }[];
  /** The `csp-nonce` meta's nonce. */
  metaNonce: string;
}

/** The value of one attribute in a tag's source, or `""`. */
function attribute(tag: string, name: string): string {
  return new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1] ?? "";
}

/** Parses the parts of a shell page the tests assert on. */
export function parseShell(html: string): ParsedShell {
  const configMatch = new RegExp(
    `(<script type="application/json" id="${UI_CONFIG_ELEMENT_ID}"[^>]*>)([\\s\\S]*?)</script>`,
  ).exec(html);
  if (!configMatch) {
    throw new Error("no config script in the shell");
  }
  const scriptTag = /<script type="module"[^>]*>/.exec(html)?.[0] ?? "";
  const styles = [...html.matchAll(/<link rel="stylesheet"[^>]*>/g)].map(
    ([tag]) => ({
      href: attribute(tag, "href"),
      integrity: attribute(tag, "integrity"),
    }),
  );
  const metaTag = /<meta property="csp-nonce"[^>]*>/.exec(html)?.[0] ?? "";
  return {
    title: /<title>([\s\S]*?)<\/title>/.exec(html)?.[1] ?? "",
    configText: configMatch[2]!,
    config: JSON.parse(configMatch[2]!) as UiConfig,
    configNonce: attribute(configMatch[1]!, "nonce"),
    script: {
      src: attribute(scriptTag, "src"),
      integrity: attribute(scriptTag, "integrity"),
      nonce: attribute(scriptTag, "nonce"),
    },
    styles,
    metaNonce: attribute(metaTag, "nonce"),
  };
}

/** Fetches the shell at `path` and parses it. */
export async function fetchShell(
  target: { fetch: (input: string, init?: RequestInit) => Promise<Response> },
  path: string,
): Promise<{ response: Response; shell: ParsedShell; html: string }> {
  const response = await target.fetch(path);
  const html = await response.text();
  return { response, shell: parseShell(html), html };
}

/** The `script-src` nonce of a CSP header. */
export function cspNonce(csp: string | null): string | undefined {
  return /'nonce-([^']+)'/.exec(csp ?? "")?.[1];
}

/** A CSP header as a map of directive → sources. */
export function parseCsp(csp: string | null): Map<string, string[]> {
  const directives = new Map<string, string[]>();
  for (const part of (csp ?? "").split(";")) {
    const [name, ...sources] = part.trim().split(/\s+/);
    if (name) {
      directives.set(name, sources);
    }
  }
  return directives;
}
