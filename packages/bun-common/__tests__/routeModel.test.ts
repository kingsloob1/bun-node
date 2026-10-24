/**
 * The route model (bun-validate V12, plan §6 row 18): `listRoutes` reads a
 * router's endpoints with each route's effective contract (replaying the
 * middleware a request would meet), `effectiveContract` merges layered
 * contracts outermost first with `commonResponses` under the route's
 * outbound, and `bodyPlacement` reads a body row into its document placement
 * (m6).
 */
import { describe, expect, it } from "bun:test";
import { z } from "zod";
import { BunHttpAdapter } from "../lib/BunHttpAdapter";
import { BunRouter } from "../lib/BunRouter";
import { validate } from "../lib/BunValidate";
import { defineChannel } from "../lib/channel";
import type { ContractEntry } from "../lib/contract/describe";
import { describeContract } from "../lib/contract/describe";
import { forwardContract, getContract } from "../lib/contract/transport";
import { createTestLogger } from "../lib/logging";
import { variants } from "../lib/responseBodies";
import type { ListedRoute } from "../lib/routeModel";
import {
  bodyPlacement,
  effectiveContract,
  listRoutes,
} from "../lib/routeModel";
import type { StandardSchemaV1 } from "../lib/types/standardSchema";
import type {
  RouterErrorMiddlewareHandler,
  RouterHandler,
} from "../lib/types/general";

const ok: RouterHandler = (_req, res) => {
  res.send("ok");
};

const User = z.object({ id: z.string() });
const Problem = z.object({ title: z.string() });

/** A route's entry by key; fails the test when absent. */
function entry(routes: ListedRoute[], key: string): ListedRoute {
  const found = routes.find((route) => route.key === key);
  expect(found, `an entry for ${key}`).toBeDefined();
  return found!;
}

/** A description with each row's origin dropped, for comparing with an unmerged contract. */
function withoutOrigins(description: ListedRoute["contract"]) {
  return {
    ...description,
    entries: description!.entries.map(({ origin: _origin, ...rest }) => rest),
  };
}

describe("listRoutes: a plain validate() route", () => {
  it("lists the middleware's contract, described, with the route as origin", () => {
    const router = new BunRouter();
    const middleware = validate({
      query: z.object({ page: z.coerce.number() }),
    });
    router.get("/users", middleware, (_req, res) => res.send("ok"));
    const routes = listRoutes(router);
    expect(routes.map((route) => route.key)).toEqual(["GET /users"]);
    const found = entry(routes, "GET /users");
    expect(found.method).toBe("GET");
    expect(found.path).toBe("/users");
    expect(found.params).toEqual([]);
    expect(found.partial).toBeUndefined();
    expect(found.contract?.transport).toBe("http");
    expect(withoutOrigins(found.contract)).toEqual(
      describeContract(getContract(middleware)!),
    );
    expect(
      found.contract!.entries.map((row) => [row.part, row.origin]),
    ).toEqual([["query", "GET /users"]]);
  });

  it("a GET route implies HEAD: there is no second entry", () => {
    const router = new BunRouter();
    router.get("/x", ok);
    expect(listRoutes(router).map((route) => route.key)).toEqual(["GET /x"]);
  });
});

describe("listRoutes: a mounted sub-router", () => {
  it("merges the use()-level validator with the route's, origins named, outermost winning", () => {
    const { logger, events } = createTestLogger();
    const app = new BunRouter();
    const mountQuery = z.object({ q: z.string() });
    const routeQuery = z.object({ q: z.string(), extra: z.string() });
    const sub = new BunRouter();
    sub.get(
      "/:id",
      validate({
        params: z.object({ id: z.coerce.number() }),
        query: routeQuery,
      }),
      (_req, res) => res.send("ok"),
    );
    app.use("/users", validate({ query: mountQuery }), sub);

    const found = entry(listRoutes(app, { logger }), "GET /users/:id");
    expect(found.params).toEqual(["id"]);
    const byPart = new Map(
      found.contract!.entries.map((row) => [row.part, row]),
    );
    // Inbound, the outermost layer declaring a part is the wire schema.
    expect(byPart.get("query")?.schema).toBe(mountQuery);
    expect(byPart.get("query")?.origin).toBe("/users");
    expect(byPart.get("params")?.origin).toBe("GET /users/:id");
    // The refinement is logged.
    expect(
      events.some(
        (event) => event.message === "contract part refined by an inner layer",
      ),
    ).toBe(true);
  });
});

describe("listRoutes: router-level commonResponses", () => {
  it("merge under every route's contract, the route winning a status it declares", () => {
    const router = new BunRouter({
      commonResponses: {
        404: {
          headers: z.object({ "x-why": z.string() }),
          content: { "application/json": Problem },
        },
      },
    });
    const Own = z.object({ code: z.number() });
    router.get(
      "/own",
      validate(
        { query: z.object({ q: z.string() }) },
        { responses: { 200: User, 404: Own } },
      ),
      (_req, res) => {
        res.status(200).json({ id: "a" });
      },
    );
    router.get(
      "/plain",
      validate({ query: z.object({ q: z.string() }) }),
      (_req, res) => res.send("ok"),
    );

    const routes = listRoutes(router);
    const own = entry(routes, "GET /own");
    const rows = own.contract!.entries.filter(
      (row) => row.side === "outbound" && row.key === "404",
    );
    // The route's 404 body replaces the router's; the router's 404 headers stand.
    const body = rows.find((row) => row.part === "body");
    const headers = rows.find((row) => row.part === "headers");
    expect(body?.schema).toBe(Own);
    expect(body?.origin).toBe("GET /own");
    expect(headers?.origin).toBe("router commonResponses");

    const plain = entry(routes, "GET /plain");
    const plainRows = plain.contract!.entries.filter(
      (row) => row.side === "outbound" && row.key === "404",
    );
    expect(plainRows.map((row) => row.origin)).toEqual([
      "router commonResponses",
      "router commonResponses",
    ]);
  });
});

describe("listRoutes: what is and is not listed", () => {
  it("finds a contract through a forwardContract wrapper", () => {
    const router = new BunRouter();
    const middleware = validate({ query: z.object({ q: z.string() }) });
    const wrapped = forwardContract(function logged(
      req: Parameters<typeof middleware>[0],
      res: Parameters<typeof middleware>[1],
      next: Parameters<typeof middleware>[2],
    ) {
      return middleware(req, res, next);
    }, middleware);
    router.get("/w", wrapped, (_req, res) => res.send("ok"));
    const found = entry(listRoutes(router), "GET /w");
    expect(found.contract?.entries.map((row) => row.part)).toEqual(["query"]);
  });

  it("a route with no validator has no contract", () => {
    const router = new BunRouter();
    router.get("/plain", ok);
    const found = entry(listRoutes(router), "GET /plain");
    expect(found.contract).toBeUndefined();
  });

  it("use() middleware and error handlers are never listed, but a use() validator merges into the routes", () => {
    const router = new BunRouter();
    router.use(validate({ headers: z.object({ "x-a": z.string() }) }));
    router.use(((_err, _req, res, _next) => {
      res.status(500).send("err");
    }) satisfies RouterErrorMiddlewareHandler);
    router.get("/x", ok);
    const routes = listRoutes(router);
    expect(routes.map((route) => route.key)).toEqual(["GET /x"]);
    const found = entry(routes, "GET /x");
    expect(found.contract!.entries.map((row) => row.part)).toEqual(["headers"]);
    // A root-level middleware has no mount path: its origin is its position.
    expect(found.contract!.entries[0].origin).toBe("layer #0");
  });
});

describe("listRoutes: response variants", () => {
  it("a variants() status lists sides.outbound.variants and one row per variant", () => {
    const router = new BunRouter();
    router.get(
      "/v",
      validate(
        {},
        {
          responses: {
            200: variants(
              {
                full: { content: { "application/json": User } },
                empty: { content: null },
              },
              { by: { header: "x-view" } },
            ),
          },
        },
      ),
      (_req, res) => {
        res.status(200).variant("full").json({ id: "a" });
      },
    );
    const found = entry(listRoutes(router), "GET /v");
    const variantsTable = found.contract?.sides.outbound?.variants?.["200"];
    expect(variantsTable?.names).toEqual(["full", "empty"]);
    expect(variantsTable?.by).toEqual({
      part: "headers",
      name: "x-view",
      values: { full: "full", empty: "empty" },
    });
    expect(
      found.contract!.entries.map((row) => [row.variant, row.part]),
    ).toEqual([
      ["full", "body"],
      ["empty", "body"],
    ]);
  });
});

describe("listRoutes: channels", () => {
  it("a channel is listed with its websocket contract, the transport naming it", async () => {
    const chat = defineChannel({
      path: "/rooms/:room",
      request: { params: z.object({ room: z.string() }) },
      receives: { say: z.object({ text: z.string() }) },
      sends: { said: z.object({ text: z.string() }) },
    });
    const adapter = new BunHttpAdapter(0);
    try {
      adapter.get(chat.path, chat.checks());
      adapter.ws(chat.path, chat.handler({}), chat.options());
      const found = listRoutes(adapter).filter(
        (route) => route.path === "/rooms/:room",
      );
      // The one entry is the checks route; the upgrade layer is not listed twice.
      expect(found.map((route) => route.key)).toEqual(["GET /rooms/:room"]);
      const contract = found[0].contract;
      expect(contract?.transport).toBe("websocket");
      expect(contract?.sides.inbound).toEqual({
        declared: true,
        keys: ["say"],
      });
      expect(contract?.sides.outbound?.keys).toEqual(["error", "said"]);
    } finally {
      await adapter.close();
    }
  });
});

describe("listRoutes: methods and partial routes", () => {
  it("all() and any() key as ALL /path", () => {
    const router = new BunRouter();
    router.all("/everything", ok);
    router.any(["GET", "POST"], "/some", ok);
    expect(listRoutes(router).map((route) => route.key)).toEqual([
      "ALL /everything",
      "ALL /some",
    ]);
  });

  it("a regex-constrained path cannot be replayed: the route's own callbacks, marked partial", () => {
    const router = new BunRouter();
    router.get(
      "/re/:id(\\d+)",
      validate({ params: z.object({ id: z.coerce.number() }) }),
      (_req, res) => res.send("ok"),
    );
    const found = entry(listRoutes(router), "GET /re/:id(\\d+)");
    expect(found.partial).toBe(true);
    // Its own validator's contract is still found.
    expect(found.contract?.entries.map((row) => row.part)).toEqual(["params"]);
    expect(found.contract?.entries[0].origin).toBe("GET /re/:id(\\d+)");
  });

  it("a wildcard path is synthesized and replayed, not partial", () => {
    const router = new BunRouter();
    router.get(
      "/files/*rest",
      validate({ headers: z.object({ "x-b": z.string() }) }),
      (_req, res) => res.send("ok"),
    );
    const found = entry(listRoutes(router), "GET /files/*rest");
    expect(found.partial).toBeUndefined();
    expect(found.params).toEqual(["rest"]);
    expect(found.contract?.entries.map((row) => row.part)).toEqual(["headers"]);
  });
});

describe("effectiveContract", () => {
  it("is undefined when no layer carries a contract", () => {
    expect(effectiveContract([ok, () => {}])).toBeUndefined();
  });

  it("names origins through the option", () => {
    const first = validate({ query: z.object({ q: z.string() }) });
    const second = validate({ body: User });
    const contract = effectiveContract([first, second], {
      origins: (_callback, index) => `L${index}`,
    })!;
    expect(
      describeContract(contract).entries.map((row) => [row.part, row.origin]),
    ).toEqual([
      ["query", "L0"],
      ["body", "L1"],
    ]);
  });

  it("merges a commonResponses declaration under the outbound side", () => {
    const middleware = validate(
      { query: z.object({ q: z.string() }) },
      { responses: { 200: User } },
    );
    const contract = effectiveContract([middleware], {
      commonResponses: { 500: Problem },
    })!;
    const rows = describeContract(contract).entries.filter(
      (row) => row.side === "outbound",
    );
    expect(rows.map((row) => [row.key, row.schema])).toEqual([
      ["200", User],
      ["500", Problem],
    ]);
    expect(rows[1].origin).toBe("router commonResponses");
  });

  it("a channel contract under an HTTP mount validator keeps its own transport", () => {
    const chat = defineChannel({
      path: "/c",
      receives: { ping: z.object({}) },
      sends: { pong: null },
    });
    const contract = effectiveContract([
      validate({ query: z.object({ q: z.string() }) }),
      chat.checks(),
    ])!;
    expect(contract.transport.name).toBe("websocket");
  });
});

/** One inbound body row for `schema`, as `describeContract` describes it. */
function bodyRow(schema: StandardSchemaV1): ContractEntry {
  const contract = getContract(validate({ body: schema }))!;
  const row = describeContract(contract).entries.find(
    (found) => found.side === "inbound" && found.part === "body",
  );
  expect(row).toBeDefined();
  return row!;
}

describe("bodyPlacement (m6)", () => {
  it("a body defaults to application/json", () => {
    expect(bodyPlacement(bodyRow(User))).toEqual({
      mediaType: "application/json",
      required: true,
    });
  });

  it("required is false when the schema's input accepts undefined", () => {
    expect(bodyPlacement(bodyRow(User.optional())).required).toBe(false);
  });

  it("control: a non-optional schema does not come out optional", () => {
    expect(bodyPlacement(bodyRow(User)).required).toBe(true);
  });

  it("a schema without a JSON Schema converter answers from validate(undefined)", () => {
    const accepts: ContractEntry = {
      side: "inbound",
      part: "body",
      kind: "value",
      encoding: "body",
      schema: {
        "~standard": {
          version: 1,
          vendor: "test",
          validate: (value) => ({ value }),
        },
      },
    };
    expect(bodyPlacement(accepts).required).toBe(false);
    const refuses: ContractEntry = {
      ...accepts,
      schema: {
        "~standard": {
          version: 1,
          vendor: "test",
          validate: () => ({ issues: [{ message: "required", path: [] }] }),
        },
      },
    };
    expect(bodyPlacement(refuses).required).toBe(true);
  });

  it("an async schema cannot be asked synchronously: required", () => {
    const asyncRow: ContractEntry = {
      side: "inbound",
      part: "body",
      kind: "value",
      encoding: "body",
      schema: {
        "~standard": {
          version: 1,
          vendor: "test",
          validate: (value) => Promise.resolve({ value }),
        },
      },
    };
    expect(bodyPlacement(asyncRow).required).toBe(true);
  });

  it("a null row (the body declared absent) is not required", () => {
    const absent: ContractEntry = {
      side: "inbound",
      part: "body",
      kind: "value",
      encoding: "body",
      schema: null,
    };
    expect(bodyPlacement(absent)).toEqual({
      mediaType: "application/json",
      required: false,
    });
  });
});
