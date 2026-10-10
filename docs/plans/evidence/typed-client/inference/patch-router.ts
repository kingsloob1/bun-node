/**
 * Copies packages/bun-common/lib into ./.patched/bun-common/lib and makes the
 * REAL BunRouter accumulate a route map in its type:
 *
 *  - a 4th class type parameter, `TRoutes = {}`;
 *  - every generated typed verb overload returns
 *    `BunRouter<TMountPath, TMountShape, THost, TRoutes & RouteEntry<VERB, `${TMountPath}${TPath}`, TShape>>`
 *    instead of `this` (the wide untyped overloads keep `this`);
 *  - the two typed `use(path, subRouter)` overloads infer the sub-router's
 *    `TSubRoutes` and return `BunRouter<…, TRoutes & TSubRoutes>`.
 *
 * Nothing in the repo is modified. Run: bun patch-router.ts
 */
import { cpSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "../../../../..");
const src = join(root, "packages/bun-common/lib");
const dest = join(import.meta.dir, ".patched/bun-common/lib");
rmSync(join(import.meta.dir, ".patched"), { recursive: true, force: true });
cpSync(src, dest, { recursive: true });

// 1. RouteEntry beside MountedHandler.
const typingFile = join(dest, "types/routeTyping.ts");
writeFileSync(
  typingFile,
  `${readFileSync(typingFile, "utf8")}
/** SPIKE: one route of an accumulated route map, keyed "VERB /full/path". */
export type RouteEntry<TVerb extends string, TFullPath extends string, TShape> = {
  [K in \`\${TVerb} \${TFullPath}\`]: {
    params: ResolveParams<TFullPath, TShape>;
    // query and params cross as strings and are coerced: the OUTPUT type is what to send
    // (zod 4: z.coerce.number() has input unknown, which would accept anything)
    query: ResolveQuery<TShape>;
    body: TShape extends { input: { body: infer B } } ? B : ResolveBody<TShape>;
    responses: TShape extends { responses: infer R } ? R : { 200: unknown };
  };
};
`,
);

// 2. BunRouter: the class parameter, the verb overloads, use().
const routerFile = join(dest, "BunRouter.ts");
let text = readFileSync(routerFile, "utf8");
text = text.replace(
  'import type { EmptyShape, MountedHandler } from "./types/routeTyping";',
  'import type { EmptyShape, MountedHandler, RouteEntry } from "./types/routeTyping";',
);
const classHead = '  THost extends string = "",\n> extends Router {';
if (!text.includes(classHead)) throw new Error("class head not found");
// eslint-disable-next-line ts/no-empty-object-type
text = text.replace(classHead, '  THost extends string = "",\n  // eslint-disable-next-line ts/no-empty-object-type\n  TRoutes = {},\n> extends Router {');

let blocks = 0;
text = text.replace(
  /( {2}\/\* --- BEGIN generated typed overloads: (\w+) --- \*\/)([\s\S]*?)( {2}\/\* --- END generated typed overloads: \2 --- \*\/)/g,
  (_m, begin: string, verb: string, body: string, end: string) => {
    blocks++;
    const ret = `BunRouter<TMountPath, TMountShape, THost, TRoutes & RouteEntry<"${verb.toUpperCase()}", \`\${TMountPath}\${TPath}\`, TShape>>`;
    return begin + body.replaceAll("  ): this;", `  ): ${ret};`) + end;
  },
);

// use(path, router) and use(path, validator, router): infer the sub-router's routes.
const use1 = `  override use<TPath extends string, TShape = EmptyShape>(
    path: TPath,`;
let uses = 0;
text = text.replaceAll(use1, () => {
  uses++;
  return `  override use<TPath extends string, TShape = EmptyShape, TSubRoutes = {}>(
    path: TPath,`;
});
text = text.replace(
  `    router: BunRouter<NoInfer<TPath>, TShape> &
      (keyof TShape extends never ? unknown : never),
  ): this;`,
  `    router: BunRouter<NoInfer<TPath>, TShape, "", TSubRoutes> &
      (keyof TShape extends never ? unknown : never),
  ): BunRouter<TMountPath, TMountShape, THost, TRoutes & TSubRoutes>;`,
);
text = text.replace(
  `    router: BunRouter<NoInfer<TPath>, NoInfer<Omit<TShape, "params">>>,
  ): this;`,
  `    router: BunRouter<NoInfer<TPath>, NoInfer<Omit<TShape, "params">>, "", TSubRoutes>,
  ): BunRouter<TMountPath, TMountShape, THost, TRoutes & TSubRoutes>;`,
);
writeFileSync(routerFile, text);
console.log(`patched ${blocks} generated verb blocks and ${uses} typed use() overloads into ${dest}`);
