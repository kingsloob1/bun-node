/**
 * The playground's whole-app OpenAPI document, in one place: the
 * `generateOpenApi` options every docs mount shares (`/playground/openapi.json`,
 * `/playground/docs`, `/playground/api-docs`, `/playground/self-hosted-docs`),
 * with the sidebar in sections and subsections — the tags each route's
 * `.describe({ tags })` names, grouped by `tagGroups` into the document's
 * `x-tagGroups`.
 *
 * The jobs management API's routes are bun-jobs' and carry no `.describe()`,
 * so the generator sees them untagged. Their tags come from the API's own
 * document (`api.openapi()`, which tags every operation), copied onto the
 * same operations here, as a "Jobs API" section in front. bun-common has no
 * router- or mount-level default tag that would do this at generation.
 */
import type {
  DocWarning,
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

/** An operation, as far as the tag copy reads one. */
interface OperationLike {
  /** Its tags. */
  tags?: string[];
  /** The listing's key, `"GET /jobs-api/meta"`. */
  "x-bun-route-key"?: string;
}

/**
 * The whole-app document: `generateOpenApi` over `app` with the playground's
 * tags and sections, then the jobs API's operations tagged from its own
 * document. A fresh document per call, so a docs mount always shows the
 * adapter as it is now.
 *
 * @param app The adapter every route is on.
 * @param api The jobs management API mounted on it.
 */
export function playgroundOpenApi(
  app: Parameters<typeof generateOpenApi>[0],
  api: JobsApi,
): OpenApiResult {
  const { document, warnings } = generateOpenApi(app, {
    title: "bun-node playground",
    version: "1.0.0",
    filter: documentedRoute,
    tags: PLAYGROUND_TAGS,
    tagGroups: PLAYGROUND_TAG_GROUPS,
  });

  const own = api.openapi();
  const ownPaths = (own.paths ?? {}) as Record<
    string,
    Record<string, OperationLike>
  >;
  const paths = (document.paths ?? {}) as Record<
    string,
    Record<string, OperationLike>
  >;
  const tagged = new Set<string>();
  const used = new Set<string>();
  for (const [path, item] of Object.entries(paths)) {
    if (!path.startsWith(`${api.basePath}/`)) continue;
    const ownItem = ownPaths[path.slice(api.basePath.length)];
    for (const [method, operation] of Object.entries(item)) {
      const tags = ownItem?.[method]?.tags;
      if (typeof operation !== "object" || tags === undefined) continue;
      if (tags.length === 0) continue;
      operation.tags = [...tags];
      for (const tag of tags) used.add(tag);
      const key = operation["x-bun-route-key"];
      if (key !== undefined) tagged.add(key);
    }
  }
  // The API's own tag order and descriptions, for the tags copied.
  const jobsTags = ((own.tags ?? []) as { name: string }[]).filter((tag) =>
    used.has(tag.name),
  );
  if (jobsTags.length > 0) {
    document.tags = [...jobsTags, ...((document.tags ?? []) as unknown[])];
    document["x-tagGroups"] = [
      { name: JOBS_API_SECTION, tags: jobsTags.map((tag) => tag.name) },
      ...((document["x-tagGroups"] ?? []) as unknown[]),
    ];
  }
  return {
    document,
    // The generator warned that these were untagged; they are not now.
    warnings: warnings.filter(
      (warning: DocWarning) =>
        !(
          warning.route !== undefined &&
          tagged.has(warning.route) &&
          warning.message.startsWith("the operation has no tag")
        ),
    ),
  };
}
