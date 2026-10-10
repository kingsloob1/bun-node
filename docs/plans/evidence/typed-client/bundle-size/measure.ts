// Throwaway spike: measured browser bundle sizes for SWR/query libraries,
// fetch wrappers and response validators. Run from docs/plans/evidence/typed-client:
//   bun bundle-size/measure.ts
// Writes one entry per case to bundle-size/entries/, bundles it with Bun.build
// (browser, minified, ESM, UI framework external) and writes bundle-size/results.txt.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { brotliCompressSync, constants } from "node:zlib";
import type { BunPlugin } from "bun";

const here = import.meta.dir;
const entriesDir = join(here, "entries");
const modules = join(here, "..", "node_modules");

const FRAMEWORKS = ["react", "react-dom", "vue", "svelte", "solid-js", "preact"];
const external = FRAMEWORKS.flatMap(f => [f, `${f}/*`]);

/** Compiles the .svelte / .svelte.js files @tanstack/svelte-query ships, like the Vite plugin would. */
const sveltePlugin: BunPlugin = {
  name: "svelte",
  async setup(build) {
    const { compile, compileModule } = await import("svelte/compiler");
    build.onLoad({ filter: /\.svelte$/ }, ({ path }) => ({
      contents: compile(readFileSync(path, "utf8"), { filename: path, generate: "client", dev: false }).js.code,
      loader: "js",
    }));
    build.onLoad({ filter: /\.svelte\.js$/ }, ({ path }) => ({
      contents: compileModule(readFileSync(path, "utf8"), { filename: path, generate: "client", dev: false }).js.code,
      loader: "js",
    }));
  },
};

// The same 10-field shape (nested arrays included) for every validator.
const SAMPLE = `{ id: 1, email: "a@b.c", name: "Ada", age: 36, active: true, role: "admin", createdAt: "2026-10-10T00:00:00Z",
  tags: ["x"], address: { street: "1 Main", city: "Lagos", zip: "100001" },
  orders: [{ id: "o1", total: 9.5, items: [{ sku: "s1", qty: 2 }] }] }`;
const JSON_SCHEMA = {
  type: "object",
  required: ["id", "email", "name", "active", "role", "createdAt", "tags", "address", "orders"],
  properties: {
    id: { type: "integer" }, email: { type: "string" }, name: { type: "string" },
    age: { type: "integer", minimum: 0 }, active: { type: "boolean" },
    role: { enum: ["admin", "user", "guest"] }, createdAt: { type: "string" },
    tags: { type: "array", items: { type: "string" } },
    address: { type: "object", required: ["street", "city", "zip"], properties: { street: { type: "string" }, city: { type: "string" }, zip: { type: "string" } } },
    orders: {
      type: "array",
      items: {
        type: "object", required: ["id", "total", "items"],
        properties: {
          id: { type: "string" }, total: { type: "number" },
          items: { type: "array", items: { type: "object", required: ["sku", "qty"], properties: { sku: { type: "string" }, qty: { type: "integer" } } } },
        },
      },
    },
  },
};

interface Case { slug: string; label: string; pkgs: string[]; ext?: "ts" | "tsx" | "js"; source: string; note?: string }

async function ajvStandaloneSource(): Promise<string> {
  const { default: Ajv } = await import("ajv");
  const { default: standaloneCode } = await import("ajv/dist/standalone");
  const ajv = new Ajv({ code: { source: true, esm: true } });
  return standaloneCode(ajv, ajv.compile(JSON_SCHEMA));
}

const cases: Case[] = [
  {
    slug: "spike-core", label: "spike core (swr-core/core.ts)", pkgs: [],
    source: `import { createQueryClient, infiniteQuery } from "../../swr-core/core";
export function app() {
  const c = createQueryClient({ defaults: { staleTime: 1000, retry: 3 } });
  const store = c.watch(["todo", 1], async ({ etag }) => (etag ? { notModified: true } : { data: 1, etag: "v1" }), { refetchInterval: 5000, tags: ["todos"] });
  store.subscribe(() => console.log(store.getSnapshot()));
  c.mutate(async () => 2, { optimistic: x => { const r = x.snapshot(["todo", 1]); x.setQueryData(["todo", 1], 2); return r; }, invalidateTags: ["todos"] });
  c.invalidate({ key: ["todo"] });
  c.hydrate(JSON.parse(JSON.stringify(c.dehydrate())));
  infiniteQuery(c, ["feed"], async ({ pageParam }) => pageParam, { initialPageParam: 0, getNextPageParam: p => p + 1 }).fetchNextPage();
  return c;
}`,
  },
  {
    slug: "spike-core-react", label: "spike core + react binding", pkgs: [], ext: "tsx",
    source: `import { createQueryClient } from "../../swr-core/core";
import { QueryClientProvider, useMutation, useQuery } from "../../swr-core/react";
const client = createQueryClient();
function Todo() {
  const q = useQuery(["todo", 1], async () => ({ data: "x" }), { staleTime: 1000 });
  const s = useQuery(["user"], async () => ({ data: "u" }), { suspense: true });
  const m = useMutation(async (v: string) => v, v => ({ optimistic: c => { const r = c.snapshot(["todo", 1]); c.setQueryData(["todo", 1], v); return r; }, invalidateTags: ["todos"] }));
  return <button onClick={() => m.mutate("y")}>{q.data}{s.data}</button>;
}
export const App = () => <QueryClientProvider client={client}><Todo /></QueryClientProvider>;`,
  },
  {
    slug: "tanstack-query-core", label: "@tanstack/query-core", pkgs: ["@tanstack/query-core"],
    source: `import { QueryClient, QueryObserver, MutationObserver, InfiniteQueryObserver, dehydrate, hydrate, focusManager, onlineManager } from "@tanstack/query-core";
export function app() {
  const qc = new QueryClient({ defaultOptions: { queries: { staleTime: 1000 } } });
  qc.mount();
  new QueryObserver(qc, { queryKey: ["todo", 1], queryFn: async () => 1 }).subscribe(r => console.log(r.data));
  new InfiniteQueryObserver(qc, { queryKey: ["feed"], queryFn: async ({ pageParam }) => pageParam, initialPageParam: 0, getNextPageParam: (l: number) => l + 1 }).subscribe(() => {});
  new MutationObserver(qc, { mutationFn: async (v: number) => v, onSuccess: () => qc.invalidateQueries({ queryKey: ["todo"] }) }).mutate(2);
  hydrate(qc, dehydrate(qc));
  focusManager.setFocused(true);
  onlineManager.setOnline(true);
  return qc;
}`,
  },
  {
    slug: "tanstack-react-query", label: "@tanstack/react-query", pkgs: ["@tanstack/react-query", "@tanstack/query-core"], ext: "tsx",
    source: `import { QueryClient, QueryClientProvider, useQuery, useMutation, useSuspenseQuery, useInfiniteQuery, HydrationBoundary } from "@tanstack/react-query";
const qc = new QueryClient();
function Todo() {
  const q = useQuery({ queryKey: ["todo", 1], queryFn: async () => "x" });
  const s = useSuspenseQuery({ queryKey: ["user"], queryFn: async () => "u" });
  const f = useInfiniteQuery({ queryKey: ["feed"], queryFn: async ({ pageParam }) => pageParam, initialPageParam: 0, getNextPageParam: (l: number) => l + 1 });
  const m = useMutation({ mutationFn: async (v: string) => v, onSuccess: () => qc.invalidateQueries({ queryKey: ["todo"] }) });
  return <button onClick={() => m.mutate("y")}>{q.data}{s.data}{f.data?.pages.length}</button>;
}
export const App = (p: { state: import("@tanstack/react-query").DehydratedState }) => <QueryClientProvider client={qc}><HydrationBoundary state={p.state}><Todo /></HydrationBoundary></QueryClientProvider>;`,
  },
  {
    slug: "tanstack-vue-query", label: "@tanstack/vue-query", pkgs: ["@tanstack/vue-query", "@tanstack/query-core", "vue-demi"],
    note: "vue-demi (tiny vue shim) is bundled",
    source: `import { QueryClient, VueQueryPlugin, useQuery, useMutation } from "@tanstack/vue-query";
export const plugin = [VueQueryPlugin, { queryClient: new QueryClient() }] as const;
export function setup() {
  const q = useQuery({ queryKey: ["todo", 1], queryFn: async () => "x" });
  const m = useMutation({ mutationFn: async (v: string) => v });
  return { q, m };
}`,
  },
  {
    slug: "tanstack-svelte-query", label: "@tanstack/svelte-query", pkgs: ["@tanstack/svelte-query", "@tanstack/query-core"],
    note: ".svelte/.svelte.js compiled with svelte/compiler (generate: client)",
    source: `import { QueryClient, QueryClientProvider, createQuery, createMutation } from "@tanstack/svelte-query";
export { QueryClientProvider };
export const client = new QueryClient();
export function setup() {
  const q = createQuery(() => ({ queryKey: ["todo", 1], queryFn: async () => "x" }));
  const m = createMutation(() => ({ mutationFn: async (v: string) => v }));
  return { q, m };
}`,
  },
  {
    slug: "tanstack-solid-query", label: "@tanstack/solid-query", pkgs: ["@tanstack/solid-query", "@tanstack/query-core"],
    source: `import { QueryClient, QueryClientProvider, useQuery, useMutation } from "@tanstack/solid-query";
export { QueryClientProvider };
export const client = new QueryClient();
export function setup() {
  const q = useQuery(() => ({ queryKey: ["todo", 1], queryFn: async () => "x" }));
  const m = useMutation(() => ({ mutationFn: async (v: string) => v }));
  return { q, m };
}`,
  },
  {
    slug: "tanstack-preact-query", label: "@tanstack/preact-query", pkgs: ["@tanstack/preact-query", "@tanstack/query-core"],
    source: `import { QueryClient, QueryClientProvider, useQuery, useMutation } from "@tanstack/preact-query";
export { QueryClientProvider };
export const client = new QueryClient();
export function useTodo() {
  const q = useQuery({ queryKey: ["todo", 1], queryFn: async () => "x" });
  const m = useMutation({ mutationFn: async (v: string) => v });
  return { q, m };
}`,
  },
  {
    slug: "swr", label: "swr", pkgs: ["swr"], ext: "tsx",
    source: `import useSWR, { SWRConfig, preload } from "swr";
import useSWRMutation from "swr/mutation";
import useSWRInfinite from "swr/infinite";
const fetcher = (u: string) => fetch(u).then(r => r.json());
preload("/api/user", fetcher);
function Todo() {
  const q = useSWR("/api/todo/1", fetcher);
  const f = useSWRInfinite((i: number) => "/api/feed?page=" + i, fetcher);
  const m = useSWRMutation("/api/todo/1", (u: string, { arg }: { arg: string }) => fetch(u, { method: "POST", body: arg }));
  return <button onClick={() => m.trigger("y")}>{q.data}{f.size}</button>;
}
export const App = () => <SWRConfig value={{ fetcher, dedupingInterval: 2000 }}><Todo /></SWRConfig>;`,
  },
  {
    slug: "nanostores-query", label: "@nanostores/query + nanostores", pkgs: ["@nanostores/query", "nanostores"],
    source: `import { nanoquery } from "@nanostores/query";
export const [createFetcherStore, createMutatorStore, { invalidateKeys }] = nanoquery({ fetcher: (...keys) => fetch(keys.join("")).then(r => r.json()) });
export const $todo = createFetcherStore<string>(["/api/todo/", "1"]);
export const $save = createMutatorStore<string>(async ({ data, invalidate }) => { invalidate("/api/todo/1"); return data; });
$todo.listen(v => console.log(v.data));`,
  },
  {
    slug: "nanostores-query-react", label: "@nanostores/query + nanostores + @nanostores/react", pkgs: ["@nanostores/query", "nanostores", "@nanostores/react"], ext: "tsx",
    source: `import { nanoquery } from "@nanostores/query";
import { useStore } from "@nanostores/react";
const [createFetcherStore, createMutatorStore] = nanoquery({ fetcher: (...keys) => fetch(keys.join("")).then(r => r.json()) });
const $todo = createFetcherStore<string>(["/api/todo/", "1"]);
const $save = createMutatorStore<string>(async ({ data, invalidate }) => { invalidate("/api/todo/1"); return data; });
export function Todo() {
  const q = useStore($todo);
  const m = useStore($save);
  return <button onClick={() => m.mutate("y")}>{q.data}</button>;
}`,
  },
  {
    slug: "openapi-fetch", label: "openapi-fetch", pkgs: ["openapi-fetch"],
    source: `import createClient from "openapi-fetch";
interface paths { "/todos/{id}": { get: { parameters: { path: { id: number } }; responses: { 200: { content: { "application/json": { id: number } } } } } };
  "/todos": { post: { requestBody: { content: { "application/json": { title: string } } }; responses: { 201: { content: { "application/json": { id: number } } } } } } }
const client = createClient<paths>({ baseUrl: "https://api.example.test" });
client.use({ onRequest: ({ request }) => request });
export async function app() {
  const a = await client.GET("/todos/{id}", { params: { path: { id: 1 } } });
  const b = await client.POST("/todos", { body: { title: "x" } });
  return [a.data, b.data];
}`,
  },
  {
    slug: "ky", label: "ky", pkgs: ["ky"],
    source: `import ky from "ky";
const api = ky.create({ baseUrl: "https://api.example.test/", retry: 2, timeout: 5000, hooks: { beforeRequest: [({ request }) => { request.headers.set("x", "1"); }] } });
export async function app() {
  const a = await api.get("todos/1").json<{ id: number }>();
  const b = await api.post("todos", { json: { title: "x" } }).json();
  return [a, b];
}`,
  },
  {
    slug: "zod", label: "zod (classic)", pkgs: ["zod"],
    source: `import { z } from "zod";
const User = z.object({
  id: z.number().int(), email: z.string(), name: z.string(), age: z.number().int().min(0).optional(), active: z.boolean(),
  role: z.enum(["admin", "user", "guest"]), createdAt: z.string(), tags: z.array(z.string()),
  address: z.object({ street: z.string(), city: z.string(), zip: z.string() }),
  orders: z.array(z.object({ id: z.string(), total: z.number(), items: z.array(z.object({ sku: z.string(), qty: z.number().int() })) })),
});
export const parse = (d: unknown) => User.parse(d);
parse(${SAMPLE});`,
  },
  {
    slug: "zod-mini", label: "zod/mini", pkgs: ["zod"],
    source: `import * as z from "zod/mini";
const User = z.object({
  id: z.int(), email: z.string(), name: z.string(), age: z.optional(z.int().check(z.minimum(0))), active: z.boolean(),
  role: z.enum(["admin", "user", "guest"]), createdAt: z.string(), tags: z.array(z.string()),
  address: z.object({ street: z.string(), city: z.string(), zip: z.string() }),
  orders: z.array(z.object({ id: z.string(), total: z.number(), items: z.array(z.object({ sku: z.string(), qty: z.int() })) })),
});
export const parse = (d: unknown) => User.parse(d);
parse(${SAMPLE});`,
  },
  {
    slug: "valibot", label: "valibot", pkgs: ["valibot"],
    source: `import * as v from "valibot";
const int = () => v.pipe(v.number(), v.integer());
const User = v.object({
  id: int(), email: v.string(), name: v.string(), age: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))), active: v.boolean(),
  role: v.picklist(["admin", "user", "guest"]), createdAt: v.string(), tags: v.array(v.string()),
  address: v.object({ street: v.string(), city: v.string(), zip: v.string() }),
  orders: v.array(v.object({ id: v.string(), total: v.number(), items: v.array(v.object({ sku: v.string(), qty: int() })) })),
});
export const parse = (d: unknown) => v.parse(User, d);
parse(${SAMPLE});`,
  },
  {
    slug: "cfworker-json-schema", label: "@cfworker/json-schema", pkgs: ["@cfworker/json-schema"],
    source: `import { Validator } from "@cfworker/json-schema";
const validator = new Validator(${JSON.stringify(JSON_SCHEMA)}, "2020-12");
export const validate = (d: unknown) => validator.validate(d);
validate(${SAMPLE});`,
  },
  {
    slug: "ajv", label: "ajv (runtime compile)", pkgs: ["ajv"],
    source: `import Ajv from "ajv";
const validate = new Ajv().compile(${JSON.stringify(JSON_SCHEMA)});
export const check = (d: unknown) => validate(d);
check(${SAMPLE});`,
  },
  {
    slug: "ajv-standalone", label: "ajv standalone (precompiled validator)", pkgs: ["ajv"],
    note: "validator generated at build time by ajv/dist/standalone",
    source: `// @ts-expect-error generated JS, no declaration
import validate from "./ajv-standalone-validator.js";
export const check = (d: unknown) => validate(d);
check(${SAMPLE});`,
  },
];

const version = (pkg: string): string => {
  try { return JSON.parse(readFileSync(join(modules, pkg, "package.json"), "utf8")).version; }
  catch { return "?"; }
};

interface Row { label: string; versions: string; min: number; gzip: number; brotli: number; evalUse: string; externals: string; note?: string }

async function measure(c: Case): Promise<Row> {
  const file = join(entriesDir, `${c.slug}.${c.ext ?? "ts"}`);
  writeFileSync(file, `// Generated by ../measure.ts: ${c.label}\n${c.source}\n`);
  const result = await Bun.build({
    entrypoints: [file],
    target: "browser",
    format: "esm",
    minify: true,
    external,
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    plugins: [sveltePlugin],
  });
  if (!result.success) throw new AggregateError(result.logs, `build failed: ${c.slug}`);
  if (result.outputs.length !== 1) throw new Error(`${c.slug}: expected one output, got ${result.outputs.length}`);
  const text = await result.outputs[0]!.text();
  const bytes = Buffer.from(text);
  const imported = [...new Set([...text.matchAll(/from\s*"([^"]+)"|import\s*"([^"]+)"/g)].map(m => m[1] ?? m[2]))];
  return {
    label: c.label,
    versions: c.pkgs.map(p => `${p}@${version(p)}`).join(" ") || "(local)",
    min: bytes.length,
    gzip: Bun.gzipSync(bytes, { level: 9 }).length,
    brotli: brotliCompressSync(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).length,
    evalUse: /new Function\s*\(|\bFunction\s*\(\s*["'`]|\beval\s*\(/.test(text) ? "yes" : "no",
    externals: imported.join(" ") || "-",
    note: c.note,
  };
}

rmSync(entriesDir, { recursive: true, force: true });
mkdirSync(entriesDir, { recursive: true });
writeFileSync(join(entriesDir, "ajv-standalone-validator.js"), `// Generated by ../measure.ts (ajv/dist/standalone)\n${await ajvStandaloneSource()}`);

const rows: Row[] = [];
for (const c of cases) rows.push(await measure(c));

const kb = (n: number) => `${(n / 1024).toFixed(1)} KiB`;
const header = ["case", "versions", "min", "gzip", "brotli", "eval", "external imports left"];
const lines = rows.map(r => [r.label, r.versions, `${r.min} (${kb(r.min)})`, `${r.gzip} (${kb(r.gzip)})`, `${r.brotli} (${kb(r.brotli)})`, r.evalUse, r.externals]);
const widths = header.map((h, i) => Math.max(h.length, ...lines.map(l => l[i]!.length)));
const fmt = (cells: string[]) => `| ${cells.map((c, i) => c.padEnd(widths[i]!)).join(" | ")} |`;
const table = [fmt(header), `|${widths.map(w => "-".repeat(w + 2)).join("|")}|`, ...lines.map(fmt)].join("\n");

const preact = version("@tanstack/preact-query");
const out = [
  `bundle-size results — ${new Date().toISOString().slice(0, 10)}, Bun ${Bun.version} (${Bun.revision.slice(0, 9)}), ${process.platform}/${process.arch}`,
  `Bun.build({ target: "browser", format: "esm", minify: true, define NODE_ENV=production }), external: ${FRAMEWORKS.join(", ")} (+ subpaths)`,
  `bytes: minified output; gzip: Bun.gzipSync level 9; brotli: node:zlib quality 11. "eval": output contains new Function(...)/eval(...).`,
  `@tanstack/preact-query on npm: ${preact === "?" ? "not found" : preact} (installed and measured).`,
  "",
  table,
  "",
  ...rows.filter(r => r.note).map(r => `note — ${r.label}: ${r.note}`),
].join("\n");
console.log(out);
writeFileSync(join(here, "results.txt"), `${out}\n`);
