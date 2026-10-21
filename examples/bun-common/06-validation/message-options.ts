/**
 * `validate()`'s `messages: "generic"` and `redactPaths: true`: the 400, the
 * error `formatError` is given, a `ResponseValidationError` and a `"warn"`
 * line, all worded by them — each asserted.
 *
 * ```bash
 * bun 06-validation/message-options.ts
 * ```
 *
 * A few things worth knowing before reading it:
 *
 * - By default an issue keeps the library's message unless it quotes the
 *   value received (the scrub, `message-scrub.ts`), and keeps its path. A
 *   path can still name what the sender chose: in a record keyed by e-mail,
 *   the path *is* the address.
 * - `messages: "generic"` replaces every schema issue's message with
 *   `Invalid value (<code>)`, or `Invalid value` when the library has no
 *   issue code (yup's issues have none). `redactPaths: true` empties every
 *   path. They are the contract guards' options of the same names, set per
 *   validator; there is no router or adapter setting.
 * - They word every issue the validator's schemas report: on the request
 *   side the `ValidationError` (the `"respond"` body, `formatError`'s
 *   argument, what `"next"` and `"throw"` raise), and on the response side
 *   the `ResponseValidationError` and the `"warn"` line of its `responses`.
 *   An issue the framework writes itself (an undeclared status) names only
 *   what is declared, and is kept as it is.
 * - A mount's validator and a route's check a response together, and the
 *   stricter wording holds: a route cannot undo its mount's redaction.
 * - A value neither option takes (`"Generic"`, `"yes"`) is a `TypeError`
 *   when the middleware is built, not a silent no-op.
 */
import type {
  BunResponse,
  JsonValue,
  LogEvent,
  RouterErrorMiddlewareHandler,
  StandardSchemaV1,
} from "@kingsleyweb/bun-common";
import {
  BunRouter,
  createTestLogger,
  ResponseValidationError,
  validate,
  ValidationError,
} from "@kingsleyweb/bun-common";
import * as yup from "yup";
import { z } from "zod";
import { check, checkEqual, checkRejects, summary } from "../shared/check";
import { show, step, title } from "../shared/console";

/** The key the sender chose, which a path would name. */
const EMAIL = "alice@example.com";

/** Scores keyed by e-mail address: every path is somebody's address. */
const Scores = z.record(z.email(), z.number());

/** A body `Scores` rejects: the score is text. */
const BAD_SCORES = { [EMAIL]: "ten" };

/** zod's own message for that body, which quotes nothing. */
const ZOD_MESSAGE = "Invalid input: expected number, received string";

/** The same issue under `messages: "generic"`: zod's code, no prose. */
const GENERIC_MESSAGE = "Invalid value (invalid_type)";

/** The wording options, as `validate()` takes them. */
interface Wording {
  /** `"generic"` replaces every message. */
  messages?: "generic";
  /** `true` empties every path. */
  redactPaths?: boolean;
}

/** The four ways to set them, each by name. */
const WORDINGS: [string, Wording][] = [
  ["as is", {}],
  ["redactPaths: true", { redactPaths: true }],
  ['messages: "generic"', { messages: "generic" }],
  ["both", { messages: "generic", redactPaths: true }],
];

/** One issue as `[target, path, message]`, for a compact comparison. */
type Triple = [string, string, string];

/** The issues of a `ValidationError` or `ResponseValidationError`, as triples. */
function triples(
  issues: readonly { target: string; path: string; message: string }[],
): Triple[] {
  return issues.map((issue) => [issue.target, issue.path, issue.message]);
}

/** POSTs `body` as JSON to `path` on `router`. */
function post(router: BunRouter, path: string, body: unknown) {
  return router.fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/**
 * Sends `body` as JSON, with `status` (default 200), from a helper that takes
 * a bare `BunResponse`, as an auth helper shared by many routes would: the
 * handler's typed `res` does not hold it to the declared statuses and bodies,
 * so this is the bad response only the runtime checks catch.
 */
function untypedJson(res: BunResponse, body: JsonValue, status = 200): void {
  res.status(status).json(body);
}

/** The issues of every response-mismatch warning logged. */
function warnedIssues(events: LogEvent[]): unknown[] {
  return events
    .filter(
      (event) =>
        event.level === "warn" && event.message.includes("does not match"),
    )
    .map((event) => event.fields.issues);
}

title("validate(): messages and redactPaths");

/* ------------------------------------------------------------------ */
step('The 400 under onFailure: "respond", worded four ways');

const requests = new BunRouter();
for (const [index, [, wording]] of WORDINGS.entries()) {
  requests.post(
    `/scores/${index}`,
    validate({ body: Scores }, { onFailure: "respond", ...wording }),
    (req, res) => {
      res.json({ saved: req.body });
    },
  );
}

/** The issues each wording's 400 carried, `[status, triples]`, and its text. */
const answers: { status: number; issues: Triple[]; text: string }[] = [];
for (const index of WORDINGS.keys()) {
  const response = await post(requests, `/scores/${index}`, BAD_SCORES);
  const text = await response.text();
  const body = JSON.parse(text) as {
    error: string;
    issues: { target: string; path: string; message: string }[];
  };
  answers.push({
    status: response.status,
    issues: triples(body.issues),
    text,
  });
  show(WORDINGS[index]?.[0] ?? "", body.issues[0]);
}

checkEqual(
  "as is: zod's message, and the path is the sender's address (the control)",
  [answers[0]?.status, answers[0]?.issues],
  [400, [["body", EMAIL, ZOD_MESSAGE]]],
);
checkEqual(
  'redactPaths: true: the path is ""',
  [answers[1]?.status, answers[1]?.issues],
  [400, [["body", "", ZOD_MESSAGE]]],
);
check(
  "…and the address appears nowhere in the response",
  answers[1] !== undefined && !answers[1].text.includes(EMAIL),
  answers[1]?.text,
);
checkEqual(
  'messages: "generic": zod\'s message becomes "Invalid value (invalid_type)"',
  [answers[2]?.status, answers[2]?.issues],
  [400, [["body", EMAIL, GENERIC_MESSAGE]]],
);
checkEqual(
  "both: neither the address nor zod's prose is left",
  [answers[3]?.status, answers[3]?.issues],
  [400, [["body", "", GENERIC_MESSAGE]]],
);

const good = await post(requests, "/scores/3", { [EMAIL]: 10 });
checkEqual(
  "a passing request is untouched by either option",
  [good.status, await good.json()],
  [200, { saved: { [EMAIL]: 10 } }],
);

/* ------------------------------------------------------------------ */
step("formatError, next and throw see the worded issues too");

/** What a `formatError` was handed, for the checks below. */
const formatted: { issues: Triple[]; message: string }[] = [];

/** A router whose 400 body is a `formatError` of its own, under `wording`. */
function formatting(wording: Wording): BunRouter {
  const router = new BunRouter();
  router.post(
    "/scores",
    validate(
      { body: Scores },
      {
        onFailure: "respond",
        status: 422,
        formatError: (error) => {
          formatted.push({
            issues: triples(error.issues),
            message: error.message,
          });
          return {
            problems: error.issues.map((issue) =>
              issue.path === ""
                ? issue.message
                : `${issue.path}: ${issue.message}`,
            ),
          };
        },
        ...wording,
      },
    ),
    (_req, res) => {
      res.json({ ok: true });
    },
  );
  return router;
}

const formattedPlain = await post(formatting({}), "/scores", BAD_SCORES);
const formattedStrict = await post(
  formatting({ messages: "generic", redactPaths: true }),
  "/scores",
  BAD_SCORES,
);
checkEqual(
  "as is: formatError gets the address in the path and in error.message (the control)",
  formatted[0],
  {
    issues: [["body", EMAIL, ZOD_MESSAGE]],
    message: `Request validation failed — body.${EMAIL}: ${ZOD_MESSAGE}`,
  },
);
checkEqual(
  "both options: formatError gets the redacted, generic issues, and error.message is built from them",
  formatted[1],
  {
    issues: [["body", "", GENERIC_MESSAGE]],
    message: `Request validation failed — body: ${GENERIC_MESSAGE}`,
  },
);
checkEqual(
  "…so the body it builds carries neither",
  [
    [formattedPlain.status, await formattedPlain.json()],
    [formattedStrict.status, await formattedStrict.json()],
  ],
  [
    [422, { problems: [`${EMAIL}: ${ZOD_MESSAGE}`] }],
    [422, { problems: [GENERIC_MESSAGE] }],
  ],
);

/** The `[name, triples]` of what a validator in `mode` raised, caught by the router's error handler. */
async function raised(mode: "next" | "throw"): Promise<[string, Triple[]]> {
  let caught: [string, Triple[]] = ["nothing reached the error handler", []];
  const router = new BunRouter();
  router.post(
    "/scores",
    validate(
      { body: Scores },
      { onFailure: mode, messages: "generic", redactPaths: true },
    ),
    (_req, res) => {
      res.json({ ok: true });
    },
  );
  router.use(((error, _req, res, _next) => {
    if (error instanceof ValidationError) {
      caught = [error.name, triples(error.issues)];
    }
    res.status(400).json({ error: "rejected" });
  }) satisfies RouterErrorMiddlewareHandler);
  await post(router, "/scores", BAD_SCORES);
  return caught;
}

checkEqual(
  'onFailure: "next": the ValidationError handed on is worded',
  await raised("next"),
  ["ValidationError", [["body", "", GENERIC_MESSAGE]]],
);
checkEqual('onFailure: "throw": so is the one thrown', await raised("throw"), [
  "ValidationError",
  [["body", "", GENERIC_MESSAGE]],
]);

/* ------------------------------------------------------------------ */
step("yup: a harmless message is replaced too");

const Contact = yup.object({ contact: yup.string().email().required() });

/** The `[status, triples]` of a 400 from `Contact` under `wording`. */
async function contactAnswer(wording: Wording): Promise<[number, Triple[]]> {
  const router = new BunRouter();
  router.post(
    "/contact",
    validate({ body: Contact }, { onFailure: "respond", ...wording }),
    (_req, res) => {
      res.json({ ok: true });
    },
  );
  const response = await post(router, "/contact", { contact: "no" });
  const body = (await response.json()) as {
    issues: { target: string; path: string; message: string }[];
  };
  return [response.status, triples(body.issues)];
}

const yupOwn = await (Contact as StandardSchemaV1)["~standard"].validate({
  contact: "no",
});
show(
  "yup writes",
  (yupOwn.issues ?? []).map((issue) => issue.message),
);
checkEqual(
  "as is: yup's message quotes nothing, so the scrub keeps it (the control)",
  await contactAnswer({}),
  [400, [["body", "contact", "contact must be a valid email"]]],
);
checkEqual(
  'messages: "generic": replaced all the same; yup has no issue code, so just "Invalid value"',
  await contactAnswer({ messages: "generic" }),
  [400, [["body", "contact", "Invalid value"]]],
);

/* ------------------------------------------------------------------ */
step("The same validator's responses: ResponseValidationError and warn");

/**
 * A router whose route promises `Scores` and answers {@link BAD_SCORES},
 * the validator in `mode` and worded by `wording`, recording every
 * `ResponseValidationError` and logging into a test sink.
 */
function scoresResponder(mode: "warn" | "error", wording: Wording) {
  const { logger, events } = createTestLogger();
  const refusals: ResponseValidationError[] = [];
  const router = new BunRouter({ logger });
  router.get(
    "/leaderboard",
    validate(
      {},
      { responses: { 200: Scores }, responseValidation: mode, ...wording },
    ),
    (_req, res) => {
      untypedJson(res, BAD_SCORES);
    },
  );
  router.use(((error, _req, res, _next) => {
    if (error instanceof ResponseValidationError) {
      refusals.push(error);
    }
    res.status(500).json({ error: "refused" });
  }) satisfies RouterErrorMiddlewareHandler);
  return { router, events, refusals };
}

/** The `[issues, message]` of the refusal `wording` gives under "error". */
async function refusal(wording: Wording): Promise<[Triple[], string]> {
  const responder = scoresResponder("error", wording);
  await responder.router.fetch("/leaderboard");
  const [error] = responder.refusals;
  return error === undefined
    ? [[], "no ResponseValidationError"]
    : [triples(error.issues), error.message];
}

checkEqual(
  '"error", as is: the refusal names the address (the control)',
  await refusal({}),
  [
    [["body", EMAIL, ZOD_MESSAGE]],
    `Response validation failed (status 200) — body.${EMAIL}: ${ZOD_MESSAGE}`,
  ],
);
checkEqual(
  '"error", redactPaths: true: its issue and message without it',
  await refusal({ redactPaths: true }),
  [
    [["body", "", ZOD_MESSAGE]],
    `Response validation failed (status 200) — body: ${ZOD_MESSAGE}`,
  ],
);
checkEqual(
  '"error", messages: "generic": the same code as on the request side',
  await refusal({ messages: "generic" }),
  [
    [["body", EMAIL, GENERIC_MESSAGE]],
    `Response validation failed (status 200) — body.${EMAIL}: ${GENERIC_MESSAGE}`,
  ],
);

/** The `[target, path, message]` of each issue each warning logged under `wording`. */
async function warning(
  wording: Wording,
): Promise<{ issues: Triple[][]; logged: string }> {
  const responder = scoresResponder("warn", wording);
  const response = await responder.router.fetch("/leaderboard");
  await response.text();
  return {
    issues: warnedIssues(responder.events).map((issues) =>
      triples(issues as { target: string; path: string; message: string }[]),
    ),
    logged: JSON.stringify(responder.events),
  };
}

const warnedPlain = await warning({});
const warnedStrict = await warning({ messages: "generic", redactPaths: true });
checkEqual(
  '"warn", as is: one line, its issue naming the address (the control)',
  warnedPlain.issues,
  [[["body", EMAIL, ZOD_MESSAGE]]],
);
checkEqual(
  '"warn", both options: the line is worded the same way',
  warnedStrict.issues,
  [[["body", "", GENERIC_MESSAGE]]],
);
check(
  "…and nothing logged carries the address",
  !warnedStrict.logged.includes(EMAIL),
  warnedStrict.logged,
);

/* ------------------------------------------------------------------ */
step("A mount's validator and a route's: the stricter wording holds");

/** A problem body, which the mount's validator declares for its 401. */
const Problem = z.object({ code: z.string() });

/**
 * The path each refusal named, for a route under a mount whose validator
 * takes `mount` and the route's `route`. The mount declares a 401 (an auth
 * check in front of every route), the route its 200; both answers are bad.
 */
async function mounted(mount: Wording, route: Wording): Promise<string[][]> {
  const refusals: ResponseValidationError[] = [];
  const router = new BunRouter({ responseValidation: "error" });
  router.use("/teams", validate({}, { responses: { 401: Problem }, ...mount }));
  router.get(
    "/teams/scores",
    validate({}, { responses: { 200: Scores }, ...route }),
    (req, res) => {
      if (req.query.anonymous === "1") {
        untypedJson(res, { code: 401 }, 401);
        return;
      }
      untypedJson(res, BAD_SCORES);
    },
  );
  router.use(((error, _req, res, _next) => {
    if (error instanceof ResponseValidationError) {
      refusals.push(error);
    }
    res.status(500).json({ error: "refused" });
  }) satisfies RouterErrorMiddlewareHandler);
  await router.fetch("/teams/scores");
  await router.fetch("/teams/scores?anonymous=1");
  return refusals.map((error) => error.issues.map((issue) => issue.path));
}

checkEqual(
  "neither redacts: the route's 200 names the address, the mount's 401 its key (the control)",
  await mounted({}, {}),
  [[EMAIL], ["code"]],
);
checkEqual(
  "the mount redacts, the route says redactPaths: false: the mount's holds",
  await mounted({ redactPaths: true }, { redactPaths: false }),
  [[""], [""]],
);
checkEqual(
  "the route redacts, the mount says false: the route's holds, the mount's 401 included",
  await mounted({ redactPaths: false }, { redactPaths: true }),
  [[""], [""]],
);

/* ------------------------------------------------------------------ */
step("A value neither option takes: a TypeError when the middleware is built");

// TypeScript rejects these in a literal; settings read from a file at run
// time, typed loosely, reach the check.
const fromConfig = JSON.parse(
  '{ "typo": { "messages": "Generic" }, "string": { "redactPaths": "yes" } }',
) as Record<"typo" | "string", Wording>;

await checkRejects(
  'messages: "Generic" (a capital G): refused, not ignored',
  () => validate({ body: Scores }, fromConfig.typo),
  { name: "TypeError", message: /messages must be "generic" or unset/ },
);
await checkRejects(
  'redactPaths: "yes": refused, it must be a boolean',
  () => validate({ body: Scores }, fromConfig.string),
  { name: "TypeError", message: /redactPaths must be a boolean/ },
);

summary();
