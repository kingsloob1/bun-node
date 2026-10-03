import { describe, expect, it } from "bun:test";
import { BunHttpAdapter } from "../lib/BunHttpAdapter";
import { BunRequest } from "../lib/BunRequest";
import { testServer } from "./helpers";

/**
 * A request's option setters tailor that request only. The adapter hands
 * every request the same options object, so a setter that wrote into it
 * changed every later request — a cap raised for one upload route raised it
 * everywhere.
 */
describe("BunRequest: per-request options stay per request", () => {
  it("leaves the options object it was built with untouched", () => {
    const options = {
      parseBody: { maxContentLength: 10 },
      parseCookies: true,
      parseQuery: true,
    };
    const snapshot = structuredClone(options);
    const req = BunRequest.init(
      new Request("http://localhost/?a=1"),
      testServer,
      options,
    ) as BunRequest;
    req.setParseBodyOptions({ maxContentLength: 1_000_000 });
    req.setQueryParserOptions({ nesting: false });
    req.setMultipartParserOptions({ limits: { files: 1 } });
    req.setXmlParserOptions({});
    req.setAllowedContentTypes(["json"]);
    expect(options).toEqual(snapshot);
    expect(Object.keys(options).sort()).toEqual(Object.keys(snapshot).sort());
  });

  it("does not lift the body cap of later requests", async () => {
    const adapter = new BunHttpAdapter(0, {
      request: { parseBody: { maxContentLength: 16 } },
    });
    adapter.post("/tailor", (req, res) => {
      // Uncapped for this request only (its small body was already read).
      req.setParseBodyOptions(true);
      res.send("ok");
    });
    adapter.post("/small", (_req, res) => res.send("ok"));

    const send = (path: string, body: string) =>
      adapter.fetch(path, {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body,
      });
    const big = "x".repeat(64);
    expect((await send("/small", big)).status).toBe(413);
    expect((await send("/tailor", "tiny")).status).toBe(200);
    // Still capped: the setter changed only its own request.
    expect((await send("/small", big)).status).toBe(413);
  });
});
