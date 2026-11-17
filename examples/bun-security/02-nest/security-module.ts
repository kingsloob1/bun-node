/**
 * bun-security in a NestJS application: `SecurityModule.forRoot()` from
 * `@kingsleyweb/bun-nest/security`, on bun-nest's `BunHttpAdapter`.
 *
 * ```bash
 * bun 02-nest/security-module.ts
 * ```
 *
 * - The module and the controller live in `modules/` (one role per file);
 *   this file boots them and sends requests through `adapter.fetch()`, the
 *   production pipeline with no socket.
 * - The early stage runs on the adapter's before-read hook, before any Nest
 *   middleware, guard or pipe: an address-listed client never reaches Nest.
 * - The route stage is `SecurityGuard`, a global guard: a refusal there is a
 *   `SecurityRefusalException` answered with the same problem body.
 *   `@SkipSecurity()` skips it on a route; `@SecurityProfile()` marks one.
 * - On bootstrap the module's self-test sends one marked request and checks a
 *   `SecurityGuard` is installed, so a defence that is not in the pipeline
 *   fails at start-up.
 */
import { BunHttpAdapter } from "@kingsleyweb/bun-nest";
import { NestFactory } from "@nestjs/core";
import { checkEqual, checkRejects, summary } from "../shared/check";
import { show, step, title } from "../shared/console";
import { AppModule } from "./modules/app.module";
import { UnguardedModule } from "./modules/unguarded.module";
import "reflect-metadata";

title("SecurityModule in a NestJS application");

const adapter = new BunHttpAdapter();
const app = await NestFactory.create(AppModule, adapter, { logger: false });
await app.init();

/** A request from `client`, through the adapter with no socket. */
async function request(
  path: string,
  client: string,
  init: { method?: string; headers?: Record<string, string> } = {},
): Promise<{ status: number; body: string }> {
  const response = await adapter.fetch(path, {
    remoteAddress: client,
    ...init,
  });
  return { status: response.status, body: await response.text() };
}

try {
  /* ------------------------------------------------------------------ */
  step("an ordinary request");
  const home = await request("/", "198.51.100.10");
  show("GET /", home);
  checkEqual("200", home.status, 200);

  /* ------------------------------------------------------------------ */
  step("the early stage: a listed address never reaches Nest");
  const early = await request("/", "203.0.113.7");
  show("from 203.0.113.7", early);
  checkEqual("403", early.status, 403);
  checkEqual(
    "the problem's code",
    (JSON.parse(early.body) as { code: string }).code,
    "blocked",
  );

  /* ------------------------------------------------------------------ */
  step("the route stage (SecurityGuard): a listed user, and a user's limit");
  const mallory = await request("/", "198.51.100.10", {
    headers: { "x-user-id": "u_mallory" },
  });
  checkEqual("u_mallory refused", mallory.status, 403);
  const statuses: number[] = [];
  for (let i = 0; i < 4; i++) {
    statuses.push(
      (
        await request("/", "198.51.100.11", {
          headers: { "x-user-id": "u_ada" },
        })
      ).status,
    );
  }
  show("u_ada, four times", statuses);
  checkEqual("the fourth is 429", statuses, [200, 200, 200, 429]);

  /* ------------------------------------------------------------------ */
  step("@SkipSecurity(): the guard lets the health check through");
  const health = await request("/health", "198.51.100.10", {
    headers: { "x-user-id": "u_mallory" },
  });
  checkEqual("u_mallory still reaches /health", health.status, 200);
  const healthEarly = await request("/health", "203.0.113.7");
  checkEqual(
    "…but the early stage still refuses a listed address",
    healthEarly.status,
    403,
  );

  /* ------------------------------------------------------------------ */
  step("@SecurityProfile() and @InjectSecurity()");
  const login = await request("/login", "198.51.100.12", { method: "POST" });
  checkEqual("the route's profile", JSON.parse(login.body), {
    profile: "login",
  });
  const why = await request("/why", "198.51.100.13");
  show("GET /why", why.body);
  checkEqual("explain() resolved the client", JSON.parse(why.body), {
    client: "198.51.100.13",
  });
} finally {
  await app.close();
}

/* ------------------------------------------------------------------ */
step("the boot self-test: an application with no SecurityGuard does not start");
await checkRejects(
  "init() rejects",
  async () => {
    const unguarded = await NestFactory.create(
      UnguardedModule,
      new BunHttpAdapter(),
      {
        logger: false,
        abortOnError: false,
      },
    );
    try {
      await unguarded.init();
    } finally {
      await unguarded.close();
    }
  },
  { message: /no SecurityGuard is installed/ },
);

summary();
