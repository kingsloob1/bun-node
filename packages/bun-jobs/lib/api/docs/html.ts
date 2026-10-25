/**
 * The two HTML viewer pages.
 *
 * The pages themselves moved to bun-common in AD (c) (plan
 * `docs/plans/api-docs-generation/` §6.1, `lib/docs/viewer.ts`); this shim
 * keeps the jobs-shaped call sites (`DocsPageContext` carries the resolved
 * config) and the two things that are this API's own: the title default
 * (`bun-jobs management API (<namespace>)`) and the CSRF header line, passed
 * on as the moved pages' `requestHeaders`.
 *
 * Each page is generated per request, because each carries a fresh nonce: the
 * Content Security Policy allows exactly one inline script (the initialiser)
 * and the pinned CDN's origin, so neither an injected script tag nor a
 * substituted bundle can run. Everything else is denied — `default-src 'none'`
 * — and the page can only talk to its own origin.
 *
 * The pages are off by default (`docs.ui`), because they put third-party
 * script into an origin holding admin cookies and because "try it out" is a
 * mutation console. The JSON documents need none of this and are always there.
 */
import type { ResolvedJobsApiConfig } from "../config";
import type { ResolvedDocsCdn } from "./cdn";
import type { DocsPage } from "@kingsleyweb/bun-common/lib/docs/viewer";
import {
  asyncApiUiPage as asyncApiUiPageBase,
  swaggerUiPage as swaggerUiPageBase,
} from "@kingsleyweb/bun-common/lib/docs/viewer";

export {
  docsPageHeaders,
  type DocsPage,
} from "@kingsleyweb/bun-common/lib/docs/viewer";

/** What a page needs to know about the API it documents. */
export interface DocsPageContext {
  /** The resolved configuration. */
  config: ResolvedJobsApiConfig;
  /** The assets to load. */
  cdn: ResolvedDocsCdn;
}

/** The API's title, for the pages. */
function title(config: ResolvedJobsApiConfig): string {
  const docs = config.docs === false ? undefined : config.docs;
  return docs?.title ?? `bun-jobs management API (${config.namespace})`;
}

/**
 * The Swagger UI page for the OpenAPI document.
 *
 * Its `requestInterceptor` sends same-origin credentials (the admin session is
 * usually a cookie) and adds the CSRF header when one is configured, so "try
 * it out" can reach mutating routes the CSRF guard would otherwise refuse.
 */
export function swaggerUiPage(context: DocsPageContext): DocsPage {
  const { config, cdn } = context;
  const documentUrl = `${config.basePath}${
    config.docs === false ? "/openapi.json" : config.docs.openapiPath
  }`;
  const csrfHeader = config.csrf === false ? undefined : config.csrf.header;
  return swaggerUiPageBase({
    cdn,
    title: title(config),
    documentUrl,
    ...(typeof csrfHeader === "string"
      ? { requestHeaders: { [csrfHeader]: "1" } }
      : {}),
  });
}

/** The AsyncAPI viewer page for the live-events document. */
export function asyncApiUiPage(context: DocsPageContext): DocsPage {
  const { config, cdn } = context;
  const documentUrl = `${config.basePath}${
    config.docs === false ? "/asyncapi.json" : config.docs.asyncapiPath
  }`;
  return asyncApiUiPageBase({ cdn, title: title(config), documentUrl });
}
