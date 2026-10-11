import { BunRouter, validate } from "@kingsleyweb/bun-common";
import { z } from "zod";

const r = new BunRouter();

// A: is the handler already fully checked at the `.get(...)` call, before any
// chained call can contribute? Give `.get` a handler and see whether a later
// chained method could possibly influence it. Proxy: does `.get()` return
// something that still carries the handler's type?
const ret = r.get("/u/:id", (req, res) => res.json({ id: req.params.id }));
type Ret = typeof ret;
export type _RetIsRouter = Ret extends BunRouter ? true : false;   // expect true

// And confirm inference already happened: params is narrowed at the call.
r.get("/u/:id", (req) => {
  const id: string = req.params.id;
  // @ts-expect-error `nope` is not a param of this path — proves narrowing already ran
  const bad: string = req.params.nope;
  return [id, bad];
});

// validator shape reaches the handler (the one shape-carrying position)
const v = validate({ query: z.object({ page: z.coerce.number() }) });
r.get("/p", v, (req) => {
  const page: number = req.query.page;
  return page;
});
