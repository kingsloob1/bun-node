/**
 * AD (e), plan §5/§9.2: the AsyncAPI generator over bun-common's own
 * channels — a `defineChannel` contract channel (params, the upgrade's
 * request schemas, replies, topics, subprotocol, binary, the SSE fallback and
 * the implicit error frame), an SSE endpoint's channel and the fallback
 * cross-reference, a bare `ws()` route's honest stub and its
 * `describeChannel()` enrichment, the strict/lenient modes, determinism, and
 * `wsRoutes()`'s read-only listing.
 *
 * The negative controls (per CLAUDE.md): the meta reach-through
 * (`x-bun-common-schema` on a parameter comes from `ChannelMeta.request`
 * riding the contract meta — `channel.ts` not passing it fails the test) and
 * the envelope wrapper (a payload without the `{ type, data }` frame fails
 * it), each provable by mutating the source and watching this file go red.
 */
import { describe, expect, it } from "bun:test";
import { z } from "zod";
import { BunRouter } from "../../lib/BunRouter";
import { validate } from "../../lib/BunValidate";
import { BunWebSocket } from "../../lib/BunWebSocket";
import { defineChannel } from "../../lib/channel";
import { describeContract } from "../../lib/contract/describe";
import { sse } from "../../lib/responseBodies";
import { ConfigError } from "../../lib/errors";
import type { AsyncApiOptions } from "../../lib/docs/index";
import { danglingRefs, generateAsyncApi } from "../../lib/docs/index";

/** A router + socket pair (no server needed: generation never binds). */
function harness(): { router: BunRouter; socket: BunWebSocket } {
  const router = new BunRouter();
  const socket = new BunWebSocket({
    newInstance: false,
    getServer: () => undefined,
    router,
  });
  return { router, socket };
}

const OPTIONS: AsyncApiOptions = { title: "The Events API", version: "1.0.0" };

/** The full contract channel: every channel mapping feature at once. */
function withChatChannel(router: BunRouter): void {
  const chat = defineChannel({
    path: "/rooms/:room",
    request: {
      params: z.object({ room: z.string().regex(/^[a-z][a-z0-9-]*$/) }),
      query: z.object({ name: z.string().min(1).optional() }),
      headers: z.object({ "x-tenant": z.string() }),
      cookies: z.object({ session: z.string() }),
    },
    receives: {
      say: z.object({ text: z.string().min(1).max(200) }),
      typing: null,
    },
    sends: {
      said: z.object({ by: z.string(), text: z.string() }),
      someoneTyping: z.object({ by: z.string() }),
    },
    replies: { say: "said" },
    subprotocol: "chat.v1",
    binary: true,
    topics: ["rooms", "rooms.lobby"],
    fallback: "/rooms/:room/events",
    envelope: { idField: "correlation" },
    meta: { name: "chat", description: "A validated chat room" },
  });
  router.ws(chat.path, chat.checks(), chat.handler({}), chat.options());
}

/** The SSE fallback endpoint the chat channel names. */
function withSseFallback(router: BunRouter): void {
  router.get(
    "/rooms/:room/events",
    validate(
      { params: z.object({ room: z.string().regex(/^[a-z][a-z0-9-]*$/) }) },
      {
        responses: {
          200: {
            content: {
              "text/event-stream": sse({
                said: z.object({ by: z.string(), text: z.string() }),
              }),
            },
          },
        },
      },
    ),
    (_req, res) => res.send(new ReadableStream()),
  );
}

/** A non-SSE GET route (the control: it must produce no channel). */
function withPlainGet(router: BunRouter): void {
  router.get(
    "/rooms/:room",
    validate({}, { responses: { 200: z.object({ room: z.string() }) } }),
    (_req, res) => res.json({ room: "lobby" }),
  );
}

type Document = ReturnType<typeof generateAsyncApi>["document"];
/** The channels/operations/messages maps, typed loosely for the assertions (openapi.test.ts' own convention). */
/* eslint-disable @typescript-eslint/no-explicit-any */
function channelsOf(document: Document): Record<string, any> {
  return (document.channels ?? {}) as Record<string, any>;
}
function operationsOf(document: Document): Record<string, any> {
  return (document.operations ?? {}) as Record<string, any>;
}
function messagesOf(document: Document): Record<string, any> {
  return ((document.components as { messages?: object } | undefined)
    ?.messages ?? {}) as Record<string, any>;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

describe("generateAsyncApi: a defineChannel channel documents itself", () => {
  const { router } = harness();
  withChatChannel(router);
  withSseFallback(router);
  withPlainGet(router);
  const { document, warnings } = generateAsyncApi(router, OPTIONS);

  it("warns about nothing", () => {
    expect(warnings).toEqual([]);
  });

  it("emits asyncapi 3.0.0 (matching bun-jobs)", () => {
    expect(document.asyncapi).toBe("3.0.0");
    expect(document.info).toMatchObject({
      title: "The Events API",
      version: "1.0.0",
    });
  });

  it("maps the address, the parameter and its schema (x-bun-common-schema)", () => {
    const chat = channelsOf(document).chat as never as {
      address: string;
      parameters: Record<string, Record<string, unknown>>;
      description: string;
    };
    expect(chat.address).toBe("/rooms/{room}");
    expect(chat.parameters.room["x-bun-common-schema"]).toMatchObject({
      type: "string",
      pattern: "^[a-z][a-z0-9-]*$",
    });
    // The channel's declared description leads, the envelope prose follows.
    expect(chat.description).toContain("A validated chat room");
    expect(chat.description).toContain('"correlation"?: string');
    // The declared cookies are prose (the ws binding has no cookie field).
    expect(chat.description).toContain("Cookie");
  });

  it("carries the upgrade's query/headers on the ws binding", () => {
    const chat = channelsOf(document).chat as never as {
      bindings: { ws: Record<string, unknown> };
    };
    expect(chat.bindings.ws.method).toBe("GET");
    expect(chat.bindings.ws.query).toMatchObject({ type: "object" });
    expect(
      (chat.bindings.ws.headers as { properties: object }).properties,
    ).toHaveProperty("x-tenant");
  });

  it("carries the meta as the approved extensions", () => {
    const chat = channelsOf(document).chat;
    expect(chat["x-bun-common-subprotocol"]).toBe("chat.v1");
    expect(chat["x-bun-common-binary"]).toBe(true);
    expect(chat["x-bun-common-topics"]).toEqual(["rooms", "rooms.lobby"]);
    expect(chat["x-bun-common-sse-fallback"]).toBe("/rooms/:room/events");
  });

  it("documents inbound messages as receive operations, with the declared reply", () => {
    const operations = operationsOf(document);
    const say = operations.receiveChatSay as never as {
      action: string;
      messages: { $ref: string }[];
      reply: { messages: { $ref: string }[] };
    };
    expect(say.action).toBe("receive");
    expect(say.messages[0].$ref).toBe("#/channels/chat/messages/say");
    expect(say.reply.messages[0].$ref).toBe("#/channels/chat/messages/said");
    const typing = operations.receiveChatTyping as never as {
      action: string;
      reply?: unknown;
    };
    expect(typing.action).toBe("receive");
    expect(typing.reply).toBeUndefined();
  });

  it("documents outbound messages as one send operation, the implicit error included", () => {
    const send = operationsOf(document).sendChat as never as {
      action: string;
      messages: { $ref: string }[];
    };
    expect(send.action).toBe("send");
    expect(send.messages.map((m) => m.$ref).sort()).toEqual([
      "#/channels/chat/messages/error",
      "#/channels/chat/messages/said",
      "#/channels/chat/messages/someoneTyping",
    ]);
    // The implicit error frame is a declared outbound key (channel.ts).
    const error = messagesOf(document)["chat.error"] as never as {
      summary: string;
      payload: { properties: { data: { properties: object } } };
    };
    expect(error.summary).toContain("framework");
    expect(error.payload.properties.data.properties).toHaveProperty("code");
  });

  it("wraps every payload in the channel envelope ({ type, correlation?, data })", () => {
    const say = messagesOf(document)["chat.say"] as never as {
      contentType: string;
      payload: {
        properties: Record<string, unknown>;
        required: string[];
      };
    };
    expect(say.contentType).toBe("application/json");
    expect([...say.payload.required].sort()).toEqual(["data", "type"]);
    expect(say.payload.properties.type).toMatchObject({ const: "say" });
    // The envelope's id field is the declared one, not the default "id".
    expect(say.payload.properties).toHaveProperty("correlation");
    expect(say.payload.properties).not.toHaveProperty("id");
    expect(say.payload.properties.data).toMatchObject({
      type: "object",
      properties: { text: { type: "string" } },
    });
    // A `null` message (typing) carries no data.
    const typing = messagesOf(document)["chat.typing"] as never as {
      payload: { properties: Record<string, unknown>; required: string[] };
    };
    expect(typing.payload.required).toEqual(["type"]);
    expect(typing.payload.properties).not.toHaveProperty("data");
  });

  it("is deterministic and has no dangling refs", () => {
    const again = generateAsyncApi(router, OPTIONS);
    expect(again.document).toEqual(document);
    expect(again.warnings).toEqual(warnings);
    expect(danglingRefs(document)).toEqual([]);
  });

  it("passes in strict mode (the fixture is warning-free)", () => {
    expect(() =>
      generateAsyncApi(router, { ...OPTIONS, strict: "strict" }),
    ).not.toThrow();
  });
});

describe("generateAsyncApi: the SSE channel and the fallback cross-reference", () => {
  it("documents an SSE GET as one channel; a non-SSE GET produces none", () => {
    const { router } = harness();
    withChatChannel(router);
    withSseFallback(router);
    withPlainGet(router);
    const { document, warnings } = generateAsyncApi(router, OPTIONS);
    expect(warnings).toEqual([]);
    const channels = channelsOf(document);
    const events = channels.roomsByRoomEvents as {
      address: string;
      "x-bun-common-sse": boolean;
      bindings: { http: { method: string } };
      parameters: Record<string, Record<string, unknown>>;
      messages: Record<string, unknown>;
    };
    expect(events.address).toBe("/rooms/{room}/events");
    expect(events["x-bun-common-sse"]).toBe(true);
    expect(events.bindings.http.method).toBe("GET");
    // The GET's params schema feeds the parameter, as the upgrade's does.
    expect(events.parameters.room["x-bun-common-schema"]).toMatchObject({
      pattern: "^[a-z][a-z0-9-]*$",
    });
    // The event's data is the payload — no frame envelope on an SSE stream.
    const said = messagesOf(document)["roomsByRoomEvents.said"] as never as {
      payload: { properties: Record<string, unknown> };
    };
    expect(said.payload.properties).toHaveProperty("by");
    expect(said.payload.properties).not.toHaveProperty("type");
    // The control: the plain GET route is no channel.
    expect(Object.keys(channels).sort()).toEqual(["chat", "roomsByRoomEvents"]);
    // Its operation sends (the client receives the stream).
    const send = operationsOf(document).sendRoomsByRoomEvents as never as {
      action: string;
    };
    expect(send.action).toBe("send");
  });

  it("warns when a channel's fallback names no SSE endpoint of the document", () => {
    const { router } = harness();
    withChatChannel(router); // no SSE route this time
    const { warnings } = generateAsyncApi(router, OPTIONS);
    expect(warnings.map((w) => w.message)).toEqual([
      expect.stringContaining(
        'the SSE fallback "/rooms/:room/events" names no SSE endpoint',
      ),
    ]);
  });
});

describe("generateAsyncApi: a bare ws() route", () => {
  it("documents as an honest stub (one unconstrained message each way), with a warning", () => {
    const { router } = harness();
    router.ws("/raw/:id", { message(_ws, _message) {} });
    const { document, warnings } = generateAsyncApi(router, OPTIONS);
    expect(warnings.map((w) => w.message)).toEqual([
      expect.stringContaining("documents as a stub"),
    ]);
    const raw = channelsOf(document).rawById as never as {
      address: string;
      parameters: Record<string, Record<string, unknown>>;
    };
    expect(raw.address).toBe("/raw/{id}");
    // The address parameter is documented, schema-less.
    expect(raw.parameters.id["x-bun-common-schema"]).toEqual({
      type: "string",
    });
    // One stub message per direction: `incoming` (receive) and `outgoing`
    // (send), both unconstrained.
    expect(Object.keys(messagesOf(document)).sort()).toEqual([
      "rawById.incoming",
      "rawById.outgoing",
    ]);
    const stubIn = messagesOf(document)["rawById.incoming"] as never as {
      payload: Record<string, unknown>;
      summary: string;
    };
    expect(stubIn.payload).toEqual({});
    expect(stubIn.summary).toContain("client → server");
    expect(
      (messagesOf(document)["rawById.outgoing"] as never as { payload: object })
        .payload,
    ).toEqual({});
    // strict mode rejects the stub.
    expect(() =>
      generateAsyncApi(router, { ...OPTIONS, strict: "strict" }),
    ).toThrow(ConfigError);
  });

  it("is enriched by describeChannel() (receives, sends, reply, subprotocol)", () => {
    const { router, socket } = harness();
    router.ws("/raw/:id", { message(_ws, _message) {} });
    socket.describeChannel("/raw/:id", {
      title: "Raw socket",
      description: "A hand-rolled socket.",
      subprotocol: "raw.v1",
      receives: {
        ping: {
          summary: "Ask for a pong.",
          payload: z.object({ t: z.number() }),
          reply: "pong",
        },
      },
      sends: {
        pong: { payload: z.object({ t: z.number() }), summary: "The answer." },
      },
    });
    const { document, warnings } = generateAsyncApi(router, OPTIONS);
    expect(warnings).toEqual([]);
    const raw = channelsOf(document).rawById;
    expect(raw.title).toBe("Raw socket");
    expect(raw.description).toBe("A hand-rolled socket.");
    expect(raw["x-bun-common-subprotocol"]).toBe("raw.v1");
    // A doc payload is the frame itself (a bare route has no envelope).
    const ping = messagesOf(document)["rawById.ping"] as never as {
      summary: string;
      payload: { properties: Record<string, unknown> };
    };
    expect(ping.summary).toBe("Ask for a pong.");
    expect(ping.payload.properties).toHaveProperty("t");
    expect(ping.payload.properties).not.toHaveProperty("type");
    const receive = operationsOf(document).receiveRawByIdPing as never as {
      reply: { messages: { $ref: string }[] };
    };
    expect(receive.reply.messages[0].$ref).toBe(
      "#/channels/rawById/messages/pong",
    );
  });

  it("throws on an unknown path, and warns when the channel documents itself", () => {
    const { router, socket } = harness();
    expect(() =>
      socket.describeChannel("/nowhere", { description: "d" }),
    ).toThrow(TypeError);
    withChatChannel(router);
    socket.describeChannel("/rooms/:room", { title: "Redundant" });
    const { warnings } = generateAsyncApi(router, OPTIONS);
    expect(warnings.some((w) => w.message.includes("describeChannel()"))).toBe(
      true,
    );
    // And the contract channel won (its own title, not the doc's).
    const { document } = generateAsyncApi(router, OPTIONS);
    expect(channelsOf(document).chat.title).toBe("chat");
  });
});

describe("generateAsyncApi: the guards", () => {
  it("a duplicate channel id is always a ConfigError (even in lenient mode)", () => {
    const { router } = harness();
    for (const path of ["/a/chat", "/b/chat"]) {
      const dup = defineChannel({
        path,
        receives: { ping: null },
        sends: { pong: null },
        meta: { name: "chat" },
      });
      router.ws(dup.path, dup.checks(), dup.handler({}), dup.options());
    }
    expect(() => generateAsyncApi(router, OPTIONS)).toThrow(ConfigError);
    expect(() => generateAsyncApi(router, OPTIONS)).toThrow(
      /share the id "chat"/,
    );
  });

  it("an undocumentable path warns in lenient mode, and the entry is left out", () => {
    const { router } = harness();
    const wild = defineChannel({
      path: "/wild/*rest",
      receives: { ping: null },
      sends: { pong: null },
    });
    router.ws(wild.path, wild.checks(), wild.handler({}), wild.options());
    const { document, warnings } = generateAsyncApi(router, OPTIONS);
    expect(warnings.some((w) => w.stage === "path")).toBe(true);
    expect(channelsOf(document)).toEqual({});
    expect(() =>
      generateAsyncApi(router, { ...OPTIONS, strict: "strict" }),
    ).toThrow(ConfigError);
  });

  it("the filter option decides which entries are documented", () => {
    const { router } = harness();
    withChatChannel(router);
    withSseFallback(router);
    router.ws("/raw", { message(_ws, _message) {} });
    const { document } = generateAsyncApi(router, {
      ...OPTIONS,
      filter: (entry) => entry.kind !== "ws",
    });
    expect(Object.keys(channelsOf(document)).sort()).toEqual([
      "chat",
      "roomsByRoomEvents",
    ]);
  });

  it("a hidden route is left out (a docs route never documents itself)", () => {
    const { router } = harness();
    router
      .get(
        "/events",
        validate(
          {},
          {
            responses: {
              200: {
                content: {
                  "text/event-stream": sse({
                    tick: z.object({ n: z.number().int() }),
                  }),
                },
              },
            },
          },
        ),
        (_req, res) => res.send(new ReadableStream()),
      )
      .describe({ hidden: true });
    const { document } = generateAsyncApi(router, OPTIONS);
    expect(channelsOf(document)).toEqual({});
  });

  it("security: schemes are mapped to AsyncAPI, a conjunctive requirement warns", () => {
    const { router } = harness();
    withChatChannel(router);
    withSseFallback(router);
    const { document, warnings } = generateAsyncApi(router, {
      ...OPTIONS,
      securitySchemes: {
        bearer: { type: "http", scheme: "bearer" },
        key: { type: "apiKey", in: "query", name: "token" },
      },
    });
    expect(warnings).toEqual([]);
    const schemes = (
      document.components as { securitySchemes: Record<string, unknown> }
    ).securitySchemes;
    expect(schemes.bearer).toMatchObject({ type: "http", scheme: "bearer" });
    // The browser note joins the description (no header on a browser socket).
    expect((schemes.bearer as { description: string }).description).toContain(
      "browser WebSocket",
    );
    const app = (document.servers as Record<string, { security: unknown[] }>)
      .app;
    expect(app.security).toEqual([
      { $ref: "#/components/securitySchemes/bearer" },
      { $ref: "#/components/securitySchemes/key" },
    ]);

    const conjunctive = generateAsyncApi(router, {
      ...OPTIONS,
      securitySchemes: {
        bearer: { type: "http", scheme: "bearer" },
        key: { type: "apiKey", in: "query", name: "token" },
      },
      security: [{ bearer: [], key: [] }],
    });
    expect(
      conjunctive.warnings.some((w) =>
        w.message.includes("conjunctive security requirement"),
      ),
    ).toBe(true);
  });
});

describe("the meta reach-through (the control for ContractMeta.channel)", () => {
  it("describeContract's meta carries the ChannelMeta, request included", () => {
    const chat = defineChannel({
      path: "/rooms/:room",
      request: { params: z.object({ room: z.string() }) },
      receives: { say: null },
      sends: { said: null },
      replies: { say: "said" },
      subprotocol: "chat.v1",
      topics: ["rooms"],
      binary: true,
      fallback: "/rooms/:room/events",
    });
    const description = describeContract(chat.contract.contract);
    expect(description.transport).toBe("websocket");
    expect(description.meta.channel).toMatchObject({
      path: "/rooms/:room",
      subprotocol: "chat.v1",
      binary: true,
      topics: ["rooms"],
      fallback: "/rooms/:room/events",
      replies: { say: "said" },
      envelope: { idField: "id" },
    });
    // The upgrade's request schemas ride the meta (the generator's only
    // reach): drop them from channel.ts and this fails.
    expect(description.meta.channel?.request?.params).toBeDefined();
  });
});

describe("BunWebSocket.wsRoutes()", () => {
  it("lists the live routes as copies (the mutable maps are never exposed)", () => {
    const { router, socket } = harness();
    router.ws("/a", { message(_ws, _message) {} });
    router.ws("/b/:id", { open: () => {}, message: () => {} });
    const listed = socket.wsRoutes();
    expect(listed.map((route) => route.path).sort()).toEqual(["/a", "/b/:id"]);
    expect(listed.every((route) => route.handlers === 1)).toBe(true);
    // A fresh copy every call: mutating the answer touches nothing.
    (listed as unknown as { path: string }[]).length = 0;
    expect(socket.wsRoutes()).toHaveLength(2);
    // A removed route drops out of the listing.
    socket.removeRouteHandler("/a");
    expect(socket.wsRoutes().map((route) => route.path)).toEqual(["/b/:id"]);
  });

  it("is the only way a plain ws() route reaches a document", () => {
    const { router, socket } = harness();
    router.ws("/plain", { message(_ws, _message) {} });
    expect(socket.wsRoutes().map((route) => route.path)).toEqual(["/plain"]);
    const { document } = generateAsyncApi(router, OPTIONS);
    expect(Object.keys(channelsOf(document))).toEqual(["plain"]);
  });
});
