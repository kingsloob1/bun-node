/**
 * Compile-time assertions for bun-validate V9 (`lib/wsValidation.ts`, plan
 * `docs/plans/bun-validate/` §4.6.2): `TypedSocket`'s `emit` is typed by the
 * gateway's `@Emits` map (an undeclared event, a wrong payload, a missing
 * payload and data for a `null` entry are all rejected), and
 * `ValidateMessage(schema, { ack })` constrains the handler's return type to
 * the ack's wire input — a transform's input, not its output — while a
 * `WsResponse` stays allowed. Checked by `bun run check`, not `bun test`.
 *
 * Every `@ts-expect-error` sits directly above the line it guards; each was
 * shown to fire by deleting the directives (every guarded line then errors,
 * on that line, and nothing else does).
 */
import type { TypedSocket } from "../lib";
import { z } from "zod";
import { Emits, ValidateMessage } from "../lib";

type Equal<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2
    ? true
    : false;
type Expect<T extends true> = T;

/* ---- TypedSocket ------------------------------------------------------ */

const Said = z.object({ by: z.string(), text: z.string() });
const emitsMap = { said: Said, typing: null } as const;

declare const socket: TypedSocket<typeof emitsMap>;

export const _said = socket.emit("said", { by: "a", text: "hi" });
export const _typing = socket.emit("typing");

// @ts-expect-error an undeclared event is not in the map
export const _undeclaredEvent = socket.emit("other", {});

// @ts-expect-error the payload is the schema's wire input: by is a string
export const _wrongPayload = socket.emit("said", { by: 1, text: "hi" });

// @ts-expect-error a declared event takes its payload
export const _missingPayload = socket.emit("said");

// @ts-expect-error a null entry takes no data
export const _nullWithData = socket.emit("typing", {});

// The second type parameter is the client's custom data.
declare const customSocket: TypedSocket<typeof emitsMap, { user: string }>;
export const _customEmit = customSocket.emit("said", {
  by: "a",
  text: "hi",
});
export type _customData = Expect<
  Equal<(typeof customSocket)["data"]["custom"], { user: string }>
>;

/* ---- ValidateMessage's ack constraint ---------------------------------- */

const Ask = z.object({ q: z.string() });
const AskAck = z.object({ ok: z.boolean(), echo: z.string() });

export class ConformingAckGateway {
  @ValidateMessage(Ask, { ack: AskAck })
  ask(body: { q: string }): { ok: boolean; echo: string } {
    return { ok: true, echo: body.q };
  }

  @ValidateMessage(Ask, { ack: AskAck })
  askAsync(): Promise<{ ok: boolean; echo: string }> {
    return Promise.resolve({ ok: true, echo: "" });
  }

  // A WsResponse is an event, not an ack: always allowed.
  @ValidateMessage(Ask, { ack: AskAck })
  announce(): { event: string; data: unknown } {
    return { event: "announcement", data: 1 };
  }

  @ValidateMessage(Ask, { ack: AskAck })
  nothing(): void {}

  // Without an ack the return is unconstrained.
  @ValidateMessage(Ask)
  unchecked(): string {
    return "anything";
  }
}

export class BadAckGateway {
  // @ts-expect-error the handler's return must satisfy the ack's wire input
  @ValidateMessage(Ask, { ack: AskAck })
  ask(): { ok: string; echo: string } {
    return { ok: "yes", echo: "" };
  }
}

/* ---- the ack's wire input is a transform's input, not its output -------- */

const LenAck = z.object({ n: z.string().transform((s) => s.length) });

export class WireInputGateway {
  @ValidateMessage(Ask, { ack: LenAck })
  ask(): { n: string } {
    return { n: "ok" };
  }
}

export class BadWireInputGateway {
  // @ts-expect-error the ack's wire input is a string (the transform's input); its output, a number, is not what the handler returns
  @ValidateMessage(Ask, { ack: LenAck })
  ask(): { n: number } {
    return { n: 1 };
  }
}

/* ---- declaration errors are type errors too ----------------------------- */

export const _emits = Emits(emitsMap);

// @ts-expect-error an event's schema must be a Standard Schema or null
export const _badEmits = Emits({ e: "nope" });

// @ts-expect-error the schema must be a Standard Schema
export const _badSchema = ValidateMessage(42);

// @ts-expect-error the ack must be a Standard Schema
export const _badAck = ValidateMessage(Ask, { ack: 42 });
