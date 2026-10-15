/** Item 6: shutdown & listen — return503OnClosing, draining, forceCloseConnections, listening state, listen errors. */
import { BeforeApplicationShutdown, Controller, Get, Module, OnApplicationShutdown, Sse } from "@nestjs/common";
import { HttpAdapterHost } from "@nestjs/core";
import { Observable } from "rxjs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build, kind, runCases, sleep, withDeadline } from "./harness";

const ev: Record<string, number> = {};
@Controller()
class C {
  @Get("slow")
  async slow() {
    await sleep(600);
    return "slow done";
  }
  @Get("fast")
  fast() {
    return "fast";
  }
  @Sse("endless")
  endless() {
    return new Observable((s) => {
      const t = setInterval(() => s.next({ data: "x" }), 50);
      return () => clearInterval(t);
    });
  }
}
class Hooks implements BeforeApplicationShutdown, OnApplicationShutdown {
  async beforeApplicationShutdown() {
    ev.before = (ev.before ?? 0) + 1;
    await sleep(300);
  }
  onApplicationShutdown() {
    ev.shutdown = (ev.shutdown ?? 0) + 1;
  }
}
@Module({ controllers: [C], providers: [Hooks] })
class M {}

const t0 = () => performance.now();
async function attempt(p: Promise<Response>) {
  try {
    const r = await p;
    return { status: r.status, connection: r.headers.get("connection"), body: (await r.text()).slice(0, 60) };
  } catch (e) {
    return { error: String(e).slice(0, 90) };
  }
}

async function drainScenario(options: any) {
  const b = await build(M, options, { served: true });
  const inflight = attempt(fetch(`${b.url}/slow`));
  await sleep(50);
  const start = t0();
  const closing = b.app.close();
  await sleep(100); // inside beforeApplicationShutdown (300ms): server still bound
  const during = await attempt(fetch(`${b.url}/fast`, { headers: { connection: "close" } }));
  await closing;
  return { inflight: await inflight, requestDuringShutdownHooks: during, closeMs: Math.round(t0() - start) };
}

async function closeWithOpenStream(options: any) {
  const b = await build(M, options, { served: true });
  const ac = new AbortController();
  const res = await fetch(`${b.url}/endless`, { signal: ac.signal });
  const reader = res.body!.getReader();
  await reader.read();
  const start = t0();
  const r = await withDeadline(b.app.close(), 3000);
  const ms = Math.round(t0() - start);
  ac.abort();
  return { closeResolved: !(r && (r as any).timeout), closeMs: ms };
}

await runCases("06-shutdown", {
  drainDefault: () => drainScenario({}),
  drainReturn503: () => drainScenario({ return503OnClosing: true }),
  closeWithOpenSseDefault: () => closeWithOpenStream({}),
  closeWithOpenSseForce: () => closeWithOpenStream({ forceCloseConnections: true }),
  listeningStateAfterClose: async () => {
    const b = await build(M, {}, { served: true });
    const host = b.app.get(HttpAdapterHost);
    const before = host.listening;
    await b.app.close();
    let url: unknown;
    try {
      url = await b.app.getUrl();
    } catch (e) {
      url = { rejected: String(e) };
    }
    return { listeningBefore: before, listeningAfter: host.listening, getUrlAfterClose: url };
  },
  concurrentClose: async () => {
    ev.before = 0;
    ev.shutdown = 0;
    const b = await build(M, {}, { served: true });
    let adapterCloses = 0;
    const orig = b.adapter.close.bind(b.adapter);
    b.adapter.close = async () => {
      adapterCloses++;
      return orig();
    };
    await Promise.all([b.app.close(), b.app.close()]);
    return { beforeShutdownHooks: ev.before, shutdownHooks: ev.shutdown, adapterCloses };
  },
  listenInvalidPort: async () => {
    const b = await build(M, {}, {}).catch((e) => ({ e }));
    // build() with kind express listens already; make a fresh unlistened app instead
    const { NestFactory } = await import("@nestjs/core");
    const adapter = kind === "bun" ? new (await import("@kingsleyweb/bun-nest")).BunHttpAdapter() : new (await import("@nestjs/platform-express")).ExpressAdapter();
    const app = await NestFactory.create(M, adapter, { logger: false });
    let unhandled: string | undefined;
    const onU = (e: unknown) => (unhandled = String(e));
    process.on("unhandledRejection", onU);
    const r = await withDeadline(app.listen(70000).then(() => "resolved", (e: unknown) => `rejected: ${String(e).slice(0, 100)}`), 1500);
    await sleep(50);
    process.off("unhandledRejection", onU);
    await app.close().catch(() => {});
    if ((b as any)?.close) await (b as any).close();
    return { listen: r, unhandledRejection: unhandled ?? null };
  },
  listenBusyPort: async () => {
    const blocker = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("x") });
    const { NestFactory } = await import("@nestjs/core");
    const adapter = kind === "bun" ? new (await import("@kingsleyweb/bun-nest")).BunHttpAdapter() : new (await import("@nestjs/platform-express")).ExpressAdapter();
    const app = await NestFactory.create(M, adapter, { logger: false });
    const r = await withDeadline(app.listen(blocker.port, "127.0.0.1").then(() => "resolved", (e: unknown) => `rejected: ${String(e).slice(0, 100)}`), 1500);
    blocker.stop(true);
    await app.close().catch(() => {});
    return { listen: r };
  },
  listenSocketPath: async () => {
    const dir = mkdtempSync(join(tmpdir(), "nest12-sock-"));
    const path = join(dir, "app.sock");
    const { NestFactory } = await import("@nestjs/core");
    const adapter = kind === "bun" ? new (await import("@kingsleyweb/bun-nest")).BunHttpAdapter() : new (await import("@nestjs/platform-express")).ExpressAdapter();
    const app = await NestFactory.create(M, adapter, { logger: false });
    let unhandled: string | undefined;
    const onU = (e: unknown) => (unhandled = String(e));
    process.on("unhandledRejection", onU);
    const r = await withDeadline(app.listen(path).then(() => "resolved", (e: unknown) => `rejected: ${String(e).slice(0, 100)}`), 1500);
    let url: unknown = null;
    let body: unknown = null;
    if (r === "resolved") {
      url = await app.getUrl().catch((e: unknown) => `getUrl rejected: ${e}`);
      body = await fetch("http://localhost/fast", { unix: path } as any).then((x) => x.text(), (e) => String(e));
    }
    process.off("unhandledRejection", onU);
    await app.close().catch(() => {});
    return { listen: r, url, body, unhandledRejection: unhandled ?? null };
  },
});
