/**
 * A channel's checks (typed-client plan, `websocket.md` §5, PR-W2): what the
 * client sends through the contract's **sender** over its `inbound` side
 * (the server's receives), what arrives through its **receiver** over
 * `outbound` (the server's sends), the very guards `defineChannel` runs
 * (D20); then a BYO schema per message type, on the same policy as HTTP
 * (TC §5.6): built-in first, BYO after on the built-in's output (or the raw
 * data when it failed), `replace` dropping the built-in, a passing BYO
 * schema's output being what is sent or delivered.
 *
 * **Loaded lazily**, by `./channel` alone; it takes bun-contract's guards
 * and `channelContract` through `./validation`, their one import site, so a
 * bundler keeps only what this module uses of it.
 */
import type {
  AnyContract,
  StandardOutcome,
  StandardSchemaV1,
  ValidationIssue,
} from "@kingsleyweb/bun-contract";
import type { ChannelSchemas, ChannelValidationConfig } from "./channel";
import type { ValidationError, ValidationErrorIssue } from "./errors";
import type { FailureMode, PartValidation, ValidationConfig } from "./types";
import {
  channelContract,
  ContractError,
  createReceiver,
  createSender,
  validateStandard,
} from "./validation";

/** A check's outcome: what to send or deliver, and the failure, when there was one. */
export interface Verdict {
  /** The data as given, or a passing BYO schema's output. */
  readonly value: unknown;
  /** Every issue found, the built-in ones first; `undefined` when it passed. */
  readonly error?: ValidationError;
}

/** One channel's checks. */
export interface ChannelChecks {
  /** Checks a message about to be sent; synchronous when every schema it runs is. */
  readonly send: (
    type: string,
    data: unknown,
    call?: PartValidation,
  ) => Verdict | Promise<Verdict>;
  /** Checks a frame that arrived (a push or a reply); synchronous when every schema it runs is. */
  readonly receive: (type: string, data: unknown) => Verdict | Promise<Verdict>;
  /** What a send's failure does. */
  readonly onSend: FailureMode;
  /** What a received frame's failure does. */
  readonly onReceive: FailureMode | "drop";
}

/** What `./channel` hands the checks. */
export interface ChannelChecksContext {
  /** The channel's path: the errors' key. */
  readonly key: string;
  /** The client's mode is development (its defaults turn checks on). */
  readonly development: boolean;
  /** The client's validation, then the channel's. */
  readonly levels: readonly [
    ValidationConfig | false | undefined,
    ChannelValidationConfig | false | undefined,
  ];
  /** The shared contract's contract, when the channel was opened with one. */
  readonly contract: AnyContract | undefined;
  /** The channel's envelope and replies, to build a contract from generated schemas. */
  readonly meta: {
    readonly path: string;
    readonly idField: string;
    readonly replies: Readonly<Record<string, string>>;
  };
  /** The generated schemas (the client's `schemas` source's `channelSchemas` entry), when there is no contract. */
  readonly schemas: (() => Promise<ChannelSchemas | undefined>) | undefined;
  /** The error class, handed over so `./errors` stays in `./channel`'s chunk. */
  readonly ValidationError: typeof ValidationError;
}

/** One message type's validation, as the levels resolved it. */
interface State {
  /** Run the built-in schema. */
  enabled: boolean;
  /** The BYO schema, run after it. */
  custom: StandardSchemaV1 | undefined;
  /** Run only the BYO schema. */
  replace: boolean;
}

/** One direction's validation: every type's default, and the types with their own. */
interface Direction {
  /** Every type not in {@link types}. */
  base: State;
  /** Per type. */
  types: Map<string, State>;
}

/** Applies one level's entry (`true` on, `false` off, an object per key), as HTTP's parts do. */
function apply(state: State, entry: PartValidation | undefined): void {
  if (entry === undefined) return;
  if (typeof entry === "boolean") {
    state.enabled = entry;
    if (!entry) {
      state.custom = undefined;
      state.replace = false;
    }
    return;
  }
  if (entry.enabled !== undefined) state.enabled = entry.enabled;
  if (entry.custom !== undefined) state.custom = entry.custom;
  if (entry.replace !== undefined) state.replace = entry.replace;
}

/** Applies a direction's entry at one level: a switch for every type, or per type. */
function applyDirection(
  direction: Direction,
  entry: boolean | { readonly [type: string]: PartValidation } | undefined,
): void {
  if (typeof entry === "boolean") {
    apply(direction.base, entry);
    for (const state of direction.types.values()) apply(state, entry);
  } else if (entry !== undefined) {
    for (const [type, part] of Object.entries(entry)) {
      const state = direction.types.get(type) ?? { ...direction.base };
      apply(state, part);
      direction.types.set(type, state);
    }
  }
}

/** `issues`, marked as `source`'s. */
function mark(
  issues: readonly ValidationIssue[],
  source: "builtin" | "custom",
): ValidationErrorIssue[] {
  return issues.map((issue) => ({
    ...issue,
    target: issue.target as ValidationErrorIssue["target"],
    source,
  }));
}

/** `f(value)`, after `value` settles when it is a promise. */
function then<T, R>(
  value: T | Promise<T>,
  f: (settled: T) => R | Promise<R>,
): R | Promise<R> {
  return value instanceof Promise ? value.then(f) : f(value);
}

/**
 * Builds a channel's checks: its guards (from the shared contract, or a
 * contract built from the generated schemas, loaded now), and the levels
 * resolved over the mode's defaults (the client's `validate.request` for
 * sends and `validate.response` for what arrives, then the channel's).
 */
export async function createChannelChecks(
  context: ChannelChecksContext,
): Promise<ChannelChecks> {
  const { development, key, meta } = context;
  let contract = context.contract;
  if (contract === undefined && context.schemas !== undefined) {
    const schemas = await context.schemas();
    if (schemas !== undefined)
      contract = channelContract({
        path: meta.path,
        receives: schemas.receives ?? {},
        sends: schemas.sends ?? {},
        replies: meta.replies,
        envelope: { idField: meta.idField },
      }).contract;
  }
  type Guard = (message: object) => unknown;
  const sender =
    contract === undefined
      ? undefined
      : (createSender(contract, "inbound") as unknown as Guard);
  const receiver =
    contract === undefined
      ? undefined
      : (createReceiver(contract, "outbound") as unknown as Guard);

  const fresh = (): Direction => ({
    base: { enabled: development, custom: undefined, replace: false },
    types: new Map(),
  });
  const send = fresh();
  const receive = fresh();
  let onSend: FailureMode = "throw";
  let onReceive: FailureMode | "drop" = "warn";
  const [client, channel] = context.levels;
  /** Applies one level: `false` turns everything off; else its two directions' entries and its failure modes. */
  const level = (
    off: boolean,
    sends: Parameters<typeof applyDirection>[1],
    receives: Parameters<typeof applyDirection>[1],
    failure:
      | FailureMode
      | {
          readonly send?: FailureMode;
          readonly receive?: FailureMode | "drop";
        }
      | undefined,
  ): void => {
    if (off) {
      for (const direction of [send, receive]) {
        apply(direction.base, false);
        direction.types.clear();
      }
      return;
    }
    applyDirection(send, sends);
    applyDirection(receive, receives);
    if (typeof failure === "string" || typeof failure === "function") {
      onSend = failure;
      onReceive = failure;
    } else if (failure !== undefined) {
      onSend = failure.send ?? onSend;
      onReceive = failure.receive ?? onReceive;
    }
  };
  // The client's level: `request` for sends, a boolean `response` for what
  // arrives (a per-status map is HTTP's alone), `onFailure` likewise.
  if (client !== undefined) {
    const failure = client === false ? undefined : client.onFailure;
    level(
      client === false,
      client === false ? undefined : client.request,
      client !== false && typeof client.response === "boolean"
        ? client.response
        : undefined,
      typeof failure === "object"
        ? { send: failure.request, receive: failure.response }
        : failure,
    );
  }
  if (channel !== undefined)
    level(
      channel === false,
      channel === false ? undefined : channel.send,
      channel === false ? undefined : channel.receive,
      channel === false ? undefined : channel.onFailure,
    );

  /** Runs one direction's checks on one message. */
  const run = (
    guard: Guard | undefined,
    state: State,
    direction: "send" | "receive",
    type: string,
    data: unknown,
  ): Verdict | Promise<Verdict> => {
    const builtin =
      state.enabled && !state.replace && guard !== undefined
        ? guard({ type, data })
        : undefined;
    return then(builtin, (outcome) => {
      const issues: ValidationErrorIssue[] = [];
      // A receiver's output (the built-in schema's) is what a BYO schema
      // reads; the data delivered stays as it arrived (§5.4).
      let checked = data;
      if (outcome instanceof ContractError)
        issues.push(...mark(outcome.issues, "builtin"));
      else if (outcome !== undefined && direction === "receive")
        checked = (outcome as { data?: unknown }).data;
      const verdict = (value: unknown): Verdict =>
        issues.length === 0
          ? { value }
          : {
              value: data,
              error: new context.ValidationError(key, direction, issues),
            };
      if (state.custom === undefined) return verdict(data);
      return then(
        validateStandard(
          state.custom,
          checked,
          "data",
          type,
          undefined,
          direction === "receive" ? { stripProtoKeys: "nest" } : undefined,
        ) as StandardOutcome<unknown> | Promise<StandardOutcome<unknown>>,
        (result) => {
          if (!result.ok) issues.push(...mark(result.issues, "custom"));
          return verdict(result.ok ? result.value : data);
        },
      );
    });
  };

  return {
    send: (type, data, call) => {
      let state = send.types.get(type) ?? send.base;
      if (call !== undefined) {
        state = { ...state };
        apply(state, call);
      }
      return run(sender, state, "send", type, data);
    },
    receive: (type, data) =>
      run(
        receiver,
        receive.types.get(type) ?? receive.base,
        "receive",
        type,
        data,
      ),
    onSend,
    onReceive,
  };
}
