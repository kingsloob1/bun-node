// The Svelte adapter: a compile step for .svelte, render() (sync, and
// awaitable for async components), no stream, and hydrate() on the client.
import type { Component } from "svelte";
import { render } from "svelte/server";
import type { ViewAdapter } from "../core/interface";
import { svelteCompile } from "./plugins/svelte-compile";

export function svelteAdapter({ async = false } = {}): ViewAdapter<Component<Record<string, unknown>>> {
  return {
    name: "svelte",
    extensions: [".svelte"],
    plugin: (side) => svelteCompile(side, { async }),
    async render({ component, props, nonce }) {
      const out = await render(component, { props, csp: nonce ? { nonce } : undefined });
      return { kind: "fragment", head: out.head, body: out.body };
    },
    clientEntry: ({ viewPath, propsGlobal, rootId }) => `
import { hydrate } from "svelte";
import View from ${JSON.stringify(viewPath)};
hydrate(View, { target: document.getElementById(${JSON.stringify(rootId)}), props: self.${propsGlobal} });
`,
  };
}
