/**
 * API documentation from the validators — every schema a route validates
 * with converts to JSON Schema automatically, so a validated router
 * documents itself.
 *
 * ```bash
 * bun 13-api-docs/from-validators.ts
 * ```
 *
 * The pipeline, end to end:
 *
 * 1. `listRoutes(router)` lists the endpoints with each one's effective
 *    contract (the validators' schemas included);
 * 2. `toJsonSchema(schema)` converts each contract row's schema — the
 *    schema's own `~standard.jsonSchema` when it has one (zod ≥ 4.2 does), a
 *    structural converter when it does not, `{}` plus a warning when nothing
 *    applies (nothing ever throws for a content problem);
 * 3. `liftComponents(json)` shapes the result for an OpenAPI document —
 *    `$defs` lifted into components, refs rewritten, `$schema` stripped.
 *
 * The converter lives at the package root and at
 * `@kingsleyweb/bun-common/lib/docs`; see the package README's
 * [Converting a schema to JSON Schema](../../packages/bun-common/README.md#converting-a-schema-to-json-schema-tojsonschema).
 */
import {
  BunRouter,
  documented,
  liftComponents,
  listRoutes,
  toJsonSchema,
  validate,
  withJsonSchema,
} from "@kingsleyweb/bun-common";
import { z } from "zod";
import { check, checkEqual, summary } from "../shared/check";
import { show, step, title } from "../shared/console";

title("API docs from the validators");

const SearchQuery = z.object({
  q: z.string().min(1),
  page: z.coerce.number().int().min(1).default(1),
});
const NewUser = z.object({
  name: z.string().min(2),
  email: z.email(),
  // A defaulted field: a client need not send it, so `input`'s `required`
  // leaves it out — direction is not cosmetic.
  role: z.enum(["admin", "user"]).default("user"),
});
const User = z.object({
  id: z.string(),
  name: z.string(),
  role: z.enum(["admin", "user"]),
});
// A legacy endpoint documented by hand: `documented()` validates nothing and
// publishes its JSON Schema directly — the escape hatch, no registration.
const LegacyNote = documented<{ text: string }>({
  type: "object",
  properties: { text: { type: "string" } },
  required: ["text"],
});

const router = new BunRouter();
router.get(
  "/users",
  validate({ query: SearchQuery }, { responses: { 200: z.array(User) } }),
  (req, res) => {
    res.json([]);
  },
);
router.post(
  "/users",
  validate({ body: NewUser }, { responses: { 201: User } }),
  (req, res) => {
    res.status(201).json({ id: "u_1", ...req.body });
  },
);
router.get(
  "/legacy/notes",
  validate({}, { responses: { 200: LegacyNote } }),
  (_req, res) => {
    res.json({ text: "hello" });
  },
);

/* ------------------------------------------------------------------ */
step("listRoutes() + toJsonSchema(): every contract row, converted");

const routes = listRoutes(router);
checkEqual("routes listed", routes.length, 3);

// What a document row becomes: where it sits, and the converted schema.
interface Row {
  readonly where: string;
  readonly direction: "input" | "output";
  readonly json: Record<string, unknown>;
}

const rows: Row[] = [];
for (const route of routes) {
  for (const entry of route.contract?.entries ?? []) {
    if (entry.schema === null || entry.implicit === true) continue;
    // Requests convert with "input" — the wire side. Responses do too: the
    // wire carries what was sent, EXCEPT under `responseOutput: "parsed"`,
    // where a response is the schema's output and "output" is right.
    const direction =
      entry.side === "outbound" && route.responseOutput === "parsed"
        ? "output"
        : "input";
    rows.push({
      where: `${route.key} ${entry.side}${entry.key === undefined ? "" : ` ${entry.key}`} ${entry.part}`,
      direction,
      json: toJsonSchema(entry.schema, { direction }),
    });
  }
}
for (const row of rows) {
  show(row.where, row.json);
}

check(
  "a row per declared part",
  rows.some((row) => row.where === "GET /users inbound query"),
);
const queryRow = rows.find((row) => row.where === "GET /users inbound query");
check(
  "the query row converted (zod's own ~standard.jsonSchema)",
  queryRow?.json.type === "object",
);
const bodyRow = rows.find((row) => row.where === "POST /users inbound body");
checkEqual(
  "the defaulted field is not required on the wire",
  bodyRow?.json.required,
  ["name", "email"],
);
const createdRow = rows.find(
  (row) => row.where === "POST /users outbound 201 body",
);
check(
  "the 201 response converted",
  (createdRow?.json.properties as Record<string, unknown> | undefined)?.id !==
    undefined,
);
const legacyRow = rows.find(
  (row) => row.where === "GET /legacy/notes outbound 200 body",
);
checkEqual("documented() converts as written", legacyRow?.json, {
  type: "object",
  properties: { text: { type: "string" } },
  required: ["text"],
});

/* ------------------------------------------------------------------ */
step('responseOutput: "parsed" converts the response with "output"');

const parsedRouter = new BunRouter({ responseOutput: "parsed" });
parsedRouter.get(
  "/users",
  validate({}, { responses: { 200: NewUser } }),
  (_req, res) => {
    res.json({ name: "ada", email: "ada@example.test", role: "admin" });
  },
);
const parsedRoute = listRoutes(parsedRouter)[0];
const parsedRow = parsedRoute.contract?.entries.find(
  (entry) => entry.side === "outbound" && entry.part === "body",
);
const parsedJson =
  parsedRow?.schema != null
    ? toJsonSchema(parsedRow.schema, {
        direction: parsedRoute.responseOutput === "parsed" ? "output" : "input",
      })
    : undefined;
checkEqual(
  'under "parsed" the defaulted field is always present',
  parsedJson?.required,
  ["name", "email", "role"],
);

/* ------------------------------------------------------------------ */
step("withJsonSchema: an explicit attachment wins");

const Approximate = withJsonSchema(z.object({ seconds: z.number() }), {
  type: "object",
  properties: {
    seconds: { type: "integer", minimum: 0 },
    unit: { type: "string", enum: ["s"] },
  },
  required: ["seconds"],
});
show("toJsonSchema(Approximate)", toJsonSchema(Approximate));
check(
  "the attachment is emitted, not the derivation",
  toJsonSchema(Approximate).properties !== undefined &&
    (toJsonSchema(Approximate).properties as Record<string, unknown>).unit !==
      undefined,
);

/* ------------------------------------------------------------------ */
step("liftComponents: towards an OpenAPI components block");

const PageQuery = z
  .object({ page: z.number().int().min(1) })
  .meta({ id: "PageQuery" });
const converted = toJsonSchema(z.object({ q: PageQuery, again: PageQuery }));
const lifted = liftComponents(converted);
show("lifted", lifted);
check(
  "$defs became components.schemas",
  lifted.components.PageQuery !== undefined &&
    JSON.stringify(lifted.schema).includes("#/components/schemas/PageQuery"),
);
check("the dialect is stripped ($schema)", lifted.schema.$schema === undefined);

summary();
