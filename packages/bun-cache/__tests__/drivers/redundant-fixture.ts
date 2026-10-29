/**
 * Builds a `redundant()` driver from a JSON description of its members, so
 * the conformance kit's two-process pass can build the same combinator in a
 * child process (`crossProcess.options` must be plain data).
 */
import type { CacheDriver } from "../../lib/index";
import { postgresDriver, redisDriver, redundant } from "../../lib/index";
import type { RedundantOptions } from "../../lib/drivers/redundant";

/** One member, as data. */
export type RedundantMemberSpec =
  | {
      /** A Postgres member. */ kind: "postgres";
      /** Its server. */ url: string;
      /** Its table prefix. */ prefix: string;
    }
  | {
      /** A Redis member. */ kind: "redis";
      /** Its server. */ url: string;
      /** Its key prefix. */ prefix: string;
    };

/** A combinator, as data. */
export interface RedundantSpec {
  /** The members, the primary first. */
  members: readonly RedundantMemberSpec[];
  /** The combinator's options. */
  options?: RedundantOptions;
}

/** The combinator a {@link RedundantSpec} describes. */
export function redundantFromSpec(spec: RedundantSpec): CacheDriver {
  return redundant(
    spec.members.map((member) =>
      member.kind === "postgres"
        ? postgresDriver({ url: member.url, prefix: member.prefix })
        : redisDriver({ url: member.url, prefix: member.prefix }),
    ),
    spec.options,
  );
}
