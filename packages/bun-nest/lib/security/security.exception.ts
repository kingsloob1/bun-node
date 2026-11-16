/**
 * The exception `SecurityGuard` refuses a request with in the route stage.
 */
import type { Decision } from "@kingsleyweb/bun-security";
import { HttpException } from "@nestjs/common";

/** The reason phrase of each status a refusal can carry. */
const TITLES: Readonly<Record<number, string>> = {
  401: "Unauthorized",
  403: "Forbidden",
  429: "Too Many Requests",
  503: "Service Unavailable",
};

/**
 * A refusal by bun-security's route stage (a limit keyed on the caller, a
 * listed or banned user, a canary credential, the CSRF check), thrown by
 * `SecurityGuard` into Nest's exception layer. Its response is the
 * problem body bun-security answers with everywhere (`{ type, title,
 * status, code }`, never the rule's name), so the default filter sends it
 * as JSON; an app's own filter can render it from {@link decision}. The
 * guard sets `Retry-After` and `Cache-Control: no-store` on the response
 * before throwing, and Nest's filters answer on that response.
 */
export class SecurityRefusalException extends HttpException {
  constructor(
    /** The decision that refused the request: its status, code and hits. */
    readonly decision: Decision,
  ) {
    const status = decision.status ?? 403;
    super(
      {
        type: "about:blank",
        title: TITLES[status] ?? "Refused",
        status,
        code: decision.code ?? "blocked",
      },
      status,
    );
  }
}
