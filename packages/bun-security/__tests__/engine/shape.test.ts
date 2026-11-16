/**
 * Layer L6, request shape (layers.md L6): every refusal and its status,
 * T-L6-1 (disguised paths read canonically, so `/admin` list `paths` cannot
 * be stepped around), case folding as the router does, per-route body limits
 * and media types, dry run, the allow list, and the `shape.refused` event.
 */
import { describe, expect, it } from "bun:test";
import { createSecurity, requestFacts } from "../../lib/index";
import type { Decision, RequestFacts, SecurityPolicy } from "../../lib/index";
import { facts, fakeClock } from "../helpers";

/** An engine, quiet. */
function engine(policy: SecurityPolicy = {}) {
  // A clock that does not move: scores do not decay between requests.
  return createSecurity({
    // The managed probe set (on in dry run by default since PR-S12) is
    // left out: these cases are about other layers.
    policy: { requestRules: { managed: false }, ...policy },
    now: fakeClock().now,
    logger: () => {},
  });
}
type Engine = ReturnType<typeof engine>;

/** `evaluate()`, synchronously. */
function decide(security: Engine, request: RequestFacts): Decision {
  const decision = security.evaluate(request);
  if (decision instanceof Promise) throw new Error("expected synchronous");
  return decision;
}

/** The facts of a request to `url`, as `withSecurity` builds them. */
function req(
  url: string,
  init: RequestInit = {},
  peer = "203.0.113.10",
): RequestFacts {
  return requestFacts(new Request(`http://svc.test${url}`, init), { peer });
}

/** Facts with the raw path set as written (a `Request` would normalise it). */
function raw(rawPath: string, extra: Partial<RequestFacts> = {}): RequestFacts {
  return facts({ rawPath, path: rawPath, ...extra });
}

/** `[rule, status]` of a refused decision. */
const refusal = (decision: Decision) => [
  decision.hits.at(-1)?.rule,
  decision.status,
];

describe("refusals", () => {
  const security = engine({
    ladder: false,
    shape: {
      hosts: ["svc.test", "api.example.com:8443"],
      methods: ["GET", "POST"],
    },
  });

  it("refuses TRACE and CONNECT always, and methods outside the list (HEAD and OPTIONS are kept)", () => {
    expect(refusal(decide(security, raw("/", { method: "TRACE" })))).toEqual([
      "shape.method",
      405,
    ]);
    expect(refusal(decide(security, raw("/", { method: "PUT" })))).toEqual([
      "shape.method",
      405,
    ]);
    for (const method of ["GET", "HEAD", "OPTIONS", "POST"]) {
      expect(decide(security, raw("/", { method })).action).toBe("allow");
    }
    expect(refusal(decide(engine(), raw("/", { method: "CONNECT" })))).toEqual([
      "shape.method",
      405,
    ]);
  });

  it("refuses encoded slashes and backslashes, NUL and non-UTF-8 escapes (400), and long paths (414)", () => {
    for (const path of [
      "/files/a%2Fb",
      "/a%5cb",
      "/a%00",
      "/%C0%AE%C0%AE/etc",
    ]) {
      expect({ path, refused: refusal(decide(security, raw(path))) }).toEqual({
        path,
        refused: ["shape.path", 400],
      });
    }
    expect(refusal(decide(security, raw(`/${"a".repeat(2048)}`)))).toEqual([
      "shape.path",
      414,
    ]);
    expect(decide(security, raw(`/${"a".repeat(2047)}`)).action).toBe("allow");
  });

  it("refuses long, wide and deep queries", () => {
    expect(
      refusal(decide(security, raw("/", { query: "a=".padEnd(8193, "x") }))),
    ).toEqual(["shape.query", 414]);
    const wide = Array.from({ length: 257 }, (_, i) => `p${i}=1`).join("&");
    expect(refusal(decide(security, raw("/", { query: wide })))).toEqual([
      "shape.query",
      400,
    ]);
    expect(
      refusal(decide(security, raw("/", { query: "a[b][c][d][e][f][g]=1" }))),
    ).toEqual(["shape.query", 400]);
    expect(
      decide(security, raw("/", { query: "a[b][c][d][e][f]=1" })).action,
    ).toBe("allow");
  });

  it("T-L6-2: refuses a duplicate Host (Bun joins the lines with a comma), and a Host outside the list", () => {
    expect(
      refusal(
        decide(
          security,
          raw("/", { headers: { host: "svc.test, evil.example" } }),
        ),
      ),
    ).toEqual(["shape.host", 400]);
    expect(
      refusal(
        decide(security, raw("/", { headers: { host: "evil.example" } })),
      ),
    ).toEqual(["shape.host", 400]);
    expect(
      decide(security, raw("/", { headers: { host: "API.example.com:8443" } }))
        .action,
    ).toBe("allow");
    // Without a hosts list, any single Host passes; a duplicate never does.
    expect(
      decide(engine(), raw("/", { headers: { host: "anything.example" } }))
        .action,
    ).toBe("allow");
    expect(
      refusal(decide(engine(), raw("/", { headers: { host: "a, b" } }))),
    ).toEqual(["shape.host", 400]);
  });

  it("refuses too many headers and a header too long (431), with cookie's own limit", () => {
    expect(refusal(decide(security, raw("/", { headerCount: 101 })))).toEqual([
      "shape.headers",
      431,
    ]);
    const long = (name: string, length: number) =>
      raw("/", {
        headers: { [name]: "x".repeat(10) },
        headerLengths: { [name]: length },
      });
    expect(refusal(decide(security, long("x-big", 8193)))).toEqual([
      "shape.headers",
      431,
    ]);
    expect(decide(security, long("cookie", 16_000)).action).toBe("allow");
    expect(refusal(decide(security, long("cookie", 16_385)))).toEqual([
      "shape.headers",
      431,
    ]);
    // From a real request: the full length is read before the facts cut it.
    expect(
      refusal(
        decide(security, req("/", { headers: { "x-big": "y".repeat(9000) } })),
      ),
    ).toEqual(["shape.headers", 431]);
  });
});

describe("per-route body limits and media types", () => {
  const security = engine({
    ladder: false,
    shape: {
      maxBodySize: 1_000_000,
      routes: [
        {
          routes: ["POST /avatar"],
          maxBodySize: 100_000,
          contentTypes: ["image/*"],
        },
        { routes: ["/api/*"], contentTypes: ["application/json"] },
        { routes: ["/files/*"], allowEncodedSlash: true },
      ],
    },
  });
  const post = (path: string, length: number, type?: string) =>
    raw(path, {
      method: "POST",
      contentLength: length,
      headers: type ? { "content-type": type } : {},
    });

  it("refuses a Content-Length over the route's limit, else the policy's (413)", () => {
    expect(
      refusal(decide(security, post("/avatar", 100_001, "image/png"))),
    ).toEqual(["shape.body", 413]);
    expect(decide(security, post("/avatar", 100_000, "image/png")).action).toBe(
      "allow",
    );
    expect(refusal(decide(security, post("/other", 1_000_001)))).toEqual([
      "shape.body",
      413,
    ]);
  });

  it("refuses a body of a media type the route does not accept (415), a missing type included", () => {
    expect(refusal(decide(security, post("/avatar", 10, "text/html")))).toEqual(
      ["shape.content-type", 415],
    );
    expect(refusal(decide(security, post("/api/x", 10)))).toEqual([
      "shape.content-type",
      415,
    ]);
    expect(
      decide(security, post("/api/x", 10, "Application/JSON; charset=utf-8"))
        .action,
    ).toBe("allow");
    // No body, no media type needed.
    expect(decide(security, post("/api/x", 0)).action).toBe("allow");
  });

  it("lets a route opt out of the encoded-slash refusal", () => {
    expect(decide(security, raw("/files/a%2Fb")).action).toBe("allow");
    expect(refusal(decide(security, raw("/elsewhere/a%2Fb")))).toEqual([
      "shape.path",
      400,
    ]);
  });
});

describe("T-L6-1: a disguised path cannot step around a path rule", () => {
  const policy: SecurityPolicy = {
    ladder: false,
    lists: [{ ip: "203.0.113.0/24", action: "block", paths: ["/admin"] }],
  };

  it("matches //admin, encoded dots, backslashes and encoded letters, as built by requestFacts", () => {
    const security = engine(policy);
    for (const path of [
      "/admin",
      "//admin",
      "/a/%2e%2e/admin",
      "/%61dmin/x",
      "/a/..%5Cadmin",
    ]) {
      const decision = decide(security, req(path));
      expect({ path, action: decision.action }).toEqual({
        path,
        action: "block",
      });
    }
    expect(decide(security, req("/administrator")).action).toBe("allow");
  });

  it("folds case as bun-common's router does, unless the shape says the app is case-sensitive", () => {
    expect(decide(engine(policy), req("/ADMIN/x")).action).toBe("block");
    const sensitive = engine({ ...policy, shape: { caseSensitive: true } });
    expect(decide(sensitive, req("/ADMIN/x")).action).toBe("allow");
    expect(decide(sensitive, req("/admin/x")).action).toBe("block");
  });
});

describe("modes and who is checked", () => {
  it("dry run logs the would-be refusal; shape: false checks nothing", () => {
    const dry = decide(
      engine({ shape: { mode: "dryRun" } }),
      raw("/", { method: "TRACE" }),
    );
    expect(dry.action).toBe("log");
    expect(dry.hits[0]).toMatchObject({
      rule: "shape.method",
      wouldHaveBeen: "block",
    });
    expect(
      decide(engine({ shape: false }), raw("/", { method: "TRACE" })).action,
    ).toBe("allow");
  });

  it("an allow entry skips the checks", () => {
    const security = engine({
      lists: [{ ip: "198.51.100.0/24", action: "allow" }],
    });
    expect(
      decide(security, raw("/a%2Fb", { client: "198.51.100.1" })).action,
    ).toBe("allow");
  });

  it("a refusal is the `shape.refused` event: weight 1, and counted rules count it", () => {
    const security = engine({
      countedRules: [
        {
          id: "malformed",
          event: "shape.refused",
          threshold: 2,
          window: "1m",
          duration: "1h",
        },
      ],
    });
    expect(decide(security, raw("/a%00")).hits.map((hit) => hit.rule)).toEqual([
      "shape.path",
    ]);
    // Two refusals (1 each) and the trip (1) reach the ladder's first step, 3.
    expect(decide(security, raw("/a%00")).hits.map((hit) => hit.rule)).toEqual([
      "shape.path",
      "counted:malformed",
      "ladder",
    ]);
    expect(decide(security, raw("/fine")).hits.map((hit) => hit.rule)).toEqual([
      "ban:ip:203.0.113.10",
    ]);
  });
});
