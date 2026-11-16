/**
 * What every integration does with challenges (layers.md L10.2), in one
 * place: a `challenge` decision answered with the challenge flow's page or
 * problem, and an answer posted to the flow's path verified, its outcome
 * signalled to the engine (`challenge.passed`, `challenge.failed`, the
 * events a counted rule or the ladder's weights can name).
 */
import type { Logger } from "@kingsleyweb/bun-common";
import type { ChallengeFlow } from "../challenge/flow";
import { refuses } from "../engine/actions";
import type { Decision } from "../engine/decision";
import type { RequestFacts } from "../engine/facts";
import type { Security } from "../engine/security";
import { refusalResponse } from "./respond";

/** The event a failed answer signals. */
export const CHALLENGE_FAILED_EVENT = "challenge.failed";

/** The event a passed answer signals. */
export const CHALLENGE_PASSED_EVENT = "challenge.passed";

/**
 * Whether `request` is an answer to a challenge the flow should take: a
 * `POST` to its path from a client the engine admitted or challenged
 * (never one it blocked, banned or dropped).
 */
export function isChallengeAnswer(
  flow: ChallengeFlow | undefined,
  decision: Decision,
  request: Request,
): flow is ChallengeFlow {
  return (
    flow !== undefined &&
    (decision.action === "challenge" || !refuses(decision.action)) &&
    flow.answers(request)
  );
}

/**
 * The challenge for a `challenge` decision, or `undefined` when the
 * decision is not one or there is no flow. A flow that throws answers the
 * default refusal (`403` with the decision's code), logged.
 */
export function challengeResponse(
  flow: ChallengeFlow | undefined,
  decision: Decision,
  request: Request,
  facts: RequestFacts,
  logger: Logger,
): Promise<Response> | undefined {
  if (flow === undefined || decision.action !== "challenge") return undefined;
  const fallback = (error: unknown): Response => {
    logger.error(
      "bun-security: the challenge flow failed; sent the default refusal",
      { error },
    );
    return refusalResponse(decision, request);
  };
  try {
    return flow.respond(decision, request, facts).catch(fallback);
  } catch (error) {
    return Promise.resolve(fallback(error));
  }
}

/**
 * Reports an answered request's outcome to the engine, giving back its
 * in-flight slot; errors are logged, never thrown.
 */
export function completeQuietly<TRequest>(
  security: Security<TRequest>,
  facts: RequestFacts,
  decision: Decision,
  status: number,
  logger: Logger,
): void {
  const failed = (error: unknown) => {
    logger.error("bun-security: complete() failed", { error });
  };
  try {
    const hits = security.complete(facts, decision, { status });
    if (hits instanceof Promise) hits.catch(failed);
  } catch (error) {
    failed(error);
  }
}

/**
 * Verifies an answer through the flow and signals its outcome; the
 * response to send. Errors are logged: a flow that throws answers `400`.
 */
export async function answerChallenge<TRequest>(
  security: Security<TRequest>,
  flow: ChallengeFlow,
  request: Request,
  facts: RequestFacts,
  logger: Logger,
): Promise<Response> {
  let answered;
  try {
    answered = await flow.answer(request, facts);
  } catch (error) {
    logger.error("bun-security: the challenge flow failed on an answer", {
      error,
    });
    return new Response(null, {
      status: 400,
      headers: { "cache-control": "no-store" },
    });
  }
  if (!answered.passed) {
    logger.info("bun-security: a challenge answer was refused", {
      provider: flow.provider.id,
      reason: answered.reason,
      client: facts.client,
    });
  }
  try {
    await security.signal(
      facts,
      answered.passed ? CHALLENGE_PASSED_EVENT : CHALLENGE_FAILED_EVENT,
    );
  } catch (error) {
    logger.error("bun-security: signal() failed after a challenge answer", {
      error,
    });
  }
  return answered.response;
}
