// A minimal Vue SFC compile step for Bun, the shape the Vue adapter would
// ship: one plugin, two sides. The server side compiles templates to Vue's
// SSR string-push functions (`ssr: true`); the client side to render
// functions. Styles are not handled (see the plan, §8.2).
import type { BunPlugin } from "bun";
import { existsSync, readFileSync } from "node:fs";
import { compileScript, compileTemplate, parse } from "vue/compiler-sfc";
import type { ViewSide } from "../../core/interface";

export function vueSfc(side: ViewSide, { prod = process.env.NODE_ENV === "production" } = {}): BunPlugin {
  const ssr = side === "server";
  return {
    name: `bun-views-vue-${side}`,
    setup(build) {
      if (build.config && side === "client") {
        // Vue's esm-bundler build reads these flags. A plugin can set them:
        // Bun.build honours a define added in setup() (measured on 1.4.3).
        build.config.define = {
          __VUE_OPTIONS_API__: "true",
          __VUE_PROD_DEVTOOLS__: "false",
          __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: "true",
          ...build.config.define,
        };
      }
      build.onLoad({ filter: /\.vue$/ }, async ({ path }) => {
        const source = await Bun.file(path).text();
        const { descriptor, errors } = parse(source, { filename: path, sourceMap: false });
        if (errors.length > 0) throw errors[0];
        const id = `v${Bun.hash(path).toString(16).slice(0, 8)}`;
        const isTs = descriptor.scriptSetup?.lang === "ts" || descriptor.script?.lang === "ts";
        let code: string;
        if (descriptor.scriptSetup) {
          // <script setup>: the template is inlined into setup(); with ssr, setup
          // returns the SSR render function and the component is marked
          // __ssrInlineRender, which the runtime turns into ssrRender.
          code = compileScript(descriptor, {
            id,
            isProd: prod,
            inlineTemplate: true,
            genDefaultAs: "__sfc__",
            templateOptions: { ssr, compilerOptions: {} },
            // Type-based props that import a type from another file
            // (`defineProps<{ item: Item }>()`) need a file system.
            fs: { fileExists: existsSync, readFile: (file) => readFileSync(file, "utf8") },
          }).content;
        } else {
          code = descriptor.script
            ? compileScript(descriptor, { id, isProd: prod, genDefaultAs: "__sfc__" }).content
            : "const __sfc__ = {};";
          if (descriptor.template) {
            const fn = ssr ? "ssrRender" : "render";
            const t = compileTemplate({ source: descriptor.template.content, filename: path, id, ssr, isProd: prod });
            if (t.errors.length > 0) throw t.errors[0];
            code += `\n${t.code.replace(`export function ${fn}`, `function ${fn}`)}\n__sfc__.${fn} = ${fn};`;
          }
        }
        code += `\n__sfc__.__file = ${JSON.stringify(path)};\nexport default __sfc__;`;
        return { contents: code, loader: isTs ? "ts" : "js" };
      });
    },
  };
}
