/**
 * What the engine asks of IP intelligence (layers.md L5), apart from how it
 * is built: the engine imports only these types, so a policy without
 * country, ASN or class rules costs nothing and the root entry never loads
 * `./intel`.
 */
import type { ParsedAddress } from "../ip/address";

/** What is known of one address. */
export interface IntelRecord {
  /** Its country, ISO 3166-1 alpha-2, upper case (`"DE"`), when a database knows it. */
  readonly country?: string;
  /** Its autonomous system number, when a database knows it. */
  readonly asn?: number;
  /** Its autonomous system's organisation, when a database names it. */
  readonly asOrganization?: string;
  /** The classes its range feeds put it in (`"tor"`, `"hosting"`), sorted. */
  readonly classes: readonly string[];
}

/** What a source of IP intelligence provides. */
export interface IntelProvides {
  /** Whether a database gives countries. */
  readonly country: boolean;
  /** Whether a database gives ASNs. */
  readonly asn: boolean;
  /** The classes its feeds and static ranges can put an address in. */
  readonly classes: ReadonlySet<string>;
}

/** IP intelligence as the engine reads it (`ipIntel()` from `./intel`, or your own). */
export interface IntelLookup {
  /** What is known of `address` (never throws; an empty record when nothing is). */
  readonly lookup: (address: ParsedAddress | string) => IntelRecord;
  /** What it can tell, so a policy naming what it cannot is refused at start. */
  readonly provides: () => IntelProvides;
}
