import type { CorsOptions, CorsStaticOrigin } from "../lib/cors";
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

  /** The Allow-Origin header a function origin answering `answer` produces. */
  async function answered(answer: CorsStaticOrigin, origin = "http://a.test") {
    const req = await makeRequest({ headers: { Origin: origin } });
    const res = await makeResponse();
    await cors({
      origin: (_origin, cb) => setTimeout(cb, 1, null, answer),
    })(req, res, () => {});
    return res.getHeader("Access-Control-Allow-Origin");
  }

  it("applies a function origin's string answer as a fixed origin", async () => {
    expect(await answered("http://fixed.test")).toBe("http://fixed.test");
  });

  it("applies a function origin's RegExp and array answers", async () => {
    expect(await answered(/a\.test$/)).toBe("http://a.test");
    expect(await answered(/b\.test$/)).toBeNull();
    expect(await answered(["http://x.test", /a\.test$/])).toBe("http://a.test");
    expect(await answered(["http://x.test"])).toBeNull();
  });

  it("applies a function origin's boolean answers", async () => {
    expect(await answered(true)).toBe("http://a.test");
    expect(await answered(false)).toBeNull();
  });

  it("forwards a function origin's error to next", async () => {
    const req = await makeRequest({ headers: { Origin: "http://a.test" } });
    const res = await makeResponse();
    const failure = new Error("lookup failed");
    let received: unknown;
    await cors({ origin: (_origin, cb) => cb(failure) })(req, res, (err) => {
      received = err;
    });
    expect(received).toBe(failure);
  });
});

describe("cors(delegate)", () => {
  it("applies the options the delegate chooses", async () => {
    const req = await makeRequest({ headers: { Origin: "http://a.test" } });
    const res = await makeResponse();
    let nextCalled = false;
    const chosen: CorsOptions = {
      origin: ["http://a.test"],
      credentials: true,
    };

    await cors((_req, cb) => setTimeout(cb, 1, null, chosen))(req, res, () => {
      nextCalled = true;
    });

    expect(nextCalled).toBe(true);
    expect(res.getHeader("Access-Control-Allow-Origin")).toBe("http://a.test");
    expect(res.getHeader("Access-Control-Allow-Credentials")).toBe("true");
  });

  it("uses the defaults when the delegate answers no options", async () => {
    const req = await makeRequest({ headers: { Origin: "http://a.test" } });
    const res = await makeResponse();
    await cors((_req, cb) => cb(null))(req, res, () => {});
    expect(res.getHeader("Access-Control-Allow-Origin")).toBe("*");
  });

  it("passes a reported error to next(err) and sets no headers", async () => {
    const req = await makeRequest({ headers: { Origin: "http://a.test" } });
    const res = await makeResponse();
    const failure = new Error("banned");
    let received: unknown;

    await cors((_req, cb) => cb(failure))(req, res, (err) => {
      received = err;
    });

    expect(received).toBe(failure);
    expect(res.headersSent).toBe(false);
    expect(res.getHeader("Access-Control-Allow-Origin")).toBeNull();
  });

  it("passes a thrown error to next(err)", async () => {
    const req = await makeRequest({ headers: { Origin: "http://a.test" } });
    const res = await makeResponse();
    let received: unknown;

    await cors(() => {
      throw new Error("threw");
    })(req, res, (err) => {
      received = err;
    });

    expect((received as Error).message).toBe("threw");
  });
});
