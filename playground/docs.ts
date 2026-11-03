/**
 * The playground's whole-app OpenAPI document, in one place: the
 * `generateOpenApi` options every docs mount shares (`/playground/openapi.json`,
 * `/playground/docs`, `/playground/api-docs`, `/playground/self-hosted-docs`),
 * with the sidebar in sections and subsections — the tags each route's
 * `.describe({ tags })` names, grouped by `tagGroups` into the document's
 * `x-tagGroups`.
 */
import type {
  OpenApiOptions,
  OpenApiResult,
} from "@kingsleyweb/bun-common/lib/docs";
import type { JobsApi } from "@kingsleyweb/bun-jobs";
import { generateOpenApi } from "@kingsleyweb/bun-common/lib/docs";

/**
 * Which routes the playground's whole-app OpenAPI document lists. The
 * playground's own pages and their support routes are `.describe({ hidden:
 * true })`; the viewers' mounts (the jobs UI at `/jobs`, the two `docsUi()`
 * apps) are other packages' routers, so they are dropped here by path.
 */
export function documentedRoute(route: { readonly path: string }): boolean {
  return !["/jobs", "/playground/api-docs", "/playground/ws-docs"].some(
    (prefix) => route.path === prefix || route.path.startsWith(`${prefix}/`),
  );
}

/** The playground's tags: what each subsection of the sidebar covers. */
export const PLAYGROUND_TAGS: NonNullable<OpenApiOptions["tags"]> = {
  "Cached responses": {
    description:
      "Routes behind `cacheResponse()`: X-Cache says HIT, MISS, STALE, BYPASS or UNCACHEABLE, with Age and the build's timing.",
  },
  "Stale serving": {
    description:
      "stale-while-revalidate (one refresh while the stale copy answers) and stale-if-error (the stale copy while the origin fails).",
  },
  Invalidation: {
    description:
      "A successful unsafe request drops what the cache stored for its path (RFC 9111 §4.4).",
  },
  Users: {
    description:
      "The typed client's demo API: users, with errors, ETags and cache tags the generated route map carries.",
  },
  Orgs: { description: "A cached read, keyed by the org's id." },
  "Failure modes": {
    description:
      "Retries with Retry-After, timeouts, an error status, and a body its own schema refuses: what the typed client does with each.",
  },
  "Server-sent events": {
    description:
      "A job's progress as an SSE stream (`sse()` on the validator): named events with ids, a resumed stream replayed after Last-Event-ID, the declared `gap` when it cannot resume.",
  },
  "Chat channel": {
    description:
      "The validated chat channel's HTTP side: a route that publishes into a room with no socket, checked like any send. The channel itself is in the AsyncAPI document.",
  },
  "Class DTOs": {
    description:
      "A class-validator DTO on the query (AD (b2)): the wire's strings arrive converted, and a failing query answers 400 with the issues.",
  },
};

/** The sections over {@link PLAYGROUND_TAGS}, in sidebar order (the jobs API's goes in front). */
export const PLAYGROUND_TAG_GROUPS: NonNullable<OpenApiOptions["tagGroups"]> = [
  {
    name: "Cache lab",
    tags: ["Cached responses", "Stale serving", "Invalidation"],
  },
  {
    name: "Typed client",
    tags: ["Users", "Orgs", "Failure modes", "Server-sent events"],
  },
  { name: "Validation", tags: ["Class DTOs", "Chat channel"] },
];

/** The section the jobs API's tags go in. */
const JOBS_API_SECTION = "Jobs API";

/** What the jobs API's own document is read for: operations and tags. */
interface JobsDocumentLike {
  /** Its paths, by the path template (`/queues/{name}`), then method. */
  paths?: Record<string, Record<string, { tags?: string[] } | undefined>>;
  /** Its tags, in its own order, with their descriptions. */
  tags?: { name: string; description?: string }[];
}

/**
 * The whole-app document: `generateOpenApi` over `app` with the playground's
 * tags and sections. The jobs management API's routes are bun-jobs' and carry
 * no `.describe()`, so `defaultTags` tags them with the tags the API's own
 * document (`api.openapi()`) gives the same operations, as a "Jobs API"
 * section in front. A fresh document per call, so a docs mount always shows
 * the adapter as it is now.
 *
 * @param app The adapter every route is on.
 * @param api The jobs management API mounted on it.
 */
export function playgroundOpenApi(
  app: Parameters<typeof generateOpenApi>[0],
  api: JobsApi,
): OpenApiResult {
  const own = api.openapi() as JobsDocumentLike;
  const prefix = `${api.basePath}/`;
  const jobsTags = new Set<string>();
  for (const item of Object.values(own.paths ?? {})) {
    for (const operation of Object.values(item)) {
      for (const tag of operation?.tags ?? []) jobsTags.add(tag);
    }
  }
  // The API's own tag order and descriptions, for the tags it uses.
  const described = (own.tags ?? []).filter((tag) => jobsTags.has(tag.name));

  return generateOpenApi(app, {
    title: "bun-node playground",
    version: "1.0.0",
    filter: documentedRoute,
    tags: {
      ...Object.fromEntries(
        described.map(({ name, description }) => [
          name,
          description === undefined ? {} : { description },
        ]),
      ),
      ...PLAYGROUND_TAGS,
    },
    tagGroups: [
      { name: JOBS_API_SECTION, tags: described.map((tag) => tag.name) },
      ...PLAYGROUND_TAG_GROUPS,
    ],
    defaultTags: (route) => {
      if (!route.path.startsWith(prefix)) return undefined;
      // `/jobs-api/queues/:name` is the API's `/queues/{name}`.
      const template = route.path
        .slice(api.basePath.length)
        .replace(/:(\w+)/g, "{$1}");
      return own.paths?.[template]?.[route.method.toLowerCase()]?.tags;
    },
  });
}
