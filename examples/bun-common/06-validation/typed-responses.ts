/**
 * A typed `res`: with `responses` declared, the handler can only send what
 * the table allows, and the runtime check agrees with the types.
 *
 * ```bash
 * bun 06-validation/typed-responses.ts
 * ```
 *
 * A few things worth knowing before reading it:
 *
 * - `res.status(code)` takes only a declared status and narrows `res` to it,
 *   so `res.status(201).json(body)` is held to the 201 schema's input.
 * - The `// @ts-expect-error` lines below are the point: each one must be an
 *   error, or the examples' type check (`bun scripts/typecheck.ts` at the
 *   root) fails on an unused directive. Removing a directive fails it too,
 *   on the line under it. `bun` itself does not type-check, so running the
 *   file shows the runtime half only.
 * - The types are a convenience, not the guarantee: a helper taking a bare
 *   `BunResponse` escapes them, and data typed wider than the truth gets
 *   through. `responseValidation: "error"` is what refuses those at runtime
 *   (see `response-checks.ts`).
 */
import type {
  ResponseSchemas,
  RouterErrorMiddlewareHandler,
} from "@kingsleyweb/bun-common";
import {
  BunRouter,
  ResponseValidationError,
  validate,
} from "@kingsleyweb/bun-common";
import { z } from "zod";
import { checkEqual, summary } from "../shared/check";
import { step, title } from "../shared/console";

title("Typed responses: res held to the declared statuses and bodies");

/** A created user, as the 201 promises it. */
const User = z.object({ id: z.string(), name: z.string() });

/** The problem body of a 409. */
const Problem = z.object({ code: z.string() });

/** The table: 201 with a User, 409 with a Problem, nothing else. */
const responses = {
  201: User,
  409: Problem,
} satisfies ResponseSchemas;

const router = new BunRouter({ responseValidation: "error" });

router.post(
  "/users",
  validate({ body: z.object({ name: z.string() }) }, { responses }),
  (req, res) => {
    const { name } = req.body;
    if (name === "taken") {
      res.status(409).json({ code: "TAKEN" });
      return;
    }
    // Compiles: 201 is declared, and the body is a User.
    res.status(201).json({ id: "u1", name });
  },
);

/**
 * The same route's mistakes, each refused by the type checker. The route is
 * requested below too, to show that the runtime check refuses the same
 * responses when a cast or a helper gets them past the types.
 */
router.post("/mistakes/:which", validate({}, { responses }), (req, res) => {
  if (req.params.which === "wrong-body") {
    // @ts-expect-error a wrong body for a declared status (201 promises a User)
    res.status(201).json({ id: 1, name: "Ada" });
    return;
  }
  // @ts-expect-error an undeclared status (only 201 and 409 are declared)
  res.status(418).json({ id: "u1", name: "Ada" });
});

router.use(((error, _req, res, _next) => {
  res.status(500).json({
    error: error instanceof ResponseValidationError ? error.name : "other",
    issues:
      error instanceof ResponseValidationError
        ? error.issues.map((issue) =>
            issue.path === "" ? issue.target : `${issue.target}.${issue.path}`,
          )
        : [],
  });
}) satisfies RouterErrorMiddlewareHandler);

/** POSTs `path` with a JSON `body`; answers the status and parsed body. */
async function post(path: string, body: unknown): Promise<[number, unknown]> {
  const response = await router.fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return [response.status, await response.json()];
}

/* ------------------------------------------------------------------ */
step("What compiles is sent");

checkEqual(
  "res.status(201).json(user): 201 with the user",
  await post("/users", { name: "Ada" }),
  [201, { id: "u1", name: "Ada" }],
);
checkEqual(
  "res.status(409).json(problem): 409 with the problem",
  await post("/users", { name: "taken" }),
  [409, { code: "TAKEN" }],
);

/* ------------------------------------------------------------------ */
step("What does not compile is refused at runtime as well");

checkEqual(
  "the wrong body, sent anyway: refused at body.id",
  await post("/mistakes/wrong-body", {}),
  [500, { error: "ResponseValidationError", issues: ["body.id"] }],
);
checkEqual(
  "the undeclared 418, sent anyway: refused on the status",
  await post("/mistakes/teapot", {}),
  [500, { error: "ResponseValidationError", issues: ["status"] }],
);

summary();
