/** The client types, lib-free (the same as ../inference/spike-types.ts's client half). */
/** JSON round trip: what `res.json(x)` becomes after `JSON.parse` on the client. */
export type Jsonify<T> = T extends { toJSON: () => infer J } ? J
  : T extends string | number | boolean | null ? T
    : T extends undefined | ((...a: never[]) => unknown) | symbol ? never
      : T extends readonly (infer E)[] ? Jsonify<E>[]
        : { [K in keyof T as T[K] extends undefined | ((...a: never[]) => unknown) ? never : K]: Jsonify<T[K]> };

/** One route as the client sees it. */
export interface ClientEntry { params: unknown; query: unknown; body: unknown; responses: unknown }

type ParamsOpt<P> = keyof P extends never ? { params?: undefined } : { params: P };
/** The request options for one entry. */
export type RequestOpts<E extends ClientEntry> = ParamsOpt<E["params"]> & { query?: Partial<E["query"]>; body?: E["body"]; signal?: AbortSignal };
/** The discriminated result: one member per declared status. */
export type Result<E extends ClientEntry> = { [S in keyof E["responses"]]: { status: S; data: Jsonify<E["responses"][S]> } }[keyof E["responses"]];

type PathsFor<R, M extends string> = { [K in keyof R & string]: K extends `${M} ${infer P}` ? P : never }[keyof R & string];
type At<R, K> = K extends keyof R ? (R[K] extends ClientEntry ? R[K] : never) : never;
/** An openapi-fetch-style client over a flat route map. */
export interface FlatClient<R> {
  get: <P extends PathsFor<R, "GET">>(path: P, opts: RequestOpts<At<R, `GET ${P}`>>) => Promise<Result<At<R, `GET ${P}`>>>;
  post: <P extends PathsFor<R, "POST">>(path: P, opts: RequestOpts<At<R, `POST ${P}`>>) => Promise<Result<At<R, `POST ${P}`>>>;
  put: <P extends PathsFor<R, "PUT">>(path: P, opts: RequestOpts<At<R, `PUT ${P}`>>) => Promise<Result<At<R, `PUT ${P}`>>>;
  delete: <P extends PathsFor<R, "DELETE">>(path: P, opts: RequestOpts<At<R, `DELETE ${P}`>>) => Promise<Result<At<R, `DELETE ${P}`>>>;
}
export function createFlatClient<R>(_base: string): FlatClient<R> {
  return {} as never;
}
