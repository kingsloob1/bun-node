/**
 * Parity (typed-client plan §12.1, PR-C2): the map the generator writes from
 * the fixture app's OpenAPI document (`fixtures/app.gen.ts`) against the
 * map bun-common's `RoutesOf` infers from the same registry — its `send` and
 * `receive` views (PR-M1, §8.5), which agree with the generated types by
 * construction: both are the schemas' wire side (§4.1).
 *
 * What a client sees is compared: the sender's `params`, `query`, `headers`
 * and `body`, and each status's body through `Jsonify` (the client applies
 * it to either source). Where the two differ on purpose, the difference is
 * pinned rather than skipped:
 *
 * - **`z.date()`** has no JSON Schema (§5.3): the document says `{}`, so the
 *   generated `joined` is `unknown`, where inference reads the `Date`'s
 *   JSON, `string`.
 * - **`x-bun-errors`** narrows the generated error bodies' `code` to the
 *   declared codes (§4.3); `RoutesOf` keeps `string`. Narrower, so the
 *   generated body is still assignable to the inferred one.
 * - **An SSE status** is `undefined` in the generated map (the client reads
 *   no body for an event stream; `sse()` does, PR-S1) and `unknown` in
 *   `RoutesOf`.
 *
 * Each `@ts-expect-error` is a negative control. Checked by `bun run check`.
 */
import type { RoutesOf } from "@kingsleyweb/bun-common";
import type { Jsonify } from "../../lib/index";
import type { api } from "./fixtures/app";
import type { Routes as Generated } from "./fixtures/app.gen";

type Equal<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2
    ? true
    : false;
type Expect<T extends true> = T;
/** Each assignable to the other. */
type Mutual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
/** `A` assignable to `B`. */
type Assignable<A, B> = [A] extends [B] ? true : false;

type Inferred = RoutesOf<typeof api>;
type Key = keyof Generated & keyof Inferred;

/** What a sender writes, generated. */
type GenSend<K extends Key> = Pick<
  Generated[K],
  "params" | "query" | "headers" | "body"
>;
/** What a sender writes, inferred. */
type InfSend<K extends Key> = Inferred[K]["send"];
/** What a receiver gets per status, generated, as the client reads it. */
type GenReceive<K extends Key> = {
  [S in keyof Generated[K]["responses"]]: Jsonify<Generated[K]["responses"][S]>;
};
/** What a receiver gets per status, inferred, as the client reads it. */
type InfReceive<K extends Key> = {
  -readonly [S in keyof Inferred[K]["receive"]]: Jsonify<
    Inferred[K]["receive"][S]
  >;
};

// The same routes, keyed the same.
type _keys = Expect<Equal<keyof Generated, keyof Inferred>>;

// Every route's sender view agrees.
type SendParity = { [K in Key]: Mutual<GenSend<K>, InfSend<K>> };
type _send = Expect<Equal<SendParity[Key], true>>;

// The receiver views agree outright where nothing differs on purpose.
type Plain = Exclude<
  Key,
  "GET /api/users/:id" | "POST /api/users" | "GET /api/users/:id/events"
>;
type ReceiveParity = { [K in Plain]: Mutual<GenReceive<K>, InfReceive<K>> };
type _receive = Expect<Equal<ReceiveParity[Plain], true>>;

// The statuses are the same everywhere.
type StatusParity = {
  [K in Key]: Equal<keyof GenReceive<K>, keyof InfReceive<K>>;
};
type _statuses = Expect<Equal<StatusParity[Key], true>>;

// Pinned: z.date() is `unknown` generated, `string` inferred; the rest of
// the user agrees.
type GenUser = GenReceive<"GET /api/users/:id">[200];
type InfUser = InfReceive<"GET /api/users/:id">[200];
type _joinedGenerated = Expect<
  Equal<Generated["GET /api/users/:id"]["responses"][200]["joined"], unknown>
>;
type _joinedInferred = Expect<Equal<InfUser["joined"], string>>;
type _user = Expect<Mutual<Omit<GenUser, "joined">, Omit<InfUser, "joined">>>;
type _created = Expect<
  Mutual<
    Omit<GenReceive<"POST /api/users">[201], "joined">,
    Omit<InfReceive<"POST /api/users">[201], "joined">
  >
>;

// Pinned: x-bun-errors narrows the code; the generated body is the narrower.
type GenNotFound = GenReceive<"GET /api/users/:id">[404];
type InfNotFound = InfReceive<"GET /api/users/:id">[404];
type _codeGenerated = Expect<Equal<GenNotFound["code"], "NOT_FOUND" | "GONE">>;
type _codeInferred = Expect<Equal<InfNotFound["code"], string>>;
type _narrower = Expect<Assignable<GenNotFound, InfNotFound>>;
type _rest = Expect<
  Mutual<Omit<GenNotFound, "code">, Omit<InfNotFound, "code">>
>;
type _conflict = Expect<
  Equal<GenReceive<"POST /api/users">[409]["code"], "CONFLICT">
>;

// Pinned: an SSE status reads no body in the client.
type _sseGenerated = Expect<
  Equal<Generated["GET /api/users/:id/events"]["responses"][200], undefined>
>;
type _sseInferred = Expect<
  Equal<Inferred["GET /api/users/:id/events"]["receive"][200], unknown>
>;
type _sseNarrower = Expect<
  Assignable<
    GenReceive<"GET /api/users/:id/events">,
    InfReceive<"GET /api/users/:id/events">
  >
>;

// Negative controls: the comparisons can fail.
type WrongQuery = Mutual<
  GenSend<"GET /api/users/:id">["query"],
  { page?: string; expand?: string[] }
>;
// @ts-expect-error -- a query typed from the parsed side (page a string) is not the generated one
type _wrongQuery = Expect<WrongQuery>;
type RequiredRole = Mutual<
  GenSend<"POST /api/users">["body"],
  { name: string; role: "admin" | "member" }
>;
// @ts-expect-error -- a required defaulted key is not the sender's view
type _requiredRole = Expect<RequiredRole>;
type Wider = Assignable<InfNotFound, GenNotFound>;
// @ts-expect-error -- the inferred error code is wider, so it is not assignable to the generated one
type _wider = Expect<Wider>;
type WithJoined = Mutual<GenUser, InfUser>;
// @ts-expect-error -- the user with `joined` included differs (the §5.3 pin is real)
type _withJoined = Expect<WithJoined>;
