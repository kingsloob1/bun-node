/**
 * Writing a transport with `defineTransport`: a small chat protocol over UDP,
 * one JSON object per datagram, validated on both sides and both ends — each
 * behaviour asserted.
 *
 * ```bash
 * bun 06-validation/custom-transport.ts
 * ```
 *
 * The package README's "Writing a transport" sketches this adapter. A
 * transport is a declaration plus an adapter:
 *
 * - **The declaration** names the parts a message carries on each side, and
 *   the field that picks its schemas (`type`). A contract then maps each
 *   message type to schemas.
 * - **The adapter** runs a receiver on what arrives, hands the parsed message
 *   to the handler, runs a sender on the reply, and turns a `ContractError`
 *   into its transport's refusal: here, an `error` frame.
 * - **The client** does the same the other way round: a sender on the
 *   `inbound` side before it sends, and a receiver on the `outbound` side for
 *   the replies.
 *
 * Both sockets bind 127.0.0.1 on port 0.
 */
import type {
  GuardOptions,
  IssueContext,
  Received,
  Sent,
  ValidationIssue,
} from "@kingsleyweb/bun-common/contract";
import {
  attachContract,
  ContractError,
  createReceiver,
  createSender,
  defineTransport,
  describeContract,
  getContract,
} from "@kingsleyweb/bun-common/contract";
import { createTestLogger } from "@kingsleyweb/bun-common";
import { z } from "zod";
import { check, checkEqual, summary } from "../shared/check";
import { show, step, title } from "../shared/console";

title("A custom transport: chat over UDP");

/* ---- the declaration ---------------------------------------------- */

/** Datagrams keyed by `type`, each with one `payload` part, both ways. */
const udp = defineTransport({
  name: "udp-chat",
  inbound: { key: "type", parts: ["payload"] },
  outbound: { key: "type", parts: ["payload"] },
});

/** The chat protocol: a post is acknowledged; a ping, which carries nothing, is answered by a pong. */
const chat = udp.contract(
  {
    inbound: {
      "chat.post": {
        payload: z.object({
          text: z.string().min(1).max(500),
          at: z.coerce.date(),
        }),
      },
      "chat.ping": {},
    },
    outbound: {
      "chat.ack": {
        payload: z.object({
          seq: z.number().int().positive(),
          at: z.iso.datetime(),
        }),
      },
      "chat.pong": {},
    },
  },
  { name: "chat" },
);

/** What the handler receives (parsed) and what it must reply with (checked). */
type ChatHandler = (
  message: Received<typeof chat, "inbound">,
) => Sent<typeof chat, "outbound">;

/** The adapter's own refusal; not part of any contract. */
interface ErrorFrame {
  /** Always `"error"`. */
  type: "error";
  /** What was wrong, with no received value in it. */
  payload: {
    /** The issues found. */
    issues: readonly ValidationIssue[];
  };
}

/** An error frame with one issue the adapter found itself. */
const errorFrame = (target: string, message: string): ErrorFrame => ({
  type: "error",
  payload: { issues: [{ target, message, path: "" }] },
});

/* ---- the adapter -------------------------------------------------- */

/** Serves `handler` under the chat contract on 127.0.0.1, an OS-assigned port. */
async function serveChat(handler: ChatHandler, options: GuardOptions = {}) {
  const receive = createReceiver(chat, "inbound", {
    ...options,
    policy: "error",
  });
  const checkReply = createSender(chat, "outbound", options);
  attachContract(handler, chat); // so a document generator finds it

  const stats = { datagrams: 0 };
  const socket = await Bun.udpSocket({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      async data(sock, buf, port, address) {
        stats.datagrams++;
        const reply = (id: unknown, frame: object): void =>
          void sock.send(JSON.stringify({ id, ...frame }), port, address);

        let envelope: Record<string, unknown>;
        try {
          envelope = JSON.parse(buf.toString()) as Record<string, unknown>;
        } catch {
          return reply(null, errorFrame("datagram", "Not JSON"));
        }
        const { id, ...message } = envelope;

        const parsed = await receive(message);
        if (parsed instanceof ContractError) {
          return reply(id, {
            type: "error",
            payload: { issues: parsed.issues },
          });
        }
        const checked = await checkReply(handler(parsed));
        return reply(
          id,
          checked instanceof ContractError
            ? errorFrame("reply", "The reply failed its contract")
            : checked,
        );
      },
    },
  });
  return { port: socket.port, stats, close: () => socket.close() };
}

/* ---- the client --------------------------------------------------- */

/** What a client request resolves to: the parsed reply, the server's refusal, or a local `ContractError`. */
type ChatReply = Received<typeof chat, "outbound"> | ErrorFrame | ContractError;

/** A chat client talking to 127.0.0.1:`port`. */
async function chatClient(port: number) {
  const checkRequest = createSender(chat, "inbound");
  const parseReply = createReceiver(chat, "outbound");
  /** Replies awaited, by datagram id; the adapter answers a datagram it could not read with id `null`. */
  const pending = new Map<number | null, (frame: { type?: unknown }) => void>();
  let nextId = 0;

  const socket = await Bun.udpSocket({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      data(_sock, buf) {
        const { id, ...frame } = JSON.parse(buf.toString()) as {
          id: number | null;
          type?: unknown;
        };
        pending.get(id)?.(frame);
        pending.delete(id);
      },
    },
  });

  /** Sends one datagram as it is and resolves with the reply frame. */
  const sendRaw = (
    text: string,
    id: number | null,
  ): Promise<{ type?: unknown }> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(
        () =>
          pending.delete(id) && reject(new Error(`no reply to datagram ${id}`)),
        2000,
      );
      pending.set(id, (frame) => {
        clearTimeout(timer);
        resolve(frame);
      });
      socket.send(text, port, "127.0.0.1");
    });

  /** Sends any message, unchecked: a peer that does not share the contract. */
  const raw = (message: object): Promise<{ type?: unknown }> => {
    const id = nextId++;
    return sendRaw(JSON.stringify({ id, ...message }), id);
  };

  return {
    raw,
    /** Sends text that is not JSON at all. */
    garbage: (text: string) => sendRaw(text, null),
    /** Checks `message`, sends it, and parses the reply. A bad message is never sent. */
    async request(message: Sent<typeof chat, "inbound">): Promise<ChatReply> {
      const checked = await checkRequest(message);
      if (checked instanceof ContractError) return checked;
      const frame = await raw(checked);
      return frame.type === "error" ? (frame as ErrorFrame) : parseReply(frame);
    },
    close: () => socket.close(),
  };
}

/* ------------------------------------------------------------------ */
step("The declaration, read back");

const description = describeContract(chat);
show("sides", description.sides);
checkEqual(
  "every declared type is listed, even those with no parts",
  description.sides,
  {
    inbound: { declared: true, keys: ["chat.ping", "chat.post"] },
    outbound: { declared: true, keys: ["chat.ack", "chat.pong"] },
  },
);
checkEqual(
  "one row per type that carries a payload",
  description.entries.map((e) => [e.side, e.key, e.part]),
  [
    ["inbound", "chat.post", "payload"],
    ["outbound", "chat.ack", "payload"],
  ],
);

const receiveInbound = createReceiver(chat, "inbound");
checkEqual(
  "checksKey(): a ping has nothing to check; a post, or an undeclared type, does",
  ["chat.ping", "chat.post", "chat.delete"].map((key) =>
    receiveInbound.checksKey(key),
  ),
  [false, true, true],
);

let threw: unknown;
try {
  defineTransport({
    name: "broken",
    inbound: { key: "payload", parts: ["payload"] },
  });
} catch (error) {
  threw = error;
}
check(
  "a key that is also a part is a TypeError",
  threw instanceof TypeError,
  threw,
);

threw = undefined;
try {
  // @ts-expect-error -- `body` is not a part this transport declares
  udp.contract({ inbound: { "chat.post": { body: z.string() } } });
} catch (error) {
  threw = error;
}
check(
  "an undeclared part is a type error and a TypeError",
  threw instanceof TypeError,
  threw,
);

/* ------------------------------------------------------------------ */
step("Serving: valid messages are parsed, handled and answered");

const reported: [issues: readonly ValidationIssue[], context: IssueContext][] =
  [];
const seen: Received<typeof chat, "inbound">[] = [];
let replyBadly = false;
let seq = 0;

const handler: ChatHandler = (message) => {
  seen.push(message);
  if (message.type === "chat.ping") return { type: "chat.pong" };
  return {
    type: "chat.ack",
    payload: {
      seq: replyBadly ? -1 : ++seq,
      at: message.payload.at.toISOString(),
    },
  };
};

const server = await serveChat(handler, {
  onIssues: (issues, context) => reported.push([issues, context]),
});
const client = await chatClient(server.port);
show("listening", `udp://127.0.0.1:${server.port}`);
check("the handler carries its contract", getContract(handler) === chat);

const sentAt = new Date("2026-10-21T09:00:00.000Z");
const ack = await client.request({
  type: "chat.post",
  payload: { text: "hello", at: sentAt },
});
show("reply", ack);
checkEqual("a post is acknowledged", ack, {
  type: "chat.ack",
  payload: { seq: 1, at: "2026-10-21T09:00:00.000Z" },
});
const first = seen[0];
check(
  "the handler got `at` as a Date: it crossed as a string and the receiver parsed it",
  first?.type === "chat.post" &&
    first.payload.at instanceof Date &&
    first.payload.at.getTime() === sentAt.getTime(),
  first,
);
checkEqual(
  "a ping is answered by a pong",
  await client.request({ type: "chat.ping" }),
  { type: "chat.pong" },
);

/* ------------------------------------------------------------------ */
step("Rejecting: the client's sender, then the server's receiver");

const before = server.stats.datagrams;
const refused = await client.request({
  type: "chat.post",
  payload: { text: "", at: sentAt },
});
show(
  "refused by the client",
  refused instanceof ContractError ? refused.message : refused,
);
check(
  "an empty text is refused by the client's sender",
  refused instanceof ContractError,
  refused,
);
checkEqual("…and never sent", server.stats.datagrams, before);

const handled = seen.length;
const badPayload = (await client.raw({
  type: "chat.post",
  payload: { text: 42, at: "not a date" },
})) as ErrorFrame;
show("refused by the server", badPayload);
checkEqual(
  "sent unchecked, a bad payload is answered by an error frame",
  badPayload.type,
  "error",
);
checkEqual(
  "…naming the part, the path and the message type",
  badPayload.payload.issues.map((i) => [i.target, i.path, i.key]),
  [
    ["payload", "text", "chat.post"],
    ["payload", "at", "chat.post"],
  ],
);
checkEqual("…and the handler never ran", seen.length, handled);

const undeclared = (await client.raw({
  type: "chat.delete",
  payload: {},
})) as ErrorFrame;
checkEqual(
  "an undeclared type is an issue on the key field",
  undeclared.payload.issues.map((i) => [i.target, i.message]),
  [["type", "This type is not declared (chat.post, chat.ping)"]],
);

const garbage = (await client.garbage("hello?")) as ErrorFrame;
checkEqual(
  "a datagram that is not JSON is the adapter's own refusal",
  garbage.payload.issues[0]?.target,
  "datagram",
);

replyBadly = true;
const badReply = await client.request({
  type: "chat.post",
  payload: { text: "again", at: sentAt },
});
replyBadly = false;
show("a bad reply", badReply);
// Had the server not checked it, the client's receiver would have caught it
// here as a ContractError instead.
checkEqual(
  "a reply that fails the contract is caught by the server's sender",
  !(badReply instanceof ContractError) && badReply.type === "error"
    ? badReply.payload.issues.map((i) => i.target)
    : badReply,
  ["reply"],
);

checkEqual(
  "onIssues ran once per failing message, on either side, with its context",
  reported.map(([issues, context]) => [issues.length, context]),
  [
    [
      2,
      {
        transport: "udp-chat",
        side: "inbound",
        key: "chat.post",
        policy: "error",
      },
    ],
    [1, { transport: "udp-chat", side: "inbound", policy: "error" }],
    [
      1,
      {
        transport: "udp-chat",
        side: "outbound",
        key: "chat.ack",
        policy: "error",
      },
    ],
  ],
);

client.close();
server.close();

/* ------------------------------------------------------------------ */
step("The other policies: warn and off");

const { logger, events } = createTestLogger();
const lenient = createReceiver(chat, "inbound", { policy: "warn", logger });
// Too long a text, and a time that is no date: both quote a value a log must not keep.
const bad = {
  type: "chat.post",
  payload: { text: "SECRET-1234".repeat(50), at: "SECRET-1234 o'clock" },
};
const passedOn = await lenient(bad);
check(
  "under warn, a bad message is handed on as it came",
  passedOn === bad,
  passedOn,
);
checkEqual(
  "…and logged once, at warn",
  events.map((e) => [e.level, e.message]),
  [["warn", "contract mismatch"]],
);
check(
  "…with no received value in the log",
  !JSON.stringify(events).includes("SECRET-1234"),
  events,
);

const off = createReceiver(chat, "inbound", { policy: "off" });
checkEqual(
  "under off, nothing is checked: the guard is the identity",
  [off.checks, off(bad) === bad],
  [false, true],
);

summary();
