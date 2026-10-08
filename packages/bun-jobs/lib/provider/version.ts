import type { Logger } from "../shared/logger";
import type { ProviderApiVersions, ProviderIdentity } from "./define";
import { ConfigError } from "../shared/errors";

/**
 * The per-facet version check (plugins §10.2) and the per-process name map
 * (plugins §9.3).
 *
 * A provider says, per facet it implements, which `"major.minor"` of the
 * plugin API it was written against. At definition, a different major, or a
 * facet without its version (or a version without its facet), is a
 * `ConfigError`. At registration (when a controller is handed a provider),
 * a newer minor, the API being experimental (`0.x`), and a second version of
 * the same provider name in one process are each one `warn`, once per
 * process.
 */

/**
 * The plugin API versions this build of bun-jobs speaks, per facet:
 * `"major.minor"`. A provider's `apiVersion` is checked against it.
 */
export const COMPUTE_PROVIDER_API: {
  /** The shared core: identity, config, contexts. */
  readonly core: "0.1";
  /**
   * The summon facet. `0.2` added `SummonRequest.queues`, `.group` and
   * `.demands` and `SummonReleaseRequest.queues` and `.group`, all
   * additive: a provider written for `0.1` runs unchanged.
   */
  readonly summon: "0.2";
} = Object.freeze({ core: "0.1", summon: "0.2" } as const);

/** The facets this build implements, besides the core. */
const FACETS = ["summon"] as const;

/** One facet's name. */
type Facet = (typeof FACETS)[number];

/** A `"major.minor"` version, strictly. */
const API_VERSION = /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/;

/** A version's two numbers, or a `ConfigError` naming the field. */
function parse(
  provider: string,
  field: string,
  value: unknown,
): [number, number] {
  const match = typeof value === "string" ? API_VERSION.exec(value) : null;
  if (match === null) {
    throw new ConfigError(
      `Provider ${provider}: apiVersion.${field} must be a "major.minor" string, e.g. "${COMPUTE_PROVIDER_API.core}"`,
      { provider, [field]: value },
    );
  }
  return [Number(match[1]), Number(match[2])];
}

/**
 * Checks a definition's `apiVersion` against this build, per facet it
 * implements, and refuses what it cannot run.
 *
 * @throws {ConfigError} when a major differs (naming which side to
 *   upgrade), when a facet has no version or a version has no facet, when
 *   either names the execute facet (this build has none), or when a version
 *   is malformed.
 */
export function checkApiVersions(
  /** The provider's name, for the message. */
  provider: string,
  /** What it declared. */
  apiVersion: ProviderApiVersions | undefined,
  /** Which facets it implements. */
  facets: Readonly<Record<Facet | "execute", boolean>>,
): void {
  if (typeof apiVersion !== "object" || apiVersion === null) {
    throw new ConfigError(
      `Provider ${provider} must declare apiVersion: the plugin API versions it was written against, e.g. { core: "${COMPUTE_PROVIDER_API.core}", summon: "${COMPUTE_PROVIDER_API.summon}" }`,
      { provider },
    );
  }
  if (facets.execute || "execute" in apiVersion) {
    throw new ConfigError(
      `Provider ${provider} declares an execute facet, and this bun-jobs has no execute facet: remove it, or use a bun-jobs that speaks it`,
      { provider },
    );
  }
  compare(provider, "core", apiVersion.core);
  for (const facet of FACETS) {
    const declared = apiVersion[facet];
    if (facets[facet] && declared === undefined) {
      throw new ConfigError(
        `Provider ${provider} has a ${facet} facet but no apiVersion.${facet}: a provider must say what it was written against`,
        { provider },
      );
    }
    if (!facets[facet] && declared !== undefined) {
      throw new ConfigError(
        `Provider ${provider} declares apiVersion.${facet} but has no ${facet} facet`,
        { provider, [facet]: declared },
      );
    }
    if (declared !== undefined) {
      compare(provider, facet, declared);
    }
  }
}

/** One facet's major against the host's, or a `ConfigError` saying which side to upgrade. */
function compare(
  provider: string,
  facet: Facet | "core",
  declared: unknown,
): void {
  const [major] = parse(provider, facet, declared);
  const host = COMPUTE_PROVIDER_API[facet];
  const [hostMajor] = parse(provider, facet, host);
  if (major !== hostMajor) {
    throw new ConfigError(
      major > hostMajor
        ? `Provider ${provider} was written for ${facet} ${String(declared)}, and this bun-jobs speaks ${facet} ${host}: upgrade bun-jobs`
        : `Provider ${provider} was written for ${facet} ${String(declared)}, and this bun-jobs speaks ${facet} ${host}: upgrade the provider`,
      { provider, facet, declared, host },
    );
  }
}

/**
 * The versions the host negotiated, per facet the provider declared: the
 * lower minor of the two (the majors already match).
 */
export function negotiate(
  apiVersion: ProviderApiVersions,
): ProviderApiVersions {
  const lower = (facet: Facet | "core", declared: string): string => {
    const [, minor] = parse("", facet, declared);
    const [major, hostMinor] = parse("", facet, COMPUTE_PROVIDER_API[facet]);
    return `${major}.${Math.min(minor, hostMinor)}`;
  };
  return Object.freeze({
    core: lower("core", apiVersion.core),
    ...(apiVersion.summon === undefined
      ? {}
      : { summon: lower("summon", apiVersion.summon) }),
  });
}

/** Identities built by the host itself (`defineSummoner`): registration warns about none of them. */
const HOST_BUILT = new WeakSet<ProviderIdentity>();

/** Internal: marks an identity as built by the host, at the host's version. */
export function markHostBuilt(identity: ProviderIdentity): void {
  HOST_BUILT.add(identity);
}

/** Whether an identity was built by the host (`defineSummoner`), which the plugin warnings skip. */
function isHostBuilt(identity: ProviderIdentity): boolean {
  return HOST_BUILT.has(identity);
}

/** `name@version`s already warned about for throwing something other than a `ProviderError`. */
const UNMAPPED = new Set<string>();

/**
 * Internal: says, once per process per `name@version`, that a provider threw
 * something other than a `ProviderError` (plugins §6.5), which is treated as
 * `transient`. Never for a provider `defineSummoner` built: that is the
 * user's own code, and each of its failures is already logged as an `error`.
 */
export function warnUnmappedThrow(
  /** The provider's identity. */
  identity: ProviderIdentity,
  /** Where the warning goes. */
  logger: Logger,
  /** What it threw. */
  error: unknown,
): void {
  if (isHostBuilt(identity)) {
    return;
  }
  const key = `${identity.name}@${identity.version}`;
  if (UNMAPPED.has(key)) {
    return;
  }
  UNMAPPED.add(key);
  logger.warn(
    `compute provider ${key} threw something other than a ProviderError; it is treated as transient (failed, counted toward the circuit). The provider should map it to a ProviderError kind`,
    {
      provider: identity.name,
      version: identity.version,
      thrown: error instanceof Error ? error.name : typeof error,
    },
  );
}

/** The name map: every provider name registered in this process, with the versions seen. */
const SEEN = new Map<string, Set<string>>();

/** `name@version`s already registered, so each warns once per process. */
const REGISTERED = new Set<string>();

/**
 * Internal: registers a provider a controller was handed, and logs, once per
 * process per `name@version`: that the API is experimental (`0.x`), that a
 * facet was written for a newer minor than this build speaks, and that
 * another version of the same name is registered too. Never for a provider
 * `defineSummoner` built.
 */
export function registerProvider(
  /** The provider's identity. */
  identity: ProviderIdentity,
  /** Where the warnings go. */
  logger: Logger,
): void {
  if (isHostBuilt(identity)) {
    return;
  }
  const key = `${identity.name}@${identity.version}`;
  if (REGISTERED.has(key)) {
    return;
  }
  REGISTERED.add(key);

  const versions = SEEN.get(identity.name) ?? new Set<string>();
  SEEN.set(identity.name, versions);
  if (versions.size > 0 && !versions.has(identity.version)) {
    logger.warn(
      `two versions of compute provider ${identity.name} are registered in this process; both work, and each is shown as name@version`,
      {
        provider: identity.name,
        versions: [...versions, identity.version],
      },
    );
  }
  versions.add(identity.version);

  const declared = identity.apiVersion;
  const experimental: string[] = [];
  for (const facet of ["core", ...FACETS] as const) {
    const version = declared[facet];
    if (version === undefined) {
      continue;
    }
    const [major, minor] = parse(identity.name, facet, version);
    const [hostMajor, hostMinor] = parse(
      identity.name,
      facet,
      COMPUTE_PROVIDER_API[facet],
    );
    if (minor > hostMinor) {
      logger.warn(
        `compute provider ${key} was written for ${facet} ${version}; this bun-jobs speaks ${facet} ${COMPUTE_PROVIDER_API[facet]}, so members added since are ignored`,
        { provider: identity.name, facet, declared: version },
      );
    }
    if (major === 0 && hostMajor === 0) {
      experimental.push(`${facet} ${COMPUTE_PROVIDER_API[facet]}`);
    }
  }
  if (experimental.length > 0) {
    logger.warn(
      `compute provider ${key}: the provider API is experimental (${experimental.join(", ")}); any 0.x minor may change it`,
      { provider: identity.name, version: identity.version },
    );
  }
}
