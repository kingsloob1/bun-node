/**
 * Fixtures for the Azure driver's SAS and Microsoft Entra ID tests
 * (`azure-auth.test.ts`): SAS tokens minted for Azurite's development
 * account with the documented signing algorithm, unsigned JWTs with the
 * claims an `--oauth basic` Azurite checks, a scoped TLS exemption for that
 * Azurite's self-signed certificate, and the factory the conformance kit's
 * second process builds a bearer-token driver with (its options must be
 * plain data, so the credential is built here, not passed in).
 */
import { Buffer } from "node:buffer";
import { createHmac } from "node:crypto";
import type { AzureTokenCredential, CacheDriver } from "../../lib/index";
import { azureBlobDriver } from "../../lib/index";

/** The tenant in the minted tokens' issuer: any GUID passes Azurite's issuer-prefix check. */
const TENANT = "00000000-0000-0000-0000-000000000000";

/** The SAS version the tests sign with (2020-12-06 and later have the encryption-scope line). */
export const SAS_VERSION = "2022-11-02";

/** A time as a SAS wants it: ISO 8601, UTC, whole seconds. */
function sasTime(epochMs: number): string {
  return `${new Date(epochMs).toISOString().slice(0, 19)}Z`;
}

/** Base64 HMAC-SHA256 of `text` under the base64-decoded key. */
function hmac(key: string, text: string): string {
  return createHmac("sha256", Buffer.from(key, "base64"))
    .update(text, "utf8")
    .digest("base64");
}

/**
 * An account SAS ("Create an account SAS", Microsoft Learn, version
 * 2020-12-06 and later): the string to sign is the account, permissions,
 * services, resource types, start, expiry, IP, protocol, version and
 * encryption scope, each followed by a newline.
 */
export function mintAccountSas(options: {
  /** The account. */
  account: string;
  /** Its key, base64. */
  key: string;
  /** `sp`, e.g. `rwdl`. */
  permissions: string;
  /** `ss`; `b` by default. */
  services?: string;
  /** `srt`; `co` by default. */
  resourceTypes?: string;
  /** `se`, epoch ms; an hour from now by default. */
  expiry?: number;
  /** `st`, epoch ms; none by default. */
  start?: number;
}): string {
  const services = options.services ?? "b";
  const resourceTypes = options.resourceTypes ?? "co";
  const expiry = sasTime(options.expiry ?? Date.now() + 3_600_000);
  const start = options.start === undefined ? "" : sasTime(options.start);
  const protocol = "https,http";
  const toSign = `${[
    options.account,
    options.permissions,
    services,
    resourceTypes,
    start,
    expiry,
    "",
    protocol,
    SAS_VERSION,
    "",
  ].join("\n")}\n`;
  const query = new URLSearchParams({
    sv: SAS_VERSION,
    ss: services,
    srt: resourceTypes,
    sp: options.permissions,
    ...(start === "" ? {} : { st: start }),
    se: expiry,
    spr: protocol,
    sig: hmac(options.key, toSign),
  });
  return query.toString();
}

/**
 * A container service SAS ("Create a service SAS", Microsoft Learn, version
 * 2020-12-06 and later): permissions, start, expiry, the canonicalized
 * resource `/blob/<account>/<container>`, identifier, IP, protocol, version,
 * resource (`c`), snapshot time, encryption scope and the five response
 * headers, newline-joined.
 */
export function mintContainerSas(options: {
  /** The account. */
  account: string;
  /** Its key, base64. */
  key: string;
  /** The container. */
  container: string;
  /** `sp`, e.g. `rwdl`. */
  permissions: string;
  /** `se`, epoch ms; an hour from now by default. */
  expiry?: number;
}): string {
  const expiry = sasTime(options.expiry ?? Date.now() + 3_600_000);
  const protocol = "https,http";
  const toSign = [
    options.permissions,
    "",
    expiry,
    `/blob/${options.account}/${options.container}`,
    "",
    "",
    protocol,
    SAS_VERSION,
    "c",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
  ].join("\n");
  return new URLSearchParams({
    sv: SAS_VERSION,
    sp: options.permissions,
    se: expiry,
    spr: protocol,
    sr: "c",
    sig: hmac(options.key, toSign),
  }).toString();
}

/**
 * An unsigned JWT with the claims an `--oauth basic` Azurite checks
 * (`aud`, an `iss` under `https://sts.windows.net/`, `iat`, `nbf`, `exp`; it
 * does not check signatures). `lifetimeSeconds` may be negative, for an
 * expired one; `nonce` makes two tokens of one second differ.
 */
export function mintStorageJwt(
  lifetimeSeconds = 3600,
  nonce = crypto.randomUUID(),
): string {
  const now = Math.floor(Date.now() / 1000);
  const part = (value: object): string =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "none", typ: "JWT" })}.${part({
    aud: "https://storage.azure.com",
    iss: `https://sts.windows.net/${TENANT}/`,
    iat: now - 60,
    nbf: now - 60,
    exp: now + lifetimeSeconds,
    oid: nonce,
  })}.`;
}

/** A credential minting a fresh JWT on every `getToken`, counting the calls and the scopes asked for. */
export function mintingCredential(
  lifetimeSeconds = 3600,
): AzureTokenCredential & {
  /** The scopes of every call, in order. */
  calls: (string | string[])[];
} {
  const calls: (string | string[])[] = [];
  return {
    calls,
    getToken: async (scopes) => {
      calls.push(scopes);
      return await Promise.resolve({
        token: mintStorageJwt(lifetimeSeconds),
        expiresOnTimestamp: Date.now() + lifetimeSeconds * 1000,
      });
    },
  };
}

/** The `tls` option Bun's `fetch` takes. */
interface BunTlsInit extends RequestInit {
  /** Bun's TLS options for one request. */
  tls?: {
    /** Whether to check the server's certificate. */
    rejectUnauthorized?: boolean;
  };
}

/**
 * Lets `fetch` accept the self-signed certificate of one origin — the
 * `--oauth basic` Azurite's, run on 127.0.0.1 for these tests — and no other.
 * Answers the function that restores the previous `fetch`.
 */
export function trustOrigin(origin: string): () => void {
  const real = globalThis.fetch;
  globalThis.fetch = (async (
    input: Parameters<typeof fetch>[0],
    init?: RequestInit,
  ) => {
    const url = new URL(
      input instanceof Request ? input.url : input.toString(),
    );
    if (url.origin !== origin) {
      return await real(input, init);
    }
    const tls: BunTlsInit = { ...init, tls: { rejectUnauthorized: false } };
    return await real(input, tls);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = real;
  };
}

/** What the kit's second process builds a bearer-token driver from: plain data. */
export interface BearerFixtureOptions {
  /** The driver's url, with no key (the bearer Azurite's). */
  url: string;
  /** `credential` (a minting `AzureTokenCredential`) or `token` (a minting function). */
  mode: "credential" | "token";
  /** The blob-name prefix. */
  prefix: string;
  /** The origin whose self-signed certificate is accepted. */
  insecureOrigin: string;
}

/** The kit's second-process factory for the bearer modes. */
export function azureBearerTestDriver(
  options: BearerFixtureOptions,
): CacheDriver {
  trustOrigin(options.insecureOrigin);
  return azureBlobDriver({
    url: options.url,
    prefix: options.prefix,
    connection:
      options.mode === "credential"
        ? { credential: mintingCredential() }
        : { token: () => mintStorageJwt() },
  });
}
