// The Vue adapter: a compile step for .vue (./plugins/vue-sfc.ts), a
// fragment render with <Teleport to="head"> for the head, Vue's web stream,
// and createSSRApp().mount() on the client.
import type { Component } from "vue";
import { createSSRApp } from "vue";
import { renderToString, renderToWebStream } from "vue/server-renderer";
import type { ViewAdapter } from "../core/interface";
import { vueSfc } from "./plugins/vue-sfc";

export function vueAdapter(): ViewAdapter<Component> {
  return {
    name: "vue",
    extensions: [".vue"],
    plugin: (side) => vueSfc(side),
    async render({ component, props, onError }) {
      const app = createSSRApp(component, props);
      // Vue's production build logs an error thrown in setup or render and
      // carries on rendering (a 200 with a hole in it) unless an
      // errorHandler is set; collect, then reject.
      const errors: unknown[] = [];
      app.config.errorHandler = (error) => void errors.push(error);
      const ctx: { teleports?: Record<string, string> } = {};
      const body = await renderToString(app, ctx);
      if (errors.length > 0) {
        for (const error of errors) onError?.(error);
        throw errors[0];
      }
      return { kind: "fragment", head: ctx.teleports?.head ?? "", body };
    },
    async renderToStream({ component, props }) {
      const app = createSSRApp(component, props);
      const ctx: { teleports?: Record<string, string> } = {};
      // The teleports (the head) are known only once the stream has ended.
      return { kind: "fragment", head: "", body: renderToWebStream(app, ctx) as ReadableStream<Uint8Array> };
    },
    clientEntry: ({ viewPath, propsGlobal, rootId }) => `
import { createSSRApp } from "vue";
import View from ${JSON.stringify(viewPath)};
createSSRApp(View, self.${propsGlobal}).mount(${JSON.stringify(`#${rootId}`)});
`,
  };
}
