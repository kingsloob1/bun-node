/**
 * The executor's HTTP plumbing: reading a bounded body, answering a problem,
 * and answering a signed envelope.
 *
 * Browser-safe: Web APIs and sibling browser-safe modules only.
 */

import type { ProblemDto, ProblemIssueDto } from "../../api/contract/types";
import type { RemoteProblemCode } from "../constants";
import type { HmacSha256 } from "../mac";
import type { RemoteSecret } from "../signing";
import { ConfigError, RemoteMessageTooLargeError } from "../../shared/errors";
import { REMOTE_HEADERS, WORKER_PROTOCOL_VERSION } from "../constants";
import { signEnvelopeWith } from "../signing";

/** Titles by problem code: short, stable, safe for any occurrence. */
const TITLES: Partial<Record<RemoteProblemCode, string>> = {
  UNSUPPORTED_OP: "Unsupported operation",
  UNSUPPORTED_PROTOCOL: "Unsupported protocol version",
  SIGNATURE_MISSING: "Signature missing or malformed",
  SIGNATURE_INVALID: "Signature invalid",
  SIGNATURE_TIMESTAMP: "Signature outside the replay window",
  REPLAYED: "Request replayed",
  TOO_LARGE: "Message too large",
  VALIDATION: "Message validation failed",
  INTERNAL: "Internal executor error",
};

/** Headers every answer carries. */
function baseHeaders(contentType: string): Headers {
  return new Headers({
    "content-type": contentType,
    "cache-control": "no-store",
    [REMOTE_HEADERS.protocol]: String(WORKER_PROTOCOL_VERSION),
  });
}

/** What a problem answer may add to the RFC 9457 members. */
export interface ProblemExtras {
  /** Human detail for this occurrence. */
  detail?: string;
  /** Validation issues, for `VALIDATION`. */
  issues?: ProblemIssueDto[];
  /** Safe context. */
  context?: Record<string, unknown>;
  /** With `UNSUPPORTED_PROTOCOL`: the versions spoken, as an extension member. */
  supported?: number[];
  /** Extra response headers (`allow`). */
  headers?: Record<string, string>;
}

/** The problem document for a code. */
export function problemBody(
  status: number,
  code: RemoteProblemCode,
  extras: ProblemExtras = {},
): ProblemDto & { supported?: number[] } {
  return {
    type: `urn:bun-jobs:error:${code}`,
    title: TITLES[code] ?? code,
    status,
    code,
    ...(extras.detail === undefined ? {} : { detail: extras.detail }),
    ...(extras.issues === undefined ? {} : { issues: extras.issues }),
    ...(extras.context === undefined ? {} : { context: extras.context }),
    ...(extras.supported === undefined ? {} : { supported: extras.supported }),
  };
}

/** How an answer is signed, when it is. */
export interface Signer {
  /** The MAC the core computes with. */
  mac: HmacSha256;
  /** The executor's secret; the first key signs. */
  secret: RemoteSecret;
  /** The request's `bun-jobs-id`, echoed on the answer. */
  id: string | null;
}

/**
 * Builds an answer: JSON, and signed as a `response` when a signer is given.
 * Only an authenticated request is answered with a signature, so an
 * unauthenticated caller never obtains one over bytes of its choosing.
 */
export async function answer(
  status: number,
  body: unknown,
  signer: Signer | null,
  contentType = "application/json",
  extraHeaders?: Record<string, string>,
): Promise<Response> {
  const text = JSON.stringify(body);
  const headers = baseHeaders(contentType);
  for (const [name, value] of Object.entries(extraHeaders ?? {})) {
    headers.set(name, value);
  }
  if (signer !== null) {
    headers.set(
      REMOTE_HEADERS.signature,
      await signEnvelopeWith(signer.mac, text, {
        direction: "response",
        secret: signer.secret,
      }),
    );
    if (signer.id !== null) {
      headers.set(REMOTE_HEADERS.id, signer.id);
    }
  }
  return new Response(text, { status, headers });
}

/** A problem answer. */
export function problem(
  status: number,
  code: RemoteProblemCode,
  extras: ProblemExtras,
  signer: Signer | null,
): Promise<Response> {
  return answer(
    status,
    problemBody(status, code, extras),
    signer,
    "application/problem+json",
    extras.headers,
  );
}

/**
 * Reads a request's body as bytes, refusing it with
 * {@link RemoteMessageTooLargeError} once it passes `max`: at once when its
 * `content-length` says so, otherwise as soon as the bytes read pass the cap,
 * without reading the rest.
 */
export async function readBounded(
  request: Request,
  max: number,
): Promise<Uint8Array> {
  if (request.bodyUsed) {
    // Signed bytes cannot be recovered from a parsed body, and verifying an
    // empty one would report a wrong key: say what is actually wrong.
    throw new ConfigError(
      "The request's body was already read before the remote executor saw it: mount the executor where the body is untouched (Bun.serve's fetch or routes, or a route with body parsing off)",
    );
  }
  const declared = request.headers.get("content-length");
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > max) {
    throw new RemoteMessageTooLargeError(Number(declared), max);
  }
  const empty = (): Uint8Array => {
    if (declared !== null && /^\d+$/.test(declared) && Number(declared) > 0) {
      // A Request copied from one whose body was read keeps its headers and
      // reports bodyUsed false, but its body is empty (oven-sh/bun#44307):
      // the bodyUsed check above cannot see it, and a 401 would mislead.
      throw new ConfigError(
        `The request declares a ${declared}-byte body but carries none: it was most likely rebuilt from a Request whose body was already read (new Request(used), oven-sh/bun#44307). Mount the executor where the body is untouched`,
      );
    }
    return new Uint8Array(0);
  };
  if (request.body === null) {
    return empty();
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    length += value.byteLength;
    if (length > max) {
      await reader.cancel().catch(() => {});
      throw new RemoteMessageTooLargeError(null, max);
    }
    chunks.push(value);
  }
  if (length === 0) {
    return empty();
  }
  if (chunks.length === 1) {
    return chunks[0]!;
  }
  const out = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
