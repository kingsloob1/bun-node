/**
 * `requestFacts`: a web-standard request turned into bounded, plain facts,
 * the client resolved by bun-common's trust-proxy resolution (plan §4.1).
 */
import { describe, expect, it } from "bun:test";
import {
  MAX_FACT_HEADER_LENGTH,
  MAX_FACT_HEADERS,
  requestFacts,
} from "../../lib/index";
import { cookieNamesOf, rawPathOf } from "../../lib/engine/facts";

describe("requestFacts", () => {
  it("reads method, raw path, headers, cookies and length", () => {
    const facts = requestFacts(
      new Request("http://app.test/a/b%2Fc?x=1#frag", {
        method: "POST",
        headers: {
          Cookie: "sid=1; theme=dark; =skip; flag",
          "X-Upper": "V",
          "Content-Length": "5",
        },
      }),
      {
        peer: "203.0.113.1",
        routeKey: "POST /a",
        service: "svc",
        environment: "prod",
        identity: { user: "u" },
      },
    );
    expect(facts).toEqual({
      method: "POST",
      path: "/a/b%2Fc",
      rawPath: "/a/b%2Fc",
      query: "x=1",
      headers: {
        cookie: "sid=1; theme=dark; =skip; flag",
        "x-upper": "V",
        "content-length": "5",
      },
      headerCount: 3,
      headerLengths: { cookie: 30, "x-upper": 1, "content-length": 1 },
      cookieNames: ["sid", "theme", "flag"],
      peer: "203.0.113.1",
      client: "203.0.113.1",
      chain: [{ address: "203.0.113.1", source: "socket", trusted: false }],
      contentLength: 5,
      routeKey: "POST /a",
      identity: { user: "u" },
      service: "svc",
      environment: "prod",
    });
  });

  it("bounds the headers it keeps", () => {
    const headers = new Headers();
    for (let i = 0; i < MAX_FACT_HEADERS + 20; i++) headers.set(`x-h${i}`, "v");
    headers.set("x-long", "a".repeat(MAX_FACT_HEADER_LENGTH + 100));
    const facts = requestFacts(new Request("http://app.test/", { headers }));
    expect(Object.keys(facts.headers)).toHaveLength(MAX_FACT_HEADERS);
    const long = requestFacts(
      new Request("http://app.test/", {
        headers: { "x-long": "a".repeat(MAX_FACT_HEADER_LENGTH + 100) },
      }),
    );
    expect(long.headers["x-long"]).toHaveLength(MAX_FACT_HEADER_LENGTH);
  });

  it("has no peer and no client without a socket", () => {
    const facts = requestFacts(new Request("http://app.test/"));
    expect(facts.peer).toBe("");
    expect(facts.client).toBe("");
  });

  it("resolves the client through trusted proxies only", () => {
    const request = () =>
      new Request("http://app.test/", {
        headers: { "x-forwarded-for": "198.51.100.1, 203.0.113.9" },
      });
    expect(requestFacts(request(), { peer: "10.0.0.1" }).client).toBe(
      "10.0.0.1",
    );
    expect(
      requestFacts(request(), { peer: "10.0.0.1", trustProxy: ["10.0.0.0/8"] })
        .client,
    ).toBe("203.0.113.9");
    expect(
      requestFacts(request(), { peer: "10.0.0.1", trustProxy: 2 }).client,
    ).toBe("198.51.100.1");
    expect(
      requestFacts(request(), { peer: "10.0.0.1", trustProxy: false }).chain,
    ).toHaveLength(1);
  });

  it("ignores a Content-Length that is not a whole number", () => {
    const facts = requestFacts(
      new Request("http://app.test/", {
        headers: { "content-length": "12abc" },
      }),
    );
    expect(facts.contentLength).toBeUndefined();
  });
});

describe("rawPathOf and cookieNamesOf", () => {
  it("cut the path from a URL as written", () => {
    expect(rawPathOf("http://h.test")).toBe("/");
    expect(rawPathOf("http://h.test/?q")).toBe("/");
    expect(rawPathOf("http://h.test//admin#x")).toBe("//admin");
    expect(rawPathOf("/relative?x")).toBe("/relative");
  });

  it("keep at most 64 cookie names", () => {
    expect(cookieNamesOf(undefined)).toEqual([]);
    const many = Array.from({ length: 100 }, (_, i) => `c${i}=1`).join("; ");
    expect(cookieNamesOf(many)).toHaveLength(64);
  });
});
