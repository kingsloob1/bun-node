/**
 * AD (e), plan §9.1: every generated AsyncAPI document is validated against
 * the official AsyncAPI 3.0.0 schema from `@asyncapi/specs` (a pinned
 * devDependency of bun-common), whose `schemas/3.0.0.json` is a draft-07
 * bundle — compiled with ajv's **draft-07** build, the embedded draft-07
 * `$schema` definition deleted first (ajv already registers it; two schemas
 * under one id are refused, and the built-in one is the same document).
 * bun-jobs' own test (`__tests__/api/api-spec.test.ts`) is the model.
 *
 * The escape hatches are bun-jobs': `BUN_COMMON_TEST_AJV_DIR` /
 * `BUN_COMMON_TEST_ASYNCAPI_DIR` may point at a `node_modules` holding the
 * packages, and where either is absent the suite skips **visibly** rather
 * than failing.
 */
import { describe, expect, it } from "bun:test";
import process from "node:process";
import { z } from "zod";
import { BunRouter } from "../../lib/BunRouter";
import { validate } from "../../lib/BunValidate";
import { BunWebSocket } from "../../lib/BunWebSocket";
import { defineChannel } from "../../lib/channel";
import { sse } from "../../lib/responseBodies";
import type { AsyncApiOptions } from "../../lib/docs/index";
import { danglingRefs, generateAsyncApi } from "../../lib/docs/index";

/** The ajv surface the validation uses. */
interface AjvLike {
  /** Compiles a schema into a validator. */
  compile: (
    schema: unknown,
  ) => ((data: unknown) => boolean) & { errors?: unknown };
}

/** Loads ajv's draft-07 build with formats, and the AsyncAPI 3.0.0 schema, or `undefined` when either is missing. */
async function loadAsyncApiValidator(): Promise<
  ((document: unknown) => { valid: boolean; errors: unknown }) | undefined
> {
  const specRoots = [
    undefined,
    ...(process.env.BUN_COMMON_TEST_ASYNCAPI_DIR
      ? [process.env.BUN_COMMON_TEST_ASYNCAPI_DIR]
      : []),
  ];
  let schemaPath: string | undefined;
  for (const root of specRoots) {
    try {
      schemaPath =
        root === undefined
          ? Bun.resolveSync(
              "@asyncapi/specs/schemas/3.0.0.json",
              import.meta.dir,
            )
          : `${root}/@asyncapi/specs/schemas/3.0.0.json`;
      if (await Bun.file(schemaPath).exists()) {
        break;
      }
      schemaPath = undefined;
    } catch {
      schemaPath = undefined;
    }
  }
  if (schemaPath === undefined) {
    return undefined;
  }
  const ajvRoots = [
    "",
    ...(process.env.BUN_COMMON_TEST_AJV_DIR
      ? [`${process.env.BUN_COMMON_TEST_AJV_DIR}/`]
      : []),
  ];
  for (const root of ajvRoots) {
    try {
      const ajvSpecifier: string = root ? `${root}ajv/dist/ajv.js` : "ajv";
      const formatsSpecifier: string = `${root}ajv-formats${root ? "/dist/index.js" : ""}`;
      const ajvModule = (await import(ajvSpecifier)) as { default?: unknown };
      const formatsModule = (await import(formatsSpecifier)) as {
        default?: unknown;
      };
      const Ajv = (ajvModule.default ?? ajvModule) as new (
        options: object,
      ) => AjvLike;
      const addFormats = (formatsModule.default ?? formatsModule) as (
        ajv: AjvLike,
      ) => void;
      const draft07 = new Ajv({ strict: false, allErrors: true });
      addFormats(draft07);
      const schema = (await Bun.file(schemaPath).json()) as {
        definitions: Record<string, unknown>;
      };
      // The bundle embeds the draft-07 meta-schema under its own `$id`, which
      // ajv already registers; two schemas under one id is refused, and the
      // built-in one is the same document. (Dropped rather than asserted: this
      // runs at import time, where a failed assertion would fail the file
      // instead of a test.)
      delete schema.definitions["http://json-schema.org/draft-07/schema"];
      const validateDocument = draft07.compile(schema);
      return (document) => {
        const valid = validateDocument(document);
        return { valid, errors: valid ? undefined : validateDocument.errors };
      };
    } catch {
      // Not installed here; try the next root.
    }
  }
  return undefined;
}

const validateAsyncApi = await loadAsyncApiValidator();

/* ------------------------------------------------------------------ *
 * The matrix's sources: one per channel kind, crossed with security.
 * ------------------------------------------------------------------ */

/** A full contract channel plus its SSE fallback (warning-free). */
function contractRouter(): BunRouter {
  const router = new BunRouter();
  const socket = new BunWebSocket({
    newInstance: false,
    getServer: () => undefined,
    router,
  });
  void socket;
  const chat = defineChannel({
    path: "/rooms/:room",
    request: {
      params: z.object({ room: z.string().regex(/^[a-z][a-z0-9-]*$/) }),
      query: z.object({ name: z.string().optional() }),
    },
    receives: { say: z.object({ text: z.string() }), typing: null },
    sends: { said: z.object({ by: z.string(), text: z.string() }) },
    replies: { say: "said" },
    subprotocol: "chat.v1",
    topics: ["rooms"],
    fallback: "/rooms/:room/events",
    meta: { name: "chat", description: "A validated chat room" },
  });
  router.ws(chat.path, chat.checks(), chat.handler({}), chat.options());
  router.get(
    "/rooms/:room/events",
    validate(
      {},
      {
        responses: {
          200: {
            content: {
              "text/event-stream": sse({ said: z.object({ by: z.string() }) }),
            },
          },
        },
      },
    ),
    (_req, res) => res.send(new ReadableStream()),
  );
  return router;
}

/** A bare `ws()` route enriched with `describeChannel()`. */
function enrichedRouter(): BunRouter {
  const router = new BunRouter();
  const socket = new BunWebSocket({
    newInstance: false,
    getServer: () => undefined,
    router,
  });
  router.ws("/raw/:id", { message(_ws, _message) {} });
  socket.describeChannel("/raw/:id", {
    title: "Raw socket",
    subprotocol: "raw.v1",
    receives: {
      ping: {
        payload: z.object({ t: z.number() }),
        reply: "pong",
        examples: { one: { t: 1 } },
      },
    },
    sends: { pong: { payload: z.object({ t: z.number() }) } },
  });
  return router;
}

/** No socket at all: the empty document. */
function emptyRouter(): BunRouter {
  const router = new BunRouter();
  router.get("/ping", (_req, res) => res.json({ ok: true }));
  return router;
}

const SOURCES: Record<string, () => BunRouter> = {
  "contract channel + SSE fallback": contractRouter,
  "describeChannel-enriched bare route": enrichedRouter,
  "no channels": emptyRouter,
};

const SECURITY: Record<string, Pick<AsyncApiOptions, "securitySchemes">> = {
  none: {},
  bearer: {
    securitySchemes: { bearer: { type: "http", scheme: "bearer" } },
  },
};

const MATRIX = Object.keys(SOURCES).flatMap((cell) =>
  Object.keys(SECURITY).map((security) => ({
    name: `${cell}, security ${security}`,
    cell,
    security,
  })),
);

/** The result for one matrix cell (lenient; every cell is warning-free). */
function documentFor(cell: string, security: string) {
  return generateAsyncApi(SOURCES[cell](), {
    title: "Matrix",
    version: "1.0.0",
    ...SECURITY[security],
  });
}

describe("the generator across the AsyncAPI matrix", () => {
  it("no warnings in any cell, and strict agrees (every cell is warning-free)", () => {
    for (const { name, cell, security } of MATRIX) {
      const { warnings } = documentFor(cell, security);
      expect({ name, warnings }).toEqual({ name, warnings: [] });
      expect(() =>
        generateAsyncApi(SOURCES[cell](), {
          title: "Matrix",
          version: "1.0.0",
          strict: "strict",
          ...SECURITY[security],
        }),
      ).not.toThrow();
    }
  });

  it("no dangling $refs in any cell", () => {
    for (const { name, cell, security } of MATRIX) {
      const { document } = documentFor(cell, security);
      expect({ name, dangling: danglingRefs(document) }).toEqual({
        name,
        dangling: [],
      });
    }
  });

  it("deterministic: two calls deep-equal in every cell", () => {
    for (const { name, cell, security } of MATRIX) {
      const first = documentFor(cell, security);
      const second = documentFor(cell, security);
      expect({ name, equal: true }).toEqual({
        name,
        equal:
          JSON.stringify(first.document) === JSON.stringify(second.document),
      });
    }
  });
});

describe.skipIf(!validateAsyncApi)(
  "AsyncAPI 3.0.0 meta-schema validation (@asyncapi/specs)",
  // eslint-disable-next-line @typescript-eslint/no-misused-promises -- bun:test awaits an async describe callback
  async () => {
    // `describe.skipIf` skips the cases, not the callback: without this the
    // body below still runs and `validateAsyncApi!` fails where the
    // devDependency is absent, failing the file instead of skipping it.
    if (!validateAsyncApi) {
      return;
    }
    for (const { name, cell, security } of MATRIX) {
      it(`is a valid AsyncAPI 3.0.0 document: ${name}`, () => {
        const { document } = documentFor(cell, security);
        expect(validateAsyncApi(document)).toEqual({
          valid: true,
          errors: undefined,
        });
      });
    }

    it("rejects a broken document (the control)", () => {
      const { document } = documentFor("no channels", "none");
      delete (document.info as { version?: string }).version;
      expect(validateAsyncApi(document).valid).toBe(false);
    });
  },
);
