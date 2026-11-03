/**
 * AsyncAPI → channels (typed-client plan, `websocket.md` §3, §12, PR-W2):
 * the route module's `Channels` and `channels`, the zod module's
 * `channelSchemas`, and how `readChannels` reads a document.
 *
 * The goldens are regenerated with the CLI, from the package directory:
 *
 * ```bash
 * bun lib/codegen/cli.ts generate --module __tests__/codegen/fixtures/channels.ts --out __tests__/codegen/fixtures/channels.gen.ts --zod __tests__/codegen/fixtures/channels.zod.gen.ts
 * ```
 *
 * `__tests__/channel.type-test.ts` checks the golden's entries `Equal` to
 * the fixture contracts inferred.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "bun:test";
import { readChannels } from "../../lib/codegen/asyncapi";
import { generateRoutes, loadDocuments, runCli } from "../../lib/codegen/index";
import { expressPath } from "../../lib/codegen/openapi";
import { channelSchemas } from "./fixtures/channels.zod.gen";

const FIXTURES = join(import.meta.dir, "fixtures");

/** A fixture's text. */
const text = (name: string) => Bun.file(join(FIXTURES, name)).text();

/** The fixture app's documents. */
const documents = () =>
  loadDocuments({ module: join(FIXTURES, "channels.ts") });

/** `readChannels` with its warnings collected. */
function read(document: object) {
  const warnings: { at: string; message: string }[] = [];
  const channels = readChannels(document, expressPath, (at, message) =>
    warnings.push({ at, message }),
  );
  return { channels, warnings };
}

/** A minimal AsyncAPI 3 document of one channel `id` at `address`. */
function documentOf(
  channel: Record<string, unknown>,
  operations: Record<string, unknown>,
  extra: Record<string, unknown> = {},
) {
  return {
    asyncapi: "3.0.0",
    info: { title: "t", version: "1" },
    channels: { c: { address: "/c/{id}", ...channel } },
    operations,
    ...extra,
  };
}

/** A bun-common envelope payload for `type`, with `data` when given. */
const envelope = (type: string, data?: unknown, idField = "id") => ({
  payload: {
    type: "object",
    properties: {
      type: { const: type },
      [idField]: { type: "string" },
      ...(data === undefined ? {} : { data }),
    },
  },
});

describe("the channels golden", () => {
  it("writes Channels, channels and channelSchemas from the fixture app's AsyncAPI document", async () => {
    const loaded = await documents();
    expect(loaded.asyncapi).toBeDefined();
    const result = generateRoutes(loaded.openapi, {
      asyncapi: loaded.asyncapi!,
      documentWarnings: loaded.warnings,
      zod: { routesModule: "./channels.gen" },
    });
    expect(result.code).toBe(await text("channels.gen.ts"));
    expect(result.zod!.code).toBe(await text("channels.zod.gen.ts"));
    expect(result.channels).toBe(2);
    expect(result.routes).toBe(1);
  });

  it("gives the same bytes on every run", async () => {
    const loaded = await documents();
    const once = generateRoutes(loaded.openapi, { asyncapi: loaded.asyncapi! });
    const twice = generateRoutes(loaded.openapi, {
      asyncapi: structuredClone(loaded.asyncapi!),
    });
    expect(twice.code).toBe(once.code);
  });

  it("writes no channel and no channel import without an AsyncAPI document, or with no WebSocket channel", async () => {
    const loaded = await documents();
    const none = generateRoutes(loaded.openapi);
    expect(none.channels).toBe(0);
    expect(none.code.includes("Channels")).toBe(false);
    expect(none.code.includes("/channel")).toBe(false);
    const sseOnly = generateRoutes(loaded.openapi, {
      asyncapi: documentOf({ "x-bun-common-sse": true }, {}),
    });
    expect(sseOnly.channels).toBe(0);
    expect(sseOnly.code.includes("ChannelDescriptors")).toBe(false);
  });

  it("the generated channelSchemas accept and refuse what the server's schemas do", () => {
    const room = channelSchemas["/rooms/:room"];
    const ok = (
      schema: { "~standard": { validate: (v: unknown) => unknown } },
      value: unknown,
    ) => !("issues" in (schema["~standard"].validate(value) as object));
    expect(ok(room.receives.say, { text: "hi" })).toBe(true);
    expect(ok(room.receives.say, { text: "" })).toBe(false);
    expect(ok(room.receives.join, { as: { name: "a", age: null } })).toBe(true);
    expect(ok(room.receives.join, { as: { name: "a", age: 1.5 } })).toBe(false);
    expect(room.receives.typing).toBeNull();
    expect(ok(room.sends.said, { by: "a", text: "b", level: "loud" })).toBe(
      false,
    );
  });

  it("generate --openapi … --asyncapi … writes the channels too", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bun-client-channels-"));
    try {
      const loaded = await documents();
      await writeFile(
        join(dir, "openapi.json"),
        JSON.stringify(loaded.openapi),
      );
      await writeFile(
        join(dir, "asyncapi.json"),
        JSON.stringify(loaded.asyncapi),
      );
      const code = await runCli(
        [
          "generate",
          "--openapi",
          "openapi.json",
          "--asyncapi",
          "asyncapi.json",
          "--out",
          "api.gen.ts",
        ],
        { cwd: dir, stdout: () => {}, stderr: () => {} },
      );
      expect(code).toBe(0);
      const written = await Bun.file(join(dir, "api.gen.ts")).text();
      expect(written).toContain("export interface Channels {");
      expect(written).toContain('"/rooms/:room": {\n    path: "/rooms/:room",');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("readChannels", () => {
  let fixture: object;
  beforeAll(async () => {
    fixture = (await documents()).asyncapi!;
  });

  it("reads a bun-common channel: the key, both sides, the replies, the id field, the subprotocol, the params and query", () => {
    const { channels, warnings } = read(fixture);
    expect(warnings).toEqual([]);
    const room = channels.find((c) => c.key === "/rooms/:room")!;
    expect(room.receives.map(([type]) => type)).toEqual([
      "join",
      "say",
      "typing",
    ]);
    expect(room.receives.find(([type]) => type === "typing")![1]).toBeNull();
    // The implicit error frame is the client's to read, not a message.
    expect(room.sends.map(([type]) => type)).toEqual([
      "joined",
      "left",
      "said",
    ]);
    expect(room.replies).toEqual([
      ["join", "joined"],
      ["say", "said"],
    ]);
    expect(room.idField).toBe("rid");
    expect(room.subprotocol).toBe("room.v1");
    expect(room.params.map(([name]) => name)).toEqual(["room"]);
    expect(room.query).toMatchObject({ type: "object", required: ["name"] });
    expect(room.doc).toBe("A chat room.");
    expect(channels.find((c) => c.key === "/ticker")!.idField).toBe("id");
  });

  it("leaves out the implicit error frame in either shape — flat (bun-common's document since the frame fix) or under `data` (older ones) — and keeps an app's own `error`", () => {
    /** One channel sending `said` and an `error` message with `payload`. */
    const withError = (payload: unknown) =>
      documentOf(
        {
          messages: {
            said: { $ref: "#/components/messages/said" },
            error: { $ref: "#/components/messages/error" },
          },
        },
        {
          s: {
            action: "send",
            channel: { $ref: "#/channels/c" },
            messages: [
              { $ref: "#/channels/c/messages/said" },
              { $ref: "#/channels/c/messages/error" },
            ],
          },
        },
        {
          components: {
            messages: {
              said: envelope("said", { type: "object" }, "rid"),
              error: { payload },
            },
          },
        },
      );
    const body = {
      type: "object",
      properties: {
        code: { enum: ["VALIDATION"] },
        status: { type: "integer" },
      },
    };
    // The flat frame the runtime sends: code and status at the top, `id`
    // beside them whatever the envelope's field, no `data`.
    const flat = read(
      withError({
        type: "object",
        properties: {
          type: { const: "error" },
          id: { type: "string" },
          ...body.properties,
        },
        required: ["type", "code", "status"],
      }),
    );
    expect(flat.warnings).toEqual([]);
    expect(flat.channels[0].sends.map(([type]) => type)).toEqual(["said"]);
    // The flat frame's `id` does not become the channel's id field.
    expect(flat.channels[0].idField).toBe("rid");
    // The envelope shape older documents described.
    const enveloped = read(withError(envelope("error", body, "rid").payload));
    expect(enveloped.channels[0].sends.map(([type]) => type)).toEqual(["said"]);
    // An app's own `error` message (no code and status) is a message.
    const own = read(
      withError(
        envelope("error", {
          type: "object",
          properties: { reason: { type: "string" } },
        }).payload,
      ),
    );
    expect(own.channels[0].sends.map(([type]) => type)).toEqual([
      "said",
      "error",
    ]);
  });

  it("reads bun-common's two messages for a type declared both ways, each direction its own schema", () => {
    const document = documentOf(
      {
        messages: {
          "ping.receive": { $ref: "#/components/messages/c.ping.receive" },
          "ping.send": { $ref: "#/components/messages/c.ping.send" },
        },
      },
      {
        r: {
          action: "receive",
          channel: { $ref: "#/channels/c" },
          messages: [{ $ref: "#/channels/c/messages/ping.receive" }],
          reply: {
            channel: { $ref: "#/channels/c" },
            messages: [{ $ref: "#/channels/c/messages/ping.send" }],
          },
        },
        s: {
          action: "send",
          channel: { $ref: "#/channels/c" },
          messages: [{ $ref: "#/channels/c/messages/ping.send" }],
        },
      },
      {
        components: {
          messages: {
            "c.ping.receive": {
              name: "ping",
              title: "ping (client → server)",
              ...envelope("ping", { required: ["sentAt"] }),
            },
            "c.ping.send": {
              name: "ping",
              title: "ping (server → client)",
              ...envelope("ping", { required: ["sentAt", "serverAt"] }),
            },
          },
        },
      },
    );
    const { channels, warnings } = read(document);
    expect(warnings).toEqual([]);
    expect(channels[0].receives).toEqual([["ping", { required: ["sentAt"] }]]);
    expect(channels[0].sends).toEqual([
      ["ping", { required: ["sentAt", "serverAt"] }],
    ]);
    expect(channels[0].replies).toEqual([["ping", "ping"]]);
  });

  it("types a payload that is not a bun-common envelope as the whole data, under its name, with a warning", () => {
    const document = documentOf(
      { messages: { m: { $ref: "#/components/messages/m" } } },
      {
        r: {
          action: "receive",
          channel: { $ref: "#/channels/c" },
          messages: [{ $ref: "#/channels/c/messages/m" }],
        },
      },
      {
        components: {
          messages: {
            m: {
              name: "hello",
              payload: {
                type: "object",
                properties: { who: { type: "string" } },
              },
            },
          },
        },
      },
    );
    const { channels, warnings } = read(document);
    expect(channels[0].receives).toEqual([
      ["hello", { type: "object", properties: { who: { type: "string" } } }],
    ]);
    expect(warnings[0].message).toContain("not a bun-common envelope");
  });

  it("inlines $refs, a recursive one left unchecked with a warning", () => {
    const document = documentOf(
      {
        messages: { m: envelope("say", { $ref: "#/components/schemas/Node" }) },
      },
      {
        r: {
          action: "receive",
          channel: { $ref: "#/channels/c" },
          messages: [{ $ref: "#/channels/c/messages/m" }],
        },
      },
      {
        components: {
          schemas: {
            Node: {
              type: "object",
              properties: { next: { $ref: "#/components/schemas/Node" } },
            },
          },
        },
      },
    );
    const { channels, warnings } = read(document);
    expect(channels[0].receives[0][1]).toEqual({
      type: "object",
      properties: { next: {} },
    });
    expect(warnings[0].message).toContain("is recursive");
    const generated = generateRoutes(
      { openapi: "3.1.0", info: { title: "t", version: "1" }, paths: {} },
      { asyncapi: document },
    );
    expect(generated.code).toContain("next?: unknown;");
  });

  it("leaves out a type starting with $, an SSE channel and a channel no operation names, each but the SSE one with a warning", () => {
    const dollar = documentOf(
      { messages: { m: envelope("$go") } },
      {
        r: {
          action: "receive",
          channel: { $ref: "#/channels/c" },
          messages: [{ $ref: "#/channels/c/messages/m" }],
        },
      },
    );
    expect(read(dollar).channels[0].receives).toEqual([]);
    expect(read(dollar).warnings[0].message).toContain('starting with "$"');
    const sse = documentOf({ "x-bun-common-sse": true }, {});
    expect(read(sse)).toEqual({ channels: [], warnings: [] });
    const orphan = documentOf({ messages: { m: envelope("x") } }, {});
    expect(read(orphan).channels).toEqual([]);
    expect(read(orphan).warnings[0].message).toContain(
      "no operation names this channel",
    );
  });

  it("refuses what is not an AsyncAPI 3 document, with a warning", () => {
    const { channels, warnings } = read({ asyncapi: "2.6.0", channels: {} });
    expect(channels).toEqual([]);
    expect(warnings[0].message).toContain("not an AsyncAPI 3.x document");
  });
});
