/**
 * The challenge flow (layers.md L10.2): what turns a `challenge` decision
 * into a challenge, and a passed one into clearance.
 *
 * ```ts
 * const security = createSecurity({
 *   policy,
 *   challenge: challenges({ provider: powChallenge({ secret }), secret: clearanceSecret }),
 * });
 * ```
 *
 * - **`respond`** answers a challenged request: the challenge page for a
 *   browser (HTML first in `Accept`), a `403` problem with the challenge
 *   for an API client (`code: "challenge_required"`, the descriptor's
 *   `data`, and where to post the answer).
 * - **`answer`** takes the answer posted to {@link ChallengeFlow.path}:
 *   verified by the provider, it mints a clearance (a cookie, and for an API
 *   client the token in the body) and sends a browser back where it was
 *   going; refused, it challenges again.
 * - **`cleared`** says whether a request's clearance (cookie or
 *   `x-security-clearance` header) is valid for its client: the engine reads
 *   it to let a cleared client past challenges (never past blocks or bans).
 */
import { ConfigError, serializeCookie } from "@kingsleyweb/bun-common";
import type { Decision } from "../engine/decision";
import type { RequestFacts } from "../engine/facts";
import { clearanceRefusal, clearanceToken, mintClearance } from "./clearance";
import { challengePage } from "./page";
import type { ChallengePageOptions } from "./page";
import type {
  ChallengeContext,
  ChallengeDescriptor,
  ChallengeProvider,
} from "./types";

/** The answer endpoint's default path. */
export const DEFAULT_CHALLENGE_PATH = "/__bun-security/challenge";

/** The clearance cookie's default name (`__Host-` before it over HTTPS). */
export const DEFAULT_CLEARANCE_COOKIE = "bun-security-clearance";

/** The header an API client sends its clearance in. */
export const DEFAULT_CLEARANCE_HEADER = "x-security-clearance";

/** The most of an answer's body read. */
const MAX_ANSWER_BODY = 16_384;

/** Options for {@link challenges}. */
export interface ChallengesOptions {
  /** Who issues and verifies challenges: `powChallenge()`, `turnstile()`, `hcaptcha()` or one's own. */
  readonly provider: ChallengeProvider;
  /** The clearance signing key: at least 32 characters, the same across instances. */
  readonly secret: string;
  /** How long a clearance lasts, in seconds. Default `1800` (30 minutes). */
  readonly ttl?: number;
  /** Where answers are posted. Default `/__bun-security/challenge`. */
  readonly path?: string;
  /** The clearance cookie's name. Default `bun-security-clearance` (`__Host-` before it over HTTPS). */
  readonly cookie?: string;
  /** The header an API client sends its clearance in. Default `x-security-clearance`. */
  readonly header?: string;
  /** The page's title. Default `"Checking your browser"`. */
  readonly title?: string;
  /**
   * Renders the challenge page in place of the built-in one (layers.md
   * L10.2's app hook): given the provider's descriptor and where the form
   * posts. The page must keep the descriptor's markup inside a form that
   * posts its field and `return` to `options.action`, and set its own CSP
   * (`challengeCsp` builds the built-in one). Default `challengePage`.
   */
  readonly page?: (
    descriptor: ChallengeDescriptor,
    options: ChallengePageOptions,
  ) => Response | Promise<Response>;
  /** The clock, epoch ms. Default `Date.now`. */
  readonly now?: () => number;
}

/** What {@link ChallengeFlow.answer} did. */
export interface ChallengeAnswer {
  /** The response to send. */
  readonly response: Response;
  /** Whether the challenge was passed (a clearance was minted). */
  readonly passed: boolean;
  /** Why it was not, for logs. */
  readonly reason?: string;
}

/** The challenge flow {@link challenges} builds. */
export interface ChallengeFlow {
  /** The provider. */
  readonly provider: ChallengeProvider;
  /** Where answers are posted. */
  readonly path: string;
  /** Whether a request carries a clearance valid for its client. */
  readonly cleared: (facts: RequestFacts) => boolean;
  /** The challenge for a request the engine challenged. */
  readonly respond: (
    decision: Decision,
    request: Request,
    facts: RequestFacts,
  ) => Promise<Response>;
  /** Whether `request` is an answer (a `POST` to {@link path}). */
  readonly answers: (request: Request) => boolean;
  /** Verifies a posted answer; see {@link ChallengeAnswer}. */
  readonly answer: (
    request: Request,
    facts: RequestFacts,
  ) => Promise<ChallengeAnswer>;
}

/** Whether the client asked for HTML ahead of JSON (a browser navigating). */
function wantsHtml(accept: string | null): boolean {
  if (!accept) return false;
  const html = accept.indexOf("text/html");
  if (html === -1) return false;
  const json = accept.search(/application\/(?:[\w.+-]+\+)?json/);
  return json === -1 || html < json;
}

/** A path on this origin to return to: `/…`, never `//host` or a scheme. */
function safeReturn(value: unknown): string {
  return typeof value === "string" &&
    value.startsWith("/") &&
    !value.startsWith("//") &&
    !value.startsWith("/\\") &&
    value.length <= 2048
    ? value
    : "/";
}

/**
 * The challenge flow, for `createSecurity`'s `challenge` option. Throws a
 * `ConfigError` for a short secret or a bad `ttl` or `path`.
 */
export function challenges(options: ChallengesOptions): ChallengeFlow {
  const { provider, secret } = options;
  if (typeof secret !== "string" || secret.length < 32) {
    throw new ConfigError(
      "challenges(): secret must be at least 32 characters",
    );
  }
  const ttl = options.ttl ?? 1800;
  if (!Number.isSafeInteger(ttl) || ttl < 60) {
    throw new ConfigError(
      `challenges(): ttl must be a whole number of seconds, at least 60; got ${String(ttl)}`,
    );
  }
  const path = options.path ?? DEFAULT_CHALLENGE_PATH;
  if (!/^\/[\w./-]{1,256}$/.test(path)) {
    throw new ConfigError(
      `challenges(): path must be a path ("/__bun-security/challenge"); got ${JSON.stringify(path)}`,
    );
  }
  const cookie = options.cookie ?? DEFAULT_CLEARANCE_COOKIE;
  const header = (options.header ?? DEFAULT_CLEARANCE_HEADER).toLowerCase();
  const title = options.title ?? "Checking your browser";
  const now = options.now ?? Date.now;
  const page = options.page ?? challengePage;

  /** The context a provider sees. */
  const contextOf = (
    request: Request,
    facts: RequestFacts,
    risk: number,
  ): ChallengeContext => ({
    client: facts.client,
    risk,
    hostname: new URL(request.url).hostname,
  });

  /** Whether the request arrived over HTTPS (its URL as the server saw it). */
  const secure = (request: Request) => request.url.startsWith("https:");

  /** A challenge response (page or problem) for `request`. */
  const challengeResponse = async (
    request: Request,
    facts: RequestFacts,
    risk: number,
    returnTo: string,
    notice: string | undefined,
    code: string,
  ): Promise<Response> => {
    const descriptor = await provider.issue(contextOf(request, facts, risk));
    if (wantsHtml(request.headers.get("accept"))) {
      return page(descriptor, {
        action: path,
        returnTo,
        title,
        status: 403,
        ...(notice ? { notice } : {}),
      });
    }
    return new Response(
      JSON.stringify({
        type: "about:blank",
        title: "Forbidden",
        status: 403,
        code,
        challenge: {
          provider: descriptor.provider,
          field: descriptor.field,
          path,
          data: descriptor.data ?? null,
        },
      }),
      {
        status: 403,
        headers: {
          "content-type": "application/problem+json",
          "cache-control": "no-store",
        },
      },
    );
  };

  /** The answer and return path of a posted body (form or JSON). */
  const readAnswer = async (
    request: Request,
    field: string,
  ): Promise<{ answer: string; returnTo: string } | undefined> => {
    const length = Number(request.headers.get("content-length") ?? "0");
    if (length > MAX_ANSWER_BODY) return undefined;
    const text = await request.text();
    if (text.length > MAX_ANSWER_BODY) return undefined;
    const type = request.headers.get("content-type") ?? "";
    if (type.includes("application/json")) {
      try {
        const body = JSON.parse(text) as Record<string, unknown>;
        return {
          answer: typeof body.answer === "string" ? body.answer : "",
          returnTo: safeReturn(body.return),
        };
      } catch {
        return undefined;
      }
    }
    const form = new URLSearchParams(text);
    return {
      answer: form.get(field) ?? form.get("answer") ?? "",
      returnTo: safeReturn(form.get("return")),
    };
  };

  return {
    provider,
    path,
    cleared(facts) {
      const token =
        clearanceToken(facts.headers, `__Host-${cookie}`, header) ??
        clearanceToken(facts.headers, cookie, header);
      if (token === undefined) return false;
      return (
        clearanceRefusal(
          secret,
          token,
          {
            client: facts.client,
            userAgent: facts.headers["user-agent"] ?? "",
          },
          now(),
        ) === undefined
      );
    },
    respond(decision, request, facts) {
      const url = new URL(request.url);
      const returnTo =
        request.method === "GET" || request.method === "HEAD"
          ? `${url.pathname}${url.search}`
          : "/";
      return challengeResponse(
        request,
        facts,
        decision.risk,
        safeReturn(returnTo),
        undefined,
        "challenge_required",
      );
    },
    answers(request) {
      return (
        request.method === "POST" && new URL(request.url).pathname === path
      );
    },
    async answer(request, facts) {
      const read = await readAnswer(request, provider.field);
      const context = contextOf(request, facts, 0);
      const verdict =
        read === undefined
          ? { ok: false, reason: "unreadable answer" }
          : await provider.verify(read.answer, context);
      const returnTo = read?.returnTo ?? "/";
      if (!verdict.ok) {
        return {
          response: await challengeResponse(
            request,
            facts,
            1,
            returnTo,
            "That did not work. Please try again.",
            "challenge_failed",
          ),
          passed: false,
          ...(verdict.reason ? { reason: verdict.reason } : {}),
        };
      }
      const expiresAt = now() + ttl * 1000;
      const token = mintClearance(
        secret,
        {
          client: facts.client,
          userAgent: request.headers.get("user-agent") ?? "",
        },
        expiresAt,
      );
      const https = secure(request);
      const setCookie = serializeCookie(
        https ? `__Host-${cookie}` : cookie,
        token,
        {
          path: "/",
          httpOnly: true,
          secure: https,
          sameSite: "lax",
          maxAge: ttl,
        },
      );
      const json = (request.headers.get("content-type") ?? "").includes(
        "application/json",
      );
      const response = json
        ? new Response(
            JSON.stringify({
              clearance: token,
              header,
              expiresAt: new Date(expiresAt).toISOString(),
            }),
            {
              status: 200,
              headers: {
                "content-type": "application/json",
                "cache-control": "no-store",
                "set-cookie": setCookie,
              },
            },
          )
        : new Response(null, {
            status: 303,
            headers: {
              location: returnTo,
              "cache-control": "no-store",
              "set-cookie": setCookie,
            },
          });
      return { response, passed: true };
    },
  };
}
