/**
 * `validate({ unknownKeys })`: the keys of `body` and `query` that a schema
 * dropped (zod's `z.object()` strips undeclared keys without a word), found
 * by comparing input and output, then left alone (`"strip"`), logged
 * (`"warn"`) or refused (`"reject"`). Also the comparison itself,
 * bun-contract's `droppedKeys`.
 */
import { droppedKeys } from "@kingsleyweb/bun-contract/lib/unknownKeys";
import { describe, expect, it } from "bun:test";
import * as v from "valibot";
import { z } from "zod";
import { BunHttpAdapter } from "../lib/BunHttpAdapter";
import { BunRouter } from "../lib/BunRouter";
import { validate } from "../lib/BunValidate";
import { createTestLogger } from "../lib/logging";

const User = z.object({
  name: z.string(),
  address: z.object({ city: z.string() }),
  tags: z.array(z.object({ id: z.number() })).optional(),
});

/** A router with `POST /u` validating its body with `User`, echoing what the handler saw. */
function app(
  options: {
    unknownKeys?: "strip" | "warn" | "reject";
    redactPaths?: boolean;
  } = {},
) {
  const { logger, events } = createTestLogger();
  const router = new BunRouter({ logger });
  router.post(
    "/u",
    validate({ body: User }, { onFailure: "respond", ...options }),
    (req, res) => res.json(req.body),
  );
  const post = (body: unknown) =>
    router.fetch("/u", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  return { router, post, events };
}

const SENT = {
  name: "ada",
  role: "admin",
  address: { city: "Lagos", zip: "100001" },
  tags: [{ id: 1, colour: "red" }],
};

describe("droppedKeys", () => {
  it("finds the keys the output lost, at any depth, and nothing else", () => {
    const out = User.parse(SENT);
    expect(droppedKeys(SENT, out)).toEqual([
      "role",
      "address.zip",
      "tags.0.colour",
    ]);
    // `.loose()` keeps the top level's: only the nested objects drop.
    expect(droppedKeys(SENT, User.loose().parse(SENT))).toEqual([
      "address.zip",
      "tags.0.colour",
    ]);
    // Negative controls: a copy, or the input itself, drops nothing.
    expect(droppedKeys(SENT, structuredClone(SENT))).toEqual([]);
    expect(droppedKeys(SENT, SENT)).toEqual([]);
  });

  it("does not look into values the schema replaced, and stops at the limit", () => {
    // A transform to a Date, or a string, is not a dropped key.
    expect(droppedKeys({ at: { y: 1 } }, { at: new Date(0) })).toEqual([]);
    expect(droppedKeys({ n: "1" }, { n: 1 })).toEqual([]);
    const wide = Object.fromEntries(
      Array.from({ length: 100 }, (_, i) => [`k${i}`, i]),
    );
    expect(droppedKeys(wide, {})).toHaveLength(20);
    expect(droppedKeys(wide, {}, 3)).toEqual(["k0", "k1", "k2"]);
  });
});

describe("validate({ unknownKeys })", () => {
  it('"strip" (the default) drops them silently, as before', async () => {
    const { post, events } = app();
    const res = await post(SENT);
    expect(await res.json()).toEqual({
      name: "ada",
      address: { city: "Lagos" },
      tags: [{ id: 1 }],
    });
    expect(events.filter((e) => e.level === "warn")).toEqual([]);
  });

  it('"warn" logs the dropped paths once, to the router\'s logger, and lets the request through', async () => {
    const { post, events } = app({ unknownKeys: "warn" });
    const res = await post(SENT);
    expect(res.status).toBe(200);
    const warnings = events.filter((e) => e.level === "warn");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.message).toBe(
      "validate(): the schema dropped keys the client sent",
    );
    expect(warnings[0]!.fields).toMatchObject({
      target: "body",
      paths: ["role", "address.zip", "tags.0.colour"],
      count: 3,
    });
    // Nothing dropped, nothing said.
    await post({ name: "ada", address: { city: "Lagos" } });
    expect(events.filter((e) => e.level === "warn")).toHaveLength(1);
  });

  it('"warn" with redactPaths logs only the count', async () => {
    const { post, events } = app({ unknownKeys: "warn", redactPaths: true });
    await post(SENT);
    const [warning] = events.filter((e) => e.level === "warn");
    expect(warning!.fields).toEqual({ target: "body", count: 3 });
  });

  it('"reject" fails validation with an issue per dropped key', async () => {
    const { post } = app({ unknownKeys: "reject" });
    const res = await post(SENT);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "Validation failed",
      issues: [
        { target: "body", message: "Unrecognized key", path: "role" },
        { target: "body", message: "Unrecognized key", path: "address.zip" },
        { target: "body", message: "Unrecognized key", path: "tags.0.colour" },
      ],
    });
    // A body with only declared keys passes.
    const ok = await post({ name: "ada", address: { city: "Lagos" } });
    expect(ok.status).toBe(200);
  });

  it("checks the query too, with any vendor (valibot), but never params or headers", async () => {
    const { logger, events } = createTestLogger();
    const router = new BunRouter({ logger });
    router.get(
      "/q/:id",
      validate(
        {
          query: v.object({ page: v.string() }),
          params: z.object({}),
          headers: z.object({ host: z.string().optional() }),
        },
        { unknownKeys: "reject", onFailure: "respond" },
      ),
      (req, res) => res.json(req.query),
    );
    const res = await router.fetch("/q/7?page=2&debug=1", {
      headers: { "x-extra": "1" },
    });
    expect(await res.json()).toEqual({
      error: "Validation failed",
      issues: [{ target: "query", message: "Unrecognized key", path: "debug" }],
    });
    expect((await router.fetch("/q/7?page=2")).status).toBe(200);
    expect(events).toEqual([]);
  });

  it("on an adapter, an async schema and a validator mounted with use()", async () => {
    const { logger, events } = createTestLogger();
    const adapter = new BunHttpAdapter(0, { logger });
    const Async: typeof User = User.refine(async () => true) as never;
    adapter.use("/m", validate({ body: Async }, { unknownKeys: "warn" }));
    adapter.post("/m", (req, res) => res.json(req.body));
    const res = await adapter.fetch("/m", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(SENT),
    });
    expect(res.status).toBe(200);
    expect(
      events.filter((e) => e.level === "warn").map((e) => e.fields),
    ).toEqual([
      {
        target: "body",
        paths: ["role", "address.zip", "tags.0.colour"],
        count: 3,
      },
    ]);
  });

  it("refuses a value it does not know", () => {
    expect(() =>
      validate({ body: User }, { unknownKeys: "error" as never }),
    ).toThrow(TypeError);
  });
});
