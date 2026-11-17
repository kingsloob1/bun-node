/**
 * Helpers of the management API's tests: an API over a memory store with
 * an Ed25519 signing key, operators named by an `x-op` header, a fake
 * clock, and a `call()` that sends a request with the CSRF header.
 */
import { generateKeyPairSync } from "node:crypto";
import type { KeyObject } from "node:crypto";
import { BunHttpAdapter } from "@kingsleyweb/bun-common";
import type { SecurityApi, SecurityApiOptions } from "../../lib/control/index";
import { createSecurityApi } from "../../lib/control/index";
import { memoryStore } from "../../lib/store/index";
import type { SecurityStoreDriver } from "../../lib/store/index";
import { fakeClock } from "../helpers";
import type { FakeClock } from "../helpers";

/** A test API and how to call it. */
export interface TestApi {
  /** The API. */
  readonly api: SecurityApi;
  /** Its store. */
  readonly store: SecurityStoreDriver;
  /** The clock. */
  readonly clock: FakeClock;
  /** The bundle key's public half. */
  readonly publicKey: KeyObject;
  /** The audit key's public half. */
  readonly auditPublicKey: KeyObject;
  /** Sends a request as `op`; the status, the parsed body and the headers. */
  readonly call: (
    method: string,
    path: string,
    body?: unknown,
    op?: string | null,
    headers?: Record<string, string>,
  ) => Promise<{ status: number; body: any; headers: Headers }>;
}

/** A fresh API; `options` replace the defaults (owners `alice`, no step-up). */
export function testApi(options: Partial<SecurityApiOptions> = {}): TestApi {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const audit = generateKeyPairSync("ed25519");
  const clock = fakeClock();
  const store = options.store ?? memoryStore({ now: clock.now });
  const api = createSecurityApi({
    store,
    authenticate: (req) => {
      const id = req.request.headers.get("x-op");
      return id === null ? null : { id, name: id.toUpperCase() };
    },
    owners: ["alice"],
    allowWithoutStepUp: true,
    signing: { keyId: "sk_test", privateKey },
    audit: {
      signing: { keyId: "ak_test", privateKey: audit.privateKey },
      allowNoExternalCheckpoints: true,
    },
    now: clock.now,
    logger: () => {},
    ...options,
  });
  const app = new BunHttpAdapter(0, { logger: () => {} });
  app.use(api.basePath, api.router);
  const call: TestApi["call"] = async (
    method,
    path,
    body,
    op = "alice",
    headers = {},
  ) => {
    const response = await app.fetch(`${api.basePath}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        "x-bun-security-csrf": "1",
        ...(op === null ? {} : { "x-op": op }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    let parsed: unknown = text;
    try {
      parsed = text === "" ? undefined : JSON.parse(text);
    } catch {
      // Not JSON: the text.
    }
    return { status: response.status, body: parsed, headers: response.headers };
  };
  return {
    api,
    store,
    clock,
    publicKey,
    auditPublicKey: audit.publicKey,
    call,
  };
}
