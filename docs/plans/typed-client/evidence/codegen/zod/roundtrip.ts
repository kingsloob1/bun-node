/**
 * What survives server schema → JSON Schema → generated client schema.
 *   bun roundtrip.ts
 */
import { z } from "zod";
const cases: Record<string, z.ZodType> = {
  "refine (cross-field)": z.object({ password: z.string(), confirm: z.string() }).refine(v => v.password === v.confirm, "must match"),
  "transform (string → number)": z.string().transform(s => Number(s)),
  "pipe (coerce then range)": z.coerce.number().pipe(z.number().min(1)),
  "custom": z.custom<`user_${string}`>(v => typeof v === "string" && v.startsWith("user_")),
  "brand": z.string().brand<"UserId">(),
  "date": z.date(),
  "default": z.object({ role: z.enum(["a", "b"]).default("a") }),
  "regex + length": z.string().min(3).max(10).regex(/^[a-z]+$/),
  "discriminated union": z.discriminatedUnion("kind", [z.object({ kind: z.literal("a"), x: z.number() }), z.object({ kind: z.literal("b"), y: z.string() })]),
  "recursive": (() => { const Node: z.ZodType<{ v: number; children: unknown[] }> = z.object({ v: z.number(), get children() { return z.array(Node); } }) as never; return Node; })(),
};
for (const [name, schema] of Object.entries(cases)) {
  const std = (schema as unknown as { "~standard": { jsonSchema: Record<"input" | "output", (o: object) => object> } })["~standard"];
  const show = (io: "input" | "output") => {
    try {
      const js = JSON.stringify(std.jsonSchema[io]({ target: "draft-2020-12" })).replace(/"\$schema":"[^"]+",?/, "");
      return js.length > 110 ? `${js.slice(0, 110)}…` : js;
    } catch (e) {
      return `THROWS: ${(e as Error).message}`;
    }
  };
  console.log(`${name}\n  input : ${show("input")}\n  output: ${show("output")}`);
}
