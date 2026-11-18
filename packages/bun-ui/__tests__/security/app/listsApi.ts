/**
 * A stateful fake of the policy routes the lists screens use, over
 * `mockApi`'s routes: a scope's head and draft, `PUT /draft` at the
 * revision read (a stale one is a 409; raw account ids keyed, and echoed
 * once as `entered`, as the control plane's `putDraft` does), the head's
 * version, a publish, and a service's effective policy. Fixtures are the
 * API's response shapes.
 */
import type { MockCall, MockHandler, MockReply } from "./mockApi";
import { problem } from "./mockApi";

/** A policy. */
type Policy = Record<string, unknown>;

/** The fake's state. */
export interface PolicyState {
  /** The published head, or `null`. */
  head: { id: string; number: number; policy: Policy } | null;
  /** The draft, or `null`. */
  draft: { policy: Policy; revision: number; updatedBy: string } | null;
}

/** An account id's key, as the control plane would make it (32 lower-case hex). */
export function keyOf(id: string): string {
  return new Bun.CryptoHasher("md5").update(id).digest("hex");
}

/** Options of {@link policyApi}. */
export interface PolicyApiOptions {
  /** The head's entries (a head `pv_3`, version 3), or `null` for none published. */
  head?: readonly Record<string, unknown>[] | null;
  /** The draft's entries (revision 2), or none. */
  draft?: readonly Record<string, unknown>[];
  /** Other fields of every policy. */
  rest?: Policy;
  /** A publish's answer; default publishes the draft as the next version. */
  publish?: MockHandler;
  /** `GET /services/:id/effective`'s answer. */
  effective?: MockReply | MockHandler;
}

/** The PUT calls made. */
export function draftPuts(calls: readonly MockCall[]): MockCall[] {
  return calls.filter(
    (call) => call.method === "PUT" && call.path.endsWith("/draft"),
  );
}

/** The publish calls made. */
export function publishes(calls: readonly MockCall[]): MockCall[] {
  return calls.filter(
    (call) => call.method === "POST" && call.path.endsWith("/publish"),
  );
}

/** See the module's description. */
export function policyApi(options: PolicyApiOptions = {}) {
  const rest = options.rest ?? { mode: "enforce" };
  const state: PolicyState = {
    head:
      options.head === null
        ? null
        : {
            id: "pv_3",
            number: 3,
            policy: { ...rest, lists: [...(options.head ?? [])] },
          },
    draft:
      options.draft === undefined
        ? null
        : {
            policy: { ...rest, lists: [...options.draft] },
            revision: 2,
            updatedBy: "op",
          },
  };
  const draftDto = () =>
    state.draft === null
      ? null
      : {
          policy: state.draft.policy,
          baseHead: state.head?.id ?? null,
          revision: state.draft.revision,
          updatedBy: state.draft.updatedBy,
          updatedAt: 1_700_000_000_000,
        };
  const publish: MockHandler = (call) => {
    const body = call.body as { expectedHead: string | null };
    if (body.expectedHead !== (state.head?.id ?? null))
      return problem(409, "conflict");
    if (state.draft === null) return problem(404, "not_found");
    const number = (state.head?.number ?? 0) + 1;
    state.head = {
      id: `pv_${number}`,
      number,
      policy: state.draft.policy,
    };
    state.draft = null;
    return {
      body: {
        version: {
          scope: "global",
          id: state.head.id,
          number,
          policy: state.head.policy,
          createdAt: 1_700_000_000_000,
          createdBy: "op",
          message: null,
          status: "published",
        },
        bundles: [],
      },
    };
  };
  const routes: Record<string, MockHandler | MockReply> = {
    "GET /policies/:scope": (call) => ({
      body: {
        scope: decodeURIComponent(call.path.split("/")[2] ?? ""),
        draft: draftDto(),
        head:
          state.head === null
            ? null
            : { id: state.head.id, number: state.head.number },
      },
    }),
    "GET /policies/:scope/versions/:id": (call) => {
      const id = call.path.split("/").at(-1);
      if (state.head === null || id !== state.head.id)
        return problem(404, "not_found");
      return {
        body: {
          scope: "global",
          id: state.head.id,
          number: state.head.number,
          policy: state.head.policy,
          createdAt: 1_700_000_000_000,
          createdBy: "op",
          message: null,
          status: "published",
        },
      };
    },
    "PUT /policies/:scope/draft": (call) => {
      const body = call.body as { policy: Policy; revision: number | null };
      if (body.revision !== (state.draft?.revision ?? null))
        return problem(409, "conflict", { current: draftDto() });
      const entered: { index: number; user?: string; apiKey?: string }[] = [];
      const lists = Array.isArray(body.policy.lists)
        ? (body.policy.lists as Record<string, unknown>[]).map(
            (entry, index) => {
              for (const [raw, keyed] of [
                ["user", "userHash"],
                ["apiKey", "apiKeyHash"],
              ] as const) {
                const id = entry[raw];
                if (typeof id === "string") {
                  entered.push({ index, [raw]: id });
                  const { [raw]: _raw, ...others } = entry;
                  return { ...others, [keyed]: keyOf(id) };
                }
              }
              return entry;
            },
          )
        : undefined;
      state.draft = {
        policy: lists === undefined ? body.policy : { ...body.policy, lists },
        revision: (state.draft?.revision ?? 0) + 1,
        updatedBy: "op",
      };
      return {
        body: {
          ...draftDto(),
          ...(entered.length === 0 ? {} : { entered }),
        },
      };
    },
    "POST /policies/:scope/publish": options.publish ?? publish,
    "DELETE /policies/:scope/draft": (call) => {
      if (state.draft === null) return problem(404, "not_found");
      if (Number(call.query.get("revision")) !== state.draft.revision)
        return problem(409, "conflict", { current: draftDto() });
      state.draft = null;
      return { status: 204 };
    },
  };
  if (options.effective !== undefined) {
    routes["GET /services/:id/effective"] = options.effective;
    routes["GET /groups/:id/effective"] = options.effective;
  }
  return { routes, state };
}
