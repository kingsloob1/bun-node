import type { BunRequest } from "../lib/BunRequest";
import type { BunResponse } from "../lib/BunResponse";
import type { WebRequestSource } from "../lib/webRequest";
import { Buffer } from "node:buffer";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "bun:test";
import { BunHttpAdapter, requestParsing, webRequestSource } from "../lib";
import { BunRequest as BunRequestClass } from "../lib/BunRequest";
import { testServer } from "./helpers";

/**
 * `req.webRequest()`: the request as a web `Request` carrying its body as
 * received, for a handler written against the Fetch API (better-auth's,
 * bun-auth plan §4.1, PR-A0). Requests are served-shaped (they carry a
 * `Content-Length`, as a served request does), so a body is read the way a
 * served one is: `request.json()`/`request.text()` with `retainBuffer: false`,
 * as bytes otherwise.
 */

const silent = { logger: () => {} };

/** A body under test: its bytes, its content type, and what `req.body` parses to. */
interface BodyCase {
  /** The case's name. */
  name: string;
  /** The bytes sent. */
  bytes: Uint8Array;
  /** The `Content-Type` sent; `undefined` sends none. */
  type: string | undefined;
  /** Whether `retainBuffer: false` reads it without its bytes. */
  direct: boolean;
  /** Asserts what a request holds once its body is parsed: `req.body`, or a multipart body's fields. */
  parsed: (parsed: Parsed) => void;
}

/** What a request's body parsed to: `req.body`, and a multipart body's fields. */
interface Parsed {
  /** `req.body`. */
  body: unknown;
  /** `(await req.getMultiParts({})).fields`: `{}` but for a multipart body. */
  fields: unknown;
}

/** Reads what `req` parsed its body to. */
async function parsedOf(req: BunRequest): Promise<Parsed> {
  return { body: req.body, fields: (await req.getMultiParts({})).fields };
}

const utf8 = (text: string) => new TextEncoder().encode(text);

const BOUNDARY = "----webRequestBoundary";

/** A multipart body with two fields, one with two spaces in its value. */
const multipart = {
  bytes: utf8(
    [
      `--${BOUNDARY}`,
      'Content-Disposition: form-data; name="email"',
      "",
      "a@b.c",
      `--${BOUNDARY}`,
      'Content-Disposition: form-data; name="note"',
      "",
      "two  spaces",
      `--${BOUNDARY}--`,
      "",
    ].join("\r\n"),
  ),
  type: `multipart/form-data; boundary=${BOUNDARY}`,
};

/** Every parse mode, each with spacing or ordering a re-serialisation changes. */
const CASES: BodyCase[] = [
  {
    name: "json",
    bytes: utf8('{ "email" : "a@b.c",\n  "n": 1 }'),
    type: "application/json",
    direct: true,
    parsed: ({ body }) => expect(body).toEqual({ email: "a@b.c", n: 1 }),
  },
  {
    name: "urlencoded",
    bytes: utf8("z=1&email=a%40b.c&note=p+w"),
    type: "application/x-www-form-urlencoded",
    direct: true,
    parsed: ({ body }) =>
      expect(body).toEqual({ z: "1", email: "a@b.c", note: "p w" }),
  },
  {
    name: "multipart",
    bytes: multipart.bytes,
    type: multipart.type,
    direct: false,
    parsed: ({ fields }) =>
      expect(fields).toEqual({ email: "a@b.c", note: "two  spaces" }),
  },
  {
    name: "text",
    bytes: utf8("hello  world\n"),
    type: "text/plain",
    direct: true,
    parsed: ({ body }) => expect(body).toBe("hello  world\n"),
  },
  {
    name: "xml",
    bytes: utf8('<?xml version="1.0"?>\n<a x="1">\n  <b>2</b>\n</a>'),
    type: "application/xml",
    direct: true,
    parsed: ({ body }) => expect(body).toEqual({ a: { "@_x": 1, b: 2 } }),
  },
  {
    name: "raw",
    bytes: new Uint8Array([0, 1, 2, 254, 255]),
    type: "application/octet-stream",
    direct: false,
    parsed: ({ body }) =>
      expect([...(body as Buffer)]).toEqual([0, 1, 2, 254, 255]),
  },
  {
    name: "no content type",
    bytes: utf8('{"a":1}'),
    type: undefined,
    direct: false,
    parsed: ({ body }) => expect(body).toEqual({ a: 1 }),
  },
];

/** A served-shaped POST of `bytes`, with its `Content-Length`. */
function post(
  path: string,
  bytes: Uint8Array,
  type: string | undefined,
  extra: Record<string, string> = {},
): Request {
  const headers: Record<string, string> = {
    "content-length": String(bytes.byteLength),
    ...extra,
  };
  if (type !== undefined) {
    headers["content-type"] = type;
  }
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers,
    body: bytes,
  });
}

/** What a downstream handler saw of each of two `webRequest()` calls. */
interface Seen {
  /** `webRequestSource` of each answer. */
  sources: (WebRequestSource | undefined)[];
  /** The bytes each answer's body held. */
  bytes: Uint8Array[];
  /** The `Content-Type` each answer carried. */
  types: (string | null)[];
  /** The `Content-Length` each answer carried. */
  lengths: (string | null)[];
  /** What the body parsed to after both were read (a deferred body read then). */
  parsed: Parsed;
}

/**
 * Mounts a handler (by `use`, or as a route) that calls `webRequest()` twice,
 * reads both answers, then reads `req.body`, and sends `request` through it.
 */
async function through(
  request: Request,
  options: { deferBody?: boolean; retainBuffer?: boolean },
  mount: "use" | "route",
): Promise<Seen> {
  const app = new BunHttpAdapter(0, { ...silent, request: options });
  let seen: Seen | undefined;
  const handler = async (req: BunRequest, res: BunResponse) => {
    const answers = [req.webRequest(), req.webRequest()];
    const bytes = await Promise.all(
      answers.map(async (r) => new Uint8Array(await r.arrayBuffer())),
    );
    // A body left unread by `deferBody` is read now: the answers above
    // must not have consumed it.
    await req.ready();
    seen = {
      sources: answers.map((r) => webRequestSource(r)),
      bytes,
      types: answers.map((r) => r.headers.get("content-type")),
      lengths: answers.map((r) => r.headers.get("content-length")),
      parsed: await parsedOf(req),
    };
    res.send("ok");
  };
  if (mount === "use") {
    app.use("/x", handler);
  } else {
    app.post("/x", handler);
  }
  const response = await app.fetch(request);
  expect(await response.text()).toBe("ok");
  return seen!;
}

/** The source `webRequest()` must report for a case, mount and options. */
function expectedSource(
  body: BodyCase,
  deferBody: boolean,
  retainBuffer: boolean,
  mount: "use" | "route",
): WebRequestSource {
  if (deferBody && mount === "use") {
    return "original";
  }
  return !retainBuffer && body.direct ? "parsed" : "retained";
}

describe("req.webRequest(): every parse mode × deferBody × retainBuffer", () => {
  for (const body of CASES) {
    for (const deferBody of [false, true]) {
      for (const retainBuffer of [true, false]) {
        for (const mount of ["use", "route"] as const) {
          const label = `${body.name}, deferBody ${deferBody}, retainBuffer ${retainBuffer}, by ${mount}`;
          it(label, async () => {
            const seen = await through(
              post("/x", body.bytes, body.type),
              { deferBody, retainBuffer },
              mount,
            );
            const source = expectedSource(body, deferBody, retainBuffer, mount);
            expect(seen.sources).toEqual([source, source]);
            for (let i = 0; i < 2; i++) {
              expect(seen.types[i]).toBe(body.type ?? null);
              expect(seen.lengths[i]).toBe(String(seen.bytes[i].byteLength));
              if (source === "parsed") {
                // The same value in the same type, not the same bytes: the
                // cases are spaced so a re-serialisation shows (text alone
                // survives it).
                const again = await BunRequestClass.init(
                  post("/x", seen.bytes[i], body.type),
                  testServer,
                  { parseBody: true },
                );
                body.parsed(await parsedOf(again));
                if (body.name !== "text") {
                  expect(Buffer.from(seen.bytes[i]).equals(body.bytes)).toBe(
                    false,
                  );
                }
              } else {
                expect([...seen.bytes[i]]).toEqual([...body.bytes]);
              }
            }
            // req.body still works after both answers were read.
            body.parsed(seen.parsed);
          });
        }
      }
    }
  }

  it("a request with no body answers one with none, the original itself", async () => {
    for (const deferBody of [false, true]) {
      for (const method of ["GET", "POST", "DELETE"]) {
        const app = new BunHttpAdapter(0, {
          ...silent,
          request: { deferBody },
        });
        let original: Request | undefined;
        let answer: Request | undefined;
        app.all("/x", (req, res) => {
          original = req.request;
          answer = req.webRequest();
          res.send("ok");
        });
        await app.fetch(new Request("http://localhost/x", { method }));
        expect(answer).toBe(original);
        expect(webRequestSource(answer!)).toBe("none");
        expect(answer!.body).toBeNull();
      }
    }
  });

  it("HEAD answers a request with no body", async () => {
    const app = new BunHttpAdapter(0, silent);
    let answer: Request | undefined;
    app.head("/x", (req, res) => {
      answer = req.webRequest();
      void res.end();
    });
    await app.fetch(new Request("http://localhost/x", { method: "HEAD" }));
    expect(answer!.method).toBe("HEAD");
    expect(answer!.body).toBeNull();
    expect(webRequestSource(answer!)).toBe("none");
  });

  it("a GET that came with a body answers a copy without one", async () => {
    // A served GET can carry a body; `new Request` cannot build one, so the
    // request is built over a stream-bodied POST's internals: a BunRequest
    // around a GET whose `body` is not null.
    const native = new Request("http://localhost/x", {
      method: "GET",
      headers: { "content-length": "3", "x-keep": "1" },
    });
    Object.defineProperty(native, "body", {
      value: new Blob(["abc"]).stream(),
    });
    const req = await BunRequestClass.init(native, testServer, {
      parseBody: false,
    });
    const answer = req.webRequest();
    expect(answer).not.toBe(native);
    expect(answer.method).toBe("GET");
    expect(answer.body).toBeNull();
    expect(answer.headers.get("content-length")).toBeNull();
    expect(answer.headers.get("x-keep")).toBe("1");
    expect(webRequestSource(answer)).toBe("none");
  });
});

describe("req.webRequest(): the marker", () => {
  it("is undefined for a Request webRequest() did not answer, copies included", async () => {
    const app = new BunHttpAdapter(0, silent);
    let answer: Request | undefined;
    app.post("/x", (req, res) => {
      answer = req.webRequest();
      res.send("ok");
    });
    await app.fetch(post("/x", utf8('{"a":1}'), "application/json"));
    expect(webRequestSource(answer!)).toBe("retained");
    // Negative controls: a copy of it, and an unrelated request.
    expect(webRequestSource(answer!.clone() as Request)).toBeUndefined();
    expect(webRequestSource(new Request(answer!))).toBeUndefined();
    expect(webRequestSource(new Request("http://h/"))).toBeUndefined();
  });

  it('is "decoded" for a body that came with a Content-Encoding, the header dropped', async () => {
    const plain = utf8('{ "a" : 1 }');
    const gzipped = new Uint8Array(gzipSync(plain));
    for (const retainBuffer of [true, false]) {
      const app = new BunHttpAdapter(0, {
        ...silent,
        request: { retainBuffer },
      });
      let answer: Request | undefined;
      app.post("/x", (req, res) => {
        answer = req.webRequest();
        res.send("ok");
      });
      await app.fetch(
        post("/x", gzipped, "application/json", { "content-encoding": "gzip" }),
      );
      expect(webRequestSource(answer!)).toBe("decoded");
      expect(answer!.headers.get("content-encoding")).toBeNull();
      expect(answer!.headers.get("content-length")).toBe(
        String(plain.byteLength),
      );
      expect([...new Uint8Array(await answer!.arrayBuffer())]).toEqual([
        ...plain,
      ]);
    }
  });

  it('is "original" for an encoded body left unread, its encoding kept', async () => {
    const gzipped = new Uint8Array(gzipSync(utf8('{"a":1}')));
    const app = new BunHttpAdapter(0, {
      ...silent,
      request: { deferBody: true },
    });
    let answer: Request | undefined;
    let body: unknown;
    app.use("/x", async (req, _res, next) => {
      answer = req.webRequest();
      await req.ready();
      body = req.body;
      next();
    });
    app.post("/x", (_req, res) => res.send("ok"));
    await app.fetch(
      post("/x", gzipped, "application/json", { "content-encoding": "gzip" }),
    );
    expect(webRequestSource(answer!)).toBe("original");
    expect(answer!.headers.get("content-encoding")).toBe("gzip");
    expect([...new Uint8Array(await answer!.arrayBuffer())]).toEqual([
      ...gzipped,
    ]);
    expect(body).toEqual({ a: 1 });
  });

  it("a rebuilt request keeps the URL, method, headers and drops Transfer-Encoding", async () => {
    const app = new BunHttpAdapter(0, silent);
    let answer: Request | undefined;
    app.put("/x", (req, res) => {
      answer = req.webRequest();
      res.send("ok");
    });
    await app.fetch(
      new Request("http://localhost/x?q=1", {
        method: "PUT",
        headers: {
          "content-type": "text/plain",
          "transfer-encoding": "chunked",
          cookie: "s=1",
        },
        body: "abc",
      }),
    );
    expect(answer!.url).toBe("http://localhost/x?q=1");
    expect(answer!.method).toBe("PUT");
    expect(answer!.headers.get("cookie")).toBe("s=1");
    expect(answer!.headers.get("transfer-encoding")).toBeNull();
    expect(answer!.headers.get("content-length")).toBe("3");
    expect(await answer!.text()).toBe("abc");
  });

  it("parsed: a form and XML keep the parser's options", async () => {
    // Built directly: a socket-free fetch under a cap is read as bytes.
    const xmlOptions = {
      parseBody: {
        contentTypes: {
          // `contentTypes` is an allowlist too.
          urlencoded: {},
          xml: { opts: { attributeNamePrefix: "$", textNodeName: "_t" } },
        },
      },
    };
    const answer = async (bytes: Uint8Array, type: string) => {
      const req = await BunRequestClass.init(
        post("/x", bytes, type),
        testServer,
        {
          ...xmlOptions,
          retainBuffer: false,
        },
      );
      const request = req.webRequest();
      expect(webRequestSource(request)).toBe("parsed");
      return BunRequestClass.init(
        post("/x", new Uint8Array(await request.arrayBuffer()), type),
        testServer,
        xmlOptions,
      );
    };
    const form = await answer(
      utf8("a[b]=1&a[c]=2&l=x&l=y"),
      "application/x-www-form-urlencoded",
    );
    expect(form.body).toEqual({ a: { b: "1", c: "2" }, l: ["x", "y"] });
    const xml = await answer(
      utf8('<r k="v &amp; w">t<c>1</c><c>2</c></r>'),
      "application/xml",
    );
    expect(xml.body).toEqual({ r: { $k: "v & w", _t: "t", c: [1, 2] } });
  });

  it("parsed: rebuilt from the value read, not one middleware replaced", async () => {
    const app = new BunHttpAdapter(0, {
      ...silent,
      request: { retainBuffer: false },
    });
    let answer: Request | undefined;
    app.post("/x", (req, res) => {
      req.body = { replaced: true };
      answer = req.webRequest();
      res.send("ok");
    });
    await app.fetch(post("/x", utf8('{"a":1}'), "application/json"));
    expect(webRequestSource(answer!)).toBe("parsed");
    expect(await answer!.json()).toEqual({ a: 1 });
  });
});

describe("req.webRequest(): refusals", () => {
  it("throws when the body was read through req.request with nothing kept", async () => {
    const req = await BunRequestClass.init(
      post("/x", utf8('{"a":1}'), "application/json"),
      testServer,
      { parseBody: false },
    );
    // Unread: a clone, and the original is still readable.
    expect(webRequestSource(req.webRequest())).toBe("original");
    expect(await req.request.json()).toEqual({ a: 1 });
    expect(() => req.webRequest()).toThrow(
      /webRequest\(\): the body was read with nothing kept/,
    );
  });

  it("throws while a read is still in progress, and answers once it is done", async () => {
    const req = await BunRequestClass.init(
      post("/x", utf8('{"a":1}'), "application/json"),
      testServer,
      { parseBody: true, deferBody: true },
    );
    const reading = req.ready();
    expect(() => req.webRequest()).toThrow(/await req\.ready\(\) first/);
    await reading;
    const answer = req.webRequest();
    expect(webRequestSource(answer)).toBe("retained");
    expect(await answer.json()).toEqual({ a: 1 });
  });
});

describe("req.webRequest(): requestParsing({ retainBuffer }) on a prefix (plan §4.1)", () => {
  // The plan assumed that `requestParsing({ retainBuffer: true })` on a
  // prefix keeps the exact bytes there. Measured: only for a body still
  // unread when it runs (`deferBody`); one read while the request was built
  // kept what the adapter said.
  const body = utf8('{ "email" : "a@b.c" }');
  const run = async (adapterOptions: {
    deferBody?: boolean;
    retainBuffer?: boolean;
  }) => {
    const app = new BunHttpAdapter(0, { ...silent, request: adapterOptions });
    app.use("/api/auth", requestParsing({ retainBuffer: true }));
    let answer: Request | undefined;
    app.post("/api/auth/sign-in", (req, res) => {
      answer = req.webRequest();
      res.send("ok");
    });
    await app.fetch(post("/api/auth/sign-in", body, "application/json"));
    return {
      source: webRequestSource(answer!),
      exact: Buffer.from(await answer!.arrayBuffer()).equals(body),
    };
  };

  it("keeps them with deferBody, whatever the adapter's retainBuffer", async () => {
    expect(await run({ deferBody: true, retainBuffer: false })).toEqual({
      source: "retained",
      exact: true,
    });
    expect(await run({ deferBody: true })).toEqual({
      source: "retained",
      exact: true,
    });
  });

  it("cannot without deferBody: the adapter's retainBuffer: false wins", async () => {
    expect(await run({ retainBuffer: false })).toEqual({
      source: "parsed",
      exact: false,
    });
    // The adapter's default keeps them anyway.
    expect(await run({})).toEqual({ source: "retained", exact: true });
  });

  it("negative control: without the middleware, deferBody alone does not keep them", async () => {
    const app = new BunHttpAdapter(0, {
      ...silent,
      request: { deferBody: true, retainBuffer: false },
    });
    let answer: Request | undefined;
    app.post("/api/auth/sign-in", (req, res) => {
      answer = req.webRequest();
      res.send("ok");
    });
    await app.fetch(post("/api/auth/sign-in", body, "application/json"));
    expect(webRequestSource(answer!)).toBe("parsed");
  });
});

/**
 * A stand-in for better-auth's handler: a `(request: Request) =>
 * Promise<Response>` that reads the body itself, JSON or a form.
 */
async function fetchHandler(request: Request): Promise<Response> {
  const type = request.headers.get("content-type") ?? "";
  const body = type.startsWith("application/x-www-form-urlencoded")
    ? Object.fromEntries(await request.formData())
    : await request.json();
  return Response.json(
    { path: new URL(request.url).pathname, body, type },
    {
      headers: [
        ["set-cookie", "a=1"],
        ["set-cookie", "b=2"],
      ],
    },
  );
}

describe("req.webRequest(): a Fetch API handler mounted on bun-common", () => {
  const configs = {
    default: {},
    deferBody: { deferBody: true },
    "retainBuffer: false": { retainBuffer: false },
  };
  const bodies = [
    ["json", utf8('{"email":"a@b.c","password":"pw"}'), "application/json"],
    [
      "form",
      utf8("email=a%40b.c&password=pw"),
      "application/x-www-form-urlencoded",
    ],
  ] as const;

  const mount = (
    app: BunHttpAdapter,
    how: "use" | "route",
    pick: (req: BunRequest) => Request,
  ) => {
    const handler = async (req: BunRequest, res: BunResponse) => {
      res.send(await fetchHandler(pick(req)));
    };
    if (how === "use") {
      app.use("/api/auth", handler);
    } else {
      app.all("/api/auth/*splat", handler);
    }
  };

  for (const [config, request] of Object.entries(configs)) {
    for (const how of ["use", "route"] as const) {
      for (const [kind, bytes, type] of bodies) {
        it(`${kind}, ${config} adapter, by ${how}: webRequest() reads`, async () => {
          const app = new BunHttpAdapter(0, { ...silent, request });
          mount(app, how, (req) => req.webRequest());
          const response = await app.fetch(
            post("/api/auth/sign-in", bytes, type),
          );
          expect(response.status).toBe(200);
          expect(await response.json()).toEqual({
            path: "/api/auth/sign-in",
            body: { email: "a@b.c", password: "pw" },
            type,
          });
          expect(response.headers.getSetCookie()).toEqual(["a=1", "b=2"]);
        });
      }
    }
  }

  // The negative control (plan evidence E5): req.request, read before the
  // handler, fails — on the default adapter by use and by route, and under
  // deferBody by route. Only deferBody by use passes it on unread.
  for (const [config, request, how] of [
    ["default", {}, "use"],
    ["default", {}, "route"],
    ["deferBody", { deferBody: true }, "route"],
  ] as const) {
    it(`negative control: req.request, ${config} adapter, by ${how}, fails`, async () => {
      const app = new BunHttpAdapter(0, { ...silent, request });
      mount(app, how, (req) => req.request);
      const response = await app.fetch(
        post("/api/auth/sign-in", bodies[0][1], bodies[0][2]),
      );
      expect(response.status).toBe(500);
    });
  }

  it("served on port 0: deferBody, by use, then req.body in the route", async () => {
    const app = new BunHttpAdapter(0, {
      ...silent,
      request: { deferBody: true },
    });
    let source: WebRequestSource | undefined;
    app.use("/api", async (req, _res, next) => {
      const request = req.webRequest();
      source = webRequestSource(request);
      const answer = await fetchHandler(request);
      // Read, and the route still parses the body.
      expect(answer.status).toBe(200);
      next();
    });
    app.post("/api/x", (req, res) => res.json(req.body));
    const server = await app.listen(0);
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/api/x`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"a":1}',
      });
      expect(await response.json()).toEqual({ a: 1 });
      expect(source).toBe("original");
    } finally {
      await app.close();
    }
  });
});
