/**
 * Response variants: one status, several whole responses, of which a
 * response must match one — `variants()` in `validate()`'s `responses`, and
 * `res.variant()` naming the one a handler sends, each asserted.
 *
 * ```bash
 * bun 06-validation/response-variants.ts
 * ```
 *
 * A few things worth knowing before reading it:
 *
 * - `200: variants({ admin: { when, headers, cookies, content }, user: … },
 *   { by, refine })`. A variant is **acceptable** when it is selected (the
 *   one `res.variant()` named, else the one the discriminant `by` selects,
 *   else every variant), **applies** (its `when(valid, req)` holds; a
 *   Promise is awaited) and **matches whole** (parts are never taken from two
 *   variants). No acceptable variant is a mismatch: there is no fallback, and
 *   a variant with no `when` (a default) is declared only when wanted.
 * - **The check never strips.** A loose user schema (`z.object({ id, name })`)
 *   accepts the admin body, `salary` and all, so a non-admin answered with it
 *   is sent, and the types let it through too. A strict schema
 *   (`z.strictObject`) refuses it, and the issue names the admin variant.
 *   `res.variant("user")` strips what the user variant does not declare.
 * - `res.variant(name)` narrows the types to that variant and, once its
 *   `when` holds, adjusts the response at the commit: it fills what the
 *   variant allows exactly one value for and the handler did not set (the
 *   discriminant, a literal header or cookie, the status, `Content-Type`,
 *   literal JSON body fields) and strips undeclared JSON body fields, without
 *   mutating the handler's object. Under `responseValidation: "off"` the
 *   adjust still runs (no `when`, no check), since the strip is a privacy
 *   measure. It reads each schema's `~standard.jsonSchema`: zod 4 and
 *   arktype 2 carry one; valibot and yup do not, so their variants are not
 *   adjusted (one warning per variant at declaration).
 * - `refine(response, req)` checks the whole response once its parts pass,
 *   on a variant, on `variants(…, { refine })` or on a plain status. Its
 *   messages are scrubbed against every part, like a schema's.
 * - An issue checked against a variant names it (`variant`); the summary
 *   opening a refusal names none. No issue carries a received value. The
 *   contract core's guards (`createSender`, `createReceiver`) refuse a
 *   variants status with a `TypeError` for now; `validate()` checks them.
 * - The `// @ts-expect-error` lines are checked by the examples' type check
 *   (`bun scripts/typecheck.ts` at the root): each must be an error.
 */
import type {
  BunRequest,
  BunResponse,
  LogEvent,
  Refine,
  RouterErrorMiddlewareHandler,
} from "@kingsleyweb/bun-common";
import {
  BunRouter,
  chunks,
  createReceiver,
  createSender,
  createTestLogger,
  describeContract,
  getContract,
  ResponseValidationError,
  validate,
  variants,
} from "@kingsleyweb/bun-common";
import { z } from "zod";
import { check, checkEqual, checkRejects, summary } from "../shared/check";
import { show, step, title } from "../shared/console";

title("Response variants: one status, a whole response per audience");

/** A signed-in user, as the auth middleware puts it on `req.user`. */
interface User {
  /** Stable user id. */
  id: string;
  /** `"admin"` sees salaries; `"staff"` does not. */
  role: "admin" | "staff";
}

/** Bearer tokens to users: the auth middleware's whole database. */
const USERS: Record<string, User> = {
  "token-ada": { id: "u1", role: "admin" },
  "token-bob": { id: "u2", role: "staff" },
};

/** An employee record as the database has it, salary included. */
interface Employee {
  /** The employee's id. */
  id: string;
  /** Their name. */
  name: string;
  /** What only an admin may see. */
  salary: number;
}

/** The employee database. */
const EMPLOYEES: Record<string, Employee> = {
  u1: { id: "u1", name: "Ada", salary: 9100 },
  u2: { id: "u2", name: "Bob", salary: 7700 },
};

/** Looks an employee up, salary and all, as a data layer would. */
function lookup(id: string): Employee {
  const found = EMPLOYEES[id];
  if (found === undefined) throw new Error(`no employee ${id}`);
  return { ...found };
}

/** What an admin is answered: the whole record. */
const AdminView = z.object({
  id: z.string(),
  name: z.string(),
  salary: z.number(),
});

/** What a user is answered, loose: a structural subset of the admin view. */
const LooseUserView = z.object({ id: z.string(), name: z.string() });

/** The same, strict: it refuses any field it does not list, `salary` included. */
const StrictUserView = z.strictObject({ id: z.string(), name: z.string() });

/** The user an auth middleware put on the request; `undefined` when anonymous. */
function userOf(req: BunRequest): User | undefined {
  return (req as BunRequest & { user?: User }).user;
}

/** Whether the request is an admin's: the admin variant's `when`. */
function isAdmin(_valid: unknown, req: BunRequest): boolean {
  return userOf(req)?.role === "admin";
}

/** Whether anyone is signed in: the user variant's `when`. */
function signedIn(_valid: unknown, req: BunRequest): boolean {
  return userOf(req) !== undefined;
}

/**
 * A router under `mode`, logging into a test sink, with the auth middleware
 * first: a known `Authorization` token puts its user on `req.user`, as
 * `Object.assign(req, { user })`.
 */
function appRouter(mode: "off" | "warn" | "error" = "error") {
  const { logger, events } = createTestLogger();
  const router = new BunRouter({ logger, responseValidation: mode });
  router.use((req, _res, next) => {
    const user = USERS[String(req.headers.authorization ?? "")];
    if (user !== undefined) Object.assign(req, { user });
    next();
  });
  return { router, events };
}

/** One issue, as the refusal renderer answers it. */
interface Issue {
  /** `target.path`, or the target alone. */
  at: string;
  /** The variant it was checked against, when it has one. */
  variant?: string;
  /** What is wrong; never the received value. */
  message: string;
}

/** Renders a `ResponseValidationError` as a JSON 500 listing its issues. */
const renderRefusal = ((error, _req, res, _next) => {
  if (error instanceof ResponseValidationError) {
    res.status(500).json({
      error: error.name,
      issues: error.issues.map((issue): Issue => {
        const at =
          issue.path === "" ? issue.target : `${issue.target}.${issue.path}`;
        return issue.variant === undefined
          ? { at, message: issue.message }
          : { at, variant: issue.variant, message: issue.message };
      }),
    });
    return;
  }
  res.status(500).json({ error: String(error) });
}) satisfies RouterErrorMiddlewareHandler;

/** What a request came back with. */
interface Answer {
  /** The HTTP status. */
  status: number;
  /** The parsed JSON body. */
  body: unknown;
  /** The response headers. */
  headers: Headers;
}

/** GETs `path` on `router` as the holder of `token` (anonymous without one). */
async function get(
  router: BunRouter,
  path: string,
  token?: string,
): Promise<Answer> {
  const response = await router.fetch(path, {
    headers: token === undefined ? {} : { authorization: token },
  });
  return {
    status: response.status,
    body: await response.json(),
    headers: response.headers,
  };
}

/** The issues of a refused answer; `undefined` when it was not refused. */
function issuesOf(answer: Answer): Issue[] | undefined {
  return (answer.body as { issues?: Issue[] }).issues;
}

/** The `[status, body]` of an answer, for one comparison. */
function statusAndBody(answer: Answer): [number, unknown] {
  return [answer.status, answer.body];
}

/** The same response as a bare `BunResponse`, to send what the types refuse. */
function untyped(res: unknown): BunResponse {
  return res as BunResponse;
}

/* ------------------------------------------------------------------ */
step("An admin and a user variant of one 200, chosen by who asked (when)");

/** `GET /employees/:id`, one 200 with an admin and a user variant, under `userView`. */
function employees(
  router: BunRouter,
  userView: typeof LooseUserView | typeof StrictUserView,
): void {
  router.get(
    "/employees/:id",
    validate(
      {},
      {
        responses: {
          200: variants({
            admin: {
              when: isAdmin,
              content: { "application/json": AdminView },
            },
            user: { when: signedIn, content: { "application/json": userView } },
          }),
        },
      },
    ),
    (req, res) => {
      const employee = lookup(req.params.id);
      switch (req.query.send) {
        // The admin body whoever asked: the bug the variants are there to catch.
        case "everything":
          res.status(200).json(employee);
          return;
        // Neither variant's body.
        case "garbage":
          untyped(res).status(200).json({ id: 7 });
          return;
        default:
          if (userOf(req)?.role === "admin") {
            res.status(200).json(employee);
          } else {
            res.status(200).json({ id: employee.id, name: employee.name });
          }
      }
    },
  );
  router.use(renderRefusal);
}

const strict = appRouter();
employees(strict.router, StrictUserView);

const asAdmin = await get(strict.router, "/employees/u2", "token-ada");
checkEqual(
  "an admin asking: the admin variant, salary included",
  [asAdmin.status, asAdmin.body],
  [200, { id: "u2", name: "Bob", salary: 7700 }],
);
const asUser = await get(strict.router, "/employees/u1", "token-bob");
checkEqual(
  "a signed-in user asking: the user variant, no salary",
  [asUser.status, asUser.body],
  [200, { id: "u1", name: "Ada" }],
);
const anonymous = await get(strict.router, "/employees/u1");
checkEqual(
  "anonymous: neither when holds, so no variant applies, and there is no fallback…",
  [anonymous.status, issuesOf(anonymous)?.[0]],
  [
    500,
    {
      at: "status",
      message:
        "No variant of this status applies to this request (2 excluded by when)",
    },
  ],
);
checkEqual(
  "…though the body is the user variant's, which the refusal names",
  issuesOf(anonymous)?.slice(1),
  [
    {
      at: "status",
      variant: "user",
      message:
        'The response matches variant "user", which does not apply to this request',
    },
  ],
);
const garbage = await get(
  strict.router,
  "/employees/u1?send=garbage",
  "token-ada",
);
const garbageIssues = issuesOf(garbage) ?? [];
checkEqual(
  "a body no variant takes: a summary first, without a variant…",
  garbageIssues[0],
  {
    at: "status",
    message: "The response matches no acceptable variant (admin, user)",
  },
);
checkEqual(
  "…then each acceptable variant's own issues, each naming its variant",
  [...new Set(garbageIssues.slice(1).map((issue) => issue.variant))],
  ["admin", "user"],
);
show("the issues", garbageIssues);

/* ------------------------------------------------------------------ */
step("The leak: a loose user schema accepts the admin body");

const loose = appRouter();
employees(loose.router, LooseUserView);

const leaked = await get(
  loose.router,
  "/employees/u1?send=everything",
  "token-bob",
);
show("a staff user answered the whole record, loose user schema", leaked.body);
checkEqual(
  "SENT: the user variant's z.object() accepts the extra salary, and the check never strips",
  [leaked.status, leaked.body],
  [200, { id: "u1", name: "Ada", salary: 9100 }],
);

const caught = await get(
  strict.router,
  "/employees/u1?send=everything",
  "token-bob",
);
checkEqual("the same with z.strictObject: refused", caught.status, 500);
const diagnosis = issuesOf(caught)?.find((issue) =>
  issue.message.startsWith("The response matches variant"),
);
checkEqual(
  "…and diagnosed: the body is the admin variant's, which does not apply here",
  diagnosis,
  {
    at: "status",
    variant: "admin",
    message:
      'The response matches variant "admin", which does not apply to this request',
  },
);
check(
  "…with no salary in the refusal",
  !JSON.stringify(caught.body).includes("9100"),
  caught.body,
);
show("the refusal's issues", issuesOf(caught));

/* ------------------------------------------------------------------ */
step(
  "res.variant(): the discriminant and a literal header filled, salary stripped",
);

/** What the adjust logged at `debug`: paths and counts, never names or values. */
function adjustments(events: LogEvent[]): unknown[] {
  return events
    .filter((event) => event.message === "response adjusted by res.variant()")
    .map((event) => event.fields.changes);
}

/** The records the handler sent, to show `res.variant()` never mutates them. */
const handed: Employee[] = [];

/**
 * The loose table again, with an `x-view` discriminant (each variant's
 * value is its name) and a literal `x-tier` header on the admin variant.
 */
const staffContract = validate(
  {},
  {
    responses: {
      200: variants(
        {
          admin: {
            when: isAdmin,
            description: "to admins (role admin)",
            headers: z.object({ "x-tier": z.literal("payroll") }),
            content: { "application/json": AdminView },
          },
          user: {
            when: signedIn,
            content: { "application/json": LooseUserView },
          },
        },
        { by: { header: "x-view" } },
      ),
    },
  },
);

/**
 * `GET /staff/:id` under `staffContract`. By default the handler sends the
 * whole record either way and lets `res.variant()` make it fit; `?send=`
 * picks one of the mistakes below instead.
 */
function staff(router: BunRouter): void {
  router.get("/staff/:id", staffContract, (req, res) => {
    const employee = lookup(req.params.id);
    handed.push(employee);
    switch (req.query.send) {
      case "unnamed":
        // No .variant(): the x-view discriminant is the handler's to set.
        res.status(200).json(employee);
        return;
      case "root":
        // @ts-expect-error "root" is not a declared variant (admin, user)
        res.status(200).variant("root").json(employee);
        return;
      case "superuser":
        // @ts-expect-error x-view takes a variant's value (admin, user) only
        res.status(200).set("x-view", "superuser");
        res.json(employee);
        return;
      case "disagree":
        // @ts-expect-error after .variant("user"), x-view can only be "user"
        res.status(200).variant("user").set("x-view", "admin");
        res.json(employee);
        return;
      default:
        if (userOf(req)?.role === "admin") {
          // x-view and x-tier allow one value each: both filled.
          res.status(200).variant("admin").json(employee);
        } else {
          // x-view filled; salary, which the user variant does not declare, stripped.
          res.status(200).variant("user").json(employee);
        }
    }
  });
  router.use(renderRefusal);
}

const adjusting = appRouter();
staff(adjusting.router);

const adjustedAdmin = await get(adjusting.router, "/staff/u2", "token-ada");
checkEqual(
  '.variant("admin"): x-view and x-tier filled, the whole record sent',
  [
    adjustedAdmin.status,
    adjustedAdmin.headers.get("x-view"),
    adjustedAdmin.headers.get("x-tier"),
    adjustedAdmin.body,
  ],
  [200, "admin", "payroll", { id: "u2", name: "Bob", salary: 7700 }],
);
const adjustedUser = await get(adjusting.router, "/staff/u1", "token-bob");
checkEqual(
  '.variant("user"): x-view filled, salary stripped, though the loose schema would accept it',
  [adjustedUser.status, adjustedUser.headers.get("x-view"), adjustedUser.body],
  [200, "user", { id: "u1", name: "Ada" }],
);
checkEqual(
  "the handler's objects were never mutated: both still carry the salary",
  handed.map((employee) => employee.salary),
  [7700, 9100],
);
checkEqual(
  "each adjust logged at debug, as paths and counts",
  adjustments(adjusting.events),
  [
    ["headers.x-view: filled", "headers.x-tier: filled"],
    ["headers.x-view: filled", "body: stripped 1 undeclared field"],
  ],
);
const unnamed = await get(
  adjusting.router,
  "/staff/u1?send=unnamed",
  "token-bob",
);
checkEqual(
  "control: without .variant() nothing is filled, so the missing x-view is refused",
  [unnamed.status, issuesOf(unnamed)?.map((issue) => issue.at)],
  [500, ["headers.x-view"]],
);
const notForYou = await get(adjusting.router, "/staff/u1");
checkEqual(
  '.variant("user") for an anonymous request: its when still holds the line',
  [notForYou.status, issuesOf(notForYou)],
  [
    500,
    [
      {
        at: "status",
        variant: "user",
        message:
          'Variant "user" (named by variant()) does not apply to this request',
      },
    ],
  ],
);

/* ------------------------------------------------------------------ */
step("An async when: awaited at the commit");

/** The permission service's grants, by user id. */
const GRANTS: Record<string, string[]> = { u1: ["payroll:read"] };

/** How many times the async `when` ran. */
let grantChecks = 0;

/** Asks the permission service (here, after a tick) whether `id` holds `grant`. */
async function hasGrant(id: string, grant: string): Promise<boolean> {
  await Bun.sleep(1);
  return GRANTS[id]?.includes(grant) ?? false;
}

const payroll = appRouter();
payroll.router.get(
  "/payroll/:id",
  validate(
    {},
    {
      responses: {
        200: variants({
          payroll: {
            // A Promise of a boolean: the commit waits for it.
            when: async (_valid, req) => {
              grantChecks++;
              const user = userOf(req);
              return user !== undefined && hasGrant(user.id, "payroll:read");
            },
            content: { "application/json": AdminView },
          },
          user: {
            when: signedIn,
            content: { "application/json": StrictUserView },
          },
        }),
      },
    },
  ),
  async (req, res) => {
    const employee = lookup(req.params.id);
    const user = userOf(req);
    const allowed =
      user !== undefined && (await hasGrant(user.id, "payroll:read"));
    if (allowed || req.query.send === "everything") {
      res.status(200).json(employee);
      return;
    }
    res.status(200).json({ id: employee.id, name: employee.name });
  },
);
payroll.router.use(renderRefusal);

checkEqual(
  "Ada holds payroll:read: the payroll variant applies, salary sent",
  statusAndBody(await get(payroll.router, "/payroll/u2", "token-ada")),
  [200, { id: "u2", name: "Bob", salary: 7700 }],
);
checkEqual(
  "Bob does not: the user variant",
  statusAndBody(await get(payroll.router, "/payroll/u1", "token-bob")),
  [200, { id: "u1", name: "Ada" }],
);
const payrollLeak = await get(
  payroll.router,
  "/payroll/u1?send=everything",
  "token-bob",
);
checkEqual(
  "Bob answered the payroll body: refused once the when resolves false",
  [
    payrollLeak.status,
    issuesOf(payrollLeak)?.find((issue) => issue.variant === "payroll"),
  ],
  [
    500,
    {
      at: "status",
      variant: "payroll",
      message:
        'The response matches variant "payroll", which does not apply to this request',
    },
  ],
);
checkEqual("…one when call per request", grantChecks, 3);

/* ------------------------------------------------------------------ */
step("A discriminant value no variant declares: a mismatch");

const superuser = await get(
  adjusting.router,
  "/staff/u1?send=superuser",
  "token-ada",
);
checkEqual(
  "x-view: superuser: refused on headers.x-view, listing the declared values",
  [superuser.status, issuesOf(superuser)],
  [
    500,
    [
      {
        at: "headers.x-view",
        message: "Does not select a variant (expected admin, user)",
      },
    ],
  ],
);
check(
  "…never the received one",
  !JSON.stringify(superuser.body).includes("superuser"),
  superuser.body,
);
const root = await get(adjusting.router, "/staff/u1?send=root", "token-ada");
checkEqual(
  'res.variant("root"), past the types: refused, the declared names listed',
  issuesOf(root)?.[0]?.message,
  'variant("root") is not declared (admin, user)',
);
const disagree = await get(
  adjusting.router,
  "/staff/u1?send=disagree",
  "token-bob",
);
checkEqual(
  'x-view: admin under .variant("user"): kept as the handler set it, and refused',
  issuesOf(disagree),
  [
    {
      at: "headers.x-view",
      variant: "user",
      message: 'Selects variant "admin", but variant("user") was named',
    },
  ],
);

/* ------------------------------------------------------------------ */
step("refine: on a variant, on variants(), on a plain status");

/** A profile's body: the strict user view. */
type Profile = z.output<typeof StrictUserView>;

const profiles = appRouter();
profiles.router.get(
  "/profiles/:id",
  validate(
    {},
    {
      responses: {
        200: variants(
          {
            own: {
              when: signedIn,
              headers: z.object({ "x-record-id": z.string() }),
              content: { "application/json": StrictUserView },
              // The variant's own: a user is answered their own profile only.
              refine: (response, req) =>
                (response.body as Profile).id === userOf(req)?.id
                  ? undefined
                  : [
                      {
                        part: "body",
                        path: "id",
                        message: "Not the requesting user's profile",
                      },
                    ],
            },
          },
          {
            // Every variant's: the x-record-id header names the body's record.
            refine: (response) =>
              response.headers["x-record-id"] === (response.body as Profile).id
                ? undefined
                : [
                    {
                      part: "headers",
                      path: "x-record-id",
                      // Quotes a value: scrubbed to "Invalid value".
                      message: `${response.headers["x-record-id"]} is not the body's id`,
                    },
                  ],
          },
        ),
        // A plain status: Location names the profile created.
        201: {
          headers: z.object({ location: z.string() }),
          content: { "application/json": StrictUserView },
          refine: ((response) =>
            response.headers.location ===
            `/profiles/${(response.body as Profile).id}`
              ? undefined
              : [
                  {
                    part: "headers",
                    path: "location",
                    message: "Does not name the created profile",
                  },
                ]) satisfies Refine,
        },
      },
    },
  ),
  (req, res) => {
    const { id, name } = lookup(req.params.id);
    switch (req.query.send) {
      case "created":
        res.status(201).set("location", `/profiles/${id}`).json({ id, name });
        return;
      case "created-elsewhere":
        res.status(201).set("location", "/profiles").json({ id, name });
        return;
      case "wrong-record":
        res.status(200).set("x-record-id", "stale-u9").json({ id, name });
        return;
      default:
        res.status(200).set("x-record-id", id).json({ id, name });
    }
  },
);
profiles.router.use(renderRefusal);

/** The summary a refused variants status opens with. */
const noneLeft: Issue = {
  at: "status",
  message: "The response matches no acceptable variant (own)",
};

/** The `[status, issues]` of `path` on the profiles router, as Bob. */
async function profile(path: string): Promise<[number, Issue[] | undefined]> {
  const answer = await get(profiles.router, path, "token-bob");
  return [answer.status, issuesOf(answer)];
}

checkEqual(
  "Bob's own profile, x-record-id right: every refine passes",
  await profile("/profiles/u2"),
  [200, undefined],
);
checkEqual(
  "Ada's profile to Bob: the variant's refine refuses it, at body.id",
  await profile("/profiles/u1"),
  [
    500,
    [
      noneLeft,
      {
        at: "body.id",
        variant: "own",
        message: "Not the requesting user's profile",
      },
    ],
  ],
);
checkEqual(
  "x-record-id stale-u9: the status-wide refine refuses it, its value-quoting message withheld",
  await profile("/profiles/u2?send=wrong-record"),
  [
    500,
    [
      noneLeft,
      { at: "headers.x-record-id", variant: "own", message: "Invalid value" },
    ],
  ],
);
checkEqual(
  "a plain 201 with a right Location: passes",
  await profile("/profiles/u2?send=created"),
  [201, undefined],
);
checkEqual(
  "…and a wrong one: refused, with no variant on the issue",
  await profile("/profiles/u2?send=created-elsewhere"),
  [
    500,
    [{ at: "headers.location", message: "Does not name the created profile" }],
  ],
);

/* ------------------------------------------------------------------ */
step('Under "off": nothing is checked, but res.variant() still adjusts');

const off = appRouter("off");
staff(off.router);

const offUser = await get(off.router, "/staff/u1");
checkEqual(
  '.variant("user"), anonymous: no when consulted, yet x-view filled and salary stripped',
  [offUser.status, offUser.headers.get("x-view"), offUser.body],
  [200, "user", { id: "u1", name: "Ada" }],
);
const offUnnamed = await get(off.router, "/staff/u1?send=unnamed", "token-bob");
checkEqual(
  "without .variant(): sent as the handler made it, salary and all, no x-view",
  [offUnnamed.status, offUnnamed.headers.get("x-view"), offUnnamed.body],
  [200, null, { id: "u1", name: "Ada", salary: 9100 }],
);
checkEqual(
  "…and nothing is logged as a mismatch",
  off.events.filter((event) => event.level === "warn"),
  [],
);

/* ------------------------------------------------------------------ */
step("A streamed variant: each chunk checked against the variants still left");

/**
 * Reads `response`'s body to its end, giving up after five seconds so a
 * hang fails a check instead of stalling the run.
 */
async function drain(
  response: Response,
): Promise<{ text: string; end: "done" | "error"; error?: unknown }> {
  const reader = response.body?.getReader();
  if (reader === undefined) return { text: "", end: "done" };
  const decoder = new TextDecoder();
  let text = "";
  const timer = setTimeout(() => {
    void reader.cancel(new Error("timed out reading the body"));
  }, 5000);
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) return { text, end: "done" };
      // `next.value` is typed `any` here; a body's chunks are bytes.
      text += decoder.decode(next.value as Uint8Array, { stream: true });
    }
  } catch (error) {
    return { text, end: "error", error };
  } finally {
    clearTimeout(timer);
  }
}

const feed = appRouter();
feed.router.get(
  "/feed",
  validate(
    {},
    {
      responses: {
        200: variants({
          // Both open with the same "feed" line, then part ways.
          ids: {
            content: { "text/plain": chunks(z.string().regex(/^(feed|id:)/)) },
          },
          names: {
            content: {
              "text/plain": chunks(z.string().regex(/^(feed|name:)/)),
            },
          },
        }),
      },
    },
  ),
  async (req, res) => {
    const out = untyped(res).status(200).type("text/plain");
    for (const line of String(req.query.lines).split(",")) {
      out.write(`${line}\n`);
    }
    await out.end();
  },
);

/** Streams `lines` from `/feed`. */
async function streamed(lines: string) {
  const response = await feed.router.fetch(`/feed?lines=${lines}`);
  return { status: response.status, ...(await drain(response)) };
}

const consistent = await streamed("feed,id:1,id:2");
checkEqual(
  "feed, id:1, id:2: names drops out at id:1, ids survives, the stream ends cleanly",
  [consistent.status, consistent.text, consistent.end],
  [200, "feed\nid:1\nid:2\n", "done"],
);
const mixed = await streamed("feed,id:1,name:Ada");
checkEqual(
  "feed, id:1, name:Ada: nothing survives name:Ada, the stream is cut before it",
  [mixed.status, mixed.text, mixed.end],
  [200, "feed\nid:1\n", "error"],
);
const cutLine = feed.events.find((event) =>
  event.message.includes("the stream was cut off"),
);
check(
  "…the body errors with a ResponseValidationError",
  mixed.error instanceof ResponseValidationError,
  mixed.error,
);
checkEqual(
  "…logged once at error: no variant left, then ids' own issue with the chunk",
  [
    feed.events.filter((event) => event.level === "error").length,
    (cutLine?.fields.issues as { message: string; variant?: string }[]).map(
      (issue) => [issue.variant ?? null, issue.message],
    ),
  ],
  [
    1,
    [
      [null, "The stream matches no acceptable variant (ids)"],
      ["ids", "Invalid string: must match pattern /^(feed|id:)/"],
    ],
  ],
);

/* ------------------------------------------------------------------ */
step("describeContract: variant rows; the contract core's guards refuse them");

const contract = getContract(staffContract);
const described =
  contract === undefined ? undefined : describeContract(contract);
checkEqual(
  "one row per variant and part, each with its variant",
  described?.entries
    .filter((entry) => entry.side === "outbound")
    .map((entry) => [
      entry.key,
      entry.variant,
      entry.part,
      entry.mediaType ?? null,
    ]),
  [
    ["200", "admin", "headers", null],
    ["200", "admin", "body", "application/json"],
    ["200", "user", "body", "application/json"],
  ],
);
checkEqual(
  "sides.outbound.variants: the names, which have a when, the discriminant, the descriptions",
  described?.sides.outbound?.variants,
  {
    200: {
      names: ["admin", "user"],
      conditional: ["admin", "user"],
      by: {
        part: "headers",
        name: "x-view",
        values: { admin: "admin", user: "user" },
      },
      descriptions: { admin: "to admins (role admin)" },
    },
  },
);
if (contract !== undefined) {
  await checkRejects(
    "createSender on a side declaring variants: a TypeError at creation",
    () => createSender(contract, "outbound"),
    { name: "TypeError", message: /declared with variants\(\)/ },
  );
  await checkRejects(
    "…and createReceiver alike (validate() is what checks variants)",
    () => createReceiver(contract, "outbound"),
    { name: "TypeError", message: /HTTP's validate\(\) checks them/ },
  );
}

summary();
