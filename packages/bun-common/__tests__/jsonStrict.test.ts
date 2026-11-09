/**
 * A body declared JSON, as body-parser's `json()` judges it: `strict` by
 * default, a `charset` that is `utf-*`, and a BOM dropped. Express's own answers
 * are compared in bun-nest's `bodyStrictCompat.nest.test.ts`.
 */
import { describe, expect, it } from "bun:test";
import { BunHttpAdapter, BunRouter, requestParsing } from "../lib";

const JSON_TYPE = "application/json";

/** An adapter echoing `req.body`, with `options` for its requests. */
function echo(options: ConstructorParameters<typeof BunHttpAdapter>[1] = {}) {
  const app = new BunHttpAdapter(0, options);
  app.post("/e", (req, res) => res.json({ body: req.body ?? "<none>" }));
  return app;
}

/** A POST of `body` under `contentType`. */
function post(contentType: string, body: string | Uint8Array) {
  return {
    method: "POST",
    headers: { "content-type": contentType },
    body,
  };
}

/** The bytes of `text` in UTF-16, with or without a BOM. */
function utf16(text: string, bigEndian = false, bom = false): Uint8Array {
  const bytes: number[] = bom ? (bigEndian ? [0xfe, 0xff] : [0xff, 0xfe]) : [];
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (bigEndian) {
      bytes.push(unit >> 8, unit & 0xff);
    } else {
      bytes.push(unit & 0xff, unit >> 8);
    }
  }
  return new Uint8Array(bytes);
}

const BARE = ["null", "1", "-1", "1.5", "0", "-0", '"s"', "true", "false"];

/** Both ways a JSON body is read: as bytes, and with `request.json()`. */
const READS = [
  ["its bytes kept", {}],
  ["no bytes kept", { request: { retainBuffer: false } }],
] as const;

describe.each(READS)("strict by default, %s", (_name, options) => {
  for (const body of BARE) {
    it(`refuses ${body} with 400`, async () => {
      const response = await echo(options).fetch("/e", post(JSON_TYPE, body));
      expect(response.status).toBe(400);
    });
  }

  it("accepts an object and an array, whitespace around them or not", async () => {
    const app = echo(options);
    for (const [body, expected] of [
      ["{}", {}],
      ['{"a":1}', { a: 1 }],
      ["[]", []],
      ["[1]", [1]],
      [' \n{"a":1}\t', { a: 1 }],
    ] as const) {
      const response = await app.fetch("/e", post(JSON_TYPE, body));
      expect(await response.json()).toEqual({ body: expected });
    }
  });

  it("reads an empty body as an empty object, as body-parser does", async () => {
    const response = await echo(options).fetch("/e", post(JSON_TYPE, ""));
    expect(await response.json()).toEqual({ body: {} });
  });
});

describe("what a refused body says", () => {
  /** The refusal on `req.bodyDecodingError`, through a bare router. */
  async function refusal(contentType: string, body: string) {
    let seen: (Error & Record<string, unknown>) | undefined;
    const router = new BunRouter();
    router.post("/e", (req, res) => {
      seen = req.bodyDecodingError as typeof seen;
      return res.json({ body: req.body ?? "<none>" });
    });
    const response = await router.fetch(
      new Request("http://localhost/e", post(contentType, body)),
    );
    await response.text();
    return seen;
  }

  it("names the first character, as body-parser's strict error does", async () => {
    for (const [body, first] of [
      ["null", "n"],
      ["1", "1"],
      ["-1", "-"],
      ['"s"', '"'],
      ["  true", "t"],
      ["nul", "n"],
      ["'s'", "'"],
    ]) {
      const error = await refusal(JSON_TYPE, body);
      expect(error).toBeInstanceOf(SyntaxError);
      expect(error?.message).toBe(
        `JSON Parse error: Unrecognized token '${first}'`,
      );
      expect(error).toMatchObject({
        status: 400,
        statusCode: 400,
        expose: true,
        type: "entity.parse.failed",
        body,
      });
    }
  });

  it("says a body of whitespace ended, as JSON.parse does", async () => {
    const error = await refusal(JSON_TYPE, "   ");
    expect(error?.message).toBe("JSON Parse error: Unexpected EOF");
  });

  it("is a SyntaxError with no bytes kept too, so a Nest filter maps it alike", async () => {
    const app = new BunHttpAdapter(0, { request: { retainBuffer: false } });
    const seen: unknown[] = [];
    app.setErrorHandler((error, _req, res) => {
      seen.push(error);
      return res.status(400).json({});
    });
    app.post("/e", (_req, res) => res.json({}));
    await app.fetch("/e", post(JSON_TYPE, "null"));
    await app.fetch("/e", post(JSON_TYPE, "{bad"));
    expect(seen).toHaveLength(2);
    for (const error of seen) {
      expect(error).toBeInstanceOf(SyntaxError);
      expect(error).toMatchObject({ type: "entity.parse.failed" });
    }
  });

  it("a charset: 415, naming it upper-cased, with its fields", async () => {
    const error = await refusal(`${JSON_TYPE}; charset=latin1`, "{}");
    expect(error?.message).toBe('unsupported charset "LATIN1"');
    expect(error).toMatchObject({
      status: 415,
      statusCode: 415,
      expose: true,
      type: "charset.unsupported",
      charset: "latin1",
    });
  });
});

describe("turning strict off", () => {
  /** The bare values, through `app`, each answered as itself. */
  async function acceptsBare(app: BunHttpAdapter) {
    for (const [body, expected] of [
      ["null", "<none>"],
      ["1", 1],
      ['"s"', "s"],
      ["true", true],
    ] as const) {
      const response = await app.fetch("/e", post(JSON_TYPE, body));
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ body: expected });
    }
  }

  it("the request option strictJson: false", async () => {
    await acceptsBare(echo({ request: { strictJson: false } }));
  });

  it("the request option, with no bytes kept", async () => {
    await acceptsBare(
      echo({ request: { strictJson: false, retainBuffer: false } }),
    );
  });

  it("parseBody.contentTypes.json.opts.strict: false, which overrides it", async () => {
    await acceptsBare(
      echo({
        request: {
          strictJson: true,
          parseBody: { contentTypes: { json: { opts: { strict: false } } } },
        },
      }),
    );
    const strict = echo({
      request: {
        strictJson: false,
        parseBody: { contentTypes: { json: { opts: { strict: true } } } },
      },
    });
    expect((await strict.fetch("/e", post(JSON_TYPE, "1"))).status).toBe(400);
  });

  it('useBodyParser("json", { strict: false }), though the body is read first', async () => {
    const app = echo();
    expect((await app.fetch("/e", post(JSON_TYPE, "1"))).status).toBe(400);
    app.useBodyParser("json", false, { strict: false });
    await acceptsBare(app);
  });

  it('useBodyParser("text", { strict: false }) says nothing of JSON', async () => {
    const app = echo();
    app.useBodyParser("text", false, { strict: false });
    expect((await app.fetch("/e", post(JSON_TYPE, "1"))).status).toBe(400);
  });

  it("requestParsing, for one route of a deferred body", async () => {
    const app = new BunHttpAdapter(0, { request: { deferBody: true } });
    app.use(
      "/loose",
      requestParsing({
        parseBody: { contentTypes: { json: { opts: { strict: false } } } },
      }),
    );
    const handler = (
      req: { body?: unknown },
      res: { json: (b: unknown) => unknown },
    ) => res.json({ body: req.body ?? "<none>" });
    app.post("/loose", handler as never);
    app.post("/strict", handler as never);
    const loose = await app.fetch("/loose", post(JSON_TYPE, "1"));
    expect(await loose.json()).toEqual({ body: 1 });
    expect((await app.fetch("/strict", post(JSON_TYPE, "1"))).status).toBe(400);
  });

  it("still refuses what does not parse", async () => {
    const app = echo({ request: { strictJson: false } });
    expect((await app.fetch("/e", post(JSON_TYPE, "nul"))).status).toBe(400);
  });
});

describe("a body with no Content-Type is only tried as JSON", () => {
  it("is not refused for being bare", async () => {
    const app = echo();
    const response = await app.fetch(
      new Request("http://localhost/e", {
        method: "POST",
        body: new TextEncoder().encode("1"),
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ body: 1 });
  });
});

describe("a reviver has no say: the text is judged, as body-parser judges it", () => {
  it("an object a reviver turns into a number passes; a number it turns into an object does not", async () => {
    const toNumber = echo({
      request: {
        parseBody: {
          contentTypes: { json: { opts: { reviver: () => 7 } } },
        },
      },
    });
    expect(
      await (await toNumber.fetch("/e", post(JSON_TYPE, "{}"))).json(),
    ).toEqual({ body: 7 });
    const toObject = echo({
      request: {
        parseBody: {
          contentTypes: { json: { opts: { reviver: () => ({}) } } },
        },
      },
    });
    expect((await toObject.fetch("/e", post(JSON_TYPE, "1"))).status).toBe(400);
  });
});

describe.each(READS)("a charset, %s", (_name, options) => {
  for (const charset of [
    "utf-8",
    "UTF-8",
    '"utf-8"',
    "utf8",
    "UTF8",
    "utf-7",
    "utf-32",
    "utf-16",
  ]) {
    it(`takes ${charset}`, async () => {
      // UTF-16 and UTF-32 bodies have their own cases: this is whether it is refused.
      const response = await echo(options).fetch(
        "/e",
        post(`${JSON_TYPE}; charset=${charset}`, '{"a":1}'),
      );
      expect(response.status).not.toBe(415);
    });
  }

  for (const charset of [
    "latin1",
    "iso-8859-1",
    "ascii",
    "us-ascii",
    "windows-1252",
    "nope",
    "utf-nope",
    "utf-8x",
    "utf16",
  ]) {
    it(`refuses ${charset} with 415, whatever the body`, async () => {
      const app = echo(options);
      for (const body of ['{"a":1}', "{bad", "null", ""]) {
        const response = await app.fetch(
          "/e",
          post(`${JSON_TYPE}; charset=${charset}`, body),
        );
        expect(response.status).toBe(415);
      }
    });
  }

  for (const [name, header] of [
    ["no space", `${JSON_TYPE};charset=latin1`],
    ["the parameter's case", `${JSON_TYPE}; CHARSET=latin1`],
    ["another parameter first", `${JSON_TYPE}; v=1; charset=latin1`],
    ["quoted", `${JSON_TYPE}; charset="latin1"`],
    ["a +json type", "application/vnd.api+json; charset=latin1"],
  ]) {
    it(`reads it through ${name}`, async () => {
      const response = await echo(options).fetch("/e", post(header, "{}"));
      expect(response.status).toBe(415);
    });
  }

  for (const [name, header] of [
    ["no value", `${JSON_TYPE}; charset`],
    ["an empty value", `${JSON_TYPE}; charset=`],
    ["an empty quoted value", `${JSON_TYPE}; charset=""`],
    ["a word that only contains it", `${JSON_TYPE}; xcharset=latin1`],
  ]) {
    it(`ignores ${name}`, async () => {
      const response = await echo(options).fetch("/e", post(header, "{}"));
      expect(response.status).toBe(200);
    });
  }

  it("only for a JSON body: a form or text charset is not read", async () => {
    const app = echo(options);
    for (const type of ["application/x-www-form-urlencoded", "text/plain"]) {
      const response = await app.fetch(
        "/e",
        post(`${type}; charset=latin1`, "a=1"),
      );
      expect(response.status).toBe(200);
    }
  });

  it("nor when JSON's parser is off", async () => {
    const app = echo({
      request: { parseBody: { contentTypes: { urlencoded: true } } },
    });
    const response = await app.fetch(
      "/e",
      post(`${JSON_TYPE}; charset=latin1`, "{}"),
    );
    expect(response.status).toBe(200);
  });
});

describe.each(READS)("decoding, %s", (_name, options) => {
  it("drops a UTF-8 BOM, and judges what follows it", async () => {
    const app = echo(options);
    // oven-sh/bun#48380. As bytes, as a client sends them: Bun's `json()` keeps the BOM of a
    // `Request` built in process from a string, against the fetch spec.
    const withBom = (text: string) =>
      new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(text)]);
    const object = await app.fetch("/e", post(JSON_TYPE, withBom('{"a":1}')));
    expect(await object.json()).toEqual({ body: { a: 1 } });
    const bare = await app.fetch("/e", post(JSON_TYPE, withBom("null")));
    expect(bare.status).toBe(400);
  });

  const TEXT = '{"a":"é"}';
  for (const [name, charset, bytes] of [
    ["utf-16 with a little-endian BOM", "utf-16", utf16(TEXT, false, true)],
    ["utf-16 with a big-endian BOM", "utf-16", utf16(TEXT, true, true)],
    ["utf-16 with none, little-endian", "utf-16", utf16(TEXT)],
    ["utf-16 with none, big-endian", "utf-16", utf16(TEXT, true)],
    ["utf-16le", "utf-16le", utf16(TEXT)],
    ["utf-16le with its BOM", "utf-16le", utf16(TEXT, false, true)],
    ["utf-16be", "utf-16be", utf16(TEXT, true)],
    ["utf-16-be", "utf-16-be", utf16(TEXT, true)],
  ] as const) {
    it(`decodes ${name}`, async () => {
      const response = await echo(options).fetch(
        "/e",
        post(`${JSON_TYPE}; charset=${charset}`, bytes),
      );
      expect(await response.json()).toEqual({ body: { a: "é" } });
    });
  }

  it("judges a UTF-16 body once decoded", async () => {
    const response = await echo(options).fetch(
      "/e",
      post(`${JSON_TYPE}; charset=utf-16le`, utf16("null")),
    );
    expect(response.status).toBe(400);
  });
});
