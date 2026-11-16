/**
 * Challenges on a Nest application (bun-security PR-S9, layers.md L10.2):
 * `SecurityModule` with a challenge flow answers an address challenge in
 * the early stage with the flow's problem, takes the answer there (before
 * Nest's body parser), and admits the client holding the clearance. A
 * route-stage challenge (`SecurityGuard`) is still the refusal exception,
 * `challenge_required`, without the challenge: noted as a follow-up.
 */
import type { BunRequest } from "@kingsleyweb/bun-common";
import type { INestApplication } from "@nestjs/common";
import type { SecurityModuleOptions } from "../lib/security/index";
import {
  challenges,
  powChallenge,
  solvePowChallenge,
} from "@kingsleyweb/bun-security/challenge";
import type { PowChallengeData } from "@kingsleyweb/bun-security/challenge";
import { Controller, Get, Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { afterEach, describe, expect, it } from "bun:test";
import { BunHttpAdapter } from "../lib/BunHttpAdapter";
import { SecurityModule } from "../lib/security/index";
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

  it("refuses a route-stage challenge with the exception's challenge_required (no challenge body yet)", async () => {
    const adapter = await boot({
      policy: { lists: [{ user: "u_1", action: "challenge" }] },
    });
    const refused = await adapter.fetch("/orders", {
      headers: { accept: "application/json", "x-user": "u_1" },
      remoteAddress: PEER,
    });
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { code: string }).code).toBe(
      "challenge_required",
    );
  });
});
