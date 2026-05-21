import { describe, expect, it } from "bun:test";
import { cors } from "../lib/cors";
import { makeRequest, makeResponse } from "./helpers";

describe("cors middleware", () => {
  it("sets a wildcard origin and calls next for normal requests", async () => {
    const req = await makeRequest({ headers: { Origin: "http://a.test" } });
    const res = await makeResponse();
    let nextCalled = false;

    await cors()(req, res, () => {
      nextCalled = true;
    });

    expect(nextCalled).toBe(true);
    expect(res.getHeader("Access-Control-Allow-Origin")).toBe("*");
    expect(res.getHeader("Vary")).toContain("Origin");
  });

  it("reflects a matching string origin", async () => {
    const req = await makeRequest({
      headers: { Origin: "http://allowed.test" },
    });
    const res = await makeResponse();

    await cors({ origin: "http://allowed.test" })(req, res, () => {});
    expect(res.getHeader("Access-Control-Allow-Origin")).toBe(
      "http://allowed.test",
    );
  });

  it("supports an origin allow-list with regular expressions", async () => {
    const req = await makeRequest({ headers: { Origin: "http://sub.test" } });
    const res = await makeResponse();

    await cors({ origin: [/sub\.test$/] })(req, res, () => {});
    expect(res.getHeader("Access-Control-Allow-Origin")).toBe(
      "http://sub.test",
    );
  });

  it("omits the origin header when the origin is not in the allow-list", async () => {
    const req = await makeRequest({
      headers: { Origin: "http://blocked.test" },
    });
    const res = await makeResponse();

    await cors({ origin: ["http://allowed.test"] })(req, res, () => {});
    expect(res.getHeader("Access-Control-Allow-Origin")).toBeNull();
  });

  it("adds credentials and exposed headers", async () => {
    const req = await makeRequest({ headers: { Origin: "http://a.test" } });
    const res = await makeResponse();

    await cors({ credentials: true, exposedHeaders: ["X-Total"] })(
      req,
      res,
      () => {},
    );
    expect(res.getHeader("Access-Control-Allow-Credentials")).toBe("true");
    expect(res.getHeader("Access-Control-Expose-Headers")).toBe("X-Total");
  });

  it("answers preflight OPTIONS requests without calling next", async () => {
    const req = await makeRequest({
      method: "OPTIONS",
      headers: {
        Origin: "http://a.test",
        "Access-Control-Request-Headers": "X-Custom",
      },
    });
    const res = await makeResponse();
    let nextCalled = false;

    await cors({ maxAge: 600 })(req, res, () => {
      nextCalled = true;
    });

    expect(nextCalled).toBe(false);
    expect(res.headersSent).toBe(true);
    expect(res.getHeader("Access-Control-Allow-Methods")).toContain("GET");
    expect(res.getHeader("Access-Control-Allow-Headers")).toBe("X-Custom");
    expect(res.getHeader("Access-Control-Max-Age")).toBe("600");
  });

  it("continues the chain on preflight when preflightContinue is set", async () => {
    const req = await makeRequest({
      method: "OPTIONS",
      headers: { Origin: "http://a.test" },
    });
    const res = await makeResponse();
    let nextCalled = false;

    await cors({ preflightContinue: true })(req, res, () => {
      nextCalled = true;
    });
    expect(nextCalled).toBe(true);
  });

  it("supports a function origin resolver", async () => {
    const req = await makeRequest({ headers: { Origin: "http://fn.test" } });
    const res = await makeResponse();

    await cors({
      origin: (origin, cb) => cb(null, origin === "http://fn.test"),
    })(req, res, () => {});
    expect(res.getHeader("Access-Control-Allow-Origin")).toBe("http://fn.test");
  });
});
