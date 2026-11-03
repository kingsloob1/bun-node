/**
 * `DevTypesModule` (typed-client plan `nest-typed-routes.md` §6, §9.1,
 * PR-N2): bun-common's `devTypes()` mounted on a Nest app's `BunHttpAdapter`,
 * its documents the app's controllers (`generateOpenApi(adapter.instance)`)
 * and gateways (`gatewayAsyncApi`). Each check beside its control:
 *
 * - `forRoot` refuses `NODE_ENV=production` when enabled; disabled, the
 *   module registers nothing (control: enabled serves);
 * - the endpoint: the app's 404 without the token or from a remote peer,
 *   `200` with an `ETag` and `no-store`, `304` on `If-None-Match`, each
 *   document alone; the change channel's `hello` over a socket, refused
 *   without the subprotocol;
 * - the documents and the hash equal a bun-common router app's `devTypes()`
 *   for the same routes; with a gateway, the AsyncAPI document is
 *   `gatewayAsyncApi`'s;
 * - the token file follows `app.listen()` and `app.close()`;
 * - `bun-client watch` against the app writes the client, and rewrites it
 *   when a route is added at run time.
 *
 * `reflect-metadata` is imported last per the import-sort rule.
 */
import type { INestApplication } from "@nestjs/common";
import { Body, Controller, Get, Module, Param, Post } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import {
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
} from "@nestjs/websockets";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { z } from "zod";
import {
  BunHttpAdapter as RouterAdapter,
  ConfigError,
  createTestLogger,
  validate,
} from "@kingsleyweb/bun-common";
import type {
  AsyncApiDocument,
  OpenApiDocument,
} from "@kingsleyweb/bun-common/lib/docs";
import { devTypes, typesHash } from "@kingsleyweb/bun-common/lib/docs";
import { runCli } from "@kingsleyweb/bun-client/codegen";
import {
  BunHttpAdapter,
  BunWebSocketAdapter,
  Describe,
  DevTypesModule,
  gatewayAsyncApi,
  Validate,
  ValidateMessage,
} from "../lib";
import "reflect-metadata";

const IdParams = z.object({ id: z.string() });
const User = z.object({ id: z.string(), name: z.string() });
const NewUser = z.object({ name: z.string().min(1) });
const Ok = z.object({ ok: z.boolean() });
const Say = z.object({ text: z.string() });

/** A token of the length `devTypes()` requires, fixed so requests can carry it. */
const TOKEN = "nest-dev-types-token-0123456789";

@Controller("users")
class UsersController {
  @Get(":id")
  @Validate({ params: IdParams, responses: { 200: User } })
  @Describe({ operationId: "getUser", cache: { tags: ["user:{id}"] } })
  one(@Param("id") id: string) {
    return { id, name: "Ada" };
  }

  @Post()
  @Validate({ body: NewUser, responses: { 201: User } })
  create(@Body() body: { name: string }) {
    return { id: "1", name: body.name };
  }
}

@WebSocketGateway({ path: "/chat" })
class ChatGateway {
  @SubscribeMessage("say")
  @ValidateMessage(Say)
  say(@MessageBody() body: { text: string }) {
    return body;
  }
}

let dir: string;
const cleanups: (() => Promise<void> | void)[] = [];
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "bun-nest-devtypes-"));
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  await rm(dir, { recursive: true, force: true });
});

/** Where a test's server writes its token file (where `bun-client watch` looks from `dir`). */
const tokenFileIn = (at: string) =>
  join(at, "node_modules", ".cache", "bun-types", "<port>.json");

/** A unique endpoint path, so no two apps share `devTypes()`'s per-path hub. */
let unique = 0;
const uniquePath = () => `/__bun/types-nest-${process.pid}-${++unique}`;

/** Boots a Nest app importing `imports`, with `UsersController` (and, optionally, the gateway), on port 0. */
async function bootNest(
  imports: unknown[],
  options: { gateway?: boolean; listen?: boolean } = {},
) {
  @Module({
    imports: imports as never[],
    controllers: [UsersController],
    providers: options.gateway === true ? [ChatGateway] : [],
  })
  class AppModule {}
  const adapter = new BunHttpAdapter(0);
  const app: INestApplication = await NestFactory.create(AppModule, adapter, {
    logger: false,
  });
  // The swap NestJS's `useWebSocketAdapter` makes before bootstrap: the
  // change channel must land on this adapter's socket, not the replaced one.
  if (options.gateway === true)
    app.useWebSocketAdapter(new BunWebSocketAdapter({ httpAdapter: adapter }));
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await app.close();
  };
  cleanups.push(close);
  if (options.listen === false) {
    await app.init();
    return { app, adapter, close, port: 0, base: "" };
  }
  await app.listen(0, "127.0.0.1");
  const port = adapter.getBunServer()?.port ?? 0;
  return { app, adapter, close, port, base: `http://127.0.0.1:${port}` };
}

/** The same routes on a bun-common router app, with `devTypes()` mounted. */
async function bootRouter(path: string) {
  const { logger } = createTestLogger();
  const app = new RouterAdapter(0, { logger });
  app
    .get(
      "/users/:id",
      validate({ params: IdParams }, { responses: { 200: User } }),
      (req, res) => res.json({ id: req.params.id, name: "Ada" }),
    )
    .describe({ operationId: "getUser", cache: { tags: ["user:{id}"] } });
  app.post(
    "/users",
    validate({ body: NewUser }, { responses: { 201: User } }),
    (_req, res) => res.status(201).json({ id: "1", name: "Ada" }),
  );
  const dev = devTypes(app, {
    enabled: true,
    path,
    token: TOKEN,
    tokenFile: false,
  });
  app.use(dev);
  await app.listen(0, "127.0.0.1");
  cleanups.push(async () => {
    dev.close();
    await app.close();
  });
  return `http://127.0.0.1:${app.getBunServer()?.port ?? 0}`;
}

const bearer = { authorization: `Bearer ${TOKEN}` };

/** A watcher on the change channel: the socket, and its first frame. */
async function openWatcher(url: string) {
  const client = new WebSocket(url, {
    headers: bearer,
    protocols: ["bun-types.v1"],
  });
  const first = new Promise<unknown>((resolve) => {
    client.onmessage = (event) => resolve(JSON.parse(String(event.data)));
  });
  await new Promise<void>((resolve, reject) => {
    client.onopen = () => resolve();
    client.onerror = () => reject(new Error(`${url} refused the watcher`));
  });
  cleanups.push(() => client.close());
  return { client, first };
}

/** Runs `body` with `NODE_ENV` set to `value`, restoring it after. */
function withNodeEnv<T>(value: string | undefined, body: () => T): T {
  const saved = process.env.NODE_ENV;
  if (value === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = value;
  try {
    return body();
  } finally {
    if (saved === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = saved;
  }
}

describe("DevTypesModule.forRoot: production and disabled", () => {
  it("throws a ConfigError under NODE_ENV=production when enabled (control: enabled: false does not)", () => {
    withNodeEnv("production", () => {
      expect(() => DevTypesModule.forRoot({ enabled: true })).toThrow(
        ConfigError,
      );
      expect(DevTypesModule.forRoot({ enabled: false })).toEqual({
        module: DevTypesModule,
      });
    });
  });

  it("disabled registers nothing (control: enabled serves the path)", async () => {
    const path = uniquePath();
    const off = await bootNest(
      [DevTypesModule.forRoot({ enabled: false, path, token: TOKEN })],
      { listen: false },
    );
    const offRes = await off.adapter.fetch(path, { headers: bearer });
    expect(offRes.status).toBe(404);
    const bare = await bootNest([], { listen: false });
    const baseline = bare.adapter.getInstance().routes().length;
    expect(off.adapter.getInstance().routes().length).toBe(baseline);

    const on = await bootNest(
      [
        DevTypesModule.forRoot({
          enabled: true,
          path: uniquePath(),
          token: TOKEN,
          tokenFile: false,
        }),
      ],
      { listen: false },
    );
    expect(on.adapter.getInstance().routes().length).toBeGreaterThan(baseline);
  });
});

describe("DevTypesModule: the endpoint", () => {
  it("answers the app's 404 without the token, 200 with it (ETag, no-store), 304 on If-None-Match, and each document alone", async () => {
    const path = uniquePath();
    const nest = await bootNest([
      DevTypesModule.forRoot({
        enabled: true,
        path,
        token: TOKEN,
        tokenFile: false,
      }),
    ]);
    const missing = await fetch(`${nest.base}/nothing-here`);
    const refused = await fetch(`${nest.base}${path}`);
    expect(refused.status).toBe(404);
    // Refused as if nothing were there: the app's own not-found answer.
    expect(await refused.text()).toBe(
      (await missing.text()).replace("/nothing-here", path),
    );
    const wrong = await fetch(`${nest.base}${path}`, {
      headers: { authorization: "Bearer wrong-token-of-enough-length" },
    });
    expect(wrong.status).toBe(404);

    const ok = await fetch(`${nest.base}${path}`, { headers: bearer });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("cache-control")).toBe("no-store");
    const body = (await ok.json()) as {
      hash: string;
      openapi: { paths: Record<string, unknown> };
      asyncapi: unknown;
    };
    expect(ok.headers.get("etag")).toBe(`"${body.hash}"`);
    expect(Object.keys(body.openapi.paths).sort()).toEqual([
      "/users",
      "/users/{id}",
    ]);

    const fresh = await fetch(`${nest.base}${path}`, {
      headers: { ...bearer, "if-none-match": `"${body.hash}"` },
    });
    expect(fresh.status).toBe(304);
    const openapi = await fetch(`${nest.base}${path}/openapi.json`, {
      headers: bearer,
    });
    expect(await openapi.json()).toEqual(body.openapi);
    const asyncapi = await fetch(`${nest.base}${path}/asyncapi.json`, {
      headers: bearer,
    });
    expect(await asyncapi.json()).toEqual(body.asyncapi);
  });

  it("answers a socket-free fetch (no peer address counts as local)", async () => {
    const path = uniquePath();
    const nest = await bootNest(
      [
        DevTypesModule.forRoot({
          enabled: true,
          path,
          token: TOKEN,
          tokenFile: false,
        }),
      ],
      { listen: false },
    );
    // No peer address: in-process, local by construction.
    expect((await nest.adapter.fetch(path, { headers: bearer })).status).toBe(
      200,
    );
  });

  it("greets a watcher on the change channel with the hash (control: refused without the subprotocol)", async () => {
    const path = uniquePath();
    const nest = await bootNest([
      DevTypesModule.forRoot({
        enabled: true,
        path,
        token: TOKEN,
        tokenFile: false,
      }),
    ]);
    const { hash } = (await (
      await fetch(`${nest.base}${path}`, { headers: bearer })
    ).json()) as { hash: string };
    const url = `ws://127.0.0.1:${nest.port}${path}/ws`;
    const { client, first } = await openWatcher(url);
    expect(await first).toEqual({ type: "hello", data: { version: 1, hash } });
    client.close();

    // Control: no subprotocol, no channel.
    const bare = new WebSocket(url, { headers: bearer });
    const outcome = await new Promise<string>((resolve) => {
      bare.onopen = () => resolve("open");
      bare.onerror = () => resolve("refused");
    });
    expect(outcome).toBe("refused");
  });
});

describe("DevTypesModule: the documents are a router app's", () => {
  it("serves the same OpenAPI document as devTypes() on a router app with the same routes, the same AsyncAPI document but for its servers, and their hash", async () => {
    const path = uniquePath();
    const nest = await bootNest([
      DevTypesModule.forRoot({
        enabled: true,
        path,
        token: TOKEN,
        tokenFile: false,
      }),
    ]);
    const routerBase = await bootRouter(`${path}-router`);
    const nestBody = (await (
      await fetch(`${nest.base}${path}`, { headers: bearer })
    ).json()) as Record<string, unknown>;
    const routerBody = (await (
      await fetch(`${routerBase}${path}-router`, { headers: bearer })
    ).json()) as Record<string, unknown>;
    expect(nestBody.openapi).toEqual(routerBody.openapi);
    // The AsyncAPI documents come from two generators: the router's names
    // its bound port as the `app` server; the gateways' names each gateway's
    // port, and this app has none. Everything else is the same.
    const { servers: _servers, ...routerAsyncApi } =
      routerBody.asyncapi as Record<string, unknown>;
    expect(nestBody.asyncapi).toEqual(routerAsyncApi);
    expect(nestBody.hash).toBe(
      typesHash({
        openapi: routerBody.openapi as OpenApiDocument,
        asyncapi: nestBody.asyncapi as AsyncApiDocument,
      }),
    );
  });

  it("with a gateway, the AsyncAPI document is gatewayAsyncApi's, and the change channel is on the swapped-in socket", async () => {
    const path = uniquePath();
    const nest = await bootNest(
      [
        DevTypesModule.forRoot({
          enabled: true,
          path,
          token: TOKEN,
          tokenFile: false,
        }),
      ],
      { gateway: true },
    );
    const body = (await (
      await fetch(`${nest.base}${path}`, { headers: bearer })
    ).json()) as { asyncapi: { channels?: Record<string, unknown> } };
    const expected = gatewayAsyncApi(nest.app, {
      title: "API",
      version: "dev",
    }).document;
    expect(body.asyncapi).toEqual(JSON.parse(JSON.stringify(expected)));
    expect(Object.keys(body.asyncapi.channels ?? {}).length).toBe(1);
    // The change channel is on the swapped-in adapter's socket.
    const { first } = await openWatcher(
      `ws://127.0.0.1:${nest.port}${path}/ws`,
    );
    expect(await first).toMatchObject({ type: "hello" });
  });
});

describe("DevTypesModule: the token file", () => {
  it("is written when the app listens and removed when it closes", async () => {
    const path = uniquePath();
    const nest = await bootNest([
      DevTypesModule.forRoot({
        enabled: true,
        path,
        tokenFile: tokenFileIn(dir),
      }),
    ]);
    const file = tokenFileIn(dir).replace("<port>", String(nest.port));
    expect(existsSync(file)).toBe(true);
    const held = JSON.parse(readFileSync(file, "utf8")) as {
      url: string;
      ws: string;
      token: string;
    };
    expect(held.url).toBe(`http://127.0.0.1:${nest.port}${path}`);
    expect(held.ws).toBe(`ws://127.0.0.1:${nest.port}${path}/ws`);
    const ok = await fetch(held.url, {
      headers: { authorization: `Bearer ${held.token}` },
    });
    expect(ok.status).toBe(200);
    await nest.close();
    expect(existsSync(file)).toBe(false);
  });
});

describe("DevTypesModule: bun-client watch", () => {
  it("writes the client from the app's documents, and rewrites it when a route is added at run time (control: the route is absent before)", async () => {
    const path = uniquePath();
    const nest = await bootNest([
      DevTypesModule.forRoot({
        enabled: true,
        path,
        tokenFile: tokenFileIn(dir),
      }),
    ]);
    const out = join(dir, "src", "api.gen.ts");
    const controller = new AbortController();
    const stdout: string[] = [];
    const stderr: string[] = [];
    const done = runCli(["watch", "--out", "src/api.gen.ts"], {
      cwd: dir,
      signal: controller.signal,
      stdout: (text) => void stdout.push(...text.split("\n").filter(Boolean)),
      stderr: (text) => void stderr.push(text),
    });
    cleanups.push(async () => {
      controller.abort();
      await done;
    });
    const text = async () => {
      try {
        return await readFile(out, "utf8");
      } catch {
        return "";
      }
    };
    const until = async (what: string, predicate: () => Promise<boolean>) => {
      const deadline = Date.now() + 20_000;
      while (!(await predicate())) {
        if (Date.now() > deadline) {
          throw new Error(
            `timed out waiting for ${what}: ${stdout.join("\n")} ${stderr.join("\n")}`,
          );
        }
        await Bun.sleep(20);
      }
    };
    await until("the first write", async () =>
      (await text()).includes('"GET /users/:id"'),
    );
    expect(await text()).toContain('"POST /users"');
    expect(await text()).not.toContain('"GET /health"');
    await until("the channel", async () =>
      stdout.some((line) => line.includes("following")),
    );

    // A route registered on the adapter at run time moves the hash.
    nest.adapter.get(
      "/health",
      validate({}, { responses: { 200: Ok } }),
      (_req, res) => res.json({ ok: true }),
    );
    await until("the rewrite", async () =>
      (await text()).includes('"GET /health"'),
    );
    controller.abort();
    expect(await done).toBe(0);
    expect(stderr).toEqual([]);
  }, 30_000);
});
