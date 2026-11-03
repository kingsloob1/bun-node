/**
 * AsyncAPI 3.0 to the client's channels (typed-client plan, `websocket.md`
 * §3, PR-W2): {@link readChannels} reads every WebSocket channel of a
 * document — bun-common's `generateAsyncApi`, or any AsyncAPI 3.0 server's —
 * into one {@link ParsedChannel} each, which `./openapi` writes as the route
 * module's `Channels` map and `channels` descriptors, and `./zod` as the zod
 * module's `channelSchemas`.
 *
 * - **The key** is the channel's address as a route path (`/rooms/{room}` →
 *   `/rooms/:room`, the OpenAPI rule).
 * - **The sides keep the server's names** (`websocket.md` §3.3): a `receive`
 *   operation's messages are what the server `receives` (the client sends
 *   them), a `send` operation's what it `sends`.
 * - **A message** is read off bun-common's envelope (`{ type: { const },
 *   <idField>?, data }`): its `type` from the `const`, its data from `data`
 *   (none when the payload declares no `data`). A payload that is not that
 *   envelope (another server's) is typed whole as the data, under the
 *   message's `name`, with a warning: a custom codec maps it.
 * - **A bun-nest packet** (`gatewayAsyncApi()`'s documents: a numeric
 *   `type.const`, `MessageEventTypes`) is read as the `"bun-nest"` codec
 *   carries it: an `EVENT`'s type is `data[0]`'s `const` and its data
 *   `data[1]` (none when absent), an `ACK` reply is a sent type of the
 *   message's `name` (`"say ack"`) with `data[0]` as its data, an `ERROR`
 *   is `"error"` with its string; `CONNECT` and `DISCONNECT` are left out.
 *   The channel's descriptor then names `codec: "bun-nest"`.
 * - **The id field** is the envelope's one property besides `type` and
 *   `data`; `"id"` when there is none.
 * - **Replies** come from each `receive` operation's `reply`.
 * - **The implicit error frame** (an outbound `error` with `code` and
 *   `status` at its payload's top level — the flat frame `defineChannel`
 *   sends, as bun-common documents it — or under `data`, as older documents
 *   described it) is left out: the client reads error frames itself
 *   (`on("$error")`, `ChannelError`).
 * - **Params** are the address's, typed by bun-common's
 *   `x-bun-common-schema` (else `string`); **the query** is the WebSocket
 *   binding's `query` schema; **the subprotocol** is
 *   `x-bun-common-subprotocol`.
 * - An SSE channel (`x-bun-common-sse`, or an HTTP binding) is not a
 *   WebSocket channel and is left out; a message type starting with `$`
 *   (the client's events' prefix) is left out with a warning.
 *
 * `$ref`s inside a message's schemas are inlined from the document (a
 * recursive one is left unchecked, `{}`, with a warning), so the channels
 * add no named types beside the OpenAPI components.
 */
import { isRecord, resolvePointer } from "./schema";

/** One message of a channel: its type and its data's JSON Schema (`null`: no data). */
export type ParsedMessage = readonly [type: string, data: unknown];

/** One WebSocket channel, as the generator writes it. */
export interface ParsedChannel {
  /** The route path (`/rooms/:room`), the map's key. */
  readonly key: string;
  /** The address's params, each name and its JSON Schema (`undefined`: a string). */
  readonly params: readonly (readonly [name: string, schema: unknown])[];
  /** The WebSocket binding's query schema, when there is one. */
  readonly query: unknown;
  /** Client → server messages, in the document's order. */
  readonly receives: readonly ParsedMessage[];
  /** Server → client messages, in the document's order. */
  readonly sends: readonly ParsedMessage[];
  /** Each replied type and the type answering it. */
  readonly replies: readonly (readonly [type: string, reply: string])[];
  /** The envelope's correlation field. */
  readonly idField: string;
  /** The subprotocol, when the document names one. */
  readonly subprotocol: string | undefined;
  /** The channel's title or description, for the map's JSDoc. */
  readonly doc: string | undefined;
  /** `"bun-nest"` when the messages are bun-nest's packets. */
  readonly codec?: "bun-nest";
}

/** A route path from an AsyncAPI address: `{room}` → `:room`, the rest literal. */
export type AddressToPath = (address: string) => string;

/**
 * Inlines every `$ref` of `schema` from `document`; a recursive one becomes
 * `{}` (unchecked) with a warning.
 */
function inline(
  schema: unknown,
  document: unknown,
  warn: (message: string) => void,
  seen: readonly string[] = [],
): unknown {
  if (Array.isArray(schema))
    return schema.map((item) => inline(item, document, warn, seen));
  if (!isRecord(schema)) return schema;
  if (typeof schema.$ref === "string") {
    const ref = schema.$ref;
    if (seen.includes(ref)) {
      warn(`\`$ref\` "${ref}" is recursive; left unchecked (\`unknown\`)`);
      return {};
    }
    const target = resolvePointer(document, ref);
    if (target === undefined) {
      warn(`\`$ref\` "${ref}" does not resolve; left unchecked (\`unknown\`)`);
      return {};
    }
    const { $ref: _ref, ...rest } = schema;
    const resolved = inline(target, document, warn, [...seen, ref]);
    return Object.keys(rest).length === 0
      ? resolved
      : { allOf: [resolved, inline(rest, document, warn, seen)] };
  }
  return Object.fromEntries(
    Object.entries(schema).map(([key, value]) => [
      key,
      inline(value, document, warn, seen),
    ]),
  );
}

/** Follows `value`'s `$ref`s (a message, a channel) to the object they name. */
function follow(value: unknown, document: unknown): unknown {
  const seen = new Set<string>();
  while (isRecord(value) && typeof value.$ref === "string") {
    if (seen.has(value.$ref)) return undefined;
    seen.add(value.$ref);
    value = resolvePointer(document, value.$ref);
  }
  return value;
}

/** Whether `schema` is an object schema declaring both `code` and `status`. */
function hasCodeAndStatus(schema: unknown): boolean {
  return (
    isRecord(schema) &&
    isRecord(schema.properties) &&
    "code" in schema.properties &&
    "status" in schema.properties
  );
}

/**
 * Whether an outbound `error` message is bun-common's implicit error frame:
 * `code` and `status` at the payload's top level (the flat frame
 * `{ type: "error", id?, code, status, … }` the runtime sends, as bun-common
 * documents it), or under `data` (the envelope older bun-common documents
 * described it in).
 *
 * @param type    The message's type.
 * @param payload The message's whole payload (inlined).
 * @param data    Its `data` schema, as {@link readChannels} read it (`null`: none).
 */
function isImplicitError(
  type: string,
  payload: unknown,
  data: unknown,
): boolean {
  return (
    type === "error" && (hasCodeAndStatus(payload) || hasCodeAndStatus(data))
  );
}

/**
 * A bun-nest packet's message read as `[type, data]` (see the module
 * header): `null` for a lifecycle frame (left out), `undefined` when the
 * payload is not a packet (a numeric `type.const`).
 *
 * @param name       The message's `name`.
 * @param properties Its payload's properties.
 */
function nestPacket(
  name: unknown,
  properties: Record<string, unknown>,
): ParsedMessage | null | undefined {
  const kind = isRecord(properties.type) ? properties.type.const : undefined;
  if (typeof kind !== "number") return undefined;
  const data = isRecord(properties.data) ? properties.data : {};
  const items = Array.isArray(data.items) ? (data.items as unknown[]) : [];
  if (kind === 2 || kind === 5) {
    const head = items[0];
    return isRecord(head) && typeof head.const === "string"
      ? [head.const, items.length > 1 ? items[1] : null]
      : undefined;
  }
  if (kind === 3 || kind === 6)
    return typeof name === "string"
      ? [name, items.length > 0 ? items[0] : null]
      : undefined;
  if (kind === 4) return ["error", properties.data ?? {}];
  return null;
}

/**
 * Reads the WebSocket channels of an AsyncAPI 3.0 document, sorted by key.
 *
 * @param document The AsyncAPI document.
 * @param toPath   The address → route path rule (the OpenAPI generator's).
 * @param warn     Records a warning at a place.
 */
export function readChannels(
  document: object,
  toPath: AddressToPath,
  warn: (at: string, message: string) => void,
): ParsedChannel[] {
  const doc = document as Record<string, unknown>;
  if (typeof doc.asyncapi !== "string" || !doc.asyncapi.startsWith("3.")) {
    warn(
      "asyncapi",
      "not an AsyncAPI 3.x document (its `asyncapi` field names the version); no channels written",
    );
    return [];
  }
  const channels = isRecord(doc.channels) ? doc.channels : {};
  const operations = isRecord(doc.operations)
    ? Object.values(doc.operations).filter(isRecord)
    : [];
  const out = new Map<string, ParsedChannel>();
  for (const id of Object.keys(channels)) {
    const channel = follow(channels[id], doc);
    if (!isRecord(channel) || typeof channel.address !== "string") continue;
    const bindings = isRecord(channel.bindings) ? channel.bindings : {};
    if (channel["x-bun-common-sse"] === true || "http" in bindings) continue;
    const key = toPath(channel.address);
    const at = `channel ${key}`;
    if (out.has(key)) {
      warn(at, `a second channel ("${id}") has this address; left out`);
      continue;
    }
    const own = operations.filter((operation) => {
      const ref = isRecord(operation.channel)
        ? operation.channel.$ref
        : undefined;
      return ref === `#/channels/${id}`;
    });
    if (own.length === 0) {
      warn(
        at,
        "no operation names this channel, so no message has a direction; left out",
      );
      continue;
    }
    /** Set once a message is a bun-nest packet. */
    let codec: "bun-nest" | undefined;

    let idField: string | undefined;
    /** The inlined payload of each message read (an implicit error frame is told by it). */
    const payloads = new WeakMap<ParsedMessage, unknown>();
    /** A message reference read as `[type, data]`. */
    const message = (ref: unknown): ParsedMessage | undefined => {
      const found = follow(ref, doc);
      if (!isRecord(found)) {
        warn(at, "a message reference does not resolve; left out");
        return undefined;
      }
      const payload = inline(found.payload, doc, (text) => warn(at, text));
      const properties =
        isRecord(payload) && isRecord(payload.properties)
          ? payload.properties
          : undefined;
      const packet =
        properties === undefined
          ? undefined
          : nestPacket(found.name, properties);
      if (packet !== undefined) {
        codec = "bun-nest";
        return packet ?? undefined;
      }
      const type =
        properties !== undefined &&
        isRecord(properties.type) &&
        typeof properties.type.const === "string"
          ? properties.type.const
          : undefined;
      if (type === undefined) {
        const name =
          typeof found.name === "string"
            ? found.name
            : (isRecord(ref) && typeof ref.$ref === "string"
                ? ref.$ref
                : "message"
              )
                .split("/")
                .at(-1)!;
        warn(
          `${at} message "${name}"`,
          "not a bun-common envelope ({ type, data }): its whole payload is typed as the data; a custom codec maps it",
        );
        return [name, payload ?? {}];
      }
      const own = properties as Record<string, unknown>;
      const extra = Object.keys(own).filter(
        (name) => name !== "type" && name !== "data",
      );
      if (idField === undefined && extra.length === 1) idField = extra[0];
      const parsed: ParsedMessage = [type, "data" in own ? own.data : null];
      payloads.set(parsed, payload);
      return parsed;
    };

    const receives: ParsedMessage[] = [];
    const sends: ParsedMessage[] = [];
    const replies: [string, string][] = [];
    const add = (side: ParsedMessage[], parsed: ParsedMessage | undefined) => {
      if (parsed === undefined) return;
      if (parsed[0].startsWith("$")) {
        warn(
          `${at} message "${parsed[0]}"`,
          "a message type starting with \"$\" (the client's events' prefix); left out",
        );
        return;
      }
      if (!side.some(([type]) => type === parsed[0])) side.push(parsed);
    };
    for (const operation of own) {
      const list = Array.isArray(operation.messages) ? operation.messages : [];
      if (operation.action === "receive") {
        for (const ref of list) {
          const parsed = message(ref);
          add(receives, parsed);
          const reply = isRecord(operation.reply) ? operation.reply : undefined;
          const answer =
            reply !== undefined && Array.isArray(reply.messages)
              ? message(reply.messages[0])
              : undefined;
          if (parsed !== undefined && answer !== undefined)
            replies.push([parsed[0], answer[0]]);
          // A gateway's ack is sent only as a reply, never by a send
          // operation: a sent type of its own.
          if (answer !== undefined && codec !== undefined) add(sends, answer);
        }
      } else if (operation.action === "send") {
        for (const ref of list) {
          const parsed = message(ref);
          if (
            parsed !== undefined &&
            !isImplicitError(parsed[0], payloads.get(parsed), parsed[1])
          )
            add(sends, parsed);
        }
      }
    }

    const parameters = isRecord(channel.parameters) ? channel.parameters : {};
    const params = [...channel.address.matchAll(/\{([^}]*)\}/g)].map(
      ([, name]): readonly [string, unknown] => {
        const param = follow(parameters[name], doc);
        const schema = isRecord(param)
          ? param["x-bun-common-schema"]
          : undefined;
        return [
          name,
          schema === undefined
            ? undefined
            : inline(schema, doc, (text) => warn(`${at} params.${name}`, text)),
        ];
      },
    );
    const ws = isRecord(bindings.ws) ? bindings.ws : {};
    // The description, without bun-common's (or bun-nest's) own line on the
    // envelope (the client's types say it).
    const prose =
      typeof channel.description === "string"
        ? channel.description
            .split("\n\n")
            .filter(
              (line) =>
                !line.startsWith("Frames are JSON envelopes") &&
                !line.startsWith("Every frame is a socket.io-shaped packet"),
            )
            .join("\n\n")
        : "";
    out.set(key, {
      key,
      params,
      query:
        ws.query === undefined
          ? undefined
          : inline(ws.query, doc, (text) => warn(`${at} query`, text)),
      receives,
      sends,
      replies,
      idField: idField ?? "id",
      subprotocol:
        typeof channel["x-bun-common-subprotocol"] === "string"
          ? channel["x-bun-common-subprotocol"]
          : undefined,
      doc: prose === "" ? undefined : prose,
      ...(codec === undefined ? {} : { codec }),
    });
  }
  return [...out.values()].sort((a, b) =>
    a.key < b.key ? -1 : a.key > b.key ? 1 : 0,
  );
}
