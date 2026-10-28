/**
 * Shared Key request signing for the Azure Blob Storage driver
 * (`azureBlobDriver`), over `fetch`: Bun has no Azure client, and the
 * driver takes no Azure SDK (the dependency policy). The string to sign is
 * the Blob service's for version 2009-09-19 and later ("Authorize with
 * Shared Key", Microsoft Learn): the verb, eleven standard headers (empty
 * when absent; `Content-Length` empty when zero), the `x-ms-*` headers
 * canonicalized, and the canonicalized resource — `/<account><path>`, then
 * each query parameter as `\n<name>:<value>`, names lower-cased and sorted,
 * values decoded. Against a path-style endpoint (Azurite,
 * `http://127.0.0.1:10000/<account>`) the account appears twice in the
 * resource, as the docs say it must.
 */
import { Buffer } from "node:buffer";

/** The Blob service REST version every request asks for (`x-ms-version`); Azurite 3.37.0 accepts it (measured). */
export const AZURE_API_VERSION = "2025-01-05";

/** The account, its key, and the blob container a signed request goes to. */
export interface AzureSigningTarget {
  /**
   * The blob endpoint, `scheme://host[:port][/path]`, with no trailing `/`:
   * `https://<account>.blob.core.windows.net` on Azure, or a path-style one
   * such as Azurite's `http://127.0.0.1:10000/devstoreaccount1`.
   */
  endpoint: string;
  /** The storage account's name. */
  account: string;
  /** The account key, base64, as the portal shows it. */
  key: string;
  /** The blob container. */
  container: string;
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
  /** The account and its key. */ target: Pick<
    AzureSigningTarget,
    "account" | "key"
  >,
  /** The request. */ input: AzureSignInput,
): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(input.headers ?? {})) {
    headers[name.toLowerCase()] = value;
  }
  headers["x-ms-date"] = (input.date ?? new Date()).toUTCString();
  headers["x-ms-version"] ??= AZURE_API_VERSION;
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
 * Sends a signed request to one blob (or the container, `blob: ""`) and
 * answers the response. A body is sent as bytes, so `fetch` adds no
 * `Content-Type` the signature did not cover. Throws only what `fetch`
 * throws; the status is the caller's to read.
 */
export async function azureFetch(
  /** Where, and with which key. */ target: AzureSigningTarget,
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
  const headers = signAzureRequest(target, {
    method: request.method,
    url,
    headers: request.headers,
    contentLength: request.body?.byteLength ?? 0,
  });
  return await fetch(url, {
    method: request.method,
    headers,
    body: request.body,
    signal: request.signal,
  });
}
