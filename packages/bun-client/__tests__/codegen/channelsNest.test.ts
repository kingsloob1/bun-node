/**
 * `readChannels` on a bun-nest gateway's document (typed-client plan,
 * `websocket.md` §11, PR-W3): `gatewayAsyncApi()` documents each message as
 * the whole packet (`{ type: <MessageEventTypes>, namespace, id?, data:
 * [event, payload] }`), the ack as the receive operation's reply. The shape
 * here is that document's, cut down; bun-nest's suite generates from a real
 * gateway's (`packages/bun-nest/__tests__/channelClient.nest.test.ts`, its
 * golden `fixtures/nest-channel/chat.gen.ts`).
 */
import { describe, expect, it } from "bun:test";
import { readChannels } from "../../lib/codegen/asyncapi";
import { expressPath, generateRoutes } from "../../lib/codegen/openapi";

/** `readChannels` with its warnings collected. */
function read(document: object) {
  const warnings: { at: string; message: string }[] = [];
  const channels = readChannels(document, expressPath, (at, message) =>
    warnings.push({ at, message }),
  );
  return { channels, warnings };
}

/** An EVENT packet's payload for `event`, its data `data` (none when `undefined`). */
const event = (name: string, data?: unknown) => ({
  name,
  payload: {
    type: "object",
    properties: {
      type: { const: 2 },
      namespace: { const: "/" },
      id: { oneOf: [{ type: "string" }, { type: "number" }] },
      data: {
        type: "array",
        items: [{ const: name }, ...(data === undefined ? [] : [data])],
        minItems: 1,
      },
    },
  },
});

/** A fixed packet (CONNECT 0, DISCONNECT 1, ERROR 4). */
const fixed = (type: number, name: string) => ({
  name,
  payload: {
    type: "object",
    properties: {
      type: { const: type },
      namespace: { const: "/" },
      ...(type === 4 ? { data: { type: "string" } } : {}),
    },
  },
});

/** A gateway's document, as `gatewayAsyncApi()` writes one (cut down). */
const gateway = {
  asyncapi: "3.0.0",
  info: { title: "Gateways", version: "1" },
  channels: {
    chat: {
      address: "/chat",
      description:
        "The ChatGateway gateway's socket (/chat).\n\nEvery frame is a socket.io-shaped packet `{ type, namespace, id?, data }`.",
      messages: {},
    },
  },
  operations: {
    receiveChatSay: {
      action: "receive",
      channel: { $ref: "#/channels/chat" },
      messages: [{ $ref: "#/components/messages/chat.in.say" }],
      reply: {
        channel: { $ref: "#/channels/chat" },
        messages: [{ $ref: "#/components/messages/chat.in.say.ack" }],
      },
    },
    receiveChatPing: {
      action: "receive",
      channel: { $ref: "#/channels/chat" },
      messages: [{ $ref: "#/components/messages/chat.in.ping" }],
    },
    lifecycleChat: {
      action: "receive",
      channel: { $ref: "#/channels/chat" },
      messages: [
        { $ref: "#/components/messages/chat.connect" },
        { $ref: "#/components/messages/chat.disconnect" },
      ],
    },
    sendChat: {
      action: "send",
      channel: { $ref: "#/channels/chat" },
      messages: [
        { $ref: "#/components/messages/chat.error" },
        { $ref: "#/components/messages/chat.out.said" },
        { $ref: "#/components/messages/chat.out.typing" },
      ],
    },
  },
  components: {
    messages: {
      "chat.in.say": event("say", {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
      }),
      "chat.in.say.ack": {
        name: "say ack",
        payload: {
          type: "object",
          properties: {
            type: { const: 3 },
            namespace: { const: "/" },
            id: { oneOf: [{ type: "string" }, { type: "number" }] },
            data: {
              type: "array",
              items: [
                {
                  type: "object",
                  properties: { ok: { type: "boolean" } },
                  required: ["ok"],
                },
              ],
              minItems: 1,
            },
          },
        },
      },
      "chat.in.ping": event("ping", {}),
      "chat.connect": fixed(0, "connect"),
      "chat.disconnect": fixed(1, "disconnect"),
      "chat.error": fixed(4, "error"),
      "chat.out.said": event("said", {
        type: "object",
        properties: { by: { type: "string" } },
        required: ["by"],
      }),
      "chat.out.typing": event("typing"),
    },
  },
};

describe("readChannels: a bun-nest gateway's document", () => {
  it("reads the packets: events by data[0], the ack as a sent type, lifecycle frames left out", () => {
    const { channels, warnings } = read(gateway);
    expect(warnings).toEqual([]);
    expect(channels).toEqual([
      {
        key: "/chat",
        params: [],
        query: undefined,
        receives: [
          [
            "say",
            {
              type: "object",
              properties: { text: { type: "string" } },
              required: ["text"],
            },
          ],
          ["ping", {}],
        ],
        sends: [
          [
            "say ack",
            {
              type: "object",
              properties: { ok: { type: "boolean" } },
              required: ["ok"],
            },
          ],
          ["error", { type: "string" }],
          [
            "said",
            {
              type: "object",
              properties: { by: { type: "string" } },
              required: ["by"],
            },
          ],
          ["typing", null],
        ],
        replies: [["say", "say ack"]],
        idField: "id",
        subprotocol: undefined,
        doc: "The ChatGateway gateway's socket (/chat).",
        codec: "bun-nest",
      },
    ]);
  });

  it("the descriptor names the codec; the map types request() by the ack", () => {
    const { code } = generateRoutes(
      { openapi: "3.1.0", info: { title: "t", version: "1" }, paths: {} },
      { asyncapi: gateway },
    );
    expect(code).toContain(
      '"/chat": { path: "/chat", replies: { say: "say ack" }, codec: "bun-nest" },',
    );
    expect(code).toContain('"say ack": {\n        ok: boolean;\n      };');
    expect(code).toContain('replies: {\n      say: "say ack";\n    };');
  });

  it("a bun-common document names no codec (control)", () => {
    const { channels } = read({
      ...gateway,
      components: {
        messages: Object.fromEntries(
          Object.entries(gateway.components.messages).map(([key, message]) => [
            key,
            {
              name: message.name,
              payload: {
                type: "object",
                properties: { type: { const: message.name }, data: {} },
              },
            },
          ]),
        ),
      },
    });
    expect(channels[0].codec).toBeUndefined();
  });
});
