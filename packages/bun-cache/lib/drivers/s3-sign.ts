/**
 * AWS Signature Version 4 header signing for the S3 driver's conditional
 * requests (plan §7.8; `bun-jobs-s3-driver.md` §3.1).
 *
 * Bun's `S3Client` sends no `If-None-Match` or `If-Match` header on any path,
 * and its `write()` answers no ETag (oven-sh/bun#17339, open: "S3 - Conditional
 * Writes & User Metadata"). A conditional `PUT` or `DELETE`, and a `GET` that
 * must also answer the object's ETag, are therefore signed here and sent with
 * `fetch`. Every header passed is signed, the conditional ones included: the
 * AWS SDK signs them into a request too, and nothing shows AWS honouring an
 * unsigned one (`bun-jobs-s3-driver.md` §3.1). The payload is
 * `UNSIGNED-PAYLOAD`, as Bun's own client sends it.
 *
 * Remove this module once Bun's client sends conditional headers and answers
 * the write's ETag.
 */

/** The credentials and the bucket a signed request goes to. */
export interface S3SigningTarget {
  /** The endpoint, `scheme://host[:port]`, with no path. */
  endpoint: string;
  /** The bucket. */
  bucket: string;
  /** The region the signature is scoped to (`us-east-1`, `auto` for R2). */
  region: string;
  /** The access key id. */
  accessKeyId: string;
  /** The secret access key. */
  secretAccessKey: string;
  /** A temporary credential's session token, sent as `x-amz-security-token`. */
  sessionToken?: string;
  /** `true`: `https://<bucket>.<host>/<key>`; `false` (path style): `https://<host>/<bucket>/<key>`. */
  virtualHostedStyle: boolean;
}

/** One request to sign. */
export interface S3SignInput {
  /** The HTTP method. */
  method: string;
  /** The request's URL, its path already encoded the way {@link s3Encode} encodes it. */
  url: URL;
  /** Headers to send and sign (any case; `host`, `x-amz-date` and `x-amz-content-sha256` are added). */
  headers?: Record<string, string>;
  /** The payload's SHA-256, hex; `UNSIGNED-PAYLOAD` by default. */
  payloadHash?: string;
  /** The signing time; now by default. For tests. */
  date?: Date;
}

/** The payload hash for a request whose body is not hashed. */
export const UNSIGNED_PAYLOAD = "UNSIGNED-PAYLOAD";

/**
 * URI-encodes one path segment or query component the way SigV4 requires:
 * every byte except the unreserved `A-Z a-z 0-9 - _ . ~` as `%XX`, upper-case
 * hex. `encodeURIComponent` leaves `! ' ( ) *` alone, which S3 encodes.
 */
export function s3Encode(text: string): string {
  return encodeURIComponent(text).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** HMAC-SHA256 of `data` under `key`. */
function hmac(key: string | Uint8Array, data: string): Uint8Array {
  const hasher = new Bun.CryptoHasher("sha256", key);
  hasher.update(data);
  return hasher.digest();
}

/** SHA-256 of `data`, hex. */
function sha256Hex(data: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(data);
  return hasher.digest("hex");
}

/** `20130524T000000Z` for a date. */
function amzDate(date: Date): string {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

/** The canonical query string: each name and value encoded, sorted by name then value. */
function canonicalQuery(url: URL): string {
  const pairs = [...url.searchParams].map(
    ([name, value]) => [s3Encode(name), s3Encode(value)] as const,
  );
  pairs.sort(([a, x], [b, y]) =>
    a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0,
  );
  return pairs.map(([name, value]) => `${name}=${value}`).join("&");
}

/**
 * Signs a request: answers the headers to send, `authorization`,
 * `x-amz-date`, `x-amz-content-sha256` (and `x-amz-security-token` with a
 * session token) included. `host` is signed but not returned (`fetch` sets
 * it from the URL).
 */
export function signS3Request(
  /** The credentials and region. */ target: Pick<
    S3SigningTarget,
    "region" | "accessKeyId" | "secretAccessKey" | "sessionToken"
  >,
  /** The request. */ input: S3SignInput,
): Record<string, string> {
  const stamp = amzDate(input.date ?? new Date());
  const day = stamp.slice(0, 8);
  const payloadHash = input.payloadHash ?? UNSIGNED_PAYLOAD;
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(input.headers ?? {})) {
    headers[name.toLowerCase()] = value.trim().replace(/\s+/g, " ");
  }
  headers.host = input.url.host;
  headers["x-amz-date"] = stamp;
  headers["x-amz-content-sha256"] = payloadHash;
  if (target.sessionToken !== undefined && target.sessionToken !== "") {
    headers["x-amz-security-token"] = target.sessionToken;
  }
  const names = Object.keys(headers).sort();
  const signedHeaders = names.join(";");
  const canonicalRequest = [
    input.method.toUpperCase(),
    input.url.pathname,
    canonicalQuery(input.url),
    names.map((name) => `${name}:${headers[name]}\n`).join(""),
    signedHeaders,
    payloadHash,
  ].join("\n");
  const scope = `${day}/${target.region}/s3/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    stamp,
    scope,
    sha256Hex(canonicalRequest),
  ].join("\n");
  const signingKey = hmac(
    hmac(hmac(hmac(`AWS4${target.secretAccessKey}`, day), target.region), "s3"),
    "aws4_request",
  );
  const signer = new Bun.CryptoHasher("sha256", signingKey);
  signer.update(stringToSign);
  const signature = signer.digest("hex");
  const { host: _host, ...send } = headers;
  return {
    ...send,
    authorization: `AWS4-HMAC-SHA256 Credential=${target.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

/** The URL of one object (or, with `key` empty, of the bucket), its path encoded for signing. */
export function s3ObjectUrl(target: S3SigningTarget, key: string): URL {
  const base = new URL(target.endpoint);
  const path = key === "" ? "" : `/${key.split("/").map(s3Encode).join("/")}`;
  if (target.virtualHostedStyle) {
    return new URL(
      `${base.protocol}//${target.bucket}.${base.host}${path || "/"}`,
    );
  }
  return new URL(
    `${base.protocol}//${base.host}/${s3Encode(target.bucket)}${path}`,
  );
}

/**
 * Sends a signed request to one object (`key`, or the bucket when empty) and
 * answers the response. Throws only what `fetch` throws; the status is the
 * caller's to read.
 */
export async function s3SignedFetch(
  /** Where, and with which credentials. */ target: S3SigningTarget,
  /** The request. */ request: {
    /** The HTTP method. */
    method: string;
    /** The object key; `""` for the bucket itself. */
    key: string;
    /** Headers to sign and send. */
    headers?: Record<string, string>;
    /** The body, for a `PUT`. */
    body?: Uint8Array | string;
    /** Aborts the request. */
    signal?: AbortSignal;
  },
): Promise<Response> {
  const url = s3ObjectUrl(target, request.key);
  const headers = signS3Request(target, {
    method: request.method,
    url,
    headers: request.headers,
  });
  return await fetch(url, {
    method: request.method,
    headers,
    body: request.body,
    signal: request.signal,
  });
}
