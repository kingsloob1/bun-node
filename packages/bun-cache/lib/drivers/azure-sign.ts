/**
 * Request authorization for the Azure Blob Storage driver
 * (`azureBlobDriver`), over `fetch`: Bun has no Azure client, and the
 * driver takes no Azure SDK (the dependency policy). Three ways, one per
 * driver:
 *
 * - **Shared Key**: the string to sign is the Blob service's for version
 *   2009-09-19 and later ("Authorize with Shared Key", Microsoft Learn): the
 *   verb, eleven standard headers (empty when absent; `Content-Length` empty
 *   when zero), the `x-ms-*` headers canonicalized, and the canonicalized
 *   resource — `/<account><path>`, then each query parameter as
 *   `\n<name>:<value>`, names lower-cased and sorted, values decoded.
 *   Against a path-style endpoint (Azurite,
 *   `http://127.0.0.1:10000/<account>`) the account appears twice in the
 *   resource, as the docs say it must.
 * - **A SAS**: its query is appended, as given, to every request's own
 *   query; nothing is signed here.
 * - **A bearer token** (Microsoft Entra ID, `azure-auth.ts`):
 *   `Authorization: Bearer <token>`, which needs `x-ms-version` 2017-11-09
 *   or later ({@link AZURE_API_VERSION} is). A request the service refuses
 *   as unauthenticated (401, or Azurite's 403 `AuthenticationFailed`) is
 *   resent once with a renewed token, when there is one: the refusal means
 *   nothing was applied, so the resend cannot apply a write twice.
 */
import { Buffer } from "node:buffer";
import type { AzureBearerSource } from "./azure-auth";

/** The Blob service REST version every request asks for (`x-ms-version`); Azurite 3.37.0 accepts it (measured). Bearer tokens need 2017-11-09 or later. */
export const AZURE_API_VERSION = "2025-01-05";

/** How a request is authorized: one of Shared Key, a SAS or a bearer token. */
export type AzureAuthorization =
  | {
      /** Shared Key: every request signed with the account key. */
      type: "shared-key";
      /** The storage account's name. */
      account: string;
      /** The account key, base64, as the portal shows it. */
      key: string;
    }
  | {
      /** A shared access signature, appended to every request's query. */
      type: "sas";
      /** The SAS query, with no leading `?`, exactly as given (still percent-encoded). */
      query: string;
    }
  | {
      /** A Microsoft Entra ID bearer token on every request. */
      type: "bearer";
      /** Where the tokens come from. */
      source: AzureBearerSource;
    };

/** The blob container a request goes to, and how it is authorized. */
export interface AzureSigningTarget {
  /**
   * The blob endpoint, `scheme://host[:port][/path]`, with no trailing `/`:
   * `https://<account>.blob.core.windows.net` on Azure, or a path-style one
   * such as Azurite's `http://127.0.0.1:10000/devstoreaccount1`.
   */
  endpoint: string;
  /** The blob container. */
  container: string;
  /** How every request is authorized. */
  auth: AzureAuthorization;
}

/** The account and key a Shared Key signature is made with. */
export interface AzureSharedKey {
  /** The storage account's name. */
  account: string;
  /** The account key, base64, as the portal shows it. */
  key: string;
}

/** One request to sign. */
export interface AzureSignInput {
  /** The HTTP method. */
  method: string;
  /** The request's URL, its path already encoded the way {@link azureEncode} encodes it. */
  url: URL;
  /** Headers to send (any case): the standard ones in the string to sign are read from here, and every `x-ms-*` one is signed. */
  headers?: Record<string, string>;
  /** The body's length in bytes; `0` (or absent) signs an empty `Content-Length`. */
  contentLength?: number;
  /** The signing time; now by default. For tests. */
  date?: Date;
}

/** The standard headers in the string to sign, in its order (`Content-Length` is handled apart). */
const STANDARD_HEADERS = [
  "content-encoding",
  "content-language",
  "content-length",
  "content-md5",
  "content-type",
  "date",
  "if-modified-since",
  "if-match",
  "if-none-match",
  "if-unmodified-since",
  "range",
] as const;

/**
 * URI-encodes one path segment: every byte except the unreserved
 * `A-Z a-z 0-9 - _ . ~` as `%XX`, upper-case hex (`encodeURIComponent`
 * leaves `! ' ( ) *` alone). The signed resource is the path exactly as sent,
 * so this only has to be consistent; it is RFC 3986's strict form.
 */
export function azureEncode(text: string): string {
  return encodeURIComponent(text).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** A header value as the string to sign wants it: trimmed, linear whitespace one space. */
function canonicalValue(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

/** The canonicalized resource: `/<account><path>`, then the query, decoded, names lower-cased and sorted, several values sorted and comma-joined. */
export function canonicalizedResource(account: string, url: URL): string {
  const params = new Map<string, string[]>();
  for (const [name, value] of url.searchParams) {
    const key = name.toLowerCase();
    params.set(key, [...(params.get(key) ?? []), value]);
  }
  const names = [...params.keys()].sort();
  return `/${account}${url.pathname}${names
    .map((name) => `\n${name}:${params.get(name)!.sort().join(",")}`)
    .join("")}`;
}

/** The string to sign for a request whose headers already hold `x-ms-date` and `x-ms-version`. */
export function azureStringToSign(
  /** The account the resource belongs to. */ account: string,
  /** The request. */ input: Pick<
    AzureSignInput,
    "method" | "url" | "headers" | "contentLength"
  >,
): string {
  const headers = new Map<string, string>();
  for (const [name, value] of Object.entries(input.headers ?? {})) {
    headers.set(name.toLowerCase(), canonicalValue(value));
  }
  const standard = STANDARD_HEADERS.map((name) =>
    name === "content-length"
      ? input.contentLength === undefined || input.contentLength === 0
        ? ""
        : String(input.contentLength)
      : (headers.get(name) ?? ""),
  );
  const canonicalHeaders = [...headers.keys()]
    .filter((name) => name.startsWith("x-ms-"))
    .sort()
    .map((name) => `${name}:${headers.get(name)}\n`)
    .join("");
  return [
    input.method.toUpperCase(),
    ...standard,
    `${canonicalHeaders}${canonicalizedResource(account, input.url)}`,
  ].join("\n");
}

/**
 * Signs a request: answers the headers to send — those given, plus
 * `x-ms-date`, `x-ms-version` (unless given) and `authorization`
 * (`SharedKey <account>:<base64 HMAC-SHA256>`).
 */
export function signAzureRequest(
  /** The account and its key. */ target: AzureSharedKey,
  /** The request. */ input: AzureSignInput,
): Record<string, string> {
  const headers = baseHeaders(input.headers, input.date);
  const signer = new Bun.CryptoHasher(
    "sha256",
    Buffer.from(target.key, "base64"),
  );
  signer.update(azureStringToSign(target.account, { ...input, headers }));
  return {
    ...headers,
    authorization: `SharedKey ${target.account}:${signer.digest("base64")}`,
  };
}

/** The headers every request sends: those given, lower-cased, plus `x-ms-date` and `x-ms-version` (unless given). */
function baseHeaders(
  /** The caller's headers, any case. */ given: Record<string, string> = {},
  /** The request time; now by default. */ date: Date = new Date(),
): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(given)) {
    headers[name.toLowerCase()] = value;
  }
  headers["x-ms-date"] = date.toUTCString();
  headers["x-ms-version"] ??= AZURE_API_VERSION;
  return headers;
}

/** Appends a SAS query (no leading `?`, still encoded) to a URL's own query, as given. */
export function appendSas(
  /** The request's URL. */ url: URL,
  /** The SAS query. */ sas: string,
): void {
  url.search = url.search === "" ? `?${sas}` : `${url.search}&${sas}`;
}

/** Whether the service refused a request as unauthenticated: 401, or the 403 `AuthenticationFailed` Azurite answers for a bad bearer token. */
export function isTokenRefused(/** The answer. */ response: Response): boolean {
  return (
    response.status === 401 ||
    (response.status === 403 &&
      response.headers.get("x-ms-error-code") === "AuthenticationFailed")
  );
}

/** The URL of one blob (or, with `blob` empty, of the container), its path encoded, with an optional query. */
export function azureBlobUrl(
  /** Where. */ target: Pick<AzureSigningTarget, "endpoint" | "container">,
  /** The blob's name; `""` for the container. */ blob: string,
  /** Query parameters, in order. */ query: Record<string, string> = {},
): URL {
  const path =
    blob === "" ? "" : `/${blob.split("/").map(azureEncode).join("/")}`;
  const url = new URL(
    `${target.endpoint}/${azureEncode(target.container)}${path}`,
  );
  for (const [name, value] of Object.entries(query)) {
    url.searchParams.append(name, value);
  }
  return url;
}

/**
 * Sends an authorized request to one blob (or the container, `blob: ""`)
 * and answers the response: signed with Shared Key, the SAS appended, or a
 * bearer token sent — and, for a token the service refuses, resent once
 * with a renewed one. A body is sent as bytes, so `fetch` adds no
 * `Content-Type` a signature did not cover. Throws only what `fetch` (or a
 * token source) throws; the status is the caller's to read.
 */
export async function azureFetch(
  /** Where, and how it is authorized. */ target: AzureSigningTarget,
  /** The request. */ request: {
    /** The HTTP method. */
    method: string;
    /** The blob's name; `""` for the container. */
    blob: string;
    /** Query parameters (`comp`, `restype`, …). */
    query?: Record<string, string>;
    /** Headers to sign and send. */
    headers?: Record<string, string>;
    /** The body, for a `PUT`. */
    body?: Uint8Array;
    /** Aborts the request. */
    signal?: AbortSignal;
  },
): Promise<Response> {
  const url = azureBlobUrl(target, request.blob, request.query);
  const send = async (headers: Record<string, string>): Promise<Response> =>
    await fetch(url, {
      method: request.method,
      headers,
      body: request.body,
      signal: request.signal,
    });
  const auth = target.auth;
  if (auth.type === "shared-key") {
    return await send(
      signAzureRequest(auth, {
        method: request.method,
        url,
        headers: request.headers,
        contentLength: request.body?.byteLength ?? 0,
      }),
    );
  }
  if (auth.type === "sas") {
    appendSas(url, auth.query);
    return await send(baseHeaders(request.headers));
  }
  const token = await auth.source.token();
  const response = await send({
    ...baseHeaders(request.headers),
    authorization: `Bearer ${token}`,
  });
  if (!isTokenRefused(response)) {
    return response;
  }
  const renewed = await auth.source.renew(token);
  if (renewed === undefined) {
    return response;
  }
  await response.body?.cancel();
  return await send({
    ...baseHeaders(request.headers),
    authorization: `Bearer ${renewed}`,
  });
}
