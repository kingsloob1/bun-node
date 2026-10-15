/** Item 5: StreamableFile — headers, source destroyed on client disconnect (#17973), stream errors. */
import { Controller, Get, Module, StreamableFile } from "@nestjs/common";
import { Readable } from "node:stream";
import { build, runCases, sleep, snap } from "./harness";

const ev: Record<string, unknown> = {};
function endless(tag: string) {
  let i = 0;
  const s = new Readable({
    read() {
      setTimeout(() => this.push(`chunk${i++}\n`), 20);
    },
  });
  s.on("close", () => (ev[`${tag}Closed`] = true));
  return s;
}

@Controller("f")
class C {
  @Get("buffer")
  buffer() {
    return new StreamableFile(Buffer.from("hello"), { type: "text/x-test", disposition: 'attachment; filename="h.txt"', length: 5 });
  }
  @Get("endless")
  endlessRoute() {
    return new StreamableFile(endless("endless"));
  }
  @Get("late")
  async late() {
    const s = endless("late");
    await sleep(300);
    ev.lateReplied = true;
    return new StreamableFile(s);
  }
  @Get("error-early")
  errorEarly() {
    const s = new Readable({
      read() {
        this.destroy(new Error("source failed"));
      },
    });
    return new StreamableFile(s);
  }
  @Get("error-custom")
  errorCustom() {
    const s = new Readable({
      read() {
        this.destroy(new Error("source failed"));
      },
    });
    return new StreamableFile(s).setErrorHandler((err: Error, res: any) => {
      ev.customHandlerCalled = true;
      res.statusCode = 503;
      res.end("custom: " + err.message);
    });
  }
}
@Module({ controllers: [C] })
class M {}

const b = await build(M, {}, { served: true });
try {
  await runCases("05-streamable", {
    buffer: async () => snap(await fetch(`${b.url}/f/buffer`)),
    endlessDisconnect: async () => {
      const ac = new AbortController();
      const res = await fetch(`${b.url}/f/endless`, { signal: ac.signal });
      const reader = res.body!.getReader();
      await reader.read();
      ac.abort();
      await sleep(500);
      return { sourceClosed: ev.endlessClosed ?? false };
    },
    disconnectBeforeReply: async () => {
      const ac = new AbortController();
      const p = fetch(`${b.url}/f/late`, { signal: ac.signal }).catch(() => "aborted");
      await sleep(80);
      ac.abort();
      await p;
      await sleep(700);
      return { replied: ev.lateReplied ?? false, sourceClosed: ev.lateClosed ?? false };
    },
    errorEarly: async () => {
      const res = await fetch(`${b.url}/f/error-early`);
      return { status: res.status, headers: Object.fromEntries(res.headers), body: await res.text().catch((e) => `body read failed: ${e}`) };
    },
    errorCustom: async () => {
      const res = await fetch(`${b.url}/f/error-custom`);
      return { status: res.status, headers: Object.fromEntries(res.headers), body: await res.text().catch((e) => `body read failed: ${e}`), customHandlerCalled: ev.customHandlerCalled ?? false };
    },
  }, async () => b.close());
} catch (e) {
  console.error(e);
}
