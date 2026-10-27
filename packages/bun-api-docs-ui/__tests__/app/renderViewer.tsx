import type { FetchLike } from "../../app/api/client";
import type { SpecDocument } from "../../app/api/docs";
import type { DocsUiConfig } from "../../lib/shared/config";
import { App } from "../../app/App";
import { createQueryClient } from "../../app/queryClient";
import { DEFAULT_EXTENSION_PREFIXES } from "../../lib/shared/config";
import { render, visit } from "./dom";

/**
 * Renders the whole viewer (the real `App`) against an injected `fetch`: the
 * document URL answers `document`, anything else answers `canned` (a try-it
 * send) or a 404 problem. Every call is recorded.
 */

/** Options of {@link renderViewer}. */
export interface RenderViewerOptions {
  /** The document served at `config.documentUrl`. */
  document: SpecDocument;
  /** The app's path to land on, relative to the mount (`""` is `/`). */
  path?: string;
  /** Config overrides. */
  config?: Partial<DocsUiConfig>;
  /** Answers the try-it panel's sends (a status and a JSON body). */
  canned?: { status?: number; body?: unknown };
  /** The document fetch fails with this status the first time (a retry test). */
  documentError?: { status: number };
}

/** What one fetch call asked for. */
export interface ViewerCall {
  /** The method. */
  method: string;
  /** The URL as requested. */
  url: string;
  /** The headers, lower-cased. */
  headers: Record<string, string>;
  /** The parsed JSON body, when there was one. */
  body?: unknown;
}

/** The viewer's config for a test. */
export function viewerConfig(
  overrides: Partial<DocsUiConfig> = {},
): DocsUiConfig {
  return {
    version: 1,
    title: "API docs",
    basePath: "/docs",
    assetsPath: "/docs/assets",
    documentUrl: "/docs/document.json",
    csrfHeader: null,
    extensions: DEFAULT_EXTENSION_PREFIXES,
    theme: "system",
    ...overrides,
  };
}

/** Renders the viewer at `<basePath><path>`, serving `document`; the fetch calls made. */
export async function renderViewer(options: RenderViewerOptions) {
  const config = viewerConfig(options.config);
  const calls: ViewerCall[] = [];
  let documentFailed = false;
  const fetcher: FetchLike = async (input, init) => {
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(init.headers ?? {})) {
      headers[name.toLowerCase()] = String(value);
    }
    calls.push({
      method: init.method ?? "GET",
      url: input,
      headers,
      body:
        typeof init.body === "string"
          ? (JSON.parse(init.body) as unknown)
          : undefined,
    });
    if (input === config.documentUrl && (init.method ?? "GET") === "GET") {
      if (options.documentError && !documentFailed) {
        documentFailed = true;
        return new Response(
          JSON.stringify({
            type: "urn:test:error:UNAVAILABLE",
            title: "Unavailable",
            status: options.documentError.status,
            code: "UNAVAILABLE",
          }),
          {
            status: options.documentError.status,
            headers: { "Content-Type": "application/problem+json" },
          },
        );
      }
      return new Response(JSON.stringify(options.document), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (options.canned) {
      return new Response(JSON.stringify(options.canned.body ?? { ok: true }), {
        status: options.canned.status ?? 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(
      JSON.stringify({
        type: "urn:test:error:NOT_FOUND",
        title: "Not found",
        status: 404,
        code: "NOT_FOUND",
      }),
      { status: 404, headers: { "Content-Type": "application/problem+json" } },
    );
  };
  visit(`${config.basePath}${options.path ?? ""}`);
  return {
    ...render(
      <App
        config={config}
        queryClient={createQueryClient({ retry: false })}
        fetch={fetcher}
      />,
    ),
    calls,
    config,
  };
}
