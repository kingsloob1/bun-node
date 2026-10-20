/**
 * Nest 12's HTTP security features on bun-nest: `app.useSecurityHeaders()`
 * and `app.enableCsrfProtection()` (12.1.0, nestjs/nest #17836, #17941),
 * which install one request hook through the adapter's
 * `registerSecurityHook`.
 *
 * The shapes of Nest's own `integration/security/e2e/csrf-protection.spec.ts`
 * and `security-headers.spec.ts` (v12.1.3), ported, not copied: the
 * helmet-equivalent headers on every kind of answer, the `403` carrying them
 * whichever feature is enabled first, the check running before guards and
 * before the body is read, unmatched routes protected, exception filters
 * shaping the `403`, and the order fixed before `init()`. Beside them, what
 * is ours: the `403` keeps headers earlier middleware set (the error is
 * answered on the request's response, G5), the body is deferred only once a
 * hook is registered (Q7, G6), and `useSecurityHeaders()`'s
 * `disable("x-powered-by")` is silent (G19). Requests go through
 * `adapter.fetch()`; one block is served.
 *
 * Nest below 12.1 has neither feature, so those blocks are skipped there,
 * visibly. The features are reached through a structural type: Nest 11's
 * `INestApplication` lacks them.
 *
 * `reflect-metadata` is imported last per the import-sort rule.
 */
import type {
  ArgumentsHost,
  CanActivate,
  ExceptionFilter,
  INestApplication,
} from "@nestjs/common";
import type { Observable } from "rxjs";
import {
  Body,
  Catch,
  Controller,
  ForbiddenException,
  Get,
  Injectable,
  Logger,
  Module,
  Post,
  Sse,
  UseGuards,
} from "@nestjs/common";
import { NestApplication, NestFactory } from "@nestjs/core";
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { of } from "rxjs";
import { BunHttpAdapter } from "../lib/BunHttpAdapter";
import "reflect-metadata";

/** Whether this Nest has the HTTP security features (12.1.0+). */
const HAS_SECURITY =
  typeof Reflect.get(NestApplication.prototype, "enableCsrfProtection") ===
  "function";
const describeSecurity = HAS_SECURITY ? describe : describe.skip;
const SKIPPED = HAS_SECURITY
  ? ""
  : " (skipped: Nest below 12.1 has no useSecurityHeaders()/enableCsrfProtection())";

/** The security features' application methods, where this Nest has them. */
type SecureApp = INestApplication & {
  useSecurityHeaders: (options?: object) => SecureApp;
  enableCsrfProtection: (options?: {
    exclude?: string[];
    trustedOrigins?: string[];
  }) => SecureApp;
  useBodyParser: (type: string, options?: object) => unknown;
};

/** The headers `useSecurityHeaders()` sets by default (Nest's spec). */
const DEFAULT_HEADERS: Record<string, string> = {
  "content-security-policy":
    "default-src 'self';base-uri 'self';font-src 'self' https: data:;" +
    "form-action 'self';frame-ancestors 'self';img-src 'self' data:;" +
    "object-src 'none';script-src 'self';script-src-attr 'none';" +
    "style-src 'self' https: 'unsafe-inline';upgrade-insecure-requests",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
  "origin-agent-cluster": "?1",
  "referrer-policy": "no-referrer",
  "strict-transport-security": "max-age=31536000; includeSubDomains",
  "x-content-type-options": "nosniff",
  "x-dns-prefetch-control": "off",
  "x-download-options": "noopen",
  "x-frame-options": "SAMEORIGIN",
  "x-permitted-cross-domain-policies": "none",
  "x-xss-protection": "0",
};

/**
 * Every default header, each exactly once (`Headers.get` joins a repeated
 * one with `, `, which then fails the comparison), and no `X-Powered-By`.
 */
function expectDefaultHeaders(headers: Headers) {
  const seen = Object.fromEntries(
    Object.keys(DEFAULT_HEADERS).map((name) => [name, headers.get(name)]),
  );
  expect(seen).toEqual(DEFAULT_HEADERS);
  expect(headers.get("x-powered-by")).toBeNull();
}

/** A cross-site browser request's headers. */
const CROSS_SITE = {
  "sec-fetch-site": "cross-site",
  origin: "https://evil.example",
};

/** Records whether the guard ran, to show the check runs before guards. */
const guardCalls: string[] = [];

@Injectable()
class RecordingGuard implements CanActivate {
  canActivate() {
    guardCalls.push("guard");
    return true;
  }
}

@Controller()
class ItemsController {
  @Get("items")
  list() {
    return ["a"];
  }

  @Post("items")
  create(@Body() body: unknown) {
    return { body: body ?? null };
  }

  @Post("guarded")
  @UseGuards(RecordingGuard)
  guarded() {
    return "guarded";
  }

  @Post("webhooks")
  webhook() {
    return "hooked";
  }

  @Get("error")
  error() {
    throw new Error("boom");
  }

  @Sse("events")
  events(): Observable<{ data: string }> {
    return of({ data: "one" });
  }
}

@Module({ controllers: [ItemsController], providers: [RecordingGuard] })
class ItemsModule {}

/** Shapes the CSRF `403` as a problem document (Nest's spec). */
@Catch(ForbiddenException)
class ProblemDetailsFilter implements ExceptionFilter {
  catch(exception: ForbiddenException, host: ArgumentsHost) {
    host
      .switchToHttp()
      .getResponse<{
        status: (code: number) => {
          type: (type: string) => { json: (body: unknown) => unknown };
        };
      }>()
      .status(403)
      .type("application/problem+json")
      .json({ title: "Forbidden", status: 403, detail: exception.message });
  }
}

/** An application, its adapter, and how it was set up. */
interface Booted {
  app: SecureApp;
  adapter: BunHttpAdapter;
}

let booted: Booted | undefined;

afterEach(async () => {
  await booted?.app.close();
  booted = undefined;
  guardCalls.length = 0;
});

/** Boots {@link ItemsModule} on a fresh adapter, configured by `configure`. */
async function boot(
  configure: (app: SecureApp) => void,
  adapter = new BunHttpAdapter(),
  listen = false,
): Promise<Booted> {
  // `abortOnError: false`: a call that throws (enabling a feature after
  // init) is rethrown, not answered with `process.exit(1)`.
  const app = (await NestFactory.create(ItemsModule, adapter, {
    logger: false,
    abortOnError: false,
  })) as unknown as SecureApp;
  configure(app);
  if (listen) {
    await app.listen(0, "127.0.0.1");
  } else {
    await app.init();
  }
  booted = { app, adapter };
  return booted;
}

/** A `POST /items` with a JSON content type and `body`, plus `headers`. */
function postItems(
  adapter: BunHttpAdapter,
  body: string,
  headers: Record<string, string> = {},
) {
  return adapter.fetch("/items", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  });
}

describeSecurity(`useSecurityHeaders()${SKIPPED}`, () => {
  it("sets the helmet-equivalent defaults on a 200, a 404, a 500 and an SSE stream", async () => {
    const { adapter } = await boot((app) => app.useSecurityHeaders());
    for (const [path, status] of [
      ["/items", 200],
      ["/does-not-exist", 404],
      ["/error", 500],
      ["/events", 200],
    ] as const) {
      const response = await adapter.fetch(path);
      expect(response.status).toBe(status);
      expectDefaultHeaders(response.headers);
      await response.body?.cancel();
    }
  });

  it("turns X-Powered-By off silently: the adapter never sends it", async () => {
    const logger = new Logger("security-test");
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    const { adapter } = await boot(
      (app) => app.useSecurityHeaders(),
      new BunHttpAdapter(0, { logger }),
    );
    const response = await adapter.fetch("/items");
    expect(response.headers.get("x-powered-by")).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });
});

describeSecurity(`enableCsrfProtection()${SKIPPED}`, () => {
  for (const [order, configure] of [
    [
      "useSecurityHeaders() first",
      (app: SecureApp) => app.useSecurityHeaders().enableCsrfProtection(),
    ],
    [
      "enableCsrfProtection() first",
      (app: SecureApp) => app.enableCsrfProtection().useSecurityHeaders(),
    ],
  ] as const) {
    it(`a 403 carries the security headers (${order})`, async () => {
      const { adapter } = await boot(configure);
      const refused = await postItems(adapter, '{"a":1}', CROSS_SITE);
      expect(refused.status).toBe(403);
      expect(await refused.json()).toEqual({
        message: "Cross-origin request detected from Sec-Fetch-Site header",
        error: "Forbidden",
        statusCode: 403,
      });
      expectDefaultHeaders(refused.headers);

      const allowed = await postItems(adapter, '{"a":1}', {
        "sec-fetch-site": "same-origin",
      });
      expect(allowed.status).toBe(201);
      expect(await allowed.json()).toEqual({ body: { a: 1 } });
      expectDefaultHeaders(allowed.headers);
    });
  }

  it("a 403 keeps the headers middleware set before the hook ran", async () => {
    const { adapter } = await boot((app) => {
      app.use(
        (
          _req: unknown,
          res: { setHeader: (n: string, v: string) => void },
          next: () => void,
        ) => {
          res.setHeader("x-before", "set");
          next();
        },
      );
      app.enableCsrfProtection();
    });
    const refused = await postItems(adapter, "{}", CROSS_SITE);
    expect(refused.status).toBe(403);
    expect(refused.headers.get("x-before")).toBe("set");
  });

  it("refuses before the body is read: a malformed or oversized body gets the 403", async () => {
    const { adapter } = await boot((app) => {
      app.enableCsrfProtection();
      app.useBodyParser("json", { limit: "1kb" });
    });
    const big = JSON.stringify({ pad: "x".repeat(4000) });

    expect((await postItems(adapter, "{not json", CROSS_SITE)).status).toBe(
      403,
    );
    expect((await postItems(adapter, big, CROSS_SITE)).status).toBe(403);
    // Allowed, the same bodies are read and refused as before.
    const sameOrigin = { "sec-fetch-site": "same-origin" };
    expect((await postItems(adapter, "{not json", sameOrigin)).status).toBe(
      400,
    );
    expect((await postItems(adapter, big, sameOrigin)).status).toBe(413);
    const parsed = await postItems(adapter, '{"a":[1]}', sameOrigin);
    expect(parsed.status).toBe(201);
    expect(await parsed.json()).toEqual({ body: { a: [1] } });
  });

  it("runs before guards, and protects unmatched routes", async () => {
    const { adapter } = await boot((app) => app.enableCsrfProtection());
    const guarded = await adapter.fetch("/guarded", {
      method: "POST",
      headers: CROSS_SITE,
    });
    expect(guarded.status).toBe(403);
    expect(guardCalls).toEqual([]);

    const unmatched = await adapter.fetch("/does-not-exist", {
      method: "POST",
      headers: CROSS_SITE,
    });
    expect(unmatched.status).toBe(403);
  });

  it("allows GET, trusted origins and excluded routes", async () => {
    const { adapter } = await boot((app) =>
      app.enableCsrfProtection({
        trustedOrigins: ["https://trusted.example"],
        exclude: ["webhooks"],
      }),
    );
    expect(
      (await adapter.fetch("/items", { headers: CROSS_SITE })).status,
    ).toBe(200);
    expect(
      (
        await postItems(adapter, "{}", {
          ...CROSS_SITE,
          origin: "https://trusted.example",
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await adapter.fetch("/webhooks", {
          method: "POST",
          headers: CROSS_SITE,
        })
      ).status,
    ).toBe(201);
  });

  it("lets exception filters shape the 403", async () => {
    const { adapter } = await boot((app) => {
      app.useGlobalFilters(new ProblemDetailsFilter());
      app.enableCsrfProtection();
    });
    const refused = await postItems(adapter, "{}", CROSS_SITE);
    expect(refused.status).toBe(403);
    // The filter's `type("application/problem+json")` is not asserted:
    // bun-common's `res.json()` replaces a Content-Type set before it, where
    // Express keeps it (expressCompat "res.type(problem+json).json(object)").
    expect(await refused.json()).toEqual({
      title: "Forbidden",
      status: 403,
      detail: "Cross-origin request detected from Sec-Fetch-Site header",
    });
  });

  it("served: the 403 carries the headers, before the body is read", async () => {
    const { adapter } = await boot(
      (app) => app.useSecurityHeaders().enableCsrfProtection(),
      new BunHttpAdapter(),
      true,
    );
    const refused = await fetch(`${adapter.url}/items`, {
      method: "POST",
      headers: { ...CROSS_SITE, "content-type": "application/json" },
      body: "{not json",
    });
    expect(refused.status).toBe(403);
    expectDefaultHeaders(refused.headers);
    await refused.body?.cancel();
  });

  it("throws when enabled after init", async () => {
    const { app } = await boot(() => undefined);
    expect(() => app.enableCsrfProtection()).toThrow(
      /must be called before app\.init\(\)/,
    );
  });
});

describe("deferring the body: only once a security hook is registered (Q7)", () => {
  it("an application without the features reads bodies while the request is built", async () => {
    const { adapter } = await boot(() => undefined);
    expect(adapter.requestOpts.deferBody).toBeUndefined();
  });

  it("registerSecurityHook() defers the body, and keeps it deferred over later request options", () => {
    const adapter = new BunHttpAdapter();
    adapter.registerSecurityHook(() => undefined);
    expect(adapter.requestOpts.deferBody).toBe(true);
    adapter.setRequestOpts({ parseCookies: false });
    expect(adapter.requestOpts.deferBody).toBe(true);
  });

  it("an explicit deferBody wins over the hook's", () => {
    const adapter = new BunHttpAdapter(0, { request: { deferBody: false } });
    adapter.registerSecurityHook(() => undefined);
    expect(adapter.requestOpts.deferBody).toBe(false);
  });

  it("registerSecurityHook() hands the hook's error to the error handling, on the request's response", async () => {
    const adapter = new BunHttpAdapter();
    adapter.registerSecurityHook((_req, res) => {
      res.setHeader("x-hook", "ran");
      return new Error("refused");
    });
    adapter.post("/x", (_req, res) => res.send("routed"));
    adapter.setErrorHandler((error, _req, res, _next) => {
      res.status(403).json({ refused: (error as Error).message });
    });
    const response = await adapter.fetch("/x", { method: "POST", body: "{" });
    expect(response.status).toBe(403);
    expect(response.headers.get("x-hook")).toBe("ran");
    expect(await response.json()).toEqual({ refused: "refused" });
  });
});
