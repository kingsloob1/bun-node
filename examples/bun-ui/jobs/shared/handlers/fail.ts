/**
 * A runner handler that always fails, the way a call to a partner API does
 * when the partner is down: the run's record carries the error, and the
 * runner its `lastError`.
 */
import { defineHandler } from "@kingsleyweb/bun-jobs";

export default defineHandler<unknown, never>(() => {
  throw new Error("crm.example answered 503 Service Unavailable");
});
