/**
 * One contract, two ends: a server and a browser client checking the same
 * declaration — `getContract()`, `createSender`/`createReceiver`,
 * `describeContract`, `mergeContracts` and `forwardContract`, each asserted.
 *
 * ```bash
 * bun 06-validation/contract-sharing.ts
 * ```
 *
 * The pieces:
 *
 * - `modules/posts-contract.ts` declares the API with `defineTransport` and
 *   zod. It imports only `@kingsleyweb/bun-common/contract`, the browser-safe
 *   entry, so a browser can load it.
 * - The server (this file) builds its `validate()` middleware from that
 *   contract's schemas, and checks every reply with a sender before sending it.
 *   `getContract(middleware)` reads the validator's own HTTP contract back.
 * - `modules/posts-client.ts` is the client. It checks a request with a sender
 *   before sending it, and parses each reply with a receiver. This file bundles
 *   it for a browser and shows that nothing server-side came along.
 *
 * A **sender** checks and hands back the very message it was given. A
 * **receiver** parses, so `createdAt`, sent as a `Date` and carried as a
 * string, arrives as a `Date` again. Neither throws: each answers with the
 * message or a `ContractError`.
 */
import type {
  AnyContract,
  ContractDescription,
  RouterHandler,
} from "@kingsleyweb/bun-common";
import { dirname, join, relative } from "node:path";
import {
  BunRouter,
  CONTRACT,
  ContractError,
  createReceiver,
  createSender,
  createTestLogger,
  describeContract,
  forwardContract,
  getContract,
  mergeContracts,
  validate,
} from "@kingsleyweb/bun-common";
import { z } from "zod";
import { check, checkEqual, summary } from "../shared/check";
import { show, step, title } from "../shared/console";
import { postsClient } from "./modules/posts-client";
import {
  createPost,
  NewPost,
  postsApi,
  Problem,
} from "./modules/posts-contract";

/** One row of a description, reduced to what the checks compare. */
type Row = [
  side: string,
  key: string | undefined,
  part: string,
  origin: string | undefined,
  vendor: string | undefined,
];

/** A description's rows as {@link Row}s. */
const rows = (description: ContractDescription): Row[] =>
  description.entries.map((e) => [e.side, e.key, e.part, e.origin, e.vendor]);

title("A contract shared by a server and a client");

/* ------------------------------------------------------------------ */
step("The server: validate() built from the shared contract");

/** The route's validator, from the contract's own body schema. */
const createPostValidator = validate(
  { body: createPost.def.inbound.body },
  { onFailure: "respond" },
);
/** The server's check of its own replies, before they are sent. */
const checkReply = createSender(createPost, "outbound");

let nextId = 1;
const router = new BunRouter();

router.post("/posts", createPostValidator, async (req, res) => {
  const post = {
    id: nextId++,
    title: req.body.title,
    tags: req.body.tags,
    createdAt: new Date(),
  };
  const reply = await checkReply({ status: 201, body: post });
  if (reply instanceof ContractError) {
    res.status(500).json({ error: "The reply failed its contract" });
    return;
  }
  res.status(reply.status).json(reply.body);
});

// A bug the server's own sender catches: an id of 0 is not a positive integer.
router.post("/posts-buggy", createPostValidator, async (req, res) => {
  const post = {
    id: 0,
    title: req.body.title,
    tags: req.body.tags,
    createdAt: new Date(),
  };
  const reply = await checkReply({ status: 201, body: post });
  if (reply instanceof ContractError) {
    show("server caught its own reply", reply.issues);
    res.status(500).json({ error: "The reply failed its contract" });
    return;
  }
  res.status(reply.status).json(reply.body);
});

// A route that skips the reply check: only the client's receiver can catch it.
router.post("/posts-unchecked", createPostValidator, (req, res) => {
  res.status(201).json({ id: "7", title: req.body.title });
});

/* ------------------------------------------------------------------ */
step("getContract(): the validator carries its HTTP contract");

const httpContract = getContract(createPostValidator);
show("transport", httpContract?.transport.name);
check(
  "getContract(validate(...)) returns a contract",
  httpContract !== undefined,
);
checkEqual(
  "…for bun-common's HTTP transport",
  httpContract?.transport.name,
  "http",
);
check(
  "…whose body schema is the shared contract's, the same object",
  (httpContract?.def as { inbound?: { body?: unknown } } | undefined)?.inbound
    ?.body === NewPost,
);
check(
  "…carried under the CONTRACT symbol, non-enumerably",
  (createPostValidator as unknown as Record<symbol, unknown>)[CONTRACT] ===
    httpContract && Object.keys(createPostValidator).length === 0,
  Object.keys(createPostValidator),
);
checkEqual(
  "a plain function carries none",
  getContract(() => {}),
  undefined,
);

/* ------------------------------------------------------------------ */
step("describeContract(): the rows a document generator reads");

const httpRows = describeContract(httpContract as AnyContract);
show("validator", rows(httpRows));
checkEqual("the validator declares one row: the inbound body", rows(httpRows), [
  ["inbound", undefined, "body", undefined, "zod"],
]);
checkEqual(
  "…as a JSON body, encoded as one",
  httpRows.entries[0]?.encoding,
  "body",
);

const apiRows = describeContract(createPost);
show("createPost", rows(apiRows));
checkEqual(
  "the shared contract's name and wire",
  [apiRows.meta.name, apiRows.wire],
  ["createPost", "json"],
);
checkEqual(
  "its outbound keys, in canonical order",
  apiRows.sides.outbound?.keys,
  ["201", "400", "500"],
);
checkEqual("one row per side, key and part", rows(apiRows), [
  ["inbound", undefined, "body", undefined, "zod"],
  ["outbound", "201", "body", undefined, "zod"],
  ["outbound", "400", "body", undefined, "zod"],
  ["outbound", "500", "body", undefined, "bun-common/documented"],
]);

/* ------------------------------------------------------------------ */
step("The client: a sender before it sends, a receiver on every reply");

const client = postsClient((path, init) => router.fetch(path, init));

const created = await client.create({ title: "Hello", tags: ["intro"] });
show("created", created);
check(
  "a good post is created (201)",
  !(created instanceof ContractError) && created.status === 201,
  created,
);
if (!(created instanceof ContractError) && created.status === 201) {
  check(
    "…and the receiver parsed createdAt back into a Date",
    created.body.createdAt instanceof Date,
    created.body,
  );
  checkEqual(
    "…with the default tags filled in by the server",
    created.body.tags,
    ["intro"],
  );
}

const refused = await client.create({ title: "Hi" });
show(
  "refused before sending",
  refused instanceof ContractError ? refused.issues : refused,
);
check(
  "a short title is refused by the client's sender",
  refused instanceof ContractError,
  refused,
);
checkEqual(
  "…naming the part and the path",
  refused instanceof ContractError
    ? refused.issues.map((i) => [i.target, i.path])
    : [],
  [["body", "title"]],
);
checkEqual("…and never sent", client.sent, ["/posts"]);

const rejected = await client.createUnchecked({ title: "Hi" });
show("rejected by the server", rejected);
check(
  "sent unchecked, the server's validate() answers 400",
  !(rejected instanceof ContractError) && rejected.status === 400,
  rejected,
);
if (!(rejected instanceof ContractError) && rejected.status === 400) {
  checkEqual(
    "…and the client parsed the 400 as its declared Problem",
    rejected.body.issues.map((i) => [i.target, i.path]),
    [["body", "title"]],
  );
  check(
    "…a Problem the shared schema accepts",
    Problem.safeParse(rejected.body).success,
  );
}

const buggy = await client.create({ title: "Buggy" }, "/posts-buggy");
check(
  "a reply the server's sender refuses becomes its 500 instead",
  !(buggy instanceof ContractError) && buggy.status === 500,
  buggy,
);

const unchecked = await client.create(
  { title: "Unchecked" },
  "/posts-unchecked",
);
show(
  "caught by the client",
  unchecked instanceof ContractError ? unchecked.issues : unchecked,
);
check(
  "a reply outside the contract is caught by the client's receiver",
  unchecked instanceof ContractError,
  unchecked,
);
checkEqual(
  "…at the 201 body's id, tags and createdAt",
  unchecked instanceof ContractError
    ? unchecked.issues.map((i) => [i.key, i.target, i.path])
    : [],
  [
    ["201", "body", "id"],
    ["201", "body", "tags"],
    ["201", "body", "createdAt"],
  ],
);

const receiveReply = createReceiver(createPost, "outbound");
const teapot = await receiveReply({ status: 418, body: {} });
checkEqual(
  "an undeclared status is an issue on the key field",
  teapot instanceof ContractError ? teapot.issues.map((i) => i.target) : [],
  ["status"],
);
check(
  "documented() documents the 500 and never checks it: any body passes",
  !(
    (await receiveReply({ status: 500, body: "plain text" })) instanceof
    ContractError
  ),
);

/* ------------------------------------------------------------------ */
step("The client is browser-safe: it imports nothing server-side");

const here = import.meta.dir;
const transpiler = new Bun.Transpiler({ loader: "ts" });
/** What a module imports, by specifier. */
const importsOf = async (file: string): Promise<string[]> =>
  transpiler
    .scanImports(await Bun.file(join(here, file)).text())
    .map((i) => i.path)
    .sort();

checkEqual(
  "posts-client.ts imports the contract entry and the shared contract",
  await importsOf("modules/posts-client.ts"),
  ["./posts-contract", "@kingsleyweb/bun-common/contract"],
);
checkEqual(
  "posts-contract.ts imports the contract entry and zod",
  await importsOf("modules/posts-contract.ts"),
  ["@kingsleyweb/bun-common/contract", "zod"],
);

/** bun-common's `lib/`, where the root entry resolves. */
const LIB = dirname(Bun.resolveSync("@kingsleyweb/bun-common", here));

/** Bundles `entry` for a browser, recording every bun-common module it loads. */
async function browserBundle(entry: string) {
  const loaded: string[] = [];
  const result = await Bun.build({
    entrypoints: [entry],
    target: "browser",
    minify: false,
    throw: false,
    plugins: [
      {
        name: "record-bun-common-modules",
        setup(build) {
          build.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, async (args) => {
            if (args.path.startsWith(LIB))
              loaded.push(relative(LIB, args.path));
            return {
              contents: await Bun.file(args.path).text(),
              loader: args.path.endsWith("js") ? "js" : "ts",
            };
          });
        },
      },
    ],
  });
  const code = result.success
    ? (await Promise.all(result.outputs.map((o) => o.text()))).join("\n")
    : "";
  return { ok: result.success, code, loaded: [...new Set(loaded)].sort() };
}

/** bun-common modules a browser should not get: anything outside the contract core and its logger. */
const serverModules = (loaded: readonly string[]): string[] =>
  loaded.filter(
    (file) => !file.startsWith("contract/") && file !== "logging.ts",
  );

const clientBundle = await browserBundle(join(here, "modules/posts-client.ts"));
show("bun-common modules in the client's bundle", clientBundle.loaded);
check("the client bundles for a browser", clientBundle.ok);
check(
  "…with bun-common's contract core in it",
  clientBundle.loaded.includes("contract/guard.ts"),
  clientBundle.loaded,
);
checkEqual(
  "…and no other bun-common module but its logger",
  serverModules(clientBundle.loaded),
  [],
);
checkEqual(
  "…and no Bun or Node API in the code",
  [/["'](?:node|bun):[\w/]+["']/, /\bBun\.\w+/]
    .filter((marker) => marker.test(clientBundle.code))
    .map(String),
  [],
);

// The control: the same check on the package's root entry, which is the server.
const rootBundle = await browserBundle(
  Bun.resolveSync("@kingsleyweb/bun-common", here),
);
show(
  "server modules the root entry pulls in (first five)",
  serverModules(rootBundle.loaded).slice(0, 5),
);
check(
  "the control: the root entry fails that check (BunRouter.ts and the rest)",
  serverModules(rootBundle.loaded).includes("BunRouter.ts"),
  rootBundle.loaded,
);

/* ------------------------------------------------------------------ */
step("mergeContracts(): the layers a request passes through");

const { logger, events } = createTestLogger();

// Inbound: a router checks every request's API key and paging; one route
// narrows the paging further. The outermost layer saw the raw value, so its
// schema is the wire schema, and the inner one is logged as a refinement.
const routerLayer = validate({
  headers: z.object({ "x-api-key": z.string() }),
  query: z.object({ page: z.coerce.number().int().min(1).default(1) }),
});
const routeLayer = validate({
  query: z.object({ page: z.number().max(50) }),
  body: NewPost,
});
const inbound = mergeContracts(
  [
    {
      contract: getContract(routerLayer) as AnyContract,
      origin: "router /posts",
    },
    { contract: getContract(routeLayer) as AnyContract, origin: "POST /posts" },
  ],
  { logger },
);
show("merged inbound", rows(describeContract(inbound)));
checkEqual(
  "every row records its origin; the outermost query wins",
  rows(describeContract(inbound)),
  [
    ["inbound", undefined, "headers", "router /posts", "zod"],
    ["inbound", undefined, "query", "router /posts", "zod"],
    ["inbound", undefined, "body", "POST /posts", "zod"],
  ],
);
checkEqual(
  "…and the inner query is logged as a refinement",
  events
    .filter((e) => e.level === "warn")
    .map((e) => [e.message, e.fields?.part]),
  [["contract part refined by an inner layer", "query"]],
);

// Outbound: the adapter declares the errors every route can answer; a route
// declares its own. The innermost wins, except that a checking schema always
// beats a documented() one.
const adapterLayer = postsApi.contract({
  outbound: {
    400: { body: z.object({ error: z.string() }) },
    500: { body: z.object({ error: z.string() }) },
  },
});
const outbound = mergeContracts(
  [
    { contract: adapterLayer, origin: "adapter" },
    { contract: createPost, origin: "POST /posts" },
  ],
  { logger },
);
const outboundRows = rows(describeContract(outbound)).filter(
  ([side]) => side === "outbound",
);
show("merged outbound", outboundRows);
checkEqual(
  "the route's 201 and 400 win; the adapter's checking 500 beats a documented one",
  outboundRows,
  [
    ["outbound", "201", "body", "POST /posts", "zod"],
    ["outbound", "400", "body", "POST /posts", "zod"],
    ["outbound", "500", "body", "adapter", "zod"],
  ],
);
check(
  "a merged contract is guarded like any other: its 500 is now checked",
  (await createReceiver(
    outbound,
    "outbound",
  )({ status: 500, body: "plain text" })) instanceof ContractError,
);

/* ------------------------------------------------------------------ */
step("forwardContract(): a wrapper keeps the contract it wraps");

/** Times the validator it wraps; a wrapper like this hides the contract unless it forwards it. */
const timed: RouterHandler = (req, res, next) => {
  const started = performance.now();
  const result = createPostValidator(req, res, next);
  show("validated in", `${(performance.now() - started).toFixed(3)}ms`);
  return result;
};
checkEqual(
  "before forwarding, the wrapper carries no contract",
  getContract(timed),
  undefined,
);
forwardContract(timed, createPostValidator);
check(
  "after forwardContract, it carries the validator's",
  getContract(timed) === httpContract,
);
checkEqual(
  "forwarding from something without a contract is a no-op",
  getContract(forwardContract(() => {}, {})),
  undefined,
);

const wrapped = new BunRouter();
wrapped.post("/posts", timed, (_req, res) => {
  res.status(201).json({ ok: true });
});
const response = await wrapped.fetch("/posts", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ title: "Hi" }),
});
checkEqual(
  "…and still validates: a short title is a 400",
  response.status,
  400,
);

summary();
