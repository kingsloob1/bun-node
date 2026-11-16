/**
 * Helpers of the sensitive endpoints' tests: an engine with a secret on a
 * fake clock, and a sign-in request's facts.
 */
import { createSecurity } from "../../lib/index";
import type {
  CreateSecurityOptions,
  Decision,
  RequestFacts,
  Security,
  SecurityPolicy,
} from "../../lib/index";
import { facts, fakeClock } from "../helpers";
import type { FakeClock } from "../helpers";

/** The secret the tests key with. */
export const SECRET = "a-test-secret-of-at-least-thirty-two-bytes";

/** An engine with {@link SECRET}, quiet, on `clock`. */
export function engine(
  policy: SecurityPolicy = {},
  clock: FakeClock = fakeClock(),
  options: Partial<CreateSecurityOptions> = {},
): Security {
  return createSecurity({
    policy,
    secret: SECRET,
    now: clock.now,
    logger: () => {},
    ...options,
  });
}

/** The facts of `POST /login` attempting `username` from `client`, with an optional `cookie` header. */
export function login(
  username: string | undefined,
  client = "203.0.113.10",
  cookie?: string,
): RequestFacts {
  return facts({
    method: "POST",
    path: "/login",
    rawPath: "/login",
    routeKey: "POST /login",
    profile: "login",
    client,
    ...(cookie === undefined ? {} : { headers: { cookie } }),
    ...(username === undefined ? {} : { identity: { username } }),
  });
}

/** `evaluate()`, awaited. */
export async function decide(
  security: Security,
  request: RequestFacts,
): Promise<Decision> {
  return await security.evaluate(request);
}

/** One failed attempt: the request decided, then its failure signalled. */
export async function fail(
  security: Security,
  request: RequestFacts,
): Promise<Decision> {
  const decision = await security.evaluate(request);
  await security.signal(request, "auth.failure");
  return decision;
}

export { fakeClock };
