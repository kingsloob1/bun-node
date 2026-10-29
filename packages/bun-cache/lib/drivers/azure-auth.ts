/**
 * Microsoft Entra ID bearer tokens for the Azure Blob Storage driver
 * (`azureBlobDriver`): a `credential` (`AzureTokenCredential`, the shape of
 * `@azure/core-auth`'s `TokenCredential`, so `new DefaultAzureCredential()`
 * from `@azure/identity` plugs in with no dependency here), or a raw `token`
 * the application refreshes itself. `azure-sign.ts` sends what these answer
 * as `Authorization: Bearer <token>`, and asks once more when the service
 * refuses one.
 */

/** The scope every token is asked for: Azure Storage's, for Microsoft Entra ID. */
export const AZURE_STORAGE_SCOPE = "https://storage.azure.com/.default";

/**
 * How long before its `expiresOnTimestamp` a cached credential token is
 * replaced: 5 minutes, Entra ID's usual clock-skew allowance. A token that
 * lives less than twice that is replaced at half its life instead.
 */
export const TOKEN_REFRESH_MARGIN_MS = 5 * 60_000;

/**
 * A Microsoft Entra ID credential, structurally: `@azure/core-auth`'s
 * `TokenCredential`, which every `@azure/identity` credential implements
 * (`DefaultAzureCredential`, `ManagedIdentityCredential`,
 * `ClientSecretCredential`, …). The driver asks it for
 * `https://storage.azure.com/.default`.
 */
export interface AzureTokenCredential {
  /**
   * Answers an access token for `scopes`, or `null` when none could be had
   * (the driver then fails the request, naming the credential).
   */
  getToken: (
    /**
     * The scope or scopes; the driver passes `https://storage.azure.com/.default`
     * and no options (so a credential's own options type, `GetTokenOptions`
     * or any other, fits).
     */
    scopes: string | string[],
  ) => Promise<{
    /** The access token, without the `Bearer ` prefix. */
    token: string;
    /** When the token expires, epoch ms. */
    expiresOnTimestamp: number;
    /** When the credential suggests asking again, epoch ms (newer `@azure/core-auth`); earlier than the margin wins. */
    refreshAfterTimestamp?: number;
  } | null>;
}

/** Where the bearer tokens a request sends come from. Internal to the driver. */
export interface AzureBearerSource {
  /** The token to send now. */
  token: () => Promise<string>;
  /**
   * Called when the service refused `rejected` (401, or Azurite's 403
   * `AuthenticationFailed`): a different token to resend the request with
   * once, or `undefined` when there is none.
   */
  renew: (
    /** The token that was refused. */ rejected: string,
  ) => Promise<string | undefined>;
}

/** A cached credential token. */
interface CachedToken {
  /** The token. */
  token: string;
  /** When it expires, epoch ms. */
  expiresAt: number;
  /** When to replace it, epoch ms. */
  refreshAt: number;
}

/** Throws unless `token` is a bare, non-empty token. */
function checkToken(
  /** The token. */ token: unknown,
  /** Who answered it, for the message. */ from: string,
): string {
  if (typeof token !== "string" || token.trim() === "") {
    throw new TypeError(`azureBlobDriver: ${from} answered no token`);
  }
  if (/^bearer\s/i.test(token)) {
    throw new TypeError(
      `azureBlobDriver: ${from} must answer the bare token, without "Bearer "`,
    );
  }
  return token;
}

/**
 * Tokens from an `AzureTokenCredential`: cached until shortly before they
 * expire ({@link TOKEN_REFRESH_MARGIN_MS}, or a `refreshAfterTimestamp`
 * the credential gives), one `getToken` at a time however many requests
 * need one (single-flight), and asked again when the service refuses the
 * cached one. A refresh that fails while the cached token is still valid
 * keeps it (the next request tries again).
 */
export class CredentialTokenSource implements AzureBearerSource {
  /** The credential. */
  readonly #credential: AzureTokenCredential;

  /** The clock, epoch ms. */
  readonly #now: () => number;

  /** The token last answered, until it is replaced. */
  #cached: CachedToken | undefined;

  /** The `getToken` in flight, shared by every caller. */
  #pending: Promise<CachedToken> | undefined;

  constructor(
    /** The credential. */ credential: AzureTokenCredential,
    /** The clock, epoch ms; `Date.now` by default. */ now: () => number = Date.now,
  ) {
    this.#credential = credential;
    this.#now = now;
  }

  async token(): Promise<string> {
    const cached = this.#cached;
    if (cached !== undefined && this.#now() < cached.refreshAt) {
      return cached.token;
    }
    try {
      return (await this.#refresh()).token;
    } catch (error) {
      if (cached !== undefined && this.#now() < cached.expiresAt) {
        return cached.token;
      }
      throw error;
    }
  }

  async renew(rejected: string): Promise<string | undefined> {
    const cached = this.#cached;
    if (
      cached !== undefined &&
      cached.token !== rejected &&
      this.#now() < cached.expiresAt
    ) {
      // Another request already replaced the refused token.
      return cached.token;
    }
    if (cached?.token === rejected) {
      this.#cached = undefined;
    }
    const fresh = await this.#refresh();
    return fresh.token === rejected ? undefined : fresh.token;
  }

  /** One `getToken`, shared by every caller while it runs. */
  #refresh(): Promise<CachedToken> {
    this.#pending ??= this.#fetch().finally(() => {
      this.#pending = undefined;
    });
    return this.#pending;
  }

  /** Asks the credential and caches the answer. */
  async #fetch(): Promise<CachedToken> {
    const answer = await this.#credential.getToken(AZURE_STORAGE_SCOPE);
    if (answer === null || answer === undefined) {
      throw new Error(
        `azureBlobDriver: the credential answered no token for ${AZURE_STORAGE_SCOPE}`,
      );
    }
    const token = checkToken(answer.token, "the credential");
    const expiresAt = answer.expiresOnTimestamp;
    if (!Number.isFinite(expiresAt)) {
      throw new TypeError(
        "azureBlobDriver: the credential answered a token with no expiresOnTimestamp",
      );
    }
    const now = this.#now();
    const margin = Math.min(TOKEN_REFRESH_MARGIN_MS, (expiresAt - now) / 2);
    const suggested = answer.refreshAfterTimestamp;
    const cached: CachedToken = {
      token,
      expiresAt,
      refreshAt: Math.min(
        expiresAt - Math.max(0, margin),
        typeof suggested === "number" && Number.isFinite(suggested)
          ? suggested
          : Infinity,
      ),
    };
    this.#cached = cached;
    return cached;
  }
}

/**
 * A raw token: a string sent as is, or a function asked on every request —
 * the application owns its caching and refresh. When the service refuses
 * a token, the function is asked once more, and the request resent only
 * if it answers a different one.
 */
export class StaticTokenSource implements AzureBearerSource {
  /** The token or its function. */
  readonly #token: string | (() => string | Promise<string>);

  constructor(
    /** The token, or a function answering it. */ token:
      string | (() => string | Promise<string>),
  ) {
    if (typeof token === "string") {
      checkToken(token, "token");
    }
    this.#token = token;
  }

  async token(): Promise<string> {
    return typeof this.#token === "string"
      ? this.#token
      : checkToken(await this.#token(), "the token function");
  }

  async renew(rejected: string): Promise<string | undefined> {
    if (typeof this.#token === "string") {
      return undefined;
    }
    const next = await this.token();
    return next === rejected ? undefined : next;
  }
}
