/**
 * A thenable-returning Standard Schema through bun-common's `validate()` and
 * its response gate (`variants()`): the router half of the thenable tests.
 * The core's half (`isPromiseLike`, `andThen`, `validateStandard`, the guard
 * receiver) is in `packages/bun-contract/__tests__/thenable.test.ts`.
 */
import type { StandardSchemaV1 } from "../../lib/types/standardSchema";
import type { RouterErrorMiddlewareHandler } from "../../lib/types/general";
import { describe, expect, it } from "bun:test";
import { z } from "zod";
import { BunRouter } from "../../lib/BunRouter";
import { validate } from "../../lib/BunValidate";
import { createTestLogger } from "../../lib/logging";
import { variants } from "../../lib/responseBodies";
import { ResponseValidationError } from "../../lib/responseValidation";

/** What a {@link thenable} settles with. */
type Settle =
  | {
      /** Fulfils with this value. */
      resolve: unknown;
    }
  | {
      /** Rejects with this reason. */
      reject: unknown;
    };

/**
 * A thenable that is not a Promise, settling as `settle` says, a microtask
 * later, and calling only the callbacks it is given (no `catch`, no
 * `finally`).
 */
function thenable(settle: Settle): PromiseLike<unknown> {
  const then = (
    onFulfilled?: (value: unknown) => unknown,
    onRejected?: (reason: unknown) => unknown,
  ): PromiseLike<unknown> =>
    new Promise<void>((resolve) => {
      queueMicrotask(resolve);
    }).then(() => {
      if ("reject" in settle) {
        if (onRejected) return onRejected(settle.reject);
        throw settle.reject as Error;
      }
      return onFulfilled ? onFulfilled(settle.resolve) : settle.resolve;
    });
  return { then } as PromiseLike<unknown>;
}

/** The error a {@link schema} rejects with. */
const BOOM = new Error("the vendor failed");

/**
 * A Standard Schema whose `validate` answers with a non-Promise thenable:
 * `{ x: number }` passes (its value, `x` doubled), anything else resolves to
 * an issue at `["x"]`; `reject` makes every call reject with {@link BOOM}.
 */
function schema(reject = false): StandardSchemaV1<unknown, { x: number }> {
  return {
    "~standard": {
      version: 1,
      vendor: "thenable",
      validate: (value) => {
        if (reject) return thenable({ reject: BOOM }) as never;
        const x = (value as { x?: unknown } | null)?.x;
        return thenable({
          resolve:
            typeof x === "number"
              ? { value: { x: x * 2 } }
              : { issues: [{ message: "x must be a number", path: ["x"] }] },
        }) as never;
      },
    },
  };
}

/** Renders any error as a 500 naming it, and a refused response's issues. */
const render = ((error, _req, res, _next) => {
  res.status(500).json({
    error: error instanceof Error ? error.message : String(error),
    ...(error instanceof ResponseValidationError
      ? { issues: error.issues }
      : {}),
  });
}) satisfies RouterErrorMiddlewareHandler;

/** A router whose `/` validates its JSON body with `body` and echoes `req.body`. */
function bodyRouter(body: StandardSchemaV1): BunRouter {
  const { logger } = createTestLogger();
  const router = new BunRouter({ logger });
  router.post("/", validate({ body }, { onFailure: "respond" }), (req, res) => {
    res.json({ got: req.body });
  });
  router.use(render);
  return router;
}

/** POSTs `body` as JSON to `router`. */
const post = async (router: BunRouter, body: unknown): Promise<Response> =>
  router.fetch("/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("validate() with a thenable-returning vendor", () => {
  it("refuses a thenable resolving to issues with 400 and the issue", async () => {
    const response = await post(bodyRouter(schema()), { x: "no" });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "Validation failed",
      issues: [{ target: "body", path: "x", message: "x must be a number" }],
    });
  });

  it("passes a thenable resolving to a value, handing on the output", async () => {
    const response = await post(bodyRouter(schema()), { x: 5 });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ got: { x: 10 } });
  });

  it("enters the error pipeline when the thenable rejects", async () => {
    const response = await post(bodyRouter(schema(true)), { x: 5 });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: BOOM.message });
  });
});

describe("the response gate with thenables", () => {
  /** A router answering `/` with `body`, its 200 declared as two variants of `content`'s shapes. */
  function gated(body: unknown, when: (() => unknown) | undefined): BunRouter {
    const { logger } = createTestLogger();
    const router = new BunRouter({ logger, responseValidation: "error" });
    router.get(
      "/",
      validate(
        {},
        {
          responses: {
            200: variants({
              a: {
                // `when` is typed `boolean | Promise<boolean>`; a thenable
                // reaches it only past the types (JavaScript, a cast).
                ...(when === undefined ? {} : { when: when as () => boolean }),
                content: { "application/json": schema() },
              },
              b: {
                content: { "application/json": z.object({ y: z.string() }) },
              },
            }),
          },
        },
      ),
      (_req, res) => {
        (res as unknown as { json: (b: unknown) => void }).json(body);
      },
    );
    router.use(render);
    return router;
  }

  it("a variant's thenable schema resolving to issues does not match", async () => {
    // Matched in short mode: before, the thenable read as a pass for `a`.
    const response = await gated({ z: 1 }, undefined).fetch("/");
    expect(response.status).toBe(500);
    const body = (await response.json()) as { issues?: unknown[] };
    expect(body.issues?.length).toBeGreaterThan(0);
  });

  it("a variant's thenable schema resolving to a value matches", async () => {
    const response = await gated({ x: 1 }, undefined).fetch("/");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ x: 1 });
  });

  it("a when answering with a thenable is awaited", async () => {
    const no = await gated({ x: 1 }, () => thenable({ resolve: false })).fetch(
      "/",
    );
    expect(no.status).toBe(500);
    const yes = await gated({ x: 1 }, () => thenable({ resolve: true })).fetch(
      "/",
    );
    expect(yes.status).toBe(200);
  });
});
