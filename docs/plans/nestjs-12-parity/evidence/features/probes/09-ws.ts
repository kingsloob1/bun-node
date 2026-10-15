/**
 * Item 9: WebSockets on Nest 12 — disconnect reason, request-scoped gateways
 * (REQUEST = the socket), lifecycle hook errors to filters (#18048), WsException
 * delivery to native clients, @MessageBody({ schema }).
 *
 * `bun 09-ws.ts bun` (repo12 or repo11: BunHttpAdapter + its WebSocket adapter)
 * `bun 09-ws.ts ws`  (agent-features/ws12: ExpressAdapter + @nestjs/platform-ws WsAdapter)
 */
import "reflect-metadata";
import * as common from "@nestjs/common";
import { Inject, Injectable, Module, Scope, UsePipes } from "@nestjs/common";
import { NestFactory, REQUEST } from "@nestjs/core";
import { ConnectedSocket, MessageBody, OnGatewayConnection, OnGatewayDisconnect, SubscribeMessage, WebSocketGateway, WsException } from "@nestjs/websockets";
import { createRequire } from "node:module";

const kind = process.argv[2] ?? "bun";
const req = createRequire(import.meta.url);
const version = (p: string) => {
  try {
    return req(`${p}/package.json`).version;
  } catch {
    return "absent";
  }
};
const C: any = common;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ev: any = { connections: 0, disconnects: [] as unknown[], scopedInstances: 0 };

let z: any;
try {
  z = (await import("zod")).z;
} catch {}
const schema = z ? z.object({ n: z.coerce.number().int() }) : undefined;
const SchemaPipes = C.StandardSchemaValidationPipe ? [new C.StandardSchemaValidationPipe()] : [];

@WebSocketGateway({ path: "/main" })
class MainGateway implements OnGatewayConnection, OnGatewayDisconnect {
  handleConnection(client: any) {
    ev.connections++;
    ev.lastClient = client;
  }
  handleDisconnect(client: any, reason?: unknown) {
    ev.disconnects.push({
      argCount: arguments.length,
      reasonType: typeof reason,
      reasonIsClient: reason === client,
      reason: reason === client ? "<the client>" : typeof reason === "object" && reason ? Object.keys(reason as object) : reason,
    });
  }
  @SubscribeMessage("echo")
  echo(@MessageBody() data: unknown) {
    return { event: "echo", data };
  }
  @SubscribeMessage("fail")
  fail() {
    throw new WsException("nope");
  }
  @SubscribeMessage("valid")
  @UsePipes(...SchemaPipes)
  valid(@MessageBody({ schema } as any) body: any) {
    return { event: "valid", data: { body, nType: typeof body?.n } };
  }
}

let nextId = 0;
@Injectable({ scope: Scope.REQUEST })
@WebSocketGateway({ path: "/scoped" })
class ScopedGateway {
  id = ++nextId;
  constructor(@Inject(REQUEST) private readonly request: any) {
    ev.scopedInstances++;
  }
  @SubscribeMessage("who")
  who(@ConnectedSocket() client: any) {
    return { event: "who", data: { instance: this.id, requestIsClient: this.request === client, requestType: this.request?.constructor?.name } };
  }
}

@WebSocketGateway({ path: "/hookerr" })
class HookErrorGateway implements OnGatewayConnection {
  handleConnection() {
    throw new WsException("denied on connect");
  }
  @SubscribeMessage("echo")
  echo(@MessageBody() data: unknown) {
    return { event: "echo", data };
  }
}

@Module({ providers: [MainGateway, ScopedGateway, HookErrorGateway] })
class M {}

let app: any;
let EVENT = 2;
if (kind === "bun") {
  const bunNest: any = await import("@kingsleyweb/bun-nest");
  EVENT = bunNest.MessageEventTypes?.EVENT ?? 2;
  const adapter = new bunNest.BunHttpAdapter();
  app = await NestFactory.create(M, adapter, { logger: false });
  app.useWebSocketAdapter(adapter.webSocketAdapter);
} else {
  const { WsAdapter } = await import("@nestjs/platform-ws");
  app = await NestFactory.create(M, { logger: false });
  app.useWebSocketAdapter(new WsAdapter(app));
}
await app.listen(0, "127.0.0.1");
const base = (await app.getUrl()).replace("http", "ws");

function encode(event: string, data: unknown) {
  return kind === "bun" ? JSON.stringify({ type: EVENT, namespace: "/", data: [event, data] }) : JSON.stringify({ event, data });
}
async function connect(path: string) {
  const ws = new WebSocket(base + path);
  const received: string[] = [];
  let closed: { code: number; reason: string } | undefined;
  ws.onmessage = (m) => received.push(String(m.data));
  ws.onclose = (e) => (closed = { code: e.code, reason: e.reason });
  const opened = await Promise.race([new Promise((r) => (ws.onopen = () => r(true))), new Promise((r) => (ws.onerror = () => r(false))), sleep(2000).then(() => false)]);
  return {
    ws,
    opened,
    received,
    closed: () => closed,
    send: (e: string, d: unknown) => ws.send(encode(e, d)),
    async waitCount(n: number, ms = 1500) {
      const end = Date.now() + ms;
      while (received.length < n && Date.now() < end) await sleep(10);
      return received.slice();
    },
  };
}

const out: any = { probe: "09-ws", kind, nest: version("@nestjs/core"), websockets: version("@nestjs/websockets"), platformWs: version("@nestjs/platform-ws"), bun: Bun.version };
async function run(name: string, fn: () => Promise<unknown>) {
  try {
    out[name] = await fn();
  } catch (e) {
    out[name] = { threw: String(e) };
  }
}
await run("echoAndErrors", async () => {
  const c = await connect("/main");
  c.send("echo", { a: 1 });
  await c.waitCount(1);
  c.send("fail", { x: 1 });
  await c.waitCount(2);
  c.send("valid", { n: "5" });
  await c.waitCount(3);
  c.send("valid", { n: "x" });
  const got = await c.waitCount(4);
  c.ws.close(4001, "bye");
  await sleep(300);
  return { opened: c.opened, received: got };
});
await run("disconnectReason", async () => ({ disconnects: ev.disconnects }));
await run("serverSideClose", async () => {
  ev.disconnects = [];
  const c = await connect("/main");
  await sleep(100);
  ev.lastClient.close(4002, "server says bye");
  await sleep(300);
  return { clientSaw: c.closed(), disconnects: ev.disconnects };
});
await run("requestScoped", async () => {
  ev.scopedInstances = 0;
  const a = await connect("/scoped");
  const b = await connect("/scoped");
  a.send("who", null);
  a.send("who", null);
  b.send("who", null);
  const ra = await a.waitCount(2);
  const rb = await b.waitCount(1);
  a.ws.close();
  b.ws.close();
  await sleep(200);
  return { a: ra, b: rb, scopedInstancesCreated: ev.scopedInstances };
});
await run("hookError", async () => {
  const c = await connect("/hookerr");
  const got = await c.waitCount(1, 800);
  c.send("echo", "still alive?");
  const got2 = await c.waitCount(2, 800);
  c.ws.close();
  return { opened: c.opened, received: got2.length ? got2 : got, closed: c.closed() ?? null };
});
await app.close();
console.log(JSON.stringify(out, null, 2));
process.exit(0);
