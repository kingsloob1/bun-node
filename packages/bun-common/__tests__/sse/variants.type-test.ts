/**
 * Compile-time assertions for per-event variants on server-sent events
 * (bun-validate V11, `sseVariants()`): a writer's `send()` takes, for an
 * event declared with variants, either a named `variant` (its `data` that
 * variant's schema's wire input) or none (`data` any variant's); a name the
 * table lacks, a `variant` on an event without variants and an unknown key
 * in a variant are refused; `RoutesOf` types the event, as a client
 * receives it, as the union of its variants' data. Checked by
 * `bun run check`, not by `bun test`; every `@ts-expect-error` is a negative
 * control that fails the build if the error it expects ever disappears.
 */
import type { BunRequest } from "../../lib/BunRequest";
import type { BunResponse } from "../../lib/BunResponse";
import type { RoutesOf } from "../../lib/defineRoutes";
import type { SseContractEvent } from "../../lib/sse";
import { z } from "zod";
import { validate } from "../../lib/BunValidate";
import { defineRoutes } from "../../lib/defineRoutes";
import { sse, sseVariants } from "../../lib/responseBodies";

type Equal<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2
    ? true
    : false;
type Expect<T extends true> = T;

const AdminTick = z.object({ n: z.number(), secret: z.string() });
const UserTick = z.object({ n: z.number(), at: z.coerce.date() });

const Ticks = sse({
  tick: sseVariants({
    admin: {
      // An annotated `when` is accepted (the declaration names no server type).
      when: (valid: { headers?: { "x-admin"?: string } }, req: BunRequest) =>
        valid.headers?.["x-admin"] === "1" && req.method === "GET",
      data: AdminTick,
    },
    user: { data: UserTick, description: "everyone else" },
  }),
  done: null,
});

declare const res: BunResponse;
const stream = res.sse({ contract: Ticks });

/* --- a named variant narrows `data` ----------------------------------- */

void stream.send({
  event: "tick",
  variant: "admin",
  data: { n: 1, secret: "s" },
});
void stream.send({
  event: "tick",
  variant: "user",
  data: { n: 1, at: new Date() },
});
// @ts-expect-error the admin variant's data needs its `secret`
void stream.send({ event: "tick", variant: "admin", data: { n: 1 } });
// @ts-expect-error the user variant's coerced `at` is held to its output, a Date
void stream.send({ event: "tick", variant: "user", data: { n: 1, at: "x" } });

/* --- none named: any variant's data ----------------------------------- */

void stream.send({ event: "tick", data: { n: 1, secret: "s" } });
void stream.send({ event: "tick", data: { n: 1, at: new Date() } });
// @ts-expect-error data no variant declares
void stream.send({ event: "tick", data: { secret: "s" } });

/* --- refused names ---------------------------------------------------- */

const guest = { n: 1, secret: "s" };
// @ts-expect-error a variant the event does not declare
void stream.send({ event: "tick", variant: "guest", data: guest });
// @ts-expect-error an event without variants takes no `variant`
void stream.send({ event: "done", variant: "admin" });

sseVariants({
  // @ts-expect-error an unknown key in a variant (HTTP's `content` is not an event's)
  a: { data: UserTick, content: null },
});

/* --- the event union, exactly ----------------------------------------- */

type Tick = Extract<
  SseContractEvent<(typeof Ticks)["events"]>,
  { event: "tick" }
>;
type _named = Expect<
  Equal<
    Extract<Tick, { variant: "admin" }>["data"],
    { n: number; secret: string }
  >
>;
type _unnamed = Expect<
  Equal<
    Extract<Tick, { variant?: undefined }>["data"],
    { n: number; secret: string } | { n: number; at: Date }
  >
>;

/* --- a client receives the union --------------------------------------- */

export const api = defineRoutes("/api", (r) => ({
  ticks: r.get(
    "/ticks",
    validate({}, { responses: { 200: Ticks } }),
    (_req, response) => response.status(200).send(""),
  ),
}));
type Events = RoutesOf<typeof api>["GET /api/ticks"]["events"];
type _received = Expect<
  Equal<
    Events["tick"],
    { n: number; secret: string } | { n: number; at: string }
  >
>;
type _done = Expect<Equal<Events["done"], undefined>>;
// @ts-expect-error a JSON event's Date arrives as a string, not a Date
type _receivedDate = Expect<Equal<Events["tick"], { n: number; at: Date }>>;
