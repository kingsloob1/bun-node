import type { SpecDocument } from "../../../../app/api/docs";

/**
 * REAL OpenAPI documents for the HTTP reference's tests, generated at test
 * time by a real `createJobsApi(...).openapi()` over the memory driver.
 *
 * Why generated rather than committed: the document is ~240 KB, and a
 * committed copy goes stale the moment a route, schema or error code
 * changes in bun-jobs — the tests would then pass against a document the
 * API no longer serves. Generating it means the viewer is always tested
 * against what the API emits today, in each configuration a test asks for.
 *
 * This file is DOM-free, and loads the package by a specifier the compiler
 * does not follow: the app's test project compiles with the DOM lib, which
 * the package's raw-.ts source graph conflicts with (see
 * `__tests__/app/pkg/tsconfig.json`). The interfaces below restate the
 * little it uses.
 */

/** The API's mode. */
export type FixtureMode = "jobs" | "runner" | "both";

/** How the API is configured for one document. */
export interface FixtureOptions {
  /** The mode. Defaults to `"both"`. */
  mode?: FixtureMode;
  /** `readOnly`. Defaults to `false`. */
  readOnly?: boolean;
  /** The CSRF header mutations must carry, or `false` for none. Defaults to `"x-bun-jobs-csrf"`. */
  csrfHeader?: string | false;
  /** `basePath`. Defaults to `"/jobs-api"`. */
  basePath?: string;
}

/** What this file uses of `@kingsleyweb/bun-jobs`. */
interface JobsModule {
  /** The context. */
  BunJobs: new (options: { namespace: string; driver: unknown }) => {
    /** Releases it. */
    close: () => Promise<void>;
  };
  /** The memory driver. */
  MemoryDriver: new () => unknown;
  /** The API factory. */
  createJobsApi: (config: Record<string, unknown>) => {
    /** The document. */
    openapi: () => SpecDocument;
  };
}

/** What this file uses of `@kingsleyweb/bun-common`. */
interface CommonModule {
  /** A logger that drops everything. */
  noopLogger: unknown;
}

/** Imports a module by a specifier the compiler does not resolve. */
function load<T>(specifier: string): Promise<T> {
  return import(specifier) as Promise<T>;
}

/** Documents already generated, by options. */
const cache = new Map<string, Promise<SpecDocument>>();

/** Generates one document. */
async function generate(options: FixtureOptions): Promise<SpecDocument> {
  const { BunJobs, MemoryDriver, createJobsApi } = await load<JobsModule>(
    ["@kingsleyweb", "bun-jobs"].join("/"),
  );
  const { noopLogger } = await load<CommonModule>(
    ["@kingsleyweb", "bun-common"].join("/"),
  );
  const jobs = new BunJobs({ namespace: "shop", driver: new MemoryDriver() });
  try {
    const header = options.csrfHeader ?? "x-bun-jobs-csrf";
    const api = createJobsApi({
      jobs,
      mode: options.mode ?? "both",
      readOnly: options.readOnly ?? false,
      basePath: options.basePath ?? "/jobs-api",
      authorize: () => true,
      logger: noopLogger,
      csrf: { header },
    });
    return api.openapi();
  } finally {
    await jobs.close();
  }
}

/**
 * The document a real API with `options` serves. Each configuration is
 * generated once per run; callers get a deep copy, so a test cannot change
 * another's document.
 */
export async function openApiFixture(
  options: FixtureOptions = {},
): Promise<SpecDocument> {
  const key = JSON.stringify(options);
  let pending = cache.get(key);
  if (!pending) {
    pending = generate(options);
    cache.set(key, pending);
  }
  return structuredClone(await pending);
}
