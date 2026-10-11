// The Solid adapter: a Babel compile step (Solid's JSX is not a runtime
// call), renderToStringAsync (waits for resources), renderToStream, and
// hydrate() on the client, which also needs Solid's hydration script in the
// head.
import { createComponent } from "solid-js";
import { generateHydrationScript, renderToStream } from "solid-js/web";
import type { ViewAdapter } from "../core/interface";
import { solidBabel } from "./plugins/solid-babel";

type SolidComponent = (props: Record<string, unknown>) => unknown;

export function solidAdapter({ filter }: { filter: RegExp }): ViewAdapter<SolidComponent> {
  return {
    name: "solid",
    extensions: [".tsx", ".jsx"],
    plugin: (side) => solidBabel(side, filter),
    async render({ component, props, nonce }) {
      // Not renderToStringAsync: it arms a 30 s timer, then calls
      // renderToStream, which throws synchronously for a view that throws in
      // its shell; the timer is cleared only on success, so it keeps the
      // process alive and rejects, unhandled, 30 s later
      // (solid-js/web/dist/server.js:236-248; errors-probe.ts). Here the
      // timer is armed only once the render has started, and always cleared.
      const rendering = renderToStream(() => createComponent(component as never, props), { nonce }) as unknown as PromiseLike<string>;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("solid: render deadline")), 10_000);
      });
      const body = await Promise.race([rendering, deadline]).finally(() => clearTimeout(timer));
      return { kind: "fragment", head: generateHydrationScript({ nonce }), body };
    },
    async renderToStream({ component, props, nonce }) {
      const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
      renderToStream(() => createComponent(component as never, props), { nonce }).pipeTo(writable);
      return { kind: "fragment", head: generateHydrationScript({ nonce }), body: readable };
    },
    clientEntry: ({ viewPath, propsGlobal, rootId }) => `
import { createComponent } from "solid-js";
import { hydrate } from "solid-js/web";
import View from ${JSON.stringify(viewPath)};
hydrate(() => createComponent(View, self.${propsGlobal}), document.getElementById(${JSON.stringify(rootId)}));
`,
  };
}
