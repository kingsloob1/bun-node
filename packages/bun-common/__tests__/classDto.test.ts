/**
 * Class DTOs (AD phase (b2), plan `docs/plans/api-docs-generation/` §3.6):
 * `useClassDtos` / `fromDto`, a DTO class on each of the six request targets
 * and in the response positions, the `ConfigError` for a class without a
 * registered adapter, the document path through the `"class-validator"`
 * converter, and the test-isolation reset.
 *
 * class-validator 0.15.1, class-transformer 0.5.1 and
 * class-validator-jsonschema 5.2.0 are devDependencies, injected through the
 * adapter exactly as a consumer would. `reflect-metadata` must be imported
 * before the DTO modules (the README states it as a requirement).
 *
 * The stage-3 decorators negative test (a child process with its own
 * tsconfig) lives at the bottom; the type tests in `classDto.type-test.ts`.
 */
import "reflect-metadata";
import { beforeEach, describe, expect, it } from "bun:test";
import { plainToInstance, Type } from "class-transformer";
import {
  IsInt,
  IsString,
  Min,
  validate as classValidate,
  ValidateNested,
} from "class-validator";
import { targetConstructorToSchema } from "class-validator-jsonschema";
import { BunRouter } from "../lib/BunRouter";
import { validate } from "../lib/BunValidate";
import type { DtoClass } from "../lib/classDto";
import {
  fromDto,
  isDtoClass,
  resetClassDtos,
  useClassDtos,
} from "../lib/classDto";
import type { ConversionWarning, JsonSchemaLike } from "../lib/docs/convert";
import { toJsonSchema } from "../lib/docs/convert";
import { generateOpenApi } from "../lib/docs/openapi";
import { ConfigError } from "../lib/errors";
import { createTestLogger } from "../lib/logging";
import { requestParsing } from "../lib/requestParsing";
import { ResponseValidationError } from "../lib/responseValidation";
import type { RouterErrorMiddlewareHandler } from "../lib/types/general";
import type { StandardSchemaV1 } from "../lib/types/standardSchema";
import { signCookie } from "../lib/utils/native";

/* ------------------------------------------------------------------ *
 * The DTOs.
 * ------------------------------------------------------------------ */

class Address {
  @IsString()
  city!: string;
}

/** A query/params DTO: every wire value arrives as a string. */
class PageQuery {
  @IsInt()
  @Min(1)
  page!: number;

  @IsString()
  name!: string;
}

/** A params DTO: the path supplies every key it declares. */
class PageParams {
  @IsInt()
  @Min(1)
  page!: number;
}

/** A body DTO with a nested class. */
class CreateUser {
  @IsString()
  name!: string;

  @ValidateNested()
  @Type(() => Address)
  address!: Address;
}

/** A whole-instance DTO, for the response side. */
class UserResult {
  @IsInt()
  id!: number;

  @IsString()
  name!: string;

  /** A method, so a structurally-identical plain object is not one. */
  label(): string {
    return `${this.id}:${this.name}`;
  }
}

const SECRET = "k1";
/** A cookie value signed the way `res.cookie(name, value, { signed: true })` signs it. */
const signed = (value: string): string =>
  encodeURIComponent(`s:${signCookie(value, SECRET)}`);
const withSecret = requestParsing({ parseCookies: { secret: SECRET } });

/** The adapter a consumer assembles from the two libraries. */
const adapter = { plainToInstance, validate: classValidate };

/**
 * `targetConstructorToSchema`'s result, as the document's `JsonSchemaLike`:
 * its `SchemaObject` has no index signature (**measured** on
 * class-validator-jsonschema 5.2.0), which is why `ClassDtoOptions.toJsonSchema`
 * returns `object`.
 */
const jsonSchemaOfDto = (cls: DtoClass): JsonSchemaLike =>
  targetConstructorToSchema(cls) as unknown as JsonSchemaLike;

/** Registers the adapter with `targetConstructorToSchema` as the JSON Schema producer. */
function registerWithJsonSchema(): void {
  useClassDtos(adapter, {
    toJsonSchema: jsonSchemaOfDto,
  });
}

beforeEach(() => {
  resetClassDtos();
});

/* ------------------------------------------------------------------ *
 * fromDto itself.
 * ------------------------------------------------------------------ */

describe("fromDto", () => {
  it("wraps a class as a Standard Schema stamped vendor class-validator", () => {
    useClassDtos(adapter);
    const schema = fromDto(PageQuery);
    expect(schema["~standard"].vendor).toBe("class-validator");
    expect(isDtoClass(schema)).toBe(false);
    expect(isDtoClass(PageQuery)).toBe(true);
  });

  it("validate is always async, and answers with the class instance", async () => {
    useClassDtos(adapter);
    const schema = fromDto(PageQuery);
    const outcome = schema["~standard"].validate({ page: "42", name: "ada" });
    expect(outcome).toBeInstanceOf(Promise);
    const result = await outcome;
    expect("value" in result && result.value).toBeInstanceOf(PageQuery);
    expect("value" in result && result.value.page).toBe(42);
  });

  it("maps class-validator's per-property errors to Standard Schema issues", async () => {
    useClassDtos(adapter);
    const schema = fromDto(CreateUser);
    // `name` absent: under enableImplicitConversion a present `7` would
    // coerce to "7" and PASS IsString — the absence is what fails.
    const result = (await schema["~standard"].validate({
      address: {},
    })) as StandardSchemaV1.FailureResult;
    expect(result.issues).toBeDefined();
    const byPath = Object.fromEntries(
      result.issues.map((issue) => [
        (issue.path ?? []).map(String).join("."),
        issue.message,
      ]),
    );
    expect(Object.keys(byPath).sort()).toEqual(["address.city", "name"]);
    expect(byPath.name).toContain("string");
    expect(byPath["address.city"]).toContain("string");
  });

  it("carries ~standard.jsonSchema only when the options carry toJsonSchema", () => {
    useClassDtos(adapter);
    expect(
      (fromDto(PageQuery)["~standard"] as { jsonSchema?: unknown }).jsonSchema,
    ).toBeUndefined();

    registerWithJsonSchema();
    const withJson = fromDto(PageQuery)["~standard"] as unknown as {
      jsonSchema: { input: (o: object) => Record<string, unknown> };
    };
    expect(withJson.jsonSchema.input({ target: "draft-2020-12" })).toEqual(
      jsonSchemaOfDto(PageQuery),
    );

    // A per-call producer overrides the registration's.
    useClassDtos(adapter);
    const perCall = fromDto(PageQuery, {
      toJsonSchema: () => ({ type: "object", description: "mine" }),
    })["~standard"] as unknown as {
      jsonSchema: { input: (o: object) => Record<string, unknown> };
    };
    expect(perCall.jsonSchema.input({ target: "draft-2020-12" })).toEqual({
      type: "object",
      description: "mine",
    });
  });

  it("refuses a non-class and, with no adapter registered, names useClassDtos", () => {
    useClassDtos(adapter);
    expect(() => fromDto({} as never)).toThrow(TypeError);

    resetClassDtos();
    try {
      fromDto(PageQuery);
      expect.unreachable("fromDto without a registration must throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as Error).message).toContain("useClassDtos");
    }
  });

  it("the measured whitelist behaviour: the default strips extras, whitelist: false keeps them", async () => {
    useClassDtos(adapter);
    const schema = fromDto(PageQuery);
    const stripped = (await schema["~standard"].validate({
      page: "42",
      name: "ada",
      extra: "x",
    })) as StandardSchemaV1.SuccessResult<PageQuery>;
    // Measured on class-validator 0.15.1: `whitelist: true` (the default)
    // removes undeclared properties from the instance.
    expect(
      (stripped.value as unknown as Record<string, unknown>).extra,
    ).toBeUndefined();

    const kept = (await fromDto(PageQuery, {
      validate: { whitelist: false },
    })["~standard"].validate({
      page: "42",
      name: "ada",
      extra: "x",
    })) as StandardSchemaV1.SuccessResult<PageQuery>;
    expect((kept.value as unknown as Record<string, unknown>).extra).toBe("x");
  });
});

/* ------------------------------------------------------------------ *
 * The six request targets.
 * ------------------------------------------------------------------ */

describe("validate() with a DTO class", () => {
  it('query: implicit conversion makes "42" a number, written back and on req.valid', async () => {
    useClassDtos(adapter);
    const router = new BunRouter();
    router.get("/q", validate({ query: PageQuery }), (req, res) => {
      res.json({
        page: req.query.page,
        type: typeof req.query.page,
        instance: req.query instanceof PageQuery,
        validInstance: req.valid.query instanceof PageQuery,
      });
    });
    const response = await router.fetch("/q?page=42&name=ada");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      page: 42,
      type: "number",
      instance: true,
      validInstance: true,
    });
  });

  it("params: the path's strings convert too", async () => {
    useClassDtos(adapter);
    const router = new BunRouter();
    router.get("/p/:page", validate({ params: PageParams }), (req, res) => {
      res.json({
        page: req.params.page,
        instance: req.params instanceof PageParams,
      });
    });
    const response = await router.fetch("/p/42");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ page: 42, instance: true });
  });

  it("body: a nested @Type arrives as a real instance", async () => {
    useClassDtos(adapter);
    const router = new BunRouter();
    router.post("/b", validate({ body: CreateUser }), (req, res) => {
      res.json({
        name: req.body.name,
        nested: req.body.address instanceof Address,
        city: req.body.address.city,
      });
    });
    const response = await router.fetch("/b", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "ada", address: { city: "Lagos" } }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      name: "ada",
      nested: true,
      city: "Lagos",
    });
  });

  it("body: per-property issues reach the client, nested under their path", async () => {
    useClassDtos(adapter);
    const router = new BunRouter();
    router.post(
      "/b",
      validate({ body: CreateUser }, { onFailure: "respond" }),
      (_req, res) => res.send("unreachable"),
    );
    const response = await router.fetch("/b", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ address: {} }),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as {
      issues: { target: string; path: string; message: string }[];
    };
    expect(body.issues.map(({ target, path }) => ({ target, path }))).toEqual([
      { target: "body", path: "name" },
      { target: "body", path: "address.city" },
    ]);
  });

  it("headers: validated, on req.valid.headers, never written back", async () => {
    class TokenHeaders {
      @IsString()
      "x-token"!: string;
    }
    useClassDtos(adapter);
    const router = new BunRouter();
    router.get("/h", validate({ headers: TokenHeaders }), (req, res) => {
      res.json({
        valid: req.valid.headers instanceof TokenHeaders,
        token: req.valid.headers["x-token"],
      });
    });
    const ok = await router.fetch("/h", { headers: { "x-token": "t" } });
    expect(await ok.json()).toEqual({ valid: true, token: "t" });
  });

  it("cookies and signedCookies: written back, converted", async () => {
    class CookieJar {
      @IsInt()
      n!: number;
    }
    useClassDtos(adapter);

    const router = new BunRouter();
    router.get("/c", validate({ cookies: CookieJar }), (req, res) => {
      res.json({
        n: req.cookies.n,
        type: typeof req.cookies.n,
        instance: req.cookies instanceof CookieJar,
      });
    });
    const response = await router.fetch("/c", { headers: { cookie: "n=7" } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      n: 7,
      type: "number",
      instance: true,
    });

    // The signed half: an unsigned cookie is absent from signedCookies, so
    // the DTO fails; a signed one validates and converts.
    const signedRouter = new BunRouter();
    signedRouter.get(
      "/s",
      withSecret,
      validate({ signedCookies: CookieJar }, { onFailure: "respond" }),
      (req, res) => res.json({ n: req.signedCookies.n }),
    );
    const forged = await signedRouter.fetch("/s", {
      headers: { cookie: "n=7" },
    });
    expect(forged.status).toBe(400);
    const verified = await signedRouter.fetch("/s", {
      headers: { cookie: `n=${signed("7")}` },
    });
    expect(verified.status).toBe(200);
    expect(await verified.json()).toEqual({ n: 7 });
  });

  it("a DTO class in a schema slot without a registration is a ConfigError naming useClassDtos", () => {
    expect(() => validate({ query: PageQuery })).toThrow(ConfigError);
    try {
      validate({ query: PageQuery });
    } catch (error) {
      expect((error as Error).message).toContain("useClassDtos");
    }
  });
});

/* ------------------------------------------------------------------ *
 * The response side.
 * ------------------------------------------------------------------ */

describe("responses with a DTO class", () => {
  it("a declared status takes the instance and checks it at runtime", async () => {
    useClassDtos(adapter);
    const router = new BunRouter({ responseValidation: "error" });
    router.post(
      "/users",
      validate({ body: CreateUser }, { responses: { 201: UserResult } }),
      (req, res) => {
        const result = new UserResult();
        result.id = 1;
        result.name = req.body.name;
        res.status(201).json(result);
      },
    );
    const ok = await router.fetch("/users", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "ada", address: { city: "Lagos" } }),
    });
    expect(ok.status).toBe(201);
    expect(await ok.json()).toEqual({ id: 1, name: "ada" });
  });

  it("a mismatching response is refused under responseValidation: error", async () => {
    useClassDtos(adapter);
    const { logger } = createTestLogger();
    const router = new BunRouter({ responseValidation: "error", logger });
    router.post(
      "/users",
      validate({ body: CreateUser }, { responses: { 201: UserResult } }),
      (_req, res) => {
        const wrong = new UserResult();
        wrong.id = "one" as unknown as number;
        wrong.name = "ada";
        res.status(201).json(wrong);
      },
    );
    router.use(((error, _req, res, _next) => {
      const refusal = error as ResponseValidationError;
      res.status(500).json({
        error: refusal.name,
        issues: refusal.issues.map(
          (issue) =>
            `${issue.target}${issue.path === "" ? "" : `.${issue.path}`}`,
        ),
      });
    }) satisfies RouterErrorMiddlewareHandler);
    const response = await router.fetch("/users", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "ada", address: { city: "Lagos" } }),
    });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: "ResponseValidationError",
      issues: ["body.id"],
    });
  });

  it("the content-map position takes a DTO class too", async () => {
    useClassDtos(adapter);
    const router = new BunRouter({ responseValidation: "error" });
    router.get(
      "/user",
      validate(
        {},
        { responses: { 200: { content: { "application/json": UserResult } } } },
      ),
      (_req, res) => {
        const result = new UserResult();
        result.id = 7;
        result.name = "ada";
        res.status(200).json(result);
      },
    );
    const response = await router.fetch("/user");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: 7, name: "ada" });
  });

  it("a DTO class in responses without a registration is the same ConfigError", () => {
    expect(() => validate({}, { responses: { 201: UserResult } })).toThrow(
      ConfigError,
    );
  });
});

/* ------------------------------------------------------------------ *
 * The document path.
 * ------------------------------------------------------------------ */

describe("class DTOs in the generated document", () => {
  it("the converter emits the injected toJsonSchema's result", () => {
    registerWithJsonSchema();
    expect(toJsonSchema(fromDto(PageQuery))).toEqual(
      jsonSchemaOfDto(PageQuery),
    );
  });

  it("without toJsonSchema a DTO documents as {} plus a warning", () => {
    useClassDtos(adapter);
    const warnings: ConversionWarning[] = [];
    const json = toJsonSchema(fromDto(PageQuery), {
      onWarning: (warning) => warnings.push(warning),
    });
    expect(json).toEqual({});
    // The converter declined, then the top-level fallback — both recorded.
    expect(warnings).toEqual([
      {
        vendor: "class-validator",
        stage: "converter",
        message:
          'the "class-validator" converter could not describe the schema',
      },
      {
        vendor: "class-validator",
        stage: "unsupported",
        message:
          "no conversion path could describe the schema; `{}` (any value) was emitted",
      },
    ]);
  });

  it("the registry converter reads the current registration's toJsonSchema", () => {
    // Wrapped while the registration has no producer: no ~standard.jsonSchema
    // of its own, so conversion falls through to the registry converter…
    useClassDtos(adapter);
    const schema = fromDto(PageQuery);
    expect(toJsonSchema(schema)).toEqual({});
    // …which answers once a producer is registered.
    registerWithJsonSchema();
    expect(toJsonSchema(schema)).toEqual(jsonSchemaOfDto(PageQuery));
  });

  it("a DTO on the validator and on .describe() both reach the document", () => {
    registerWithJsonSchema();
    const router = new BunRouter();
    router.get(
      "/search",
      validate({ query: PageQuery }, { responses: { 200: UserResult } }),
      (_req, res) => {
        const result = new UserResult();
        result.id = 1;
        result.name = "ada";
        res.status(200).json(result);
      },
    );
    router
      .get("/annotated", (_req, res) => res.json({}))
      .describe({
        request: { query: PageQuery },
        responses: { 200: UserResult },
      });
    const { document, warnings } = generateOpenApi(router, {
      title: "T",
      version: "1",
    });
    expect(warnings).toEqual([]);

    const paths = document.paths as Record<string, Record<string, never>>;
    const search = paths["/search"].get as {
      parameters: { name: string; schema: Record<string, unknown> }[];
      responses: Record<
        string,
        { content: Record<string, { schema: unknown }> }
      >;
    };
    expect(
      search.parameters.find((parameter) => parameter.name === "page")?.schema,
    ).toEqual({ type: "integer", minimum: 1 });
    // …and the validator's response-status DTO as the 200's body schema.
    expect(search.responses["200"].content["application/json"].schema).toEqual(
      jsonSchemaOfDto(UserResult),
    );

    const annotated = paths["/annotated"].get as {
      parameters: { name: string }[];
      responses: Record<
        string,
        { content: Record<string, { schema: unknown }> }
      >;
    };
    // The .describe() query DTO documented as parameters…
    expect(annotated.parameters.map((parameter) => parameter.name)).toEqual([
      "page",
      "name",
    ]);
    // …and the response-status DTO as the 200's body schema.
    expect(
      annotated.responses["200"].content["application/json"].schema,
    ).toEqual(jsonSchemaOfDto(UserResult));
  });

  it("a DTO in .describe() without a registration is the ConfigError", () => {
    const router = new BunRouter();
    router
      .get("/annotated", (_req, res) => res.json({}))
      .describe({ request: { query: PageQuery } });
    expect(() => generateOpenApi(router, { title: "T", version: "1" })).toThrow(
      ConfigError,
    );
  });
});

/* ------------------------------------------------------------------ *
 * Test isolation.
 * ------------------------------------------------------------------ */

describe("resetClassDtos", () => {
  it("removes the adapter and the converter, so nothing leaks between files", () => {
    useClassDtos(adapter);
    const schema = fromDto(PageQuery);
    resetClassDtos();

    // The adapter is gone…
    expect(() => fromDto(PageQuery)).toThrow(ConfigError);
    expect(() => validate({ query: PageQuery })).toThrow(ConfigError);
    // …and the schema it wrapped no longer converts (the converter went with
    // the registration; the schema has no ~standard.jsonSchema of its own).
    const warnings: ConversionWarning[] = [];
    expect(
      toJsonSchema(schema, { onWarning: (warning) => warnings.push(warning) }),
    ).toEqual({});
    expect(warnings[0]?.stage).toBe("unsupported");
  });
});

/* ------------------------------------------------------------------ *
 * Stage-3 decorators: the documented hard break (plan §3.6, risk 1e).
 * A consumer WITHOUT experimentalDecorators cannot load a class-validator
 * DTO at all — measured on class-validator 0.15.1 under Bun 1.4.4:
 * `TypeError: undefined is not an object (evaluating 'object.constructor')`
 * at class-definition time. The fixtures carry their own tsconfig and run
 * as child processes with the fixture directory as cwd, because Bun
 * resolves tsconfig from the cwd upward (measured).
 * ------------------------------------------------------------------ */

describe("the experimentalDecorators requirement (plan risk 1e)", () => {
  const fixtures = `${import.meta.dir}/fixtures/classDto-stage3`;

  /** Runs `bun dto.ts` in the fixture's own directory. */
  function runFixture(variant: "off" | "on"): {
    exitCode: number;
    stdout: string;
    stderr: string;
  } {
    const child = Bun.spawnSync({
      cmd: [process.execPath, "dto.ts"],
      cwd: `${fixtures}/${variant}`,
      stdout: "pipe",
      stderr: "pipe",
    });
    return {
      exitCode: child.exitCode,
      stdout: child.stdout.toString(),
      stderr: child.stderr.toString(),
    };
  }

  it("without experimentalDecorators the DTO crashes at class-definition time", () => {
    const { exitCode, stderr } = runFixture("off");
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("TypeError: undefined is not an object");
    expect(stderr).toContain("object.constructor");
  });

  it("control: the same DTO with experimentalDecorators boots", () => {
    const { exitCode, stdout } = runFixture("on");
    expect(exitCode).toBe(0);
    expect(stdout).toContain("booted Stage3Dto");
  });
});
