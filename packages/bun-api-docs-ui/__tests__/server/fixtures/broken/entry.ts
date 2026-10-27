/** An entry that cannot build: the module it imports does not exist. */
// @ts-expect-error -- deliberately missing, so the bundler fails.
import { missing } from "./does-not-exist";

export const value: unknown = missing;
