// The Preact adapter: no compile step (Bun's JSX with a per-file
// @jsxImportSource pragma), renderToStringAsync (waits for lazy/Suspense),
// a web stream, and hydrate() on the client. No head handling of its own.
import type { ComponentType } from "preact";
import { h } from "preact";
import { renderToStringAsync } from "preact-render-to-string";
import { renderToReadableStream } from "preact-render-to-string/stream";
import type { ViewAdapter } from "../core/interface";

export function preactAdapter(): ViewAdapter<ComponentType<Record<string, unknown>>> {
  return {
    name: "preact",
    extensions: [".tsx", ".jsx"],
    async render({ component, props }) {
      return { kind: "fragment", head: "", body: await renderToStringAsync(h(component, props)) };
    },
    async renderToStream({ component, props }) {
      return { kind: "fragment", head: "", body: renderToReadableStream(h(component, props)) as ReadableStream<Uint8Array> };
    },
    clientEntry: ({ viewPath, propsGlobal, rootId }) => `
import { h, hydrate } from "preact";
import View from ${JSON.stringify(viewPath)};
hydrate(h(View, self.${propsGlobal}), document.getElementById(${JSON.stringify(rootId)}));
`,
  };
}
