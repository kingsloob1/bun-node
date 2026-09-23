/* eslint-disable */
import { BunRouter } from "../lib/BunRouter";
import type { BunResponse } from "../lib/BunResponse";
import type { NextFunction } from "../lib/types/general";
import { BunRequest } from "../lib/BunRequest";

interface U { id: string }

/**
 * Simulate the best possible chained `.describe()`: `get` returns a builder
 * carrying the handler's type, and `describe` takes the responses. Question:
 * can `describe` retroactively constrain the ALREADY-PASSED handler?
 */
declare class Builder<H> {
  describe<R extends Record<number, unknown>>(d: { responses: R }): void;
}
declare class Chained {
  get<TPath extends string, H extends (req: any, res: any, next: any) => unknown>(
    path: TPath,
    handler: H,
  ): Builder<H>;
}
declare const c: Chained;

// The handler is checked when `get` is called. `describe` runs afterwards and
// cannot reach back into it: `res` was already `any` at that point.
c.get("/u", (req, res) => res.status(200).json({ totally: "wrong" }))
 .describe({ responses: { 200: {} as U } });   // no error — enforcement impossible

// The ONLY way a chained call could constrain the handler is if the handler
// were passed AFTER the responses, i.e. a different call order entirely:
declare class Ordered {
  responses<R extends Record<number, unknown>>(r: R): { handle(h: (res: { json(b: R[keyof R]): void }) => void): void };
}
declare const o: Ordered;
o.responses({ 200: {} as U }).handle((res) => res.json({ id: "ok" }));
// @ts-expect-error a wrong body IS caught once responses precede the handler
o.responses({ 200: {} as U }).handle((res) => res.json({ wrong: 1 }));

// --- the OTHER mechanism: typing the handler's RETURN ---
type ReturningHandler<TBody> = (req: BunRequest, res: BunResponse, next: NextFunction) => TBody | Promise<TBody>;
declare function registerByReturn<TBody>(path: string, h: ReturningHandler<TBody>, body: TBody): void;

// It types `return body` fine...
registerByReturn("/ok", (req, res) => ({ id: "x" }), { id: "x" } as U);
// ...but a handler that responds through `res` returns BunResponse, which is
// not the body type — the deliberate `R = unknown` comment in general.ts.
// @ts-expect-error `res.json()` returns BunResponse, not U
registerByReturn("/clash", (req, res) => res.json({ id: "x" }), { id: "x" } as U);
