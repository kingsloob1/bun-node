import { existsSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { describe, expect, it } from "bun:test";

/**
 * The first-party rule (plugins §5): a first-party provider
 * (`lib/providers/`) and a first-party runtime adapter
 * (`lib/remote/adapters/`) are written against the public plugin API and
 * import nothing else from the package, so what they need, third parties get
 * too.
 *
 * | From | May import |
 * |---|---|
 * | `lib/providers/**` | `lib/provider/index.ts` (`./provider`), `lib/provider/auth/index.ts` (`./provider/auth`), `lib/summon/index.ts` (`./summon`, types only), its own files under `lib/providers/<name>/`, `@kingsleyweb/bun-common`, `node:*`, `bun:*` |
 * | `lib/remote/adapters/**` | `lib/remote/index.ts` (`./remote`) and other adapter files only: no built-ins, no packages |
 *
 * Neither directory exists yet (the first providers land in 1.5c), so today
 * the scan covers nothing, and the negative controls below are what make
 * this test mean something until then.
 */

const LIB = resolve(import.meta.dir, "../../lib");

/** One import a file makes, and whether only types come through it. */
interface ImportSpec {
  /** The specifier as written. */
  specifier: string;
  /** Whether the statement is `import type` / `export type`. */
  typeOnly: boolean;
}

/**
 * Every import in `source`, type imports included: the transpiler's scan
 * sees what survives to run time (including `require` and dynamic
 * `import()`), and a statement scan adds the type-only ones it strips.
 */
function importsOf(source: string): ImportSpec[] {
  const found = new Map<string, ImportSpec>();
  // Every `from "…"` and bare `import "…"`; whether it is type-only is
  // read from the `import`/`export` keyword that opens its statement.
  const specifier = /\b(?:from|import)\s*["']([^"']+)["']/g;
  for (const match of source.matchAll(specifier)) {
    const before = source.slice(0, match.index + 6);
    const opener = Math.max(
      before.lastIndexOf("import"),
      before.lastIndexOf("export"),
    );
    const typeOnly = /^(?:import|export)\s+type\b/.test(source.slice(opener));
    const known = found.get(match[1]!);
    found.set(match[1]!, {
      specifier: match[1]!,
      typeOnly: known === undefined ? typeOnly : known.typeOnly && typeOnly,
    });
  }
  for (const entry of new Bun.Transpiler({ loader: "ts" }).scanImports(
    source,
  )) {
    // Anything the transpiler keeps is a runtime import.
    found.set(entry.path, { specifier: entry.path, typeOnly: false });
  }
  return [...found.values()];
}

/** A module path without its extension or a trailing `/index`. */
function moduleOf(path: string): string {
  return path.replace(/\.(?:ts|js)$/, "").replace(/[/\\]index$/, "");
}

/** Whether `path` is `dir` or inside it. */
function inside(path: string, dir: string): boolean {
  return path === dir || path.startsWith(dir + sep);
}

/**
 * The imports of one first-party file that break the rule, as readable
 * strings. `file` is its path under `lib/`.
 */
function violations(file: string, source: string): string[] {
  const absolute = join(LIB, file);
  const inProviders = inside(absolute, join(LIB, "providers"));
  const inAdapters = inside(absolute, join(LIB, "remote", "adapters"));
  if (!inProviders && !inAdapters) {
    throw new Error(`${file} is not a first-party provider or adapter`);
  }
  // A provider's own helpers: lib/providers/<name>/ for lib/providers/<name>.ts
  // or any file under it.
  const own = inProviders
    ? join(
        LIB,
        "providers",
        moduleOf(relative(join(LIB, "providers"), absolute)).split(sep)[0]!,
      )
    : join(LIB, "remote", "adapters");

  const broken: string[] = [];
  for (const { specifier, typeOnly } of importsOf(source)) {
    const bad = (why: string) => broken.push(`${file}: ${specifier} (${why})`);
    if (!specifier.startsWith(".")) {
      if (inAdapters) {
        bad("an adapter must stay browser-safe: no built-ins or packages");
      } else if (
        specifier !== "@kingsleyweb/bun-common" &&
        !specifier.startsWith("node:") &&
        !specifier.startsWith("bun:")
      ) {
        bad("only @kingsleyweb/bun-common and built-ins");
      }
      continue;
    }
    const target = moduleOf(resolve(dirname(absolute), specifier));
    if (inside(target, own)) {
      continue;
    }
    if (inAdapters) {
      if (target !== join(LIB, "remote")) {
        bad("only the ./remote entry");
      }
      continue;
    }
    if (
      target === join(LIB, "provider") ||
      target === join(LIB, "provider", "auth")
    ) {
      continue;
    }
    if (target === join(LIB, "summon")) {
      if (!typeOnly) {
        bad("the ./summon entry is for types only");
      }
      continue;
    }
    bad("not a public entry");
  }
  return broken;
}

/** Every `.ts` file under `dir` (relative to `lib/`), or none when it does not exist. */
async function filesUnder(dir: string): Promise<string[]> {
  if (!existsSync(join(LIB, dir))) {
    return [];
  }
  const files: string[] = [];
  for await (const file of new Bun.Glob("**/*.ts").scan(join(LIB, dir))) {
    files.push(join(dir, file));
  }
  return files;
}

describe("first-party providers and adapters import only the public API", () => {
  it("holds for every file under lib/providers/ and lib/remote/adapters/", async () => {
    const files = [
      ...(await filesUnder("providers")),
      ...(await filesUnder(join("remote", "adapters"))),
    ];
    const broken: string[] = [];
    for (const file of files) {
      broken.push(...violations(file, await Bun.file(join(LIB, file)).text()));
    }
    expect(broken).toEqual([]);
  });

  it("accepts what the table allows", () => {
    expect(
      violations(
        "providers/acme.ts",
        [
          'import { defineComputeProvider } from "../provider/index";',
          'import type { SummonPolicy } from "../summon/index.ts";',
          'export type { SummonStatus } from "../summon";',
          'import { signAwsRequest } from "../provider/auth/index";',
          'import { sign } from "./acme/sign";',
          'import { createLogger } from "@kingsleyweb/bun-common";',
          'import { createHash } from "node:crypto";',
          'import { file } from "bun:jsc";',
        ].join("\n"),
      ),
    ).toEqual([]);
    expect(
      violations(
        "providers/acme/sign.ts",
        'import { COMPUTE_PROVIDER_API } from "../../provider";\nimport { x } from "./util";',
      ),
    ).toEqual([]);
    expect(
      violations(
        "remote/adapters/lambda.ts",
        'import { defineRuntimeAdapter } from "../index";\nimport { frame } from "./shared";',
      ),
    ).toEqual([]);
  });

  // The negative controls: each breaks the rule one way and must be caught.
  it("catches a deep import into the package, a runtime or a type one", () => {
    expect(
      violations(
        "providers/acme/client.ts",
        'import { attemptId } from "../../summon/marker";',
      ),
    ).toEqual([
      "providers/acme/client.ts: ../../summon/marker (not a public entry)",
    ]);
    expect(
      violations(
        "providers/acme.ts",
        'import type { SummonMarker } from "../summon/types";',
      ),
    ).toHaveLength(1);
    expect(
      violations(
        "providers/acme.ts",
        'const lazy = await import("../shared/errors");',
      ),
    ).toHaveLength(1);
  });

  it("catches a value import from ./summon, another provider's files, and an undeclared package", () => {
    expect(
      violations(
        "providers/acme.ts",
        'import { SummonController } from "../summon/index";',
      ),
    ).toEqual([
      "providers/acme.ts: ../summon/index (the ./summon entry is for types only)",
    ]);
    expect(
      violations("providers/acme.ts", 'import { x } from "./other/util";'),
    ).toHaveLength(1);
    expect(
      violations(
        "providers/acme.ts",
        'import { S3 } from "@aws-sdk/client-s3";',
      ),
    ).toHaveLength(1);
  });

  it("catches a built-in in an adapter, and anything but ./remote", () => {
    expect(
      violations("remote/adapters/lambda.ts", 'import { x } from "node:fs";'),
    ).toHaveLength(1);
    expect(
      violations(
        "remote/adapters/lambda.ts",
        'import { y } from "../../provider/index";',
      ),
    ).toHaveLength(1);
  });
});
