import type {
  ComputeProviderDefinition,
  ConfiguredProvider,
  ProviderIdentity,
} from "./define";

/**
 * The per-process registry of configured providers (plugins §9.3, §14.1):
 * what `GET /providers` lists and what `/providers/:id/…` finds.
 *
 * Every `provider(config)` registers the instance it makes, under an id
 * `name@version~<n>`: the nth instance of that `name@version` configured in
 * this process, counted from 1. An id is never reused, so it is stable for
 * the process's life, and meaningless in any other process.
 *
 * The registry holds its entries weakly: an instance nothing references any
 * more (no controller, no variable) drops out of the list once it is
 * collected. Its id is not handed out again.
 */

/** How far a configured provider's config has got. */
export type ProviderReadiness = "ready" | "pending" | "failed";

/** Internal: one configured provider, as the registry holds it. */
export interface RegisteredProvider {
  /** Its id, `name@version~<n>`. */
  readonly id: string;
  /** Its identity. */
  readonly identity: ProviderIdentity;
  /** The definition it was made from: its schema, whether it has a preflight. */
  readonly definition: ComputeProviderDefinition<unknown, unknown>;
  /** The configured instance itself. */
  readonly configured: ConfiguredProvider;
  /**
   * Whether its config is known (`"ready"`), still validating (`"pending"`),
   * or rejected — the latest validation failed, or building the facets threw
   * (`"failed"`).
   */
  readonly readiness: () => ProviderReadiness;
  /** Its declared secrets' current values, for redaction. */
  readonly secrets: () => unknown[];
  /**
   * What building its facets from a valid config threw, kept for good
   * (`readiness` is then `"failed"`); `undefined` otherwise.
   */
  readonly buildError: () => unknown;
}

/** The last `n` handed out, per `name@version`. */
const COUNTERS = new Map<string, number>();

/** Every live entry, by id, in the order they were configured. */
const ENTRIES = new Map<string, WeakRef<RegisteredProvider>>();

/** Drops an entry once what it refers to is collected. */
const FINALIZER = new FinalizationRegistry<string>((id) => {
  const ref = ENTRIES.get(id);
  if (ref !== undefined && ref.deref() === undefined) {
    ENTRIES.delete(id);
  }
});

/**
 * Internal: the next id for an instance of `identity`, `name@version~<n>`.
 * Called once per configured instance.
 */
export function nextProviderId(identity: ProviderIdentity): string {
  const key = `${identity.name}@${identity.version}`;
  const n = (COUNTERS.get(key) ?? 0) + 1;
  COUNTERS.set(key, n);
  return `${key}~${n}`;
}

/**
 * Internal: records a configured instance. The entry is held weakly: the
 * caller keeps it alive for as long as the configured provider is.
 */
export function registerConfigured(entry: RegisteredProvider): void {
  ENTRIES.set(entry.id, new WeakRef(entry));
  FINALIZER.register(entry, entry.id);
}

/** Internal: every configured provider still alive in this process, oldest first. */
export function configuredProviders(): RegisteredProvider[] {
  const live: RegisteredProvider[] = [];
  for (const [id, ref] of ENTRIES) {
    const entry = ref.deref();
    if (entry === undefined) {
      ENTRIES.delete(id);
    } else {
      live.push(entry);
    }
  }
  return live;
}

/** Internal: the configured provider with this id, if it is still alive. */
export function configuredProvider(id: string): RegisteredProvider | undefined {
  return ENTRIES.get(id)?.deref();
}
