import type { WsAddressOptions } from "@kingsleyweb/bun-api-docs-ui/embed";
import {
  encodeJobId,
  MAX_NAME_LENGTH,
  NAME_PARAM_PATTERN,
} from "@kingsleyweb/bun-jobs/api/contract";

/**
 * The contract's own rules for the WebSocket reference's try-it, injected
 * into the package's machinery: queue/runner names follow the contract's
 * name rule, a job id is anything (it is escaped), and a job id is escaped
 * exactly as the live client names job channels (`liveChannels.job`).
 */

/** How a queue or runner name must look (the contract's `NAME_PARAM_PATTERN`). */
const NAME_PATTERN = new RegExp(NAME_PARAM_PATTERN);

/** Why a name is refused under the contract's rule. */
const NAME_PROBLEM = `Letters, digits, "_", "." and "-" only (not "." or ".."), at most ${MAX_NAME_LENGTH}.`;

/** The reference's address options: the contract's rule, wording and job-id escaping. */
export const JOBS_ADDRESS: WsAddressOptions = {
  nameRule: (name, value) => {
    if (name === "jobId") {
      return null;
    }
    return value.length <= MAX_NAME_LENGTH && NAME_PATTERN.test(value)
      ? null
      : NAME_PROBLEM;
  },
  patternText: {
    [NAME_PARAM_PATTERN]:
      'Letters, digits, "_", "." and "-" only (not "." or "..").',
  },
  escapeValue: (name, value) => (name === "jobId" ? encodeJobId(value) : value),
};
