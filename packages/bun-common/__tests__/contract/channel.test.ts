/**
 * `channelContract()` (lib/contract/channel.ts), the pure half of a WebSocket
 * channel: the message maps' normalization, the implicit `error` frame, the
 * declaration TypeErrors and the meta the typed client reads. Socket-free; the
 * server binding (lib/channel.ts's `defineChannel`) is covered in
 * __tests__/channel.test.ts.
 */
import type { StandardSchemaV1 } from "../../lib/types/standardSchema";
import { describe, expect, it } from "bun:test";
import { z } from "zod";
import { channelContract, wsTransport } from "../../lib/contract/channel";
import { variants } from "../../lib/responseBodies";

/** A `say`/`said` payload. */
const Say = z.object({ text: z.string() });
const Said = z.object({ by: z.string(), text: z.string() });

/** A channel contract's def, loosely read: side to message type to its one part. */
type Def = Readonly<Record<string, { data: unknown }>>;

/** The def of a built channel contract, by side. */
function defOf(built: ReturnType<typeof channelContract>): {
  inbound: Def;
  outbound: Def;
} {
  return built.contract.def as { inbound: Def; outbound: Def };
}

describe("channelContract: the declaration", () => {
  it("normalizes each entry to its parts, a null entry meaning no data", () => {
    const built = channelContract({
      path: "/rooms/:room",
      receives: { say: Say, typing: null },
      sends: { said: Said },
    });
    const { inbound, outbound } = defOf(built);
    expect(inbound.say.data).toBe(Say);
    expect(inbound.typing).toEqual({ data: null });
    expect(outbound.said.data).toBe(Said);
    // The websocket transport: both sides keyed by `type`, one part, `data`.
    expect(built.contract.transport).toBe(wsTransport.spec);
    expect(built.contract.transport.name).toBe("websocket");
  });

  it("refuses a path that is not a route path", () => {
    expect(() =>
      channelContract({ path: "rooms/:room", receives: {}, sends: {} }),
    ).toThrow(
      new TypeError(
        'defineChannel(): "path" must be a route path (starting with "/")',
      ),
    );
    expect(() =>
      channelContract({ path: 42, receives: {}, sends: {} } as never),
    ).toThrow(TypeError);
    expect(() => channelContract(undefined as never)).toThrow(TypeError);
  });

  it("refuses an entry that is not a Standard Schema or null, naming side and type", () => {
    expect(() =>
      channelContract({
        path: "/c",
        receives: { bad: {} as never },
        sends: {},
      }),
    ).toThrow(
      new TypeError(
        'defineChannel(): the receives "bad" must be a Standard Schema or null',
      ),
    );
    expect(() =>
      channelContract({
        path: "/c",
        receives: {},
        sends: { bad: "nope" as never },
      }),
    ).toThrow(
      new TypeError(
        'defineChannel(): the sends "bad" must be a Standard Schema or null',
      ),
    );
  });

  it("refuses a variants() entry for now (the variants-on-sends shape is an open design point, plan §9)", () => {
    expect(() =>
      channelContract({
        path: "/c",
        receives: {},
        sends: {
          said: variants({
            admin: { content: { "application/json": Said } },
          }) as never,
        },
      }),
    ).toThrow(
      new TypeError(
        'defineChannel(): the sends "said" must be a Standard Schema or null',
      ),
    );
  });
});

describe("channelContract: the implicit error frame", () => {
  it("joins the outbound side when sends does not declare it, as a documented (unchecked) schema", () => {
    const built = channelContract({
      path: "/c",
      receives: { say: Say },
      sends: { said: Said },
    });
    const { outbound } = defOf(built);
    expect(Object.keys(outbound).sort()).toEqual(["error", "said"]);
    const schema = outbound.error.data as StandardSchemaV1;
    expect(schema["~standard"].vendor).toBe("bun-common/documented");
    // documented() checks nothing: any payload passes, as given.
    const verdict = schema["~standard"].validate({ secret: "value" });
    expect(verdict).toEqual({ value: { secret: "value" } });
  });

  it("keeps the app's own error schema when it declares one", () => {
    const Mine = z.object({ code: z.string(), status: z.number() });
    const built = channelContract({
      path: "/c",
      receives: {},
      sends: { error: Mine },
    });
    const { outbound } = defOf(built);
    expect(Object.keys(outbound)).toEqual(["error"]);
    expect(outbound.error.data).toBe(Mine);
  });
});

describe("channelContract: the meta", () => {
  it("maps the spec onto the meta the typed client reads, with the defaults", () => {
    const bare = channelContract({ path: "/c", receives: {}, sends: {} });
    expect(bare.meta).toEqual({
      path: "/c",
      envelope: { idField: "id" },
      replies: {},
      binary: false,
      subprotocol: undefined,
      topics: undefined,
      fallback: undefined,
    });
    // The contract is named for documents — the path when no name is given.
    expect(bare.contract.meta).toEqual({ name: "/c" });
  });

  it("carries envelope, replies, binary, subprotocol, topics and fallback, and the spec as given", () => {
    const spec = {
      path: "/rooms/:room",
      receives: { say: Say, typing: null },
      sends: { said: Said },
      envelope: { idField: "correlation" },
      replies: { say: "said" },
      binary: true,
      subprotocol: "chat.v1",
      topics: ["rooms"],
      fallback: "/rooms/:room/events",
      meta: { name: "chat", description: "A validated chat room" },
    };
    const built = channelContract(spec);
    expect(built.meta).toEqual({
      path: "/rooms/:room",
      envelope: { idField: "correlation" },
      replies: { say: "said" },
      binary: true,
      subprotocol: "chat.v1",
      topics: ["rooms"],
      fallback: "/rooms/:room/events",
    });
    expect(built.spec).toBe(spec);
    expect(built.contract.meta).toEqual({
      name: "chat",
      description: "A validated chat room",
    });
  });
});
