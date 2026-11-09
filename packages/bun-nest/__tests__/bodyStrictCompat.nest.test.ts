/**
 * A body declared JSON, against Express on the installed Nest: body-parser's
 * `strict` default and its charset rule, on a Nest application on both adapters
 * and on plain Express against bun-common's own adapter. Express's answers are
 * measured, so the next release's drift fails here.
 *
 * bun-common answers a refusal on its own adapter with its status page, as
 * Express does in production, so that side compares statuses and what reached
 * the handler; a Nest application compares the whole body.
 *
 * bun-common's own cases are in its `__tests__/jsonStrict.test.ts`.
 *
 * No top-level `await`: it perturbs decorator metadata in other test files.
 */
import type { INestApplication } from "@nestjs/common";
import type { Server } from "node:http";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { BunHttpAdapter as CommonAdapter } from "@kingsleyweb/bun-common";
import { Controller, HttpCode, Module, Post, Req } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { BunHttpAdapter } from "../lib/BunHttpAdapter";
import { expressReference } from "./expressCompat/reference";
import "reflect-metadata";

/** One request: its name, `Content-Type` and body. */
type Case = readonly [
  name: string,
  contentType: string,
  body: string | Uint8Array,
];

const JSON_TYPE = "application/json";

/** `text` as UTF-16 bytes. */
function utf16(text: string, bigEndian = false): Uint8Array {
  const bytes: number[] = [];
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

/** `text` as UTF-8 bytes, after a BOM: as a string, Bun keeps the BOM (oven-sh/bun#48380). */
function withBom(text: string): Uint8Array {
  return new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(text)]);
}

/** What both answer alike. */
const CASES: readonly Case[] = [
  ...[
    "null",
    "1",
    "-1",
    "1.5",
    "0",
    "-0",
    "1e3",
    '"s"',
    "true",
    "false",
    " null",
    "\n\t 1 ",
    "[]",
    "{}",
    "[1]",
    " {} ",
    "",
    "  ",
    "nul",
    "{",
    "NaN",
    "'s'",
    "#",
  ].map((body): Case => [`body ${JSON.stringify(body)}`, JSON_TYPE, body]),
  ["a BOM before an object", JSON_TYPE, withBom("{}")],
  ["a BOM before a bare value", JSON_TYPE, withBom("null")],
  ...[
    "utf-8",
    "UTF-8",
    '"utf-8"',
    "utf-nope",
    "latin1",
    "iso-8859-1",
    "ascii",
    "us-ascii",
    "nope",
    "windows-1252",
    "",
  ].map((charset): Case => [
    `charset=${charset}`,
    `${JSON_TYPE}; charset=${charset}`,
    '{"a":"b"}',
  ]),
  ["charset=latin1, a bad body", `${JSON_TYPE}; charset=latin1`, "{bad"],
  ["charset=latin1, a bare body", `${JSON_TYPE}; charset=latin1`, "null"],
  ["charset=latin1, no space", `${JSON_TYPE};charset=latin1`, "{}"],
  ["charset=latin1, the name's case", `${JSON_TYPE}; CHARSET=latin1`, "{}"],
  [
    "charset=latin1, a parameter first",
    `${JSON_TYPE}; v=1; charset=latin1`,
    "{}",
  ],
  [
    "charset=latin1, a parameter after",
    `${JSON_TYPE}; charset=latin1; v=1`,
    "{}",
  ],
  ["charset=latin1, spaces", `${JSON_TYPE};  charset = latin1 `, "{}"],
  [
    "charset=latin1, a trailing semicolon",
    `${JSON_TYPE}; charset=latin1;`,
    "{}",
  ],
  [
    "charset=latin1, a bad parameter after",
    `${JSON_TYPE}; charset=latin1; bad`,
    "{}",
  ],
  ["charset quoted", `${JSON_TYPE}; charset="latin1"`, "{}"],
  ["charset quoted and escaped", `${JSON_TYPE}; charset="lat\\in1"`, "{}"],
  ["charset with no value", `${JSON_TYPE}; charset`, "{}"],
  ["charset twice", `${JSON_TYPE}; charset=latin1; charset=utf-8`, "{}"],
  [
    "charset twice, the other way",
    `${JSON_TYPE}; charset=utf-8; charset=latin1`,
    "{}",
  ],
  ["charset after a bare parameter", `${JSON_TYPE}; bad; charset=latin1`, "{}"],
  [
    "charset after a quoted semicolon",
    `${JSON_TYPE}; v="a;charset=x"; charset=latin1`,
    "{}",
  ],
  ["charset unterminated", `${JSON_TYPE}; charset="latin1`, "{}"],
  ["charset quoted, then text", `${JSON_TYPE}; charset="latin1"x; v=1`, "{}"],
  ["charset, empty and quoted", `${JSON_TYPE}; charset=""`, "{}"],
  [
    "charset, empty, then another",
    `${JSON_TYPE}; charset=; charset=latin1`,
    "{}",
  ],
  ["a name that only contains it", `${JSON_TYPE}; xcharset=latin1`, "{}"],
  ["utf-16le", `${JSON_TYPE}; charset=utf-16le`, utf16('{"a":"é"}')],
  ["utf-16be", `${JSON_TYPE}; charset=utf-16be`, utf16('{"a":"é"}', true)],
  ["utf-16 with no BOM", `${JSON_TYPE}; charset=utf-16`, utf16('{"a":"é"}')],
  [
    "utf-16 with a BOM",
    `${JSON_TYPE}; charset=utf-16`,
    new Uint8Array([0xff, 0xfe, ...utf16('{"a":"é"}')]),
  ],
  ["utf-16, a bare value", `${JSON_TYPE}; charset=utf-16le`, utf16("null")],
  ["utf-7, ASCII", `${JSON_TYPE}; charset=utf-7`, '{"a":"b"}'],
];

/** Listed differences: each still checked to differ, so a fixed one comes off. */
const DIFFERENT: readonly Case[] = [
  // Accepted on purpose: clients send it, and it can only mean UTF-8.
  ["charset=utf8", `${JSON_TYPE}; charset=utf8`, '{"a":"b"}'],
  ["charset=UTF8", `${JSON_TYPE}; charset=UTF8`, '{"a":"b"}'],
  // Read as UTF-8: `TextDecoder` has no UTF-32.
  [
    "utf-32",
    `${JSON_TYPE}; charset=utf-32le`,
    new Uint8Array([0x7b, 0, 0, 0, 0x7d, 0, 0, 0]),
  ],
  // A form's and a text body's charset rules are not read.
  [
    "a form, charset=latin1",
    "application/x-www-form-urlencoded; charset=latin1",
    "a=1",
  ],
];

/** A handler's answer: what reached it, or that nothing did. */
function echo(body: unknown) {
  return { body: body === undefined ? "<undefined>" : body };
}

@Controller()
class EchoController {
  @Post("e")
  @HttpCode(200)
  e(@Req() req: { body?: unknown }) {
    return echo(req.body);
  }
}

@Module({ controllers: [EchoController] })
class EchoModule {}

/** A POST of one case, as text: its status and body. */
async function send(base: string, [, type, body]: Case) {
  const response = await fetch(`${base}/e`, {
    method: "POST",
    headers: { "content-type": type },
    body,
  });
  return { status: response.status, body: await response.text() };
}

describe("a body declared JSON: Nest, against platform-express", () => {
  let express: INestApplication;
  let bun: INestApplication;
  let expressBase: string;
  let bunBase: string;

  beforeAll(async () => {
    express = await NestFactory.create(EchoModule, expressReference(), {
      logger: false,
    });
    bun = await NestFactory.create(EchoModule, new BunHttpAdapter(), {
      logger: false,
    });
    await express.listen(0);
    await bun.listen(0);
    expressBase = (await express.getUrl()).replace("[::1]", "127.0.0.1");
    bunBase = (await bun.getUrl()).replace("[::1]", "127.0.0.1");
  });

  afterAll(async () => {
    await express?.close();
    await bun?.close();
  });

  for (const entry of CASES) {
    it(`answers as Express: ${entry[0]}`, async () => {
      expect(await send(bunBase, entry)).toEqual(
        await send(expressBase, entry),
      );
    });
  }

  for (const entry of DIFFERENT) {
    it(`a listed difference, which still differs: ${entry[0]}`, async () => {
      const [reference, ours] = [
        await send(expressBase, entry),
        await send(bunBase, entry),
      ];
      expect(ours.status).not.toBe(reference.status);
    });
  }

  it("strict: false, as useBodyParser takes it on Express", async () => {
    const options = { logger: false } as const;
    const apps = [
      await NestFactory.create(EchoModule, expressReference(), {
        ...options,
        bodyParser: false,
      }),
      await NestFactory.create(EchoModule, new BunHttpAdapter(), {
        ...options,
        bodyParser: false,
      }),
    ];
    try {
      const answers = [];
      for (const app of apps) {
        (
          app as unknown as {
            useBodyParser: (type: string, options: object) => unknown;
          }
        ).useBodyParser("json", { strict: false });
        await app.listen(0);
        const base = (await app.getUrl()).replace("[::1]", "127.0.0.1");
        answers.push([
          await send(base, ["null", JSON_TYPE, "null"]),
          await send(base, ["1", JSON_TYPE, "1"]),
          await send(base, ['"s"', JSON_TYPE, '"s"']),
          await send(base, ["nul", JSON_TYPE, "nul"]),
        ]);
      }
      expect(answers[1]).toEqual(answers[0]);
      expect(answers[0][1]).toEqual({ status: 200, body: '{"body":1}' });
      expect(answers[0][3].status).toBe(400);
    } finally {
      for (const app of apps) {
        await app.close();
      }
    }
  });
});

describe("a body declared JSON: bun-common's adapter, against plain Express", () => {
  let server: Server;
  let common: CommonAdapter;
  let expressBase: string;
  let commonBase: string;

  beforeAll(async () => {
    const require = createRequire(import.meta.url);
    const express = require(
      require.resolve("express", {
        paths: [dirname(require.resolve("@nestjs/platform-express"))],
      }),
    ) as {
      (): {
        use: (...handlers: unknown[]) => void;
        post: (path: string, handler: unknown) => void;
        listen: (port: number, callback: () => void) => Server;
      };
      json: () => unknown;
    };
    const app = express();
    app.use(express.json());
    app.post(
      "/e",
      (req: { body?: unknown }, res: { json: (body: unknown) => unknown }) =>
        res.json(echo(req.body)),
    );
    await new Promise<void>((resolve) => {
      server = app.listen(0, resolve);
    });
    expressBase = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

    common = new CommonAdapter(0);
    common.post("/e", (req, res) => res.json(echo(req.body)));
    await common.listen(0);
    commonBase = `http://127.0.0.1:${common.listeningPort}`;
  });

  afterAll(async () => {
    server?.close();
    await common?.close();
  });

  for (const entry of CASES) {
    it(`takes or refuses it as Express: ${entry[0]}`, async () => {
      const [reference, ours] = [
        await send(expressBase, entry),
        await send(commonBase, entry),
      ];
      expect(ours.status).toBe(reference.status);
      if (reference.status === 200) {
        expect(ours.body).toBe(reference.body);
      }
    });
  }
});
