// Solid's compile step: its JSX becomes template strings (server) or DOM
// templates (client) through babel-preset-solid; Bun's own JSX transform
// cannot do that. Limited to `filter`, so other .tsx files in the process
// (React's, the application's) are left to Bun.
import type { BunPlugin } from "bun";
import { transformAsync } from "@babel/core";
import solid from "babel-preset-solid";
import typescript from "@babel/preset-typescript";
import type { ViewSide } from "../../core/interface";

export function solidBabel(side: ViewSide, filter: RegExp): BunPlugin {
  return {
    name: `bun-views-solid-${side}`,
    setup(build) {
      build.onLoad({ filter }, async ({ path }) => {
        const source = await Bun.file(path).text();
        const out = await transformAsync(source, {
          filename: path,
          babelrc: false,
          configFile: false,
          presets: [
            [solid, { generate: side === "server" ? "ssr" : "dom", hydratable: true }],
            [typescript, { isTSX: true, allExtensions: true }],
          ],
        });
        return { contents: out!.code!, loader: "js" };
      });
    },
  };
}
