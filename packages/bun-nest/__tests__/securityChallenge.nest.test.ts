/**
 * Challenges on a Nest application (bun-security PR-S9, layers.md L10.2):
 * `SecurityModule` with a challenge flow answers an address challenge in
 * the early stage with the flow's problem, takes the answer there (before
 * Nest's body parser), and admits the client holding the clearance. A
 * route-stage challenge (`SecurityGuard`, a user list entry here) answers
 * the flow's own challenge too: the problem with its descriptor for an API
 * client, the page under its strict CSP for a browser, through Nest's
 * exception layer as a `SecurityChallengeException`. Without a flow it is
 * the bare refusal, as before (the negative control).
 */
import type { BunRequest } from "@kingsleyweb/bun-common";
import type {
  ArgumentsHost,
  ExceptionFilter,
  INestApplication,
} from "@nestjs/common";
import type { SecurityModuleOptions } from "../lib/security/index";
import {
  challenges,
  powChallenge,
  solvePowChallenge,
} from "@kingsleyweb/bun-security/challenge";
import type { PowChallengeData } from "@kingsleyweb/bun-security/challenge";
import { Catch, Controller, Get, Module } from "@nestjs/common";
import { APP_FILTER, NestFactory } from "@nestjs/core";
import { afterEach, describe, expect, it } from "bun:test";
import { BunHttpAdapter } from "../lib/BunHttpAdapter";
import {
  SecurityChallengeException,
  SecurityModule,
  SecurityRefusalException,
} from "../lib/security/index";
import "reflect-metadata";

/** Applications to close after each test. */
const apps: INestApplication[] = [];

afterEach(async () => {
  for (const app of apps.splice(0).reverse()) await app.close();
});

@Controller()
class AppController {
  @Get("orders")
  orders() {
    return "orders";
  }
}

/** Boots the controller under `SecurityModule.forRoot(options)`. */
async function boot(
  options: Partial<SecurityModuleOptions>,
  providers: unknown[] = [],
): Promise<BunHttpAdapter> {
  class AppModule {}
  Module({
    imports: [
      SecurityModule.forRoot({
        policy: {},
        logger: () => {},
        identify: (req: BunRequest) => {
          const user = req.request.headers.get("x-user");
          return user === null ? undefined : { user };
        },
        challenge: challenges({
          provider: powChallenge({ secret: "p".repeat(32), maxNumber: 300 }),
          secret: "c".repeat(32),
        }),
        ...options,
      } as SecurityModuleOptions),
    ],
    controllers: [AppController],
    providers: providers as never[],
  })(AppModule);
  const adapter = new BunHttpAdapter();
  const app = await NestFactory.create(AppModule, adapter, {
    logger: false,
    abortOnError: false,
  });
  apps.push(app);
  await app.init();
  return adapter;
}

const PEER = "203.0.113.10";

describe("SecurityModule with a challenge flow", () => {
  it("challenges an address early, takes the answer, and admits the cleared client", async () => {
    const adapter = await boot({
      policy: { lists: [{ ip: "203.0.113.0/24", action: "challenge" }] },
    });
    const problem = await adapter.fetch("/orders", {
      headers: { accept: "application/json" },
      remoteAddress: PEER,
    });
    expect(problem.status).toBe(403);
    const body = (await problem.json()) as {
      code: string;
      challenge: { path: string; data: PowChallengeData };
    };
    expect(body.code).toBe("challenge_required");
    const answered = await adapter.fetch(body.challenge.path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ answer: solvePowChallenge(body.challenge.data) }),
      remoteAddress: PEER,
    });
    expect(answered.status).toBe(200);
    const { clearance } = (await answered.json()) as { clearance: string };
    const admitted = await adapter.fetch("/orders", {
      headers: { "x-security-clearance": clearance },
      remoteAddress: PEER,
    });
    expect([admitted.status, await admitted.text()]).toEqual([200, "orders"]);
  });

  it("answers a route-stage challenge with the problem and its descriptor, and admits the cleared caller", async () => {
    const adapter = await boot({
      policy: { lists: [{ user: "u_1", action: "challenge" }] },
    });
    const problem = await adapter.fetch("/orders", {
      headers: { accept: "application/json", "x-user": "u_1" },
      remoteAddress: PEER,
    });
    expect(problem.status).toBe(403);
    expect(problem.headers.get("content-type")).toStartWith(
      "application/problem+json",
    );
    expect(problem.headers.get("cache-control")).toBe("no-store");
    const body = (await problem.json()) as {
      code: string;
      challenge: { provider: string; path: string; data: PowChallengeData };
    };
    expect(body.code).toBe("challenge_required");
    expect(body.challenge.provider).toBe("pow");
    // The answer goes to the early stage, as an early challenge's does.
    const answered = await adapter.fetch(body.challenge.path, {
      method: "POST",
      headers: { "content-type": "application/json", "x-user": "u_1" },
      body: JSON.stringify({ answer: solvePowChallenge(body.challenge.data) }),
      remoteAddress: PEER,
    });
    expect(answered.status).toBe(200);
    const { clearance } = (await answered.json()) as { clearance: string };
    const admitted = await adapter.fetch("/orders", {
      headers: { "x-security-clearance": clearance, "x-user": "u_1" },
      remoteAddress: PEER,
    });
    expect([admitted.status, await admitted.text()]).toEqual([200, "orders"]);
  });

  it("answers a browser's route-stage challenge with the page under its strict CSP", async () => {
    const adapter = await boot({
      policy: { lists: [{ user: "u_1", action: "challenge" }] },
    });
    const page = await adapter.fetch("/orders", {
      headers: { accept: "text/html", "x-user": "u_1" },
      remoteAddress: PEER,
    });
    expect(page.status).toBe(403);
    expect(page.headers.get("content-type")).toStartWith("text/html");
    const csp = page.headers.get("content-security-policy") ?? "";
    expect(csp).toStartWith("default-src 'none'; script-src 'nonce-");
    const html = await page.text();
    expect(html).toContain('id="bun-security-pow"');
    expect(html).toContain('name="return" value="/orders"');
  });

  it("hands an app's exception filter a SecurityChallengeException, still a SecurityRefusalException", async () => {
    const seen: unknown[] = [];
    let secondSeen: () => void = () => {};
    const second = new Promise<void>((resolve) => {
      secondSeen = resolve;
    });
    @Catch(SecurityRefusalException)
    class RefusalFilter implements ExceptionFilter {
      catch(exception: SecurityRefusalException, host: ArgumentsHost) {
        seen.push(exception);
        if (seen.length === 2) secondSeen();
        // The page was sent already: leave it, as Nest's own filter does.
        if (exception instanceof SecurityChallengeException && exception.sent) {
          return;
        }
        const res = host.switchToHttp().getResponse<{
          status: (code: number) => { send: (body: unknown) => unknown };
        }>();
        res.status(exception.getStatus()).send(exception.getResponse());
      }
    }
    const adapter = await boot(
      { policy: { lists: [{ user: "u_1", action: "challenge" }] } },
      [{ provide: APP_FILTER, useClass: RefusalFilter }],
    );
    const refused = await adapter.fetch("/orders", {
      headers: { accept: "application/json", "x-user": "u_1" },
      remoteAddress: PEER,
    });
    expect(refused.status).toBe(403);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBeInstanceOf(SecurityChallengeException);
    expect((seen[0] as SecurityChallengeException).decision.action).toBe(
      "challenge",
    );
    expect((seen[0] as SecurityChallengeException).sent).toBe(false);
    const page = await adapter.fetch("/orders", {
      headers: { accept: "text/html", "x-user": "u_1" },
      remoteAddress: PEER,
    });
    expect([
      page.status,
      (await page.text()).includes("bun-security-pow"),
    ]).toEqual([403, true]);
    // The page is sent before the exception reaches the filter, so the
    // filter may run just after the client has its answer.
    await Promise.race([second, Bun.sleep(2_000)]);
    expect((seen[1] as SecurityChallengeException).sent).toBe(true);
  });

  it("negative control: without a challenge flow, the route stage refuses with the bare challenge_required", async () => {
    const adapter = await boot({
      policy: { lists: [{ user: "u_1", action: "challenge" }] },
      challenge: undefined,
    });
    const refused = await adapter.fetch("/orders", {
      headers: { accept: "application/json", "x-user": "u_1" },
      remoteAddress: PEER,
    });
    expect(refused.status).toBe(403);
    const body = (await refused.json()) as Record<string, unknown>;
    // The engine's fallback is a block, answered with its own code.
    expect(body.code).toBe("blocked");
    expect(body.challenge).toBeUndefined();
  });

  it("leaves other route-stage refusals as they were", async () => {
    const adapter = await boot({
      policy: { lists: [{ user: "u_1", action: "block" }] },
    });
    const refused = await adapter.fetch("/orders", {
      headers: { accept: "text/html", "x-user": "u_1" },
      remoteAddress: PEER,
    });
    expect(refused.status).toBe(403);
    // The module's own CSP header, never the challenge page's.
    expect(refused.headers.get("content-security-policy") ?? "").not.toContain(
      "nonce-",
    );
    expect(((await refused.json()) as { code: string }).code).toBe("blocked");
  });
});
