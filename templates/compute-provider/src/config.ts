import type { StandardSchemaV1 } from "@kingsleyweb/bun-jobs/provider";
import { toStandardSchema } from "@kingsleyweb/bun-jobs/provider";

/**
 * The provider's config: what a user passes to `acme({ … })`, and the schema
 * that validates it. Any Standard Schema works (zod, valibot, arktype); this
 * one is `toStandardSchema` around a function, so the template needs no
 * validation library.
 */

/** What a user passes to `acme({ … })`. */
export interface AcmeConfig {
  /** The pool units start in: a machine shape and image, created in Acme's console. */
  pool: string;
  /** The region the pool is in, e.g. `"eu-west"`. A fact, shown in the UI. */
  region: string;
  /** The API token. Give it, or `apiTokenFile`. A secret: redacted from every log. */
  apiToken?: string;
  /** A file holding the API token (a mounted secret), read when the provider is configured. */
  apiTokenFile?: string;
  /** The API's base URL. Defaults to Acme's; a test points it at the fake. */
  url?: string;
}

/** The config the facets receive: validated, with the token resolved and the URL defaulted. */
export interface ValidAcmeConfig {
  /** The pool units start in. */
  pool: string;
  /** The pool's region. */
  region: string;
  /** The API token, from `apiToken` or read from `apiTokenFile`. */
  apiToken: string;
  /** The API's base URL, without a trailing slash. */
  url: string;
}

/** Acme's API, when `url` is not given. */
const DEFAULT_URL = "https://api.acme-compute.example";

/** A region or pool name, as Acme's console allows them. */
const NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** One validation issue: what is wrong, and where. */
interface Issue {
  /** What is wrong. Never echo a secret here. */
  message: string;
  /** The config key it is about: the conformance kit checks it. */
  path: string[];
}

/** Checks everything that needs no I/O. */
function check(input: unknown): Issue[] {
  const config = (
    typeof input === "object" && input !== null ? input : {}
  ) as Record<string, unknown>;
  const issues: Issue[] = [];
  for (const key of ["pool", "region"] as const) {
    if (typeof config[key] !== "string" || !NAME.test(config[key])) {
      issues.push({
        message: `${key} must be 1-40 lowercase letters, digits and dashes`,
        path: [key],
      });
    }
  }
  const hasToken = config.apiToken !== undefined;
  const hasFile = config.apiTokenFile !== undefined;
  if (hasToken === hasFile) {
    issues.push({
      message: "give one of apiToken and apiTokenFile",
      path: ["apiToken"],
    });
  } else if (
    hasToken &&
    (typeof config.apiToken !== "string" || !/^\S{8,}$/.test(config.apiToken))
  ) {
    issues.push({
      message: "apiToken must be at least 8 characters, without spaces",
      path: ["apiToken"],
    });
  } else if (
    hasFile &&
    (typeof config.apiTokenFile !== "string" || config.apiTokenFile === "")
  ) {
    issues.push({
      message: "apiTokenFile must be a path",
      path: ["apiTokenFile"],
    });
  }
  if (config.url !== undefined) {
    const problem = urlProblem(config.url);
    if (problem !== undefined) {
      issues.push({ message: problem, path: ["url"] });
    }
  }
  return issues;
}

/** The hosts plain `http:` may reach: this machine only (a local fake, a tunnel). */
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * What is wrong with a `url`, or `undefined`. The bearer token goes on every
 * call, so it crosses plain HTTP only to this machine.
 */
function urlProblem(url: unknown): string | undefined {
  const parsed = typeof url === "string" ? URL.parse(url) : null;
  if (parsed === null || parsed.hostname === "") {
    return "url must be an absolute https URL";
  }
  if (parsed.protocol === "https:") {
    return undefined;
  }
  if (parsed.protocol === "http:") {
    return LOOPBACK.has(parsed.hostname)
      ? undefined
      : `url must use https: the API token would cross the network in clear text (http is allowed only for ${[...LOOPBACK].join(", ")})`;
  }
  return `url must be an https URL, not ${parsed.protocol}`;
}

/**
 * The config schema. It answers synchronously when it can, so a bad config
 * throws a `ConfigError` from `acme({ … })` at once; only reading
 * `apiTokenFile` makes it answer with a promise, and then the configured
 * provider's `ready` settles (or rejects) once the file is read.
 */
export const acmeConfigSchema: StandardSchemaV1<AcmeConfig, ValidAcmeConfig> =
  toStandardSchema<AcmeConfig, ValidAcmeConfig>((input) => {
    const issues = check(input);
    if (issues.length > 0) {
      return { issues };
    }
    const config = input as AcmeConfig;
    const valid = (apiToken: string): { value: ValidAcmeConfig } => ({
      value: {
        pool: config.pool,
        region: config.region,
        apiToken,
        url: (config.url ?? DEFAULT_URL).replace(/\/+$/, ""),
      },
    });
    if (config.apiToken !== undefined) {
      return valid(config.apiToken);
    }
    const path = config.apiTokenFile!;
    return Bun.file(path)
      .text()
      .then(
        (text) =>
          /^\S{8,}$/.test(text.trim())
            ? valid(text.trim())
            : {
                issues: [
                  {
                    message: `${path} does not hold a token`,
                    path: ["apiTokenFile"],
                  },
                ],
              },
        () => ({
          issues: [{ message: `cannot read ${path}`, path: ["apiTokenFile"] }],
        }),
      );
  });
