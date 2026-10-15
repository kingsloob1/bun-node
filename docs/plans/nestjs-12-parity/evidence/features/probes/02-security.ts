/** Item 2: app.enableCsrfProtection() / app.useSecurityHeaders() (#17836, #17941). */
import { Body, Controller, Get, Module, Post } from "@nestjs/common";
import { build, kind, runCases, snap } from "./harness";

@Controller()
class C {
  @Get("ok")
  ok() {
    return { ok: true };
  }
  @Post("echo")
  echo(@Body() body: any) {
    return { body };
  }
  @Post("webhooks")
  hook() {
    return "hooked";
  }
}
@Module({ controllers: [C] })
class M {}

const served = process.argv.includes("--served");
const cross = { origin: "http://evil.example", "sec-fetch-site": "cross-site" };

async function scenario(setup: (app: any) => void, options: any = {}, bunOptions?: any) {
  let b;
  try {
    b = await build(M, options, { setup, served, bunOptions });
  } catch (e) {
    return { startupThrew: String(e) };
  }
  const hostHeader = b.url ? new URL(b.url).host : "localhost";
  try {
    const r: Record<string, unknown> = {};
    r.getOk = await snap(await b.request("/ok"));
    r.getUnmatched = await snap(await b.request("/nope"));
    r.postCross = await snap(await b.request("/echo", { method: "POST", headers: { ...cross, "content-type": "application/json" }, body: '{"a":1}' }));
    r.postCrossOriginOnly = await snap(await b.request("/echo", { method: "POST", headers: { origin: "http://evil.example", "content-type": "application/json" }, body: '{"a":1}' }));
    r.postSameOriginHost = await snap(await b.request("/echo", { method: "POST", headers: { origin: `http://${hostHeader}`, host: hostHeader, "content-type": "application/json" }, body: '{"a":1}' }));
    r.postSecFetchSame = await snap(await b.request("/echo", { method: "POST", headers: { "sec-fetch-site": "same-origin", "content-type": "application/json" }, body: '{"a":1}' }));
    r.postNoBrowserHeaders = await snap(await b.request("/echo", { method: "POST", headers: { "content-type": "application/json" }, body: '{"a":1}' }));
    r.postCrossInvalidJson = await snap(await b.request("/echo", { method: "POST", headers: { ...cross, "content-type": "application/json" }, body: "{not json" }));
    r.postCrossUnmatched = await snap(await b.request("/nope", { method: "POST", headers: cross }));
    r.postCrossBig = await snap(await b.request("/echo", { method: "POST", headers: { ...cross, "content-type": "application/json" }, body: JSON.stringify({ a: "x".repeat(200_000) }) }));
    r.postCrossTrusted = await snap(await b.request("/echo", { method: "POST", headers: { origin: "https://trusted.example", "sec-fetch-site": "cross-site", "content-type": "application/json" }, body: "{}" }));
    r.postCrossExcluded = await snap(await b.request("/webhooks", { method: "POST", headers: cross }));
    r.postCrossExcludedPrefixed = await snap(await b.request("/api/webhooks", { method: "POST", headers: cross }));
    return r;
  } finally {
    await b.close();
  }
}

await runCases(`02-security${served ? "-served" : ""}`, {
  both: () =>
    scenario((app) => {
      if (!app.useSecurityHeaders) throw new Error("no useSecurityHeaders on this Nest");
      app.useSecurityHeaders();
      app.enableCsrfProtection({ trustedOrigins: ["https://trusted.example"], exclude: ["webhooks"] });
    }),
  withPrefix: () =>
    scenario((app) => {
      if (!app.useSecurityHeaders) throw new Error("no useSecurityHeaders on this Nest");
      app.setGlobalPrefix("api");
      app.useSecurityHeaders();
      app.enableCsrfProtection({ exclude: ["webhooks"] });
    }),
  // a filter shapes the 403?
  withFilterAndPayloadLimit: () =>
    scenario(
      (app) => {
        if (!app.useSecurityHeaders) throw new Error("no useSecurityHeaders on this Nest");
        app.enableCsrfProtection();
        app.useBodyParser("json", { limit: "1kb" });
      },
      {},
    ),
  // bun only: does deferring the body read (bun-common `deferBody`) restore express' order?
  bunDeferBody: () =>
    kind === "bun"
      ? scenario(
          (app) => {
            app.enableCsrfProtection();
          },
          {},
          { request: { deferBody: true } },
        )
      : Promise.resolve("bun only"),
  afterInit: async () => {
    const b = await build(M, {}, { served });
    try {
      b.app.useSecurityHeaders();
      return "no throw";
    } catch (e) {
      return { threw: String(e) };
    } finally {
      await b.close();
    }
  },
});
