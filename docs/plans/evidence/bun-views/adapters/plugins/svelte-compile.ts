// A minimal Svelte 5 compile step for Bun, beside the official
// bun-plugin-svelte (which the spike also runs): the same two sides, plus
// the compiler's experimental async mode, which the official plugin cannot
// pass (its compilerOptions are limited to customElement, runes, modernAst
// and namespace), and the same whitespace handling on both sides.
import type { BunPlugin } from "bun";
import { compile } from "svelte/compiler";
import { DEV } from "esm-env";
import type { ViewSide } from "../../core/interface";

// Svelte's runtime decides whether it is a development build from the
// `development` export condition (esm-env), not from NODE_ENV, and a
// component compiled with `dev: true` throws inside a runtime that is not
// ("context.function[FILENAME]"): Bun's runtime sets that condition only
// under `bun --conditions=development`. So the server side follows the
// runtime, and the client side adds the condition to its build when dev.
export function svelteCompile(
  side: ViewSide,
  { dev = side === "server" ? DEV === true : process.env.NODE_ENV !== "production", async = false } = {},
): BunPlugin {
  return {
    name: `bun-views-svelte-${side}`,
    setup(build) {
      if (build.config) {
        // The "svelte" export condition, as the official plugin adds it.
        const conditions = ([] as string[]).concat(build.config.conditions ?? []);
        build.config.conditions = [...conditions, "svelte", ...(dev ? ["development"] : [])];
      }
      build.onLoad({ filter: /\.svelte$/ }, async ({ path }) => {
        const source = await Bun.file(path).text();
        const { js, warnings } = compile(source, {
          filename: path,
          generate: side,
          dev,
          css: "injected",
          ...(async ? { experimental: { async: true } } : {}),
        });
        for (const w of warnings) if (w.code !== "state_referenced_locally") console.warn(`svelte: ${w.code} ${w.message}`);
        return { contents: js.code, loader: "js" };
      });
    },
  };
}
