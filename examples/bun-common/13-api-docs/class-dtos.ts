/**
 * Class DTOs (AD phase (b2), plan `docs/plans/api-docs-generation/` §3.6):
 * a class-validator / class-transformer DTO class anywhere a Standard Schema
 * is accepted — here on `query` — with the libraries injected through
 * `useClassDtos`, never depended on by bun-common itself.
 *
 * ```bash
 * bun 13-api-docs/class-dtos.ts
 * ```
 *
 * Requirements, stated as requirements (measured on class-validator 0.15.1):
 *
 * - `experimentalDecorators` (and `emitDecoratorMetadata`) on — under
 *   TypeScript 5+ standard decorators, class-validator crashes at
 *   class-definition time; and
 * - `reflect-metadata` imported before the DTO module.
 *
 * Bun reads those flags from the **working directory's** tsconfig
 * (oven-sh/bun#28605), so run from the app's root — this folder's tsconfig
 * sets them.
 *
 * class-validator, class-transformer and class-validator-jsonschema are
 * devDependencies of the workspace, resolved from the root `node_modules`.
 * Where they are not installed this example prints a line starting
 * `skipped:` and exits 0.
 */
import { BunRouter, useClassDtos, validate } from "@kingsleyweb/bun-common";
import { generateOpenApi } from "@kingsleyweb/bun-common/lib/docs";
import process from "node:process";
import { check, checkEqual, summary } from "../shared/check";
import { show, step, title } from "../shared/console";

/** Where any of the three libraries is absent, skip visibly rather than fail. */
const MISSING = [
  "reflect-metadata",
  "class-validator",
  "class-transformer",
  "class-validator-jsonschema",
].filter((name) => {
  try {
    Bun.resolveSync(name, import.meta.dir);
    return false;
  } catch {
    return true;
  }
});
if (MISSING.length > 0) {
  console.log(`skipped: ${MISSING.join(", ")} not installed`);
  process.exit(0);
}

// `reflect-metadata` first: class-transformer reads `design:type` metadata
// through it (without it, implicit conversion throws `Reflect.getMetadata is
// not a function`).
await import("reflect-metadata");
const { plainToInstance } = await import("class-transformer");
const {
  IsInt,
  IsString,
  Min,
  validate: classValidate,
} = await import("class-validator");
const { targetConstructorToSchema } =
  await import("class-validator-jsonschema");

title("Class DTOs: validate and document with class-validator");

/** A query DTO — every wire value arrives as a string. */
class SearchQuery {
  @IsInt()
  @Min(1)
  page!: number;

  @IsString()
  q!: string;
}

/* ------------------------------------------------------------------ */
step("useClassDtos: inject the libraries, once at startup");

useClassDtos(
  { plainToInstance, validate: classValidate },
  // What the generated document reads for a DTO; without it a DTO validates
  // and documents as `{}` plus a warning.
  { toJsonSchema: (cls) => targetConstructorToSchema(cls) },
);
check("registered without touching bun-common's dependencies", true);

/* ------------------------------------------------------------------ */
step('a DTO on query: "42" validates to the number 42');

const router = new BunRouter();
router.get(
  "/search",
  // "respond": a failing DTO answers 400 with the issues, no error handler needed.
  validate({ query: SearchQuery }, { onFailure: "respond" }),
  (req, res) => {
    // req.query IS a SearchQuery instance — the class, typed and built.
    res.json({
      page: req.query.page,
      type: typeof req.query.page,
      q: req.query.q,
      instance: req.query instanceof SearchQuery,
    });
  },
);

const ok = await router.fetch("/search?page=42&q=bun");
checkEqual("a string query converted and validated", await ok.json(), {
  page: 42,
  type: "number",
  q: "bun",
  instance: true,
});

const bad = await router.fetch("/search?page=0&q=bun");
checkEqual("a failing DTO answers 400", bad.status, 400);
const badBody = (await bad.json()) as {
  issues: { target: string; path: string; message: string }[];
};
checkEqual(
  "…with the issue, keyed by the DTO's property",
  badBody.issues.map(({ target, path }) => `${target}.${path}`),
  ["query.page"],
);

/* ------------------------------------------------------------------ */
step("the generated document carries the DTO's schema");

const { document, warnings } = generateOpenApi(router, {
  title: "DTOs",
  version: "1",
});
const operation = (
  document.paths as Record<
    string,
    {
      get: {
        parameters: {
          name: string;
          in: string;
          required: boolean;
          schema: unknown;
        }[];
      };
    }
  >
)["/search"].get;
show("parameters", operation.parameters);
check(
  "the query DTO became OpenAPI parameters",
  operation.parameters.some(
    (parameter) =>
      parameter.name === "page" &&
      Bun.deepEquals(parameter.schema, { type: "integer", minimum: 1 }),
  ),
);
checkEqual(
  'no warnings — "respond"\'s implicit 400 covers the responses rule',
  warnings.length,
  0,
);

/* ------------------------------------------------------------------ */
step("the requirement, said out loud");

console.log(
  "  class DTOs need experimentalDecorators + emitDecoratorMetadata (and",
);
console.log(
  "  reflect-metadata imported first). Under stage-3 decorators the DTO",
);
console.log(
  "  module crashes when the class is defined — there is no degradation.",
);
check("printed the requirement", true);

summary();
