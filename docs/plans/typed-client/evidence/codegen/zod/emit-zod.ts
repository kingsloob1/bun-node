/**
 * Route model → runtime Zod schemas, for a client that cannot import the
 * server's schema objects (another repo, or schemas that are not browser
 * safe). Two flavours: "classic" (`zod`, method chains) and "mini"
 * (`zod/mini`, functions: tree-shakes to a fifth of the size).
 *
 * Objects are emitted LOOSE (`z.looseObject`): a client checking a response
 * must not reject a field a newer server added. Anything the emitter cannot
 * express becomes `z.unknown()` plus a warning comment in the output.
 */
import type { JsonSchema, RouteModel } from "../describe";

export type Flavour = "classic" | "mini";

export function zodExpr(s: JsonSchema | null | undefined, f: Flavour, warn: (m: string) => void, defs: Record<string, JsonSchema> = {}): string {
  const opt = (x: string) => (f === "classic" ? `${x}.optional()` : `z.optional(${x})`);
  const nul = (x: string) => (f === "classic" ? `${x}.nullable()` : `z.nullable(${x})`);
  const checks = (base: string, cs: string[]) => (cs.length === 0 ? base : f === "classic" ? `${base}${cs.map(c => `.${c}`).join("")}` : `${base}.check(${cs.map(c => `z.${c.replace(/^min\(/, "minimum(").replace(/^max\(/, "maximum(")}`).join(", ")})`);
  if (s == null) return "z.undefined()";
  if (Object.keys(s).filter(k => k !== "$schema").length === 0) return "z.unknown()";
  if (typeof s.$ref === "string") return zodExpr(defs[s.$ref.replace(/^#\/\$defs\//, "")], f, warn, defs);
  const local = { ...defs, ...(s.$defs as Record<string, JsonSchema> | undefined) };
  if ("const" in s) return `z.literal(${JSON.stringify(s.const)})`;
  if (Array.isArray(s.enum)) return s.enum.every(v => typeof v === "string") ? `z.enum(${JSON.stringify(s.enum)})` : `z.union([${s.enum.map(v => `z.literal(${JSON.stringify(v)})`).join(", ")}])`;
  const union = (s.anyOf ?? s.oneOf) as JsonSchema[] | undefined;
  if (union) return `z.union([${union.map(u => zodExpr(u, f, warn, local)).join(", ")}])`;
  const types = Array.isArray(s.type) ? (s.type as string[]) : s.type ? [s.type as string] : [];
  if (types.length === 2 && types.includes("null")) return nul(zodExpr({ ...s, type: types.find(t => t !== "null") }, f, warn, local));
  if (types.length > 1) return `z.union([${types.map(t => zodExpr({ ...s, type: t }, f, warn, local)).join(", ")}])`;
  switch (types[0]) {
    case "string": {
      const formats: Record<string, string> = { "email": "z.email()", "uuid": "z.uuid()", "date-time": "z.iso.datetime()", "uri": "z.url()", "date": "z.iso.date()" };
      const base = typeof s.format === "string" && formats[s.format] ? formats[s.format]! : "z.string()";
      const cs: string[] = [];
      if (typeof s.minLength === "number") cs.push(f === "classic" ? `min(${s.minLength})` : `minLength(${s.minLength})`);
      if (typeof s.maxLength === "number") cs.push(f === "classic" ? `max(${s.maxLength})` : `maxLength(${s.maxLength})`);
      if (typeof s.pattern === "string" && !s.format) cs.push(`regex(new RegExp(${JSON.stringify(s.pattern)}))`);
      return f === "classic" ? checks(base, cs) : cs.length ? `${base}.check(${cs.map(c => `z.${c}`).join(", ")})` : base;
    }
    case "integer": case "number": {
      const base = types[0] === "integer" ? "z.int()" : "z.number()";
      const cs: string[] = [];
      const safe = (n: unknown) => typeof n === "number" && Math.abs(n) < Number.MAX_SAFE_INTEGER;
      if (safe(s.minimum)) cs.push(f === "classic" ? `min(${s.minimum})` : `gte(${s.minimum})`);
      if (safe(s.maximum)) cs.push(f === "classic" ? `max(${s.maximum})` : `lte(${s.maximum})`);
      return f === "classic" ? checks(base, cs) : cs.length ? `${base}.check(${cs.map(c => `z.${c}`).join(", ")})` : base;
    }
    case "boolean": return "z.boolean()";
    case "null": return "z.null()";
    case "array": return `z.array(${zodExpr(s.items as JsonSchema, f, warn, local)})`;
    case "object": {
      const props = (s.properties ?? {}) as Record<string, JsonSchema>;
      const req = new Set((s.required ?? []) as string[]);
      const fields = Object.entries(props).map(([k, v]) => `${JSON.stringify(k)}: ${req.has(k) ? zodExpr(v, f, warn, local) : opt(zodExpr(v, f, warn, local))}`);
      return `z.looseObject({ ${fields.join(", ")} })`;
    }
    default:
      warn(`unsupported JSON Schema: ${JSON.stringify(s).slice(0, 80)}`);
      return "z.unknown()";
  }
}

/** One module exporting `schemas[key] = { params?, query?, body?, responses }`. */
export function emitZod(model: RouteModel, f: Flavour): { source: string; warnings: string[] } {
  const warnings: string[] = [];
  const lines = [
    "// Generated from the server's route model. Do not edit.",
    `// hash: ${model.hash}`,
    `import { z } from "${f === "classic" ? "zod" : "zod/mini"}";`,
    "export const schemas = {",
  ];
  for (const r of model.routes) {
    const w = (m: string) => warnings.push(`${r.key}: ${m}`);
    for (const rw of r.warnings) lines.push(`  // warning ${r.key}: ${rw}`);
    const parts: string[] = [];
    for (const part of ["params", "query", "body"] as const) {
      const js = r.request[part];
      if (js) parts.push(`${part}: ${zodExpr(js, f, w)}`);
    }
    const responses = Object.entries(r.responses).map(([st, js]) => `${st}: ${js ? zodExpr(js, f, w) : "null"}`);
    parts.push(`responses: { ${responses.join(", ")} }`);
    lines.push(`  ${JSON.stringify(r.key)}: { ${parts.join(", ")} },`);
  }
  lines.push("} as const;", "");
  return { source: lines.join("\n"), warnings };
}
