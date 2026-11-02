/**
 * The typed channel client's type surface, as the plan proposes it
 * (`../../../websocket.md` §3), in two forms over the same messages:
 *
 * - `ChannelClient<S>`: **inferred** from a `channelContract()` spec, so the
 *   types come from the zod schemas (a monorepo importing the browser-safe
 *   spec module).
 * - `GenChannelClient<M>`: over a **generated** plain map, which is what
 *   codegen from the model (or AsyncAPI) writes for a separate repo.
 *
 * The client sends what the server receives (each field's wire input, the
 * contract core's `WireInput`) and receives what the server sends, after
 * JSON (`Jsonify` of the output).
 */
import type { StandardSchemaV1 } from "@kingsleyweb/bun-common/lib/types/standardSchema";
import type { WireInput } from "@kingsleyweb/bun-common/lib/contract/model";
import type { ChannelSpec } from "@kingsleyweb/bun-common/contract";

/** What `JSON.parse` returns for `T` (enough of it for the spike). */
export type Jsonify<T> = T extends Date
  ? string
  : T extends string | number | boolean | null
    ? T
    : T extends readonly (infer U)[]
      ? Jsonify<U>[]
      : T extends object
        ? { [K in keyof T as T[K] extends (...a: never[]) => unknown ? never : K]: Jsonify<T[K]> }
        : never;

type SendData<D> = D extends StandardSchemaV1 ? WireInput<D> : never;
type RecvData<D> = D extends StandardSchemaV1 ? Jsonify<StandardSchemaV1.InferOutput<D>> : never;

/** `send(type, data)`'s argument list: no data for a `null` message. */
type SendArgs<D, X> = D extends null ? [] : [data: X];

/** The inferred client of one channel. */
export interface ChannelClient<S extends ChannelSpec> {
  /** Sends a message the server receives. */
  send<T extends keyof S["receives"] & string>(
    type: T,
    ...args: SendArgs<S["receives"][T], SendData<S["receives"][T]>>
  ): void;
  /** Sends a request and resolves with the declared reply's data. */
  request<T extends keyof S["receives"] & keyof NonNullable<S["replies"]> & string>(
    type: T,
    ...args: SendArgs<S["receives"][T], SendData<S["receives"][T]>>
  ): Promise<RecvData<S["sends"][NonNullable<S["replies"]>[T] & keyof S["sends"]]>>;
  /** Listens for a message the server sends. */
  on<T extends keyof S["sends"] & string>(type: T, fn: (data: RecvData<S["sends"][T]>) => void): () => void;
}

/** A generated channel entry: plain types, both directions, the replies map. */
export interface GenChannel {
  receives: Record<string, unknown>;
  sends: Record<string, unknown>;
  replies: Record<string, string>;
}

/** The client of one channel over a generated entry. */
export interface GenChannelClient<C extends GenChannel> {
  send<T extends keyof C["receives"] & string>(
    type: T,
    ...args: C["receives"][T] extends undefined ? [] : [data: C["receives"][T]]
  ): void;
  request<T extends keyof C["receives"] & keyof C["replies"] & string>(
    type: T,
    ...args: C["receives"][T] extends undefined ? [] : [data: C["receives"][T]]
  ): Promise<C["sends"][C["replies"][T] & keyof C["sends"]]>;
  on<T extends keyof C["sends"] & string>(type: T, fn: (data: C["sends"][T]) => void): () => void;
}

/** Opens a channel (types only in the spike; the body is never run). */
export declare function channel<S extends ChannelSpec>(spec: { spec: S }): ChannelClient<S>;
/** Opens a channel from a generated map, keyed by path. */
export declare function genChannel<M, P extends keyof M & string>(path: P): M[P] extends GenChannel ? GenChannelClient<M[P]> : never;
