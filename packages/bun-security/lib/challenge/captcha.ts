/**
 * Hosted CAPTCHAs (layers.md L10.2): Cloudflare Turnstile and hCaptcha, each
 * a few lines over `fetch`, no SDK. The widget yields a token; the server
 * posts `secret`, `response` and `remoteip` to the provider's verify
 * endpoint, and checks `success`, the `hostname` and, when set, the
 * `action`. Server-side verification is mandatory: the client is never
 * trusted alone. A network failure or a timeout fails the answer.
 */
import { ConfigError } from "@kingsleyweb/bun-common";
import type {
  ChallengeContext,
  ChallengeProvider,
  ChallengeVerdict,
} from "./types";

/** The `fetch` the adapters call: the global one, or a test's. */
export type VerifyFetch = (
  input: string,
  init: { method: string; body: URLSearchParams; signal: AbortSignal },
) => Promise<Response>;

/** Options for {@link turnstile} and {@link hcaptcha}. */
export interface CaptchaOptions {
  /** The widget's site key (public). */
  readonly siteKey: string;
  /** The verification secret (private). */
  readonly secret: string;
  /**
   * The hostnames a solved token may name. Default: the host the request
   * was made to.
   */
  readonly hostnames?: readonly string[];
  /** The action the widget was rendered with; a token for another is refused. Default: not checked. */
  readonly action?: string;
  /** The `fetch` to verify with. Default the global `fetch`. */
  readonly fetch?: VerifyFetch;
  /** How long a verification may take, in ms. Default `5000`. */
  readonly timeoutMs?: number;
  /** The verify endpoint, for a self-hosted or test one. Default the provider's. */
  readonly verifyUrl?: string;
}

/** What a provider's verify endpoint answers (the fields read). */
interface SiteVerify {
  /** Whether the token is good. */
  readonly success?: unknown;
  /** The hostname the widget was solved on. */
  readonly hostname?: unknown;
  /** The widget's action (Turnstile). */
  readonly action?: unknown;
  /** Why not. */
  readonly "error-codes"?: unknown;
}

/** One hosted CAPTCHA's shape. */
interface CaptchaKind {
  /** Its id. */
  readonly id: string;
  /** The form field its widget fills. */
  readonly field: string;
  /** Its verify endpoint. */
  readonly verifyUrl: string;
  /** Its script. */
  readonly script: string;
  /** The origins its widget needs. */
  readonly origins: {
    readonly frame: readonly string[];
    readonly connect: readonly string[];
    readonly style: readonly string[];
  };
  /** Its widget's markup. */
  readonly html: (siteKey: string, action: string | undefined) => string;
}

/** `text` escaped for an HTML attribute. */
function attribute(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;");
}

/** Builds a hosted CAPTCHA provider. */
function captcha(
  kind: CaptchaKind,
  options: CaptchaOptions,
): ChallengeProvider {
  for (const key of ["siteKey", "secret"] as const) {
    if (typeof options[key] !== "string" || options[key].length === 0) {
      throw new ConfigError(`${kind.id}(): ${key} is required`);
    }
  }
  const verifyUrl = options.verifyUrl ?? kind.verifyUrl;
  const timeoutMs = options.timeoutMs ?? 5000;
  return {
    id: kind.id,
    field: kind.field,
    issue: () => ({
      provider: kind.id,
      field: kind.field,
      html: kind.html(options.siteKey, options.action),
      scripts: [kind.script],
      origins: kind.origins,
      data: {
        siteKey: options.siteKey,
        field: kind.field,
        ...(options.action ? { action: options.action } : {}),
      },
    }),
    async verify(
      answer: string,
      context: ChallengeContext,
    ): Promise<ChallengeVerdict> {
      if (answer.length === 0 || answer.length > 4096) {
        return { ok: false, reason: "missing or oversized token" };
      }
      const body = new URLSearchParams({
        secret: options.secret,
        response: answer,
      });
      if (context.client) body.set("remoteip", context.client);
      if (kind.id === "hcaptcha") body.set("sitekey", options.siteKey);
      let result: SiteVerify;
      try {
        const verify: VerifyFetch =
          options.fetch ?? ((input, init) => fetch(input, init));
        const response = await verify(verifyUrl, {
          method: "POST",
          body,
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!response.ok)
          return {
            ok: false,
            reason: `verify endpoint answered ${response.status}`,
          };
        result = (await response.json()) as SiteVerify;
      } catch (error) {
        return {
          ok: false,
          reason: `verification failed: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
      if (result.success !== true) {
        return {
          ok: false,
          reason: `rejected: ${JSON.stringify(result["error-codes"] ?? [])}`,
        };
      }
      const hostnames = options.hostnames ?? [context.hostname];
      if (
        typeof result.hostname !== "string" ||
        !hostnames.includes(result.hostname)
      ) {
        return {
          ok: false,
          reason: `solved on another host: ${String(result.hostname)}`,
        };
      }
      if (options.action !== undefined && result.action !== options.action) {
        return {
          ok: false,
          reason: `for another action: ${String(result.action)}`,
        };
      }
      return { ok: true };
    },
  };
}

/**
 * Cloudflare Turnstile. Its tokens are single use and valid for 300 s;
 * the verify call is what enforces that.
 */
export function turnstile(options: CaptchaOptions): ChallengeProvider {
  return captcha(
    {
      id: "turnstile",
      field: "cf-turnstile-response",
      verifyUrl: "https://challenges.cloudflare.com/turnstile/v0/siteverify",
      script: "https://challenges.cloudflare.com/turnstile/v0/api.js",
      origins: {
        frame: ["https://challenges.cloudflare.com"],
        connect: ["https://challenges.cloudflare.com"],
        style: [],
      },
      html: (siteKey, action) =>
        `<div class="cf-turnstile" data-sitekey="${attribute(siteKey)}"${action ? ` data-action="${attribute(action)}"` : ""} data-callback="bunSecuritySolved"></div>`,
    },
    options,
  );
}

/** hCaptcha. */
export function hcaptcha(options: CaptchaOptions): ChallengeProvider {
  return captcha(
    {
      id: "hcaptcha",
      field: "h-captcha-response",
      verifyUrl: "https://api.hcaptcha.com/siteverify",
      script: "https://js.hcaptcha.com/1/api.js",
      origins: {
        frame: ["https://hcaptcha.com", "https://*.hcaptcha.com"],
        connect: ["https://hcaptcha.com", "https://*.hcaptcha.com"],
        style: ["https://hcaptcha.com", "https://*.hcaptcha.com"],
      },
      html: (siteKey) =>
        `<div class="h-captcha" data-sitekey="${attribute(siteKey)}" data-callback="bunSecuritySolved"></div>`,
    },
    options,
  );
}
