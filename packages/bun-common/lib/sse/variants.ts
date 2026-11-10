/**
 * How an SSE event declared with `sseVariants()` is decided (bun-validate
 * V11, the SSE side of plan §4.4.6): shared by the writer, which checks an
 * event before it is encoded, and the response gate, which checks the
 * stream's events as they are sent. Each brings its own way of running a
 * schema and of wording an issue; the steps and the messages are here.
 *
 * 1. **Selected**: the variant `send({ variant })` named, else every one.
 * 2. **Applicable**: the selected variants whose `when` holds for the
 *    request that opened the stream (asked once per stream, see
 *    {@link SseWhenScope}).
 * 3. **Matched**: the first applicable variant whose `data` schema passes.
 *
 * A refusal carries a summary, each applicable variant's issues tagged with
 * its name, and, for a variant `when` excluded that the data matches in
 * full, the leak's own diagnosis.
 *
 * The writer's per-variant guards are compiled here too
 * ({@link compileVariants}).
 *
 * Browser-safe: it imports only the contract core and the declaration.
 */
import type {
  AnyContract,
  MaybePromise,
  Policy,
  ValidationIssue,
} from "../contract/model";
import type { Logger } from "../logging";
import type { SseEventMap, SseVariants, SseVariantSpec } from "./declaration";
import { ContractError, createSender } from "../contract/guard";
import { isPromiseLike } from "../contract/model";
import { sseTransport } from "../contract/sse";
import { isSseVariants } from "./declaration";

/** A `when` that threw (or answered a non-boolean): kept, so every later event of the stream fails the same way. */
interface Failed {
  /** What it threw. */
  readonly error: unknown;
}

/**
 * The `when` answers of one stream: each `when` is asked once, with the
 * request that opened the stream, and its answer (a boolean, or a promise of
 * one) kept for the stream's later events. Keyed by the function, so a
 * `when` shared by several variants is asked once.
 *
 * @internal
 */
export class SseWhenScope {
  /** The request's parsed parts, what a `when` takes first. */
  readonly #valid: unknown;
  /** The request, what a `when` takes second. */
  readonly #request: unknown;
  /** The answers so far. */
  readonly #answers = new Map<
    NonNullable<SseVariantSpec["when"]>,
    MaybePromise<boolean> | Failed
  >();

  /**
   * @param valid   The request's parsed parts (`req.valid`); `{}` when none.
   * @param request The request that opened the stream.
   */
  constructor(valid: unknown, request: unknown) {
    this.#valid = valid ?? {};
    this.#request = request;
  }

  /**
   * Whether `spec` applies on this stream: `true` with no `when`. Throws (or
   * rejects) for a `when` that throws, rejects or answers a non-boolean.
   *
   * @param name The variant's name, for the error's message.
   * @param spec The variant.
   */
  applies(name: string, spec: SseVariantSpec): MaybePromise<boolean> {
    const when = spec.when;
    if (when === undefined) return true;
    let answer = this.#answers.get(when);
    if (answer === undefined) {
      answer = this.#ask(name, when);
      this.#answers.set(when, answer);
    }
    if (typeof answer === "object" && !(answer instanceof Promise)) {
      throw answer.error;
    }
    return answer;
  }

  /** Asks `when` once: its answer, a promise of it, or what it threw. */
  #ask(
    name: string,
    when: NonNullable<SseVariantSpec["when"]>,
  ): MaybePromise<boolean> | Failed {
    let answer: unknown;
    try {
      answer = when(this.#valid as never, this.#request);
    } catch (error) {
      return { error };
    }
    if (typeof answer === "boolean") return answer;
    if (isPromiseLike(answer)) {
      return Promise.resolve(answer).then((resolved: unknown) => {
        if (typeof resolved !== "boolean") {
          throw new TypeError(
            `variant ${JSON.stringify(name)}: when must resolve to a boolean`,
          );
        }
        return resolved;
      });
    }
    return {
      error: new TypeError(
        `variant ${JSON.stringify(name)}: when must return a boolean`,
      ),
    };
  }
}

/**
 * What a caller brings to {@link decideSseVariant}: how to run one
 * variant's schema on the event, and how to word an issue.
 *
 * @typeParam I The caller's issue type.
 * @internal
 */
export interface SseVariantRunner<I> {
  /** The issues of the event's data against one variant's schema (`[]` passes), untagged. */
  readonly check: (name: string, spec: SseVariantSpec) => MaybePromise<I[]>;
  /** An issue about the event as a whole, tagged with `variant` when it names one. */
  readonly issue: (message: string, variant?: string) => I;
  /** `issues`, each tagged with `variant`. */
  readonly tag: (issues: readonly I[], variant: string) => I[];
}

/** Settles each of `list`, staying synchronous when it can. */
function all<T>(list: readonly MaybePromise<T>[]): MaybePromise<T[]> {
  return list.some((v) => v instanceof Promise)
    ? Promise.all(list)
    : (list as T[]);
}

/** `then` that stays synchronous for a plain value. */
function andThen<T, R>(
  value: MaybePromise<T>,
  next: (settled: T) => MaybePromise<R>,
): MaybePromise<R> {
  return value instanceof Promise ? value.then(next) : next(value);
}

/**
 * Decides one event declared with `sseVariants()`: `[]` when a variant is
 * acceptable, else the refusal's issues. Throws (or rejects) when a `when`
 * fails (the caller makes that a failed check).
 *
 * @param variants The event's variants.
 * @param named    The variant `send({ variant })` named; `undefined`: every one.
 * @param scope    The stream's `when` answers.
 * @param runner   How to check a variant and word an issue.
 * @internal
 */
export function decideSseVariant<I>(
  variants: SseVariants,
  named: string | undefined,
  scope: Pick<SseWhenScope, "applies">,
  runner: SseVariantRunner<I>,
): MaybePromise<I[]> {
  const table = variants.table;
  const names = Object.keys(table);
  let selected: readonly string[] = names;
  if (named !== undefined) {
    if (!Object.hasOwn(table, named)) {
      return [
        runner.issue(
          `variant(${JSON.stringify(named)}) is not declared (${names.join(", ")})`,
        ),
      ];
    }
    selected = [named];
  }
  const answers = selected.map((name) => scope.applies(name, table[name]));
  return andThen(all(answers), (holds) => {
    const acceptable: string[] = [];
    const excluded: string[] = [];
    selected.forEach((name, i) =>
      (holds[i] ? acceptable : excluded).push(name),
    );
    if (acceptable.length === 0) {
      if (named !== undefined) {
        return [
          runner.issue(
            `Variant "${named}" (named by send()) does not apply to this request`,
            named,
          ),
        ];
      }
      return diagnose(table, excluded, runner, [
        runner.issue(
          `No variant of this event applies to this request (${excluded.length} excluded by when)`,
        ),
      ]);
    }
    const found: I[][] = [];
    const from = (i: number): MaybePromise<I[]> => {
      for (; i < acceptable.length; i++) {
        const name = acceptable[i];
        const issues = runner.check(name, table[name]);
        if (issues instanceof Promise) {
          const next = i + 1;
          return issues.then((settled) => {
            if (settled.length === 0) return [];
            found.push(runner.tag(settled, name));
            return from(next);
          });
        }
        if (issues.length === 0) return [];
        found.push(runner.tag(issues, name));
      }
      return diagnose(table, excluded, runner, [
        runner.issue(
          `The event matches no acceptable variant (${acceptable.join(", ")})`,
        ),
        ...found.flat(),
      ]);
    };
    return from(0);
  });
}

/**
 * On the refusal path only: names each variant `when` excluded whose schema
 * the event's data matches in full, the leak `when` exists to catch.
 */
function diagnose<I>(
  table: SseVariants["table"],
  excluded: readonly string[],
  runner: SseVariantRunner<I>,
  issues: I[],
): MaybePromise<I[]> {
  if (excluded.length === 0) return issues;
  const checked = excluded.map((name) => runner.check(name, table[name]));
  return andThen(all(checked), (lists) => {
    lists.forEach((list, i) => {
      if (list.length > 0) return;
      const name = excluded[i];
      issues.push(
        runner.issue(
          `The event matches variant "${name}", which does not apply to this request`,
          name,
        ),
      );
    });
    return issues;
  });
}

/**
 * An event declared with `sseVariants()`, compiled for the writer: its
 * declaration and one sender guard per variant.
 *
 * @internal
 */
export interface EventVariants {
  /** The declaration. */
  readonly decl: SseVariants;
  /** Variant name to its guard (policy `"error"`, so it reports and never logs). */
  readonly guards: ReadonlyMap<string, (message: unknown) => unknown>;
}

/**
 * A sender guard's verdict as issues: `[]` for a pass. Internal.
 *
 * @param verdict What the guard returned (settled).
 * @internal
 */
export function issuesOf(verdict: unknown): ValidationIssue[] {
  return verdict instanceof ContractError ? [...verdict.issues] : [];
}

/**
 * The guards for a contract with events declared by `sseVariants()`: the
 * contract core's guards refuse such a key, so the writer's main guard sees
 * it with no part (it passes there) and each variant gets a guard of its
 * own. Internal.
 *
 * @param events The declaration's events.
 * @param nested The declaration's contract (`nestedOf`), kept when no
 *   event has variants.
 * @internal
 */
export function compileVariants(
  events: SseEventMap,
  nested: AnyContract,
): { checked: AnyContract; variants: Map<string, EventVariants> } {
  const variants = new Map<string, EventVariants>();
  const outbound: Record<string, object> = {};
  for (const [name, decl] of Object.entries(events)) {
    if (!isSseVariants(decl)) {
      outbound[name] = { data: decl };
      continue;
    }
    outbound[name] = {};
    const guards = new Map<string, (message: unknown) => unknown>();
    for (const [variant, spec] of Object.entries(decl.table)) {
      const one = sseTransport.contract({
        outbound: { [name]: { data: spec.data } },
      } as never);
      guards.set(
        variant,
        createSender(one, "outbound", {
          policy: "error",
        }) as unknown as (message: unknown) => unknown,
      );
    }
    variants.set(name, { decl, guards });
  }
  return variants.size === 0
    ? { checked: nested, variants }
    : {
        checked: sseTransport.contract({ outbound } as never),
        variants,
      };
}

/** What {@link SseVariantChecker.check} answers for an event it does not check: the writer's own guard does. */
export const NOT_VARIANTS: unique symbol = Symbol("not variants");

/** What a {@link SseVariantChecker} asks `when` with, and where it logs. */
interface SseVariantContext {
  /** The request's parsed parts, `when`'s first argument; `{}` when absent. */
  readonly valid: object | undefined;
  /** The request that opened the stream, `when`'s second argument. */
  readonly request: unknown;
  /** The writer's logger. */
  readonly log: () => Logger;
  /**
   * Every variant applies, whatever its `when`: a broadcast channel's
   * events go to many streams and have no request to ask about, so its
   * check is the union of the variants. Default `false`.
   */
  readonly whenless?: boolean;
}

/** The scope of a check with no request: every variant applies. */
const EVERY_VARIANT: Pick<SseWhenScope, "applies"> = { applies: () => true };

/**
 * A writer's checks of its contract's `sseVariants()` events, under a
 * policy other than `"off"`. Internal.
 *
 * @internal
 */
export class SseVariantChecker {
  /** The compiled events with variants, by name. */
  readonly #variants: ReadonlyMap<string, EventVariants>;
  /** `"warn"` or `"error"`. */
  readonly #policy: Policy;
  /** What `when` is asked with, and the logger. */
  readonly #context: SseVariantContext;
  /** The stream's `when` answers, made on first use. */
  #scope: SseWhenScope | undefined;

  /**
   * @param variants The compiled events ({@link compileVariants}).
   * @param policy   The writer's policy (not `"off"`).
   * @param context  What `when` is asked with, and the logger.
   */
  constructor(
    variants: ReadonlyMap<string, EventVariants>,
    policy: Policy,
    context: SseVariantContext,
  ) {
    this.#variants = variants;
    this.#policy = policy;
    this.#context = context;
  }

  /**
   * Checks `message` when its event is declared with variants (or it names
   * a `variant` an event without them cannot take): `undefined` to send it,
   * or a promise of `undefined` or the refusing `ContractError`; a
   * synchronous refusal (and, under `"error"`, a failed `when`) is thrown.
   * {@link NOT_VARIANTS} for any other event.
   *
   * @param message The event.
   */
  check(message: {
    readonly event?: string;
    readonly data?: unknown;
    readonly id?: string | number;
  }): unknown {
    const name = message.event ?? "message";
    const named = (message as { readonly variant?: unknown }).variant;
    const set = this.#variants.get(name);
    if (set === undefined) {
      if (named === undefined) return NOT_VARIANTS;
      const refused = this.#settle(name, [
        {
          target: "event",
          message: `variant(${JSON.stringify(named)}) names a variant, but this event declares none`,
          path: "",
          key: name,
        },
      ]);
      if (refused !== undefined) throw refused;
      return NOT_VARIANTS;
    }
    const checked = {
      event: name,
      data: message.data,
      ...(message.id === undefined ? {} : { id: message.id }),
    };
    const runner: SseVariantRunner<ValidationIssue> = {
      check: (variant) => {
        const verdict = set.guards.get(variant)!(checked);
        return isPromiseLike(verdict)
          ? Promise.resolve(verdict).then(issuesOf)
          : issuesOf(verdict);
      },
      issue: (text, variant) => ({
        target: "event",
        message: text,
        path: "",
        key: name,
        ...(variant === undefined ? {} : { variant }),
      }),
      tag: (issues, variant) => issues.map((i) => ({ ...i, variant })),
    };
    const scope = this.#context.whenless
      ? EVERY_VARIANT
      : (this.#scope ??= new SseWhenScope(
          this.#context.valid,
          this.#context.request,
        ));
    let decided: MaybePromise<ValidationIssue[]>;
    try {
      decided = decideSseVariant(
        set.decl,
        named === undefined ? undefined : String(named),
        scope,
        runner,
      );
    } catch (error) {
      return this.#whenFailed(name, error);
    }
    if (decided instanceof Promise) {
      return decided.then(
        (issues) => this.#settle(name, issues),
        (error: unknown) => this.#whenFailed(name, error),
      );
    }
    const verdict = this.#settle(name, decided);
    if (verdict instanceof ContractError) throw verdict;
    return verdict;
  }

  /** Issues under the policy: `undefined` (send it), or the `ContractError` refusing it. */
  #settle(
    name: string,
    issues: readonly ValidationIssue[],
  ): ContractError | undefined {
    if (issues.length === 0) return undefined;
    if (this.#policy === "error") {
      return new ContractError(issues, {
        transport: "sse",
        side: "outbound",
        key: name,
        policy: "error",
      });
    }
    this.#context.log().warn("contract mismatch", {
      transport: "sse",
      side: "outbound",
      key: name,
      issues: issues.map((i) => ({
        target: i.target,
        path: i.path,
        message: i.message,
        ...(i.key === undefined ? {} : { key: i.key }),
        ...(i.variant === undefined ? {} : { variant: i.variant }),
      })),
    });
    return undefined;
  }

  /** A `when` that failed: thrown under `"error"` (rejected, from a promise), logged under `"warn"` (the event is sent). */
  #whenFailed(name: string, error: unknown): undefined {
    if (this.#policy === "error") throw error;
    this.#context.log().error("an event's variant check failed; sending it", {
      event: name,
      error,
    });
    return undefined;
  }
}
