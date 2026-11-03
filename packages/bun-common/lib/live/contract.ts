/**
 * The live channel's contract (typed-client plan `websocket.md` §9, TC D15,
 * PR-W4): the browser-safe half of live invalidation. A client subscribes to
 * cache tags and is told when one is invalidated, so it refetches the queries
 * filed under it; the server half is `./server.ts` (`liveInvalidation`,
 * `publishTags`).
 *
 * The frames, on `/__live` (bun-common's `{ type, id?, data }` envelope):
 *
 * - client → server: `subscribe { tags }` and `unsubscribe { tags }` (the
 *   tags to add or drop), `resume { epoch, seq }` (the cursor the client
 *   kept, sent after a reconnect once it has subscribed again: what it
 *   missed is replayed for the tags it holds); `subscribe` and `resume` are
 *   answered with `hello`.
 * - server → client: `hello { epoch, seq }` (where the server is now),
 *   `invalidate { tags, seq, epoch }` (each invalidation is numbered by a
 *   per-process `seq`; a frame carries one of the invalidation's tags the
 *   socket subscribed to, so one invalidation may arrive as several frames
 *   with the same `seq`), and `gap { epoch, seq }` (the server cannot replay
 *   what the client missed: its epoch changed, or the cursor fell off the
 *   replay ring; the client invalidates everything).
 *
 * The SSE fallback (`/__live/sse`, the contract's `fallback`) carries the
 * same `hello`, `invalidate` and `gap` as events, each with the id
 * `<epoch>:<seq>`, so `Last-Event-ID` is the cursor; its tags are the
 * request's `tag` query values.
 *
 * Nothing here imports a Bun or Node API or bun-common's server code: only
 * the contract core (`@kingsleyweb/bun-contract`), so a browser client can
 * bundle it.
 */
import type { StandardSchemaV1 } from "../types/standardSchema";
import { channelContract } from "../contract/channel";

/** The most tags one `subscribe`, `unsubscribe` or `invalidate` frame carries. */
export const LIVE_MAX_TAGS = 256;

/** The longest tag accepted, in characters. */
export const LIVE_MAX_TAG_LENGTH = 512;

/** One issue, at `path`. */
interface Issue {
  /** What is wrong. */
  readonly message: string;
  /** Where (property names). */
  readonly path?: readonly PropertyKey[];
}

/** A checking Standard Schema carrying its JSON Schema (for the documents). */
type LiveSchema<T> = StandardSchemaV1<T, T> & {
  /** The Standard Schema properties, with the JSON Schema converter. */
  readonly "~standard": StandardSchemaV1.Props<T, T> & {
    /** The JSON Schema converter (Standard JSON Schema), the same both ways. */
    readonly jsonSchema: {
      /** The JSON Schema of what it accepts. */
      readonly input: () => Record<string, unknown>;
      /** The JSON Schema of what it produces. */
      readonly output: () => Record<string, unknown>;
    };
  };
};

/**
 * A synchronous schema from a check and a JSON Schema: `check` answers the
 * issues (none: valid), the value passing through unchanged.
 */
function liveSchema<T>(
  check: (value: Record<string, unknown>) => Issue[],
  json: Record<string, unknown>,
): LiveSchema<T> {
  const copy = (): Record<string, unknown> =>
    JSON.parse(JSON.stringify(json)) as Record<string, unknown>;
  return {
    "~standard": {
      version: 1,
      vendor: "bun-common/live",
      validate: (value: unknown) => {
        if (typeof value !== "object" || value === null || Array.isArray(value))
          return { issues: [{ message: "Expected an object" }] };
        const issues = check(value as Record<string, unknown>);
        return issues.length > 0 ? { issues } : { value: value as T };
      },
      jsonSchema: { input: copy, output: copy },
    },
  };
}

/** The issues of a `tags` field: a non-empty array of non-empty strings, within the limits. */
function tagIssues(tags: unknown): Issue[] {
  if (!Array.isArray(tags) || tags.length === 0)
    return [{ message: "Expected a non-empty array of tags", path: ["tags"] }];
  if (tags.length > LIVE_MAX_TAGS)
    return [
      {
        message: `At most ${LIVE_MAX_TAGS} tags in one frame`,
        path: ["tags"],
      },
    ];
  const issues: Issue[] = [];
  tags.forEach((tag: unknown, index) => {
    if (
      typeof tag !== "string" ||
      tag.length === 0 ||
      tag.length > LIVE_MAX_TAG_LENGTH
    )
      issues.push({
        message: `Expected a tag: a string of 1 to ${LIVE_MAX_TAG_LENGTH} characters`,
        path: ["tags", index],
      });
  });
  return issues;
}

/** The issues of a cursor's fields (`epoch`, `seq`). */
function cursorIssues(value: Record<string, unknown>): Issue[] {
  const issues: Issue[] = [];
  if (typeof value.epoch !== "string" || value.epoch.length === 0)
    issues.push({ message: "Expected the epoch, a string", path: ["epoch"] });
  if (
    typeof value.seq !== "number" ||
    !Number.isSafeInteger(value.seq) ||
    value.seq < 0
  )
    issues.push({
      message: "Expected the sequence number, a whole number from 0",
      path: ["seq"],
    });
  return issues;
}

/** The JSON Schema of a `tags` field. */
const TAGS_JSON = {
  type: "array",
  minItems: 1,
  maxItems: LIVE_MAX_TAGS,
  items: { type: "string", minLength: 1, maxLength: LIVE_MAX_TAG_LENGTH },
} as const;

/** The JSON Schema of a cursor's fields. */
const CURSOR_PROPERTIES = {
  epoch: {
    type: "string",
    minLength: 1,
    description: "The server process's epoch: random per process",
  },
  seq: {
    type: "integer",
    minimum: 0,
    description: "The last invalidation's sequence number in that epoch",
  },
} as const;

/** `subscribe` and `unsubscribe`'s data: the tags to add or drop. */
export interface LiveTags {
  /** The tags (1 to 256, each 1 to 512 characters). */
  tags: string[];
}

/** A position in the server's invalidations: `resume`'s data, and `hello`'s and `gap`'s. */
export interface LiveCursor {
  /** The server process's epoch (random per process). */
  epoch: string;
  /** The last invalidation's sequence number in that epoch (`0` before any). */
  seq: number;
}

/** `invalidate`'s data: tags one invalidation hit, its number and epoch. */
export interface LiveInvalidate extends LiveCursor {
  /** The invalidated tags (those of the invalidation this socket subscribed to). */
  tags: string[];
}

/** The tags of a `subscribe` or `unsubscribe`. */
const Tags = liveSchema<LiveTags>((value) => tagIssues(value.tags), {
  type: "object",
  properties: { tags: TAGS_JSON },
  required: ["tags"],
});

/** A cursor: `resume`'s data, `hello`'s and `gap`'s. */
const Cursor = liveSchema<LiveCursor>(cursorIssues, {
  type: "object",
  properties: CURSOR_PROPERTIES,
  required: ["epoch", "seq"],
});

/** An invalidation. */
const Invalidate = liveSchema<LiveInvalidate>(
  (value) => [...tagIssues(value.tags), ...cursorIssues(value)],
  {
    type: "object",
    properties: { tags: TAGS_JSON, ...CURSOR_PROPERTIES },
    required: ["tags", "epoch", "seq"],
  },
);

/**
 * The live channel's contract (`websocket.md` §9): a `channelContract()`,
 * so `defineChannel(liveContract)` serves it and a browser client can type a
 * `channel(api, liveContract)` from it. Served by `liveInvalidation()` at
 * `/__live`, with its SSE fallback at `/__live/sse`.
 */
export const liveContract = channelContract({
  path: "/__live",
  receives: { subscribe: Tags, unsubscribe: Tags, resume: Cursor },
  sends: { invalidate: Invalidate, gap: Cursor, hello: Cursor },
  replies: { subscribe: "hello", resume: "hello" },
  fallback: "/__live/sse",
  meta: {
    name: "live",
    description:
      "Live invalidation: subscribe to cache tags, and hear when one is invalidated, to refetch what is filed under it.",
  },
});
