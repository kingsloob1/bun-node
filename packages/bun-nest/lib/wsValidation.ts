/**
 * Typed, validated WebSocket gateways (bun-validate V9, plan
 * `docs/plans/bun-validate/` §4.6.2, NTR §7):
 *
 * - {@link ValidateMessage} — a `@SubscribeMessage` handler's interceptor:
 *   the incoming payload is checked against its schema (a failure is a
 *   `StandardValidationException`, 400 with value-free issues, which
 *   `ValidationExceptionFilter` emits as the gateway's `{ status, code:
 *   "VALIDATION", issues }` frame), the parsed value written back so
 *   `@MessageBody()` sees it, and the handler's return checked against the
 *   declared `ack` (each emitted value; a `WsResponse` is an event, not an
 *   ack, and is passed through).
 * - {@link Emits} — a gateway class's declared server → client events:
 *   `client.emit` of a declared event is checked under `"error"` (a
 *   mismatch throws to the caller, nothing is written; an asynchronous
 *   vendor's mismatch is logged instead, the caller having returned), an
 *   undeclared event passes unchecked. The declaration is also the type
 *   source of {@link TypedSocket}.
 * - {@link TypedSocket} — `@ConnectedSocket()` typed by the gateway's
 *   `@Emits` map, so `emit` rejects an undeclared event or a wrong payload
 *   at compile time too.
 *
 * ```ts
 * const chatEmits = { said: Said, typing: null } as const;
 *
 * @WebSocketGateway({ path: "/chat" })
 * @UseFilters(ValidationExceptionFilter)
 * @Emits(chatEmits)
 * class ChatGateway {
 *   @SubscribeMessage("say")
 *   @ValidateMessage(Say, { ack: SayAck })
 *   say(
 *     @MessageBody() msg: Infer<typeof Say>,
 *     @ConnectedSocket() socket: TypedSocket<typeof chatEmits>,
 *   ) {
 *     socket.emit("said", { by: "…", text: msg.text });
 *     return { ok: true }; // checked against SayAck
 *   }
 * }
 * ```
 *
 * Do not combine `@ValidateMessage` with a payload pipe
 * (`@MessageBody(new StandardSchemaPipe(S))`, or Nest 12's
 * `@MessageBody({ schema })`) on one handler: the interceptor checks first
 * and writes the parsed value back, so the pipe would run the schema a
 * second time on the output — a transforming schema refuses that. The pipe
 * is the alternative, not a complement.
 */
import type {
  CallHandler,
  ExecutionContext,
  NestInterceptor,
} from "@nestjs/common";
import type { StandardSchemaV1, WireInput } from "@kingsleyweb/bun-common";
import type { BunNestWebSocketClient } from "./BunWebSocketAdapter";
import { Logger, SetMetadata, UseInterceptors } from "@nestjs/common";
import { concatMap } from "rxjs";
import type { Observable } from "rxjs";
import { validateStandard } from "@kingsleyweb/bun-common";
import { StandardValidationException } from "./validation";

/* ------------------------------------------------------------------ *
 * Shared
 * ------------------------------------------------------------------ */

/** A gateway's emitted events: the event name to its payload's schema, or `null` for no payload. */
export type EmitsSchemas = Readonly<Record<string, StandardSchemaV1 | null>>;

/**
 * The event map an {@link Emits} declaration types {@link TypedSocket} with:
 * a schema entry takes one data argument (its wire input), a `null` entry
 * none.
 */
export type EmitsEventMap<M extends EmitsSchemas = EmitsSchemas> = {
  [K in keyof M & string]: M[K] extends StandardSchemaV1
    ? [data: WireInput<M[K]>]
    : [];
};

/**
 * A gateway's client socket typed by its {@link Emits} declaration:
 *
 * ```ts
 * const chatEmits = { said: Said } as const;
 * // in the gateway:
 * @ConnectedSocket() socket: TypedSocket<typeof chatEmits>
 * ```
 *
 * (`TypedSocket<typeof ChatGateway>` — deriving the map from the class — is
 * not expressible: a class decorator's argument is invisible to the type
 * system. The same `as const` map feeds both `@Emits` and the socket's
 * type.)
 */
export type TypedSocket<
  M extends EmitsSchemas = EmitsSchemas,
  TCustom = unknown,
> = BunNestWebSocketClient<TCustom, EmitsEventMap<M>>;

/** Whether `value` is a Standard Schema (has a `~standard.validate`). */
function isStandardSchema(value: unknown): value is StandardSchemaV1 {
  if (
    (typeof value !== "object" && typeof value !== "function") ||
    value === null
  ) {
    return false;
  }
  const props = (value as { "~standard"?: { validate?: unknown } })[
    "~standard"
  ];
  return typeof props?.validate === "function";
}

/** Whether `value` is a promise. */
function isPromise(value: unknown): value is Promise<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

/* ------------------------------------------------------------------ *
 * @Emits
 * ------------------------------------------------------------------ */

/** Marks a client's `emit` as checked, with the gateway's map (once per client). */
const CHECKED_EMIT = Symbol.for("@kingsleyweb/bun-nest.checkedEmit");

/** The per-client write queue, so an asynchronous vendor never reorders a socket's emits. */
const EMIT_CHAINS = new WeakMap<object, Promise<void>>();

/** Where an asynchronous vendor's refusal is logged (the write is skipped). */
const emitsLogger = new Logger("Emits");

/**
 * Wraps the client's adapter-installed `emit`: a declared event's payload is
 * checked under `"error"` before the write (a synchronous vendor's mismatch
 * throws to the caller; an asynchronous one's queues the write behind the
 * client's pending writes, logging and skipping it on a mismatch). An
 * undeclared event passes through unchecked.
 */
function installCheckedEmit(client: unknown, schemas: EmitsSchemas): void {
  const socket = client as Partial<BunNestWebSocketClient>;
  const emit = socket.emit;
  if (typeof emit !== "function") {
    return;
  }
  const marked = emit as unknown as { [CHECKED_EMIT]?: true };
  if (marked[CHECKED_EMIT] === true) {
    return;
  }
  const checked = function (
    this: unknown,
    event: string,
    ...args: unknown[]
  ): boolean {
    const schema = Object.hasOwn(schemas, event) ? schemas[event] : undefined;
    if (schema === undefined) {
      return emit.call(this, event, ...args);
    }
    // A declared event carries one payload; a `null` entry carries none.
    const data = args[0];
    if (schema === null) {
      if (data !== undefined) {
        throw new StandardValidationException<string>([
          { target: "payload", message: "No data is declared here", path: "" },
        ]);
      }
      return emit.call(this, event, ...args);
    }
    const verdict = validateStandard(schema, data, "payload", event);
    if (!isPromise(verdict) && EMIT_CHAINS.get(socket) === undefined) {
      if (!verdict.ok) {
        throw new StandardValidationException<string>(verdict.issues);
      }
      return emit.call(this, event, ...args);
    }
    // An asynchronous vendor (or one pending behind it): the write queues.
    const chain = (EMIT_CHAINS.get(socket) ?? Promise.resolve()).then(
      async () => {
        const settled = await verdict;
        if (!settled.ok) {
          emitsLogger.error(
            `emit "${event}" failed its schema; nothing was written: ${(
              settled.issues ?? []
            )
              .map((issue) => `${issue.path || "(root)"}: ${issue.message}`)
              .join("; ")}`,
          );
          return;
        }
        emit.call(this, event, ...args);
      },
    );
    EMIT_CHAINS.set(socket, chain);
    return true;
  };
  (checked as unknown as { [CHECKED_EMIT]?: true })[CHECKED_EMIT] = true;
  // The adapter's own hidden markers (ADAPTER_EMIT and friends) must survive
  // the wrap: Nest 12's exception routing reads them off the client's `emit`.
  for (const key of Object.getOwnPropertyNames(emit)) {
    if (!(key in checked)) {
      Object.defineProperty(checked, key, {
        value: (emit as unknown as Record<string, unknown>)[key],
      });
    }
  }
  for (const key of Object.getOwnPropertySymbols(emit)) {
    Object.defineProperty(checked, key, {
      value: (emit as unknown as Record<symbol, unknown>)[key],
    });
  }
  socket.emit = checked as BunNestWebSocketClient["emit"];
}

/**
 * The metadata key a gateway's {@link Emits} declaration is stored under
 * (module-private, as NTR's `bun:*` keys are: documents read it by its value
 * through `Reflect`, not by import).
 */
const EMITS_METADATA = "bun:validate:emits";

/**
 * Declares a gateway's server → client events: `{ event: schema }`, a `null`
 * entry carrying no payload. On the Bun WebSocket adapter, each client's
 * `emit` then checks a declared event's payload under `"error"` (see
 * {@link installCheckedEmit}); the same map types {@link TypedSocket}. The
 * declaration is also recorded as metadata (the key is `"bun:validate:emits"`).
 *
 * An entry that is not a Standard Schema or `null` throws a `TypeError` at
 * the declaration.
 *
 * @param schemas The event map — one `as const` object feeding both this
 *   decorator and `TypedSocket<typeof …>`.
 */
export function Emits<const M extends EmitsSchemas>(
  schemas: M,
): ClassDecorator {
  for (const [event, schema] of Object.entries(schemas)) {
    if (schema !== null && !isStandardSchema(schema)) {
      throw new TypeError(
        `@Emits: the event "${event}" must be a Standard Schema or null`,
      );
    }
  }
  return (target) => {
    SetMetadata(EMITS_METADATA, schemas)(target);
    // The client first reaches the gateway at `handleConnection` — after the
    // adapter installed its `emit` (the connection callback's client has it),
    // before any handler runs.
    const proto = target.prototype as {
      handleConnection?: (client: unknown, ...args: unknown[]) => unknown;
    };
    const original = proto.handleConnection;
    proto.handleConnection = function (
      this: unknown,
      client: unknown,
      ...args: unknown[]
    ): unknown {
      installCheckedEmit(client, schemas);
      return original?.call(this, client, ...args);
    };
  };
}

/* ------------------------------------------------------------------ *
 * @ValidateMessage
 * ------------------------------------------------------------------ */

/**
 * The metadata key a handler's {@link ValidateMessage} declaration is recorded
 * under — `{ schema, ack }` — for documents (`./gateway-docs.ts` reads it by
 * its value through `Reflect`, as it does {@link EMITS_METADATA}, NTR's `bun:*`
 * convention).
 */
const MESSAGE_VALIDATE_METADATA = "bun:validate:message";

/** What a handler whose ack is declared may return. */
type AckReturn<A extends StandardSchemaV1> =
  | WireInput<A>
  | Promise<WireInput<A>>
  | Observable<WireInput<A>>
  | { event: string; data: unknown }
  | void
  | null;

/** Whether `value` is a `WsResponse` (`{ event, data }`) — an event to emit, not an ack. */
function isWsResponse(
  value: unknown,
): value is { event: string; data: unknown } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { event?: unknown }).event === "string"
  );
}

/**
 * The interceptor {@link ValidateMessage} stacks on a `@SubscribeMessage`
 * handler: checks the payload, writes the parsed value back onto the call's
 * arguments (so `@MessageBody()` — and any later pipe reading the data — sees
 * it), and checks each returned value against the ack.
 */
class ValidateMessageInterceptor implements NestInterceptor {
  constructor(
    private readonly schema: StandardSchemaV1,
    private readonly ack: StandardSchemaV1 | undefined,
  ) {}

  async intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Promise<Observable<unknown>> {
    const data = context.switchToWs().getData();
    const verdict = await validateStandard(
      this.schema,
      data,
      "payload",
      context.switchToWs().getPattern(),
    );
    if (!verdict.ok) {
      throw new StandardValidationException<string>(verdict.issues);
    }
    // Write the parsed value back: the ws arguments are [client, data, …]
    // (the client is pre-bound), so a coercion reaches @MessageBody().
    const args = context.getArgs();
    if (args.length > 1 && args[1] === data) {
      args[1] = verdict.value;
    }

    const ack = this.ack;
    if (ack === undefined) {
      return next.handle();
    }
    return next.handle().pipe(
      // concatMap: a synchronous burst of results must each wait its check.
      concatMap(async (value: unknown) => {
        // No ack is sent for a nullish return, and a WsResponse is emitted.
        if (value === undefined || value === null || isWsResponse(value)) {
          return value;
        }
        const ackVerdict = await validateStandard(ack, value, "ack");
        if (!ackVerdict.ok) {
          throw new StandardValidationException<string>(ackVerdict.issues);
        }
        return value;
      }),
    );
  }
}

/**
 * Checks a `@SubscribeMessage` handler's payload against `schema` and its
 * return against `options.ack` (NTR §7):
 *
 * - A bad payload throws a `StandardValidationException` (400, value-free
 *   issues): `ValidationExceptionFilter` emits it as the gateway's
 *   `{ status, code: "VALIDATION", issues }` frame.
 * - The parsed payload is written back, so `@MessageBody()` sees the
 *   schema's output (a coercion arrives coerced).
 * - With `ack` declared, each value the handler returns (a Promise's or
 *   Observable's included) is checked against it; a mismatch throws the same
 *   exception. The declared return type is constrained to the ack's wire
 *   input at compile time.
 *
 * Synchronous when the vendor is. Do not combine with a payload pipe on the
 * same handler (the pipe would re-run the schema on the parsed value).
 *
 * The declaration is also recorded as metadata (the key is
 * `"bun:validate:message"`, the value `{ schema, ack }`) — `gatewayAsyncApi`
 * (`./gateway-docs.ts`) documents the pair from it.
 *
 * @param schema  The client → server payload's schema.
 * @param options `ack`: the schema of the handler's answer.
 */
export function ValidateMessage<S extends StandardSchemaV1>(
  schema: S,
): MethodDecorator;
export function ValidateMessage<
  S extends StandardSchemaV1,
  A extends StandardSchemaV1,
>(
  schema: S,
  options: { ack: A },
): <T extends (...args: never[]) => AckReturn<A>>(
  target: object,
  key: string | symbol,
  descriptor: TypedPropertyDescriptor<T>,
) => void;
export function ValidateMessage(
  schema: StandardSchemaV1,
  options?: { ack?: StandardSchemaV1 },
): MethodDecorator {
  if (!isStandardSchema(schema)) {
    throw new TypeError(
      "@ValidateMessage: the schema must be a Standard Schema",
    );
  }
  if (options?.ack !== undefined && !isStandardSchema(options.ack)) {
    throw new TypeError("@ValidateMessage: the ack must be a Standard Schema");
  }
  return (target, key, descriptor) => {
    UseInterceptors(new ValidateMessageInterceptor(schema, options?.ack))(
      target,
      key,
      descriptor,
    );
    // Recorded for documents (gatewayAsyncApi reads the payload/ack schemas).
    SetMetadata(MESSAGE_VALIDATE_METADATA, { schema, ack: options?.ack })(
      target,
      key,
      descriptor,
    );
  };
}
