/**
 * Route model → TypeScript. A deliberately small JSON Schema → TS emitter for
 * what Standard Schema vendors emit (objects, arrays, scalars, enums, const,
 * anyOf/oneOf, type arrays for nullable, $defs/$ref, additionalProperties).
 * Output: `export interface Routes { "GET /users/:id": { … } }`, the same map
 * shape the inference path produces, so one client type serves both.
 */
import type { JsonSchema, RouteModel } from "./describe";

const ident = /^[A-Z_$][\w$]*$/i;
const prop = (k: string) => (ident.test(k) ? k : JSON.stringify(k));

export function tsType(s: JsonSchema | null | undefined, indent = "", defs: Record<string, JsonSchema> = {}): string {
  if (s == null) return "undefined";
  if (Object.keys(s).filter(k => k !== "$schema").length === 0) return "unknown";
  if (typeof s.$ref === "string") return tsType(defs[s.$ref.replace(/^#\/\$defs\//, "")], indent, defs);
  const local = { ...defs, ...(s.$defs as Record<string, JsonSchema> | undefined) };
  if ("const" in s) return JSON.stringify(s.const);
  if (Array.isArray(s.enum)) return s.enum.map(v => JSON.stringify(v)).join(" | ");
  const union = (s.anyOf ?? s.oneOf) as JsonSchema[] | undefined;
  if (union) return union.map(u => tsType(u, indent, local)).join(" | ");
  const types = Array.isArray(s.type) ? (s.type as string[]) : s.type ? [s.type as string] : [];
  if (types.length > 1) return types.map(t => tsType({ ...s, type: t }, indent, local)).join(" | ");
  switch (types[0]) {
    case "string": return "string";
    case "integer": case "number": return "number";
    case "boolean": return "boolean";
    case "null": return "null";
    case "array": {
      if (Array.isArray(s.prefixItems)) return `[${(s.prefixItems as JsonSchema[]).map(i => tsType(i, indent, local)).join(", ")}]`;
      const item = tsType(s.items as JsonSchema, indent, local);
      return /[|&]/.test(item) ? `(${item})[]` : `${item}[]`;
    }
    case "object": {
      const props = (s.properties ?? {}) as Record<string, JsonSchema>;
      const req = new Set((s.required ?? []) as string[]);
      const inner = `${indent}  `;
      const lines = Object.entries(props).map(([k, v]) => `${inner}${prop(k)}${req.has(k) ? "" : "?"}: ${tsType(v, inner, local)};`);
      const ap = s.additionalProperties;
      if (ap && typeof ap === "object") lines.push(`${inner}[key: string]: ${tsType(ap as JsonSchema, inner, local)};`);
      return lines.length ? `{\n${lines.join("\n")}\n${indent}}` : "Record<never, never>";
    }
    default: return "unknown";
  }
}

export function emitRoutes(model: RouteModel): string {
  const out: string[] = [
    "// Generated from the server's route model. Do not edit.",
    `// hash: ${model.hash}`,
    "export interface Routes {",
  ];
  for (const r of model.routes) {
    const params = r.request.params ?? (r.params.length ? { type: "object", properties: Object.fromEntries(r.params.map(p => [p, { type: "string" }])), required: r.params } : undefined);
    const responses = Object.keys(r.responses).length
      ? `{\n${Object.entries(r.responses).map(([st, sc]) => `      ${st}: ${tsType(sc, "      ")};`).join("\n")}\n    }`
      : "{ 200: unknown }";
    out.push(
      `  ${JSON.stringify(r.key)}: {`,
      `    operationId: ${JSON.stringify(r.operationId)};`,
      `    params: ${params ? tsType(params, "    ") : "Record<never, never>"};`,
      `    query: ${r.request.query ? tsType(r.request.query, "    ") : "Record<never, never>"};`,
      `    body: ${r.request.body ? tsType(r.request.body, "    ") : "undefined"};`,
      `    responses: ${responses};`,
      "  };",
    );
  }
  out.push("}", "");
  return out.join("\n");
}
