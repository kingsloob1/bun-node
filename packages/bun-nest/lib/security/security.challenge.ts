/**
 * Route-stage challenges on a Nest application (bun-security layers.md
 * L10.2): when `SecurityGuard`'s decision is a `challenge` and the engine
 * has a challenge flow (`createSecurity`'s `challenge`), the refusal Nest
 * answers with is the flow's own answer — the challenge page under its
 * strict CSP for a browser, or the `403` problem with the challenge
 * descriptor for an API client — not a bare `challenge_required`.
 *
 * It is still a {@link SecurityRefusalException} (a
 * {@link SecurityChallengeException}), so an app's exception filter that
 * renders refusals keeps working; Nest's default filter sends the problem.
 * The page is sent before the exception reaches the filters (Nest's layer
 * would turn an HTML string into JSON), and {@link
 * SecurityChallengeException.sent} says so: a filter of the app's own must
 * then leave the response alone, as Nest's does. The
 * answer's headers (`Content-Type`, `Content-Security-Policy`,
 * `Cache-Control: no-store`, …) are set on the response Nest answers on,
 * as the guard sets `Retry-After` for other refusals.
 *
 * The answer to a challenge is taken by the module's early stage (a `POST`
 * to the flow's path), before Nest routes it, as it is for an early-stage
 * challenge; a client holding a valid clearance then passes the route
 * stage's challenge.
 */
import type { BunRequest, BunResponse } from "@kingsleyweb/bun-common";
import type { Decision, Security } from "@kingsleyweb/bun-security";
import { createLogger } from "@kingsleyweb/bun-common";
import { stateOf } from "@kingsleyweb/bun-security/lib/http/state";
import { challengeResponse } from "@kingsleyweb/bun-security/lib/serve/challenge";
import { SecurityRefusalException } from "./security.exception";

/** A body that is JSON. */
type Problem = Record<string, unknown>;

/**
 * A route-stage challenge: a {@link SecurityRefusalException} whose
 * response is the challenge — the page's HTML, or the problem object with
 * its `challenge` descriptor — with the challenge's status.
 */
export class SecurityChallengeException extends SecurityRefusalException {
  /** The challenge's body: the page's HTML, or the problem object. */
  readonly #body: string | Problem;

  constructor(
    /** The decision that challenged the request. */
    decision: Decision,
    /** The challenge's body: the page's HTML, or the problem object. */
    body: string | Problem,
    /** Its status (`403`). */
    readonly challengeStatus: number,
    /**
     * Whether the challenge was already sent (the page, for a browser):
     * an exception filter must not answer again. `false` for the problem,
     * which Nest's layer (or the app's filter) sends.
     */
    readonly sent = false,
  ) {
    super(decision);
    this.#body = body;
  }

  /** The challenge, for Nest's exception layer. */
  override getResponse(): string | Problem {
    return this.#body;
  }

  /** The challenge's status. */
  override getStatus(): number {
    return this.challengeStatus;
  }
}

/**
 * The exception a route-stage refusal is answered with: the challenge,
 * for a `challenge` decision when the engine has a flow; otherwise
 * `refusal` unchanged. Sets the challenge's headers on `res`. A flow that
 * fails answers the plain refusal, logged.
 */
export async function challengeRefusal(
  security: Security<BunRequest>,
  req: BunRequest,
  res: BunResponse,
  refusal: SecurityRefusalException,
): Promise<SecurityRefusalException> {
  const decision = refusal.decision;
  const facts = stateOf(req.request)?.routeFacts;
  if (decision.action !== "challenge" || facts === undefined) return refusal;
  const pending = challengeResponse(
    security.challenge,
    decision,
    req.request,
    facts,
    createLogger({ name: "bun-security" }),
  );
  if (pending === undefined) return refusal;
  const answer = await pending;
  answer.headers.forEach((value, name) => {
    res.setHeader(name, value);
  });
  const text = await answer.text();
  const type = answer.headers.get("content-type") ?? "";
  if (type.includes("json")) {
    try {
      return new SecurityChallengeException(
        decision,
        JSON.parse(text) as Problem,
        answer.status,
      );
    } catch {
      return refusal;
    }
  }
  // A page: Nest's exception layer sends only JSON for an error (a string
  // response becomes `{ statusCode, message }`), so the page is sent here,
  // and the layer, seeing the answer sent, only ends it.
  void res.status(answer.status).send(text);
  return new SecurityChallengeException(decision, text, answer.status, true);
}
