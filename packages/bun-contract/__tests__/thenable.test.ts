/**
 * A Standard Schema (or a hook) answering with a thenable that is not a
 * native `Promise`: the core reads any object or function with a callable
 * `then` as async, adopts it with `Promise.resolve()`, and so refuses the
 * issues it resolves to, passes the value, and fails as for a rejected
 * Promise when it rejects. Before, `instanceof Promise` read the thenable as
 * a settled result with no `issues`: a pass.
 */
import type { StandardSchemaV1 } from "../lib/standardSchema";
import { describe, expect, it } from "bun:test";
import { z } from "zod";
import { ContractError, createReceiver } from "../lib/guard";
import { andThen, validateStandard } from "../lib/issues";
import { isPromiseLike } from "../lib/model";
import { recordOf } from "../lib/schemas";
import { broker } from "./fixtures";

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

describe("isPromiseLike", () => {
  it("is true for a Promise and any object or function with a callable then", () => {
    const fn = Object.assign(() => 1, { then: () => undefined });
    expect(isPromiseLike(Promise.resolve(1))).toBe(true);
    expect(isPromiseLike(thenable({ resolve: 1 }))).toBe(true);
    expect(isPromiseLike(fn)).toBe(true);
    for (const not of [null, undefined, 1, "then", { then: 1 }, {}, []]) {
      expect(isPromiseLike(not)).toBe(false);
    }
  });
});

describe("andThen adopts a thenable", () => {
  it("chains it as a Promise", async () => {
    const later = andThen(
      thenable({ resolve: 2 }) as never,
      (x: number) => x * 3,
    );
    expect(later).toBeInstanceOf(Promise);
    expect(await later).toBe(6);
  });
});

describe("validateStandard with a thenable-returning vendor", () => {
  it("refuses a thenable resolving to issues, with the issue", async () => {
    const out = validateStandard(schema(), { x: "nope" }, "body");
    expect(out).toBeInstanceOf(Promise);
    expect(await out).toEqual({
      ok: false,
      issues: [{ target: "body", path: "x", message: "x must be a number" }],
    });
  });

  it("passes a thenable resolving to a value, with the vendor's output", async () => {
    expect(await validateStandard(schema(), { x: 2 }, "body")).toEqual({
      ok: true,
      value: { x: 4 },
    });
  });

  it("rejects as for a rejected Promise when the thenable rejects", async () => {
    const out = validateStandard(schema(true), { x: 2 }, "body");
    expect(out).toBeInstanceOf(Promise);
    await expect(out).rejects.toBe(BOOM);
  });

  it("refuses through recordOf when a member answers with a thenable", async () => {
    const record = recordOf({ a: schema(), b: z.number() });
    expect(
      await validateStandard(record, { a: { x: "no" }, b: 1 }, "data"),
    ).toEqual({
      ok: false,
      issues: [{ target: "data", path: "a.x", message: "x must be a number" }],
    });
    expect(
      await validateStandard(record, { a: { x: 1 }, b: 1 }, "data"),
    ).toEqual({
      ok: true,
      value: { a: { x: 2 }, b: 1 },
    });
  });
});

describe("a guard receiver with a thenable-returning vendor", () => {
  const c = broker.contract({ inbound: { t: { payload: schema() } } });
  const failing = broker.contract({
    inbound: { t: { payload: schema(true) } },
  });

  it("refuses a thenable resolving to issues with a ContractError", async () => {
    const r = createReceiver(
      c,
      "inbound",
    )({ topic: "t", payload: { x: "no" } });
    expect(r).toBeInstanceOf(Promise);
    const settled = await r;
    expect(settled).toBeInstanceOf(ContractError);
    expect((settled as ContractError).issues).toEqual([
      { target: "payload", path: "x", message: "x must be a number", key: "t" },
    ]);
  });

  it("hands on the vendor's output for a thenable resolving to a value", async () => {
    expect<unknown>(
      await createReceiver(c, "inbound")({ topic: "t", payload: { x: 3 } }),
    ).toEqual({ topic: "t", payload: { x: 6 } });
  });

  it("rejects when the thenable rejects", async () => {
    const r = createReceiver(
      failing,
      "inbound",
    )({ topic: "t", payload: { x: 3 } });
    expect(r).toBeInstanceOf(Promise);
    await expect(r).rejects.toBe(BOOM);
  });
});
