/**
 * Challenges (layers.md L10.2): a provider-neutral interface. A provider
 * issues what the client must solve and verifies the answer on the server;
 * it never trusts the client alone.
 */

/** What a provider knows of the request it challenges or verifies. */
export interface ChallengeContext {
  /** The client's address, as the engine resolved it (`""` when there is none). */
  readonly client: string;
  /** The request's risk (its decision's `risk`): a provider may make the challenge harder with it. */
  readonly risk: number;
  /** The host the request was made to, without the port, for the hosted CAPTCHAs' hostname check. */
  readonly hostname: string;
}

/**
 * What the client must solve, as the challenge page and API clients see it.
 * A provider builds it; the page puts it under its strict CSP.
 */
export interface ChallengeDescriptor {
  /** The provider's id (`pow`, `turnstile`, `hcaptcha`, or one's own). */
  readonly provider: string;
  /** The form field the answer is posted in (`altcha`, `cf-turnstile-response`, `h-captcha-response`). */
  readonly field: string;
  /**
   * The widget's markup, placed in the page's form. No script to run here
   * (scripts go in {@link scripts} or {@link script}); a JSON data block
   * (`<script type="application/json">`) is fine, as it never runs.
   */
  readonly html: string;
  /** Script URLs the page loads (a hosted CAPTCHA's), allowed by its CSP. */
  readonly scripts?: readonly string[];
  /** An inline script the page runs (with its nonce): the proof of work's solver. */
  readonly script?: string;
  /** Origins the page's CSP allows beside `'self'`, by directive. */
  readonly origins?: {
    /** `frame-src` (a CAPTCHA's iframe). */
    readonly frame?: readonly string[];
    /** `connect-src`. */
    readonly connect?: readonly string[];
    /** `style-src`. */
    readonly style?: readonly string[];
  };
  /** What an API client needs to solve it without the page (the proof of work's challenge). */
  readonly data?: unknown;
}

/** A provider's verdict on an answer. */
export interface ChallengeVerdict {
  /** Whether the answer is good. */
  readonly ok: boolean;
  /** Why not, for logs (never sent to the client). */
  readonly reason?: string;
}

/**
 * A challenge provider (layers.md L10.2): issues what the client must
 * solve, and verifies the answer it posts back.
 */
export interface ChallengeProvider {
  /** Its id, for logs and the descriptor. */
  readonly id: string;
  /** The form field its answer is posted in. */
  readonly field: string;
  /** Builds what the client must solve. */
  issue: (
    context: ChallengeContext,
  ) => ChallengeDescriptor | Promise<ChallengeDescriptor>;
  /** Verifies the client's answer, from the descriptor's form field. */
  verify: (
    answer: string,
    context: ChallengeContext,
  ) => ChallengeVerdict | Promise<ChallengeVerdict>;
}
