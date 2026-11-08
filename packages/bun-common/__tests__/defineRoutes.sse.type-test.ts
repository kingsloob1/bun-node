/**
 * Compile-time assertions for `RoutesOf`'s event streams (typed-client
 * `sse.md` §3.1, a PR-S1 follow-up): a route whose 2xx status declares an
 * `sse()` body carries `stream: "sse"` and its `events`, each event's data
 * as a client receives it, as the client generator writes them from
 * `x-sse-events` and `x-sse-data`; any other route has neither. Checked by
 * `bun run check` (`bun check`), never by `bun test`. Every
 * `@ts-expect-error` is a negative control: if the error stops appearing,
 * the check fails on the unused directive.
 */
import { z } from "zod";
import type { RoutesOf } from "../lib/defineRoutes";
import { validate } from "../lib/BunValidate";
import { defineRoutes } from "../lib/defineRoutes";
import { sse } from "../lib/responseBodies";

type Equal<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2
    ? true
    : false;
type Expect<T extends true> = T;

const Progress = z.object({ percent: z.number(), at: z.date() });

export const jobs = defineRoutes("/jobs", (r) => ({
  // JSON data (the default), a `null` event, a bare `sse()` as the status.
  events: r.get(
    "/:id/events",
    validate(
      {},
      {
        responses: {
          200: sse({
            progress: Progress,
            done: z.object({ ok: z.boolean() }),
            gap: null,
          }),
          404: z.object({ code: z.literal("NOT_FOUND") }),
        },
      },
    ),
    (_req, res) => res.status(404).json({ code: "NOT_FOUND" }),
  ),
  // Text data, under a media type: a string schema keeps its type, any
  // other arrives as text.
  log: r.get(
    "/:id/log",
    validate(
      {},
      {
        responses: {
          200: {
            content: {
              "text/event-stream": sse(
                {
                  line: z.string(),
                  level: z.enum(["info", "warn"]),
                  count: z.coerce.number(),
                },
                { data: "text" },
              ),
            },
          },
        },
      },
    ),
    (_req, res) => res.status(200).send(""),
  ),
  // An event stream on an error status only is not the route's stream.
  failing: r.get(
    "/failing",
    validate(
      {},
      { responses: { 200: z.object({ ok: z.boolean() }), 503: sse({}) } },
    ),
    (_req, res) => res.status(200).json({ ok: true }),
  ),
  plain: r.get(
    "/plain",
    validate({}, { responses: { 200: z.object({ ok: z.boolean() }) } }),
    (_req, res) => res.status(200).json({ ok: true }),
  ),
  bare: r.get("/bare", (_req, res) => res.send("x")),
}));

type Api = RoutesOf<typeof jobs>;
type Events = Api["GET /jobs/:id/events"];
type Log = Api["GET /jobs/:id/log"];

/* --- an event stream is marked, its events typed ---------------------- */

type _stream = Expect<Equal<Events["stream"], "sse">>;
type _events = Expect<
  Equal<
    Events["events"],
    {
      progress: { percent: number; at: string };
      done: { ok: boolean };
      gap: undefined;
    }
  >
>;
type _textStream = Expect<Equal<Log["stream"], "sse">>;
type _textEvents = Expect<
  Equal<Log["events"], { line: string; level: "info" | "warn"; count: string }>
>;

// The rest of the entry is as it was: the 200's body is still `unknown`
// (the client reads none), the 404 typed.
type _receive200 = Expect<Equal<Events["receive"][200], unknown>>;
type _receive404 = Expect<Equal<Events["receive"][404], { code: "NOT_FOUND" }>>;

/* --- anything else is not --------------------------------------------- */

type _failing = Expect<
  Equal<"stream" | "events" extends keyof Api["GET /jobs/failing"] ? 1 : 0, 0>
>;
type _plain = Expect<
  Equal<"stream" extends keyof Api["GET /jobs/plain"] ? 1 : 0, 0>
>;
type _bare = Expect<
  Equal<"events" extends keyof Api["GET /jobs/bare"] ? 1 : 0, 0>
>;

/* --- negative controls ------------------------------------------------ */

// @ts-expect-error a JSON event's `Date` arrives as its JSON, a string
type _dateIsDate = Expect<Equal<Events["events"]["progress"]["at"], Date>>;
// @ts-expect-error a text event's coerced number arrives as text, not a number
type _countIsNumber = Expect<Equal<Log["events"]["count"], number>>;
// @ts-expect-error a `null` event carries no data
type _gapHasData = Expect<Equal<Events["events"]["gap"], null>>;
// @ts-expect-error a route that streams no events is not marked
type _plainStreams = Expect<Equal<Api["GET /jobs/plain"]["stream"], "sse">>;
