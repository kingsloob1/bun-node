// A minimal bun-views core, framework-agnostic: it knows nothing of React,
// Vue, Svelte, Preact or Solid beyond the ViewAdapter interface. It loads a
// view by path (after registering the adapter's server compile step), renders
// it, wraps a fragment in its shell, streams, builds per-view client entries
// with Bun.build through a virtual module, and exposes an Express engine
// (`fn(path, options, callback)` plus the optional `renderToStream`).
// Not production code: just enough to prove the interface.
import type { BuildArtifact, BunPlugin } from "bun";
import type { RenderInput, RenderOutput, StreamOutput, ViewAdapter } from "./interface";

export const PROPS_GLOBAL = "__BV_PROPS";
export const ROOT_ID = "bv-root";

/** JSON safe inside <script> (bun-jobs-ui's jsonForScript, lib/shell.ts). */
export const jsonForScript = (value: unknown) =>
  JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026")
    .replaceAll(" ", "\\u2028")
    .replaceAll(" ", "\\u2029");

const integrityOf = (bytes: Uint8Array) => `sha384-${new Bun.CryptoHasher("sha384").update(bytes).digest("base64")}`;

export interface ClientAsset { body: Uint8Array; integrity: string; kind: BuildArtifact["kind"] }
export interface ClientBuild { entries: Map<string, string>; assets: Map<string, ClientAsset>; ms: number }

const serverPlugins = new Set<string>();

/** Registers an adapter's server-side compile step once per process. */
export function registerServer(adapter: ViewAdapter) {
  if (adapter.plugin && !serverPlugins.has(adapter.name)) {
    Bun.plugin(adapter.plugin("server"));
    serverPlugins.add(adapter.name);
  }
}

const modules = new Map<string, Record<string, unknown>>();
export async function loadView(adapter: ViewAdapter, path: string) {
  registerServer(adapter);
  let mod = modules.get(path);
  if (!mod) {
    mod = (await import(path)) as Record<string, unknown>;
    if (mod.default === undefined) throw new Error(`View ${path} has no default export`);
    modules.set(path, mod);
  }
  return mod;
}

export interface RenderOptions {
  nonce?: string;
  /** Hydrate: the client entry built for this view. */
  client?: { src: string; integrity: string };
  onError?: (error: unknown) => void;
  signal?: AbortSignal;
}

function inputFor(mod: Record<string, unknown>, props: Record<string, unknown>, o: RenderOptions): RenderInput {
  const propsScript = `self.${PROPS_GLOBAL}=${jsonForScript(props)}`;
  return {
    component: mod.default,
    module: mod,
    props,
    nonce: o.nonce,
    signal: o.signal,
    onError: o.onError,
    bootstrap: o.client ? { ...o.client, propsScript } : undefined,
  };
}

/** The core's shell around a fragment, with the props and entry scripts. */
function shellParts(head: string, props: Record<string, unknown>, o: RenderOptions): [string, string] {
  const n = o.nonce ? ` nonce="${o.nonce}"` : "";
  const scripts = o.client
    ? `<script${n}>self.${PROPS_GLOBAL}=${jsonForScript(props)}</script><script type="module"${n} src="${o.client.src}" integrity="${o.client.integrity}"></script>`
    : "";
  return [
    `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">${head}</head><body><div id="${ROOT_ID}">`,
    `</div>${scripts}</body></html>`,
  ];
}

export async function renderView(adapter: ViewAdapter, path: string, props: Record<string, unknown>, o: RenderOptions = {}): Promise<string> {
  const mod = await loadView(adapter, path);
  const out: RenderOutput = await adapter.render(inputFor(mod, props, o));
  if (out.kind === "document") return out.html;
  const [pre, post] = shellParts(out.head, props, o);
  return pre + out.body + post;
}

const encoder = new TextEncoder();
async function* chunks(stream: ReadableStream<Uint8Array | string>) {
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    yield typeof value === "string" ? encoder.encode(value) : value;
  }
}

/** Undefined when the adapter has no stream. */
export async function streamView(adapter: ViewAdapter, path: string, props: Record<string, unknown>, o: RenderOptions = {}): Promise<ReadableStream<Uint8Array> | undefined> {
  if (!adapter.renderToStream) return undefined;
  const mod = await loadView(adapter, path);
  const out: StreamOutput = await adapter.renderToStream(inputFor(mod, props, o));
  if (out.kind === "document") return out.stream;
  const [pre, post] = shellParts(out.head, props, o);
  const body = out.body;
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(encoder.encode(pre));
      for await (const chunk of chunks(body)) controller.enqueue(chunk);
      controller.enqueue(encoder.encode(post));
      controller.close();
    },
  });
}

/** Per-view client entries as virtual modules, bundled with the adapter's client compile step. */
export async function buildClient(adapter: ViewAdapter, viewPaths: string[], { minify = true, splitting = true } = {}): Promise<ClientBuild> {
  if (!adapter.clientEntry) throw new Error(`${adapter.name} has no client entry`);
  const sources = new Map<string, string>();
  for (const viewPath of viewPaths) {
    const name = viewPath.split("/").at(-1)!.replace(/\.[^.]+$/, "");
    sources.set(`bv-entry-${adapter.name}-${name}`, adapter.clientEntry({ viewPath, propsGlobal: PROPS_GLOBAL, rootId: ROOT_ID }));
  }
  const virtual: BunPlugin = {
    name: "bun-views-entries",
    setup(build) {
      // The entrypoint as written becomes the output's [name] (the resolved
      // path does not), so the specifier has no ":" in it.
      build.onResolve({ filter: /^bv-entry-/ }, (args) => ({ path: args.path, namespace: "bv-entry" }));
      build.onLoad({ filter: /.*/, namespace: "bv-entry" }, (args) => ({ contents: sources.get(args.path)!, loader: "tsx", resolveDir: import.meta.dir }));
    },
  };
  const t0 = performance.now();
  const result = await Bun.build({
    entrypoints: [...sources.keys()],
    target: "browser",
    format: "esm",
    minify,
    splitting,
    naming: { entry: "[name]-[hash].[ext]", chunk: "chunk-[hash].[ext]" },
    define: {
      "process.env.NODE_ENV": JSON.stringify(process.env.NODE_ENV ?? "development"),
    },
    plugins: [virtual, ...(adapter.plugin ? [adapter.plugin("client")] : [])],
  });
  const ms = performance.now() - t0;
  if (!result.success) throw new AggregateError(result.logs, `${adapter.name}: client build failed`);
  const entries = new Map<string, string>();
  const assets = new Map<string, ClientAsset>();
  for (const output of result.outputs) {
    const body = new Uint8Array(await output.arrayBuffer());
    const file = output.path.split("/").at(-1)!;
    assets.set(file, { body, integrity: integrityOf(body), kind: output.kind });
    if (output.kind === "entry-point") {
      const view = viewPaths.find((p) => file.startsWith(`bv-entry-${adapter.name}-${p.split("/").at(-1)!.replace(/\.[^.]+$/, "")}-`));
      if (view) entries.set(view, file);
    }
  }
  return { entries, assets, ms };
}

/** An Express view engine over one adapter, with the optional stream capability. */
export function engine(adapter: ViewAdapter) {
  const strip = (options: Record<string, unknown>) => {
    const { settings: _s, _locals: _l, cache: _c, ...props } = options;
    return props;
  };
  const fn = (path: string, options: Record<string, unknown>, callback: (err: Error | null, html?: string) => void) => {
    renderView(adapter, path, strip(options)).then((html) => callback(null, html), (error: Error) => callback(error));
  };
  fn.renderToStream = (path: string, options: Record<string, unknown>) => streamView(adapter, path, strip(options));
  return fn;
}
