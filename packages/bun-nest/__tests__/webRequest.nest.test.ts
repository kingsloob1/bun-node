/**
 * bun-common's `req.webRequest()` through bun-nest's adapter (bun-auth plan
 * §4.1, PR-A0): a Nest route hands a Fetch API handler (a stand-in for
 * better-auth's) the request with its body as received, after Nest's body
 * parser — or the adapter's own parse — has already read it.
 *
 * `reflect-metadata` is imported last per the import-sort rule. No top-level
 * `await`: it perturbs decorator metadata in other gateway test files.
 */
import type { BunRequest } from "@kingsleyweb/bun-common";
import type { INestApplication } from "@nestjs/common";
import { webRequestSource } from "@kingsleyweb/bun-common";
import { Buffer } from "node:buffer";
import { All, Controller, Module, Req } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { BunHttpAdapter } from "../lib";
import "reflect-metadata";

/** What the stand-in handler answers. */
interface HandlerAnswer {
  /** The request's path. */
  path: string;
  /** The body it read. */
  body: unknown;
}

/**
 * A stand-in for better-auth's handler: a `(request: Request) =>
 * Promise<Response>` that reads the body itself, JSON or a form.
 */
async function fetchHandler(request: Request): Promise<Response> {
  const type = request.headers.get("content-type") ?? "";
  const body = type.startsWith("application/x-www-form-urlencoded")
    ? Object.fromEntries(await request.formData())
    : await request.json();
  return Response.json({ path: new URL(request.url).pathname, body });
}

@Controller("api/auth")
class AuthController {
  @All("sign-in")
  async signIn(@Req() req: BunRequest) {
    const request = req.webRequest();
    const answer = await fetchHandler(request);
    const read = (await answer.json()) as HandlerAnswer;
    return { source: webRequestSource(request), ...read };
  }

  /** The negative control: the native request, whose body was read. */
  @All("native")
  async native(@Req() req: BunRequest) {
    const answer = await fetchHandler(req.request);
    return answer.json();
  }
}

@Module({ controllers: [AuthController] })
class AppModule {}

const apps: INestApplication[] = [];
const adapters: Record<string, BunHttpAdapter> = {};

beforeAll(async () => {
  const configs = {
    // Nest's own body parser reads every body before the route.
    "Nest body parser": { request: {}, bodyParser: true },
    "deferBody, no Nest body parser": {
      request: { deferBody: true },
      bodyParser: false,
    },
    "retainBuffer: false": {
      request: { retainBuffer: false },
      bodyParser: false,
    },
  };
  for (const [name, { request, bodyParser }] of Object.entries(configs)) {
    const adapter = new BunHttpAdapter(0, { request });
    const app = await NestFactory.create(AppModule, adapter, {
      logger: false,
      bodyParser,
    });
    await app.init();
    apps.push(app);
    adapters[name] = adapter;
  }
});

afterAll(async () => {
  for (const app of apps) {
    await app.close();
  }
});

const bodies = [
  ["json", '{"email":"a@b.c","password":"pw"}', "application/json"],
  ["form", "email=a%40b.c&password=pw", "application/x-www-form-urlencoded"],
] as const;

const post = (
  adapter: BunHttpAdapter,
  path: string,
  body: string,
  type: string,
) =>
  adapter.fetch(path, {
    method: "POST",
    headers: {
      "content-type": type,
      "content-length": String(Buffer.byteLength(body)),
    },
    body,
  });

describe("bun-nest: req.webRequest() in a route", () => {
  const expected: Record<string, string> = {
    "Nest body parser": "retained",
    "deferBody, no Nest body parser": "retained",
    "retainBuffer: false": "parsed",
  };
  for (const name of Object.keys(expected)) {
    for (const [kind, body, type] of bodies) {
      it(`${kind}, ${name}: the handler reads the body`, async () => {
        const response = await post(
          adapters[name],
          "/api/auth/sign-in",
          body,
          type,
        );
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({
          source: expected[name],
          path: "/api/auth/sign-in",
          body: { email: "a@b.c", password: "pw" },
        });
      });

      it(`negative control: ${kind}, ${name}: req.request fails`, async () => {
        const response = await post(
          adapters[name],
          "/api/auth/native",
          body,
          type,
        );
        expect(response.status).toBe(500);
      });
    }
  }
});
