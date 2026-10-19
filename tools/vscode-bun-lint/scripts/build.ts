/**
 * Bundles the extension into `dist/extension.js` with `Bun.build`: one
 * CommonJS file for the extension host (Node, inside VS Code), with `vscode`
 * left as the host's own module. Run with `bun run build`; `bun run package`
 * builds and then packs the `.vsix`.
 */
import { join } from "node:path";

const root = join(import.meta.dir, "..");

const result = await Bun.build({
  entrypoints: [join(root, "src/extension.ts")],
  outdir: join(root, "dist"),
  naming: "extension.js",
  target: "node",
  format: "cjs",
  external: ["vscode"],
  sourcemap: "none",
  minify: false,
});

if (!result.success)
  throw new AggregateError(
    result.logs,
    "bun build failed for the VS Code extension",
  );
