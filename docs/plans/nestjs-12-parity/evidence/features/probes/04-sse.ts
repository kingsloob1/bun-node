/** Item 4: SSE changes 11.2.x–12.1.3, served over a socket on both adapters. */
import * as common from "@nestjs/common";
import { Controller, Get, Header, HttpCode, Module, Res, Sse } from "@nestjs/common";
import { EMPTY, interval, map, Observable, of, take } from "rxjs";
import { build, runCases, sleep } from "./harness";

const SseSignal: any = (common as any).SseSignal ?? (() => () => undefined);
const hasSignal = typeof (common as any).SseSignal === "function";
const events: Record<string, unknown> = {};
const frozen = Object.freeze({ data: "same" });

@Controller("sse")
class C {
  @Sse("ticks")
  ticks() {
    return interval(5).pipe(take(2), map((n) => ({ data: { n }, type: "tick" })));
  }
  @Sse("decorated")
  @Header("X-Decorated", "yes")
  @HttpCode(202)
  decorated() {
    return of({ data: "d" });
  }
  @Sse("imperative")
  imperative(@Res({ passthrough: true }) res: any) {
    res.status(203);
    res.setHeader("X-Imperative", "yes");
    res.setHeader("Cache-Control", "public, max-age=999");
    return of({ data: "i" });
  }
  @Sse("empty")
  empty() {
    return EMPTY;
  }
  @Sse("bigint")
  bigint() {
    return of({ data: "ok" }, { data: { n: 1n } as any }, { data: "after" });
  }
  @Sse("frozen")
  frozenTwice() {
    return of(frozen, frozen);
  }
  @Sse("comment")
  comment() {
    return of({ comment: "hello\nworld" } as any, { data: "x", retry: 0 } as any);
  }
  @Sse("slow-setup")
  async slowSetup(@SseSignal() signal: AbortSignal) {
    events.slowSetupStarted = true;
    signal?.addEventListener?.("abort", () => (events.slowSetupSignalAborted = true), { once: true });
    await sleep(300);
    events.slowSetupAbortedAfterSetup = signal?.aborted;
    return new Observable((sub) => {
      events.slowSetupSubscribed = true;
      const t = setInterval(() => sub.next({ data: "late" }), 10);
      return () => {
        clearInterval(t);
        events.slowSetupUnsubscribed = true;
      };
    });
  }
  @Sse("endless")
  endless(@SseSignal() signal: AbortSignal) {
    signal?.addEventListener?.("abort", () => (events.endlessSignalAborted = true), { once: true });
    return new Observable((sub) => {
      const t = setInterval(() => sub.next({ data: "e" }), 10);
      return () => {
        clearInterval(t);
        events.endlessUnsubscribed = true;
      };
    });
  }
  /** Not SSE: an Observable from a plain route; #17826 stops it on disconnect. */
  @Get("plain-observable")
  plainObservable() {
    return new Observable((sub) => {
      events.plainSubscribed = true;
      const t = setTimeout(() => sub.next({ late: true }), 2000);
      return () => {
        clearTimeout(t);
        events.plainUnsubscribed = true;
      };
    });
  }
}
@Module({ controllers: [C] })
class M {}

async function readAll(res: Response, ms = 1500) {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let text = "";
  let ended = false;
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const r: any = await Promise.race([reader.read(), sleep(deadline - Date.now()).then(() => "timeout")]);
    if (r === "timeout") break;
    if (r.done) {
      ended = true;
      break;
    }
    text += dec.decode(r.value, { stream: true });
  }
  reader.cancel().catch(() => {});
  return { text: text.replace(/\n/g, "⏎"), ended };
}
function hdrs(res: Response) {
  const h: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    if (!["date", "keep-alive", "x-powered-by", "transfer-encoding"].includes(k)) h[k] = v;
  });
  return h;
}

await runCases("04-sse", {
  all: async () => {
    const b = await build(M, {}, { served: true });
    const out: Record<string, unknown> = { hasSseSignal: hasSignal };
    try {
      for (const p of ["ticks", "decorated", "imperative", "empty", "bigint", "frozen", "comment"]) {
        const res = await fetch(`${b.url}/sse/${p}`);
        out[p] = { status: res.status, headers: hdrs(res), ...(await readAll(res)) };
      }
      // Early disconnect during async setup (#17987, @SseSignal #17469)
      {
        const ac = new AbortController();
        const pending = fetch(`${b.url}/sse/slow-setup`, { signal: ac.signal }).catch((e) => String(e));
        await sleep(80);
        ac.abort();
        await pending;
        await sleep(600);
        out.slowSetup = {
          started: events.slowSetupStarted,
          signalAborted: events.slowSetupSignalAborted ?? false,
          abortedAfterSetup: events.slowSetupAbortedAfterSetup ?? null,
          subscribed: events.slowSetupSubscribed ?? false,
          unsubscribed: events.slowSetupUnsubscribed ?? false,
        };
      }
      // Disconnect mid-stream
      {
        const ac = new AbortController();
        const res = await fetch(`${b.url}/sse/endless`, { signal: ac.signal });
        const reader = res.body!.getReader();
        await reader.read();
        ac.abort();
        await sleep(400);
        out.endless = { unsubscribed: events.endlessUnsubscribed ?? false, signalAborted: events.endlessSignalAborted ?? false };
      }
      // #17826: plain route returning an Observable
      {
        const ac = new AbortController();
        const pending = fetch(`${b.url}/sse/plain-observable`, { signal: ac.signal }).catch((e) => String(e));
        await sleep(100);
        ac.abort();
        await pending;
        await sleep(300);
        out.plainObservable = { subscribed: events.plainSubscribed ?? false, unsubscribed: events.plainUnsubscribed ?? false };
      }
      return out;
    } finally {
      await b.close();
    }
  },
});
