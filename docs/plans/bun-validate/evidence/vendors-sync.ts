/**
 * Which Standard Schema vendors answer `~standard.validate` synchronously,
 * and what one check of a typical response body costs.
 *
 * Why it matters: a response check that may *fail the response* (a 500 in
 * development) has to decide before the `Response` is produced. A sync result
 * can decide inside `res.json()`; a Promise cannot, so the design has to hold
 * the response until it settles (plan §B1.3). Run from this directory:
 *
 *   bun vendors-sync.ts > results-vendors.txt
 */
import { toStandardSchema } from "@kingsleyweb/bun-common";
import type { StandardSchemaV1 } from "@kingsleyweb/bun-common";
import { s } from "@kingsleyweb/bun-jobs/lib/api";
import { type } from "arktype";
import * as v from "valibot";
import * as yup from "yup";
import { z } from "zod";

const user = (i: number) => ({ id: `u${i}`, name: `User ${i}`, email: `u${i}@example.com`, age: 20 + (i % 50), admin: i % 7 === 0 });
const list = { items: Array.from({ length: 20 }, (_, i) => user(i)), total: 20 };

const vendors: Record<string, StandardSchemaV1> = {
  zod: z.object({ items: z.array(z.object({ id: z.string(), name: z.string(), email: z.string().email(), age: z.number().int(), admin: z.boolean() })), total: z.number().int() }),
  valibot: v.object({ items: v.array(v.object({ id: v.string(), name: v.string(), email: v.pipe(v.string(), v.email()), age: v.pipe(v.number(), v.integer()), admin: v.boolean() })), total: v.pipe(v.number(), v.integer()) }),
  arktype: type({ items: type({ id: "string", name: "string", email: "string.email", age: "number.integer", admin: "boolean" }).array(), total: "number.integer" }),
  yup: yup.object({ items: yup.array(yup.object({ id: yup.string().required(), name: yup.string().required(), email: yup.string().email().required(), age: yup.number().integer().required(), admin: yup.boolean().required() })).required(), total: yup.number().integer().required() }),
  "bun-jobs s": s.object({ items: s.array(s.object({ id: s.string(), name: s.string(), email: s.string(), age: s.integer(), admin: s.boolean() })), total: s.integer() }),
  toStandardSchema: toStandardSchema<typeof list>((x) => ({ value: x as typeof list })),
};

const lines: string[] = [];
for (const [name, schema] of Object.entries(vendors)) {
  const result = schema["~standard"].validate(list);
  const isPromise = result instanceof Promise;
  const settled = await result;
  const hasJsonSchema = typeof (schema["~standard"] as { jsonSchema?: { output?: unknown } }).jsonSchema?.output === "function";
  // Warm up, then time; awaiting only when the vendor returned a promise.
  const N = 20_000;
  for (let i = 0; i < 2_000; i++) {
    const r = schema["~standard"].validate(list);
    if (r instanceof Promise) await r;
  }
  const t0 = Bun.nanoseconds();
  for (let i = 0; i < N; i++) {
    const r = schema["~standard"].validate(list);
    if (r instanceof Promise) await r;
  }
  const us = (Bun.nanoseconds() - t0) / N / 1000;
  lines.push(`${name.padEnd(16)} returns ${isPromise ? "Promise" : "sync   "}  valid=${!settled.issues}  ~standard.jsonSchema=${hasJsonSchema}  ${us.toFixed(2)} us/check (20-item list)`);
}

// Baseline: what serialising the same body costs, which every response pays.
{
  const N = 20_000;
  const t0 = Bun.nanoseconds();
  for (let i = 0; i < N; i++) JSON.stringify(list);
  lines.push(`JSON.stringify   baseline                                        ${((Bun.nanoseconds() - t0) / N / 1000).toFixed(2)} us/call`);
}

console.log(`# bun ${Bun.revision.slice(0, 9)} ${Bun.version}`);
console.log(lines.join("\n"));
