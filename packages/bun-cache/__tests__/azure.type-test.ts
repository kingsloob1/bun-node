/**
 * Type-level assertions for the Azure driver's authorization options:
 * `AzureTokenCredential` is structural, so this package never depends on
 * `@azure/core-auth` or `@azure/identity` — and a real credential must still
 * satisfy it, or `credential: new DefaultAzureCredential()` stops
 * compiling. The declarations below are copied from `@azure/core-auth`
 * 1.10 (`TokenCredential`, `GetTokenOptions`, `AccessToken`) and
 * `@azure/abort-controller` 2 (`AbortSignalLike`), which `@azure/identity`'s
 * credentials implement. The `@ts-expect-error`s are the negative controls.
 *
 * Checked by `bun run check`, not by `bun test`.
 */
import type {
  AzureBlobDriverOptions,
  AzureTokenCredential,
} from "../lib/index";
import { azureBlobDriver } from "../lib/index";

/* eslint-disable @typescript-eslint/method-signature-style, @typescript-eslint/no-explicit-any -- copied as published */
/** `@azure/abort-controller`'s `AbortSignalLike`. */
interface AbortSignalLike {
  /** Whether it was aborted. */
  readonly aborted: boolean;
  /** Why. */
  readonly reason?: any;
  /** Adds an abort listener. */
  addEventListener(
    type: "abort",
    listener: (this: AbortSignalLike, ev: any) => any,
    options?: any,
  ): void;
  /** Removes one. */
  removeEventListener(
    type: "abort",
    listener: (this: AbortSignalLike, ev: any) => any,
    options?: any,
  ): void;
  /** Throws when aborted. */
  throwIfAborted(): void;
}
/* eslint-enable @typescript-eslint/method-signature-style, @typescript-eslint/no-explicit-any */

/** `@azure/core-auth`'s `GetTokenOptions`. */
interface GetTokenOptions {
  /** Aborts the request. */
  abortSignal?: AbortSignalLike;
  /** Per-request options. */
  requestOptions?: {
    /** A timeout, ms. */
    timeout?: number;
  };
  /** Tracing. */
  tracingOptions?: {
    /** The tracing context. */
    tracingContext?: unknown;
  };
  /** CAE claims. */
  claims?: string;
  /** Continuous access evaluation. */
  enableCae?: boolean;
  /** The tenant. */
  tenantId?: string;
  /** Proof-of-possession. */
  proofOfPossessionOptions?: {
    /** The nonce. */
    nonce: string;
    /** The method. */
    resourceRequestMethod: string;
    /** The URL. */
    resourceRequestUrl: string;
  };
}

/** `@azure/core-auth`'s `AccessToken`. */
interface AccessToken {
  /** The token. */
  token: string;
  /** Expiry, epoch ms. */
  expiresOnTimestamp: number;
  /** When to refresh, epoch ms. */
  refreshAfterTimestamp?: number;
  /** The token's type. */
  tokenType?: "Bearer" | "pop";
}

/** `@azure/core-auth`'s `TokenCredential`, as `@azure/identity`'s classes implement it (a method). */
declare class DefaultAzureCredential {
  getToken(
    scopes: string | string[],
    options?: GetTokenOptions,
  ): Promise<AccessToken>;
}

/** A credential typed as the interface, whose answer may be `null`. */
declare const tokenCredential: {
  getToken: (
    scopes: string | string[],
    options?: GetTokenOptions,
  ) => Promise<AccessToken | null>;
};

// Real credentials are AzureTokenCredentials, and the option takes them.
export const _identity: AzureTokenCredential = new DefaultAzureCredential();
export const _interface: AzureTokenCredential = tokenCredential;
export const _driver = azureBlobDriver({
  url: "azure://acct.blob.core.windows.net/cache",
  connection: { credential: new DefaultAzureCredential() },
});
export const _token: AzureBlobDriverOptions = {
  url: "azure://acct.blob.core.windows.net/cache",
  connection: { token: async () => await Promise.resolve("eyJ…") },
};
export const _sas: AzureBlobDriverOptions = {
  connection: {
    endpoint: "https://acct.blob.core.windows.net",
    container: "cache",
    sasToken: "sv=2022-11-02&sp=rwdl&sig=…",
  },
};

export const _wrongAnswer: AzureTokenCredential = {
  // @ts-expect-error — a credential answers { token, expiresOnTimestamp }, not a bare string.
  getToken: async () => await Promise.resolve("eyJ…"),
};

export const _wrongToken: AzureBlobDriverOptions = {
  // @ts-expect-error — a token function answers a string, not an AccessToken.
  connection: { token: async () => await Promise.resolve({ token: "x" }) },
};
