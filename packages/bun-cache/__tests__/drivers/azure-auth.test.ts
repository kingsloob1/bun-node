/**
 * The Azure Blob Storage driver's SAS and Microsoft Entra ID authorization:
 * the option rules (exactly one way to authorize, the SAS in a url and a
 * connection string) and the credential's token cache without a server;
 * the bearer path against a local fake that checks `Authorization: Bearer`
 * and `x-ms-version`; then, on the Azurite `BUN_CACHE_TEST_AZURE_URL`
 * names, the conformance kit over a SAS minted for its development account
 * (Azurite checks SAS signatures and permissions); and, on the HTTPS
 * Azurite with `--oauth basic` that `BUN_CACHE_TEST_AZURE_OAUTH_URL` names,
 * the kit over a `credential` and over a `token` (Azurite checks a token's
 * audience, issuer and lifetime, not its signature).
 *
 * Test data: every blob carries this run's prefix
 * (`bun-cache-test/<pid>-<time>-auth/…`), and the end of the file deletes
 * exactly the blobs under the prefixes it used, through Shared Key. Unset,
 * a backend skips visibly; set but unreachable, it fails, naming the
 * variable.
 */
import process from "node:process";
import { afterAll, describe, expect, test } from "bun:test";
import type { AzureTokenCredential, StoredEntry } from "../../lib/index";
import { azureBlobDriver } from "../../lib/index";
import type { AzureBlobDriverOptions } from "../../lib/drivers/azure";
import {
  AzureBlobCacheDriver,
  parseAzureUrl,
  parseConnectionString,
  resolveAzureTarget,
} from "../../lib/drivers/azure";
import {
  AZURE_STORAGE_SCOPE,
  CredentialTokenSource,
  StaticTokenSource,
  TOKEN_REFRESH_MARGIN_MS,
} from "../../lib/drivers/azure-auth";
import { AZURE_API_VERSION } from "../../lib/drivers/azure-sign";
import { fakeClock, runCacheDriverConformance } from "../../lib/testing/index";
import {
  mintAccountSas,
  mintContainerSas,
  mintingCredential,
  mintStorageJwt,
  trustOrigin,
} from "./azure-auth-fixtures";
import {
  azureBackend,
  azureRawDump,
  azureReachError,
  deleteAzurePrefix,
} from "./backends";
import { reportNotConfigured, reportUnreachable } from "./sqlSuite";

/** An entry for the cases. */
function entry(key: string, bytes: number[]): StoredEntry {
  return { key, value: new Uint8Array(bytes), expiresAt: null, tags: [] };
}

/** A promise and its resolver. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** A credential answering the given tokens in turn (the last one for ever), counting its calls. */
function scriptedCredential(
  answers: readonly (
    | {
        token: string;
        expiresOnTimestamp: number;
        refreshAfterTimestamp?: number;
      }
    | null
    | Error
  )[],
): AzureTokenCredential & { calls: (string | string[])[] } {
  const calls: (string | string[])[] = [];
  return {
    calls,
    getToken: async (scopes) => {
      calls.push(scopes);
      const answer = answers[Math.min(calls.length, answers.length) - 1];
      await Promise.resolve();
      if (answer instanceof Error) {
        throw answer;
      }
      return answer;
    },
  };
}

describe("azureBlobDriver authorization options", () => {
  const SAS =
    "sv=2022-11-02&ss=b&srt=co&sp=rwdl&se=2030-01-01T00%3A00%3A00Z&sig=a%2Bb%2Fc%3D";

  test("the url carries a SAS as its query, kept as written, beside scheme; a query with no sig is refused", () => {
    expect(
      parseAzureUrl(`azure://acct.blob.core.windows.net/cache?${SAS}`),
    ).toEqual({
      endpoint: "https://acct.blob.core.windows.net",
      container: "cache",
      sasToken: SAS,
    });
    expect(
      parseAzureUrl(
        `azure://127.0.0.1:10000/devstoreaccount1/c?scheme=http&${SAS}`,
      ),
    ).toEqual({
      endpoint: "http://127.0.0.1:10000/devstoreaccount1",
      container: "c",
      sasToken: SAS,
    });
    // A query of scheme alone is no SAS.
    expect(parseAzureUrl("azure://a:a2V5@h/c?scheme=http").sasToken).toBe(
      undefined,
    );
    expect(() => parseAzureUrl("azure://h/c?sv=2022-11-02&sp=rwdl")).toThrow(
      "but no sig",
    );
    expect(() => parseAzureUrl("azure://a:a2V5@h/c?timeout=5")).toThrow(
      "timeout but no sig",
    );
  });

  test("a SAS from the url, a field (a leading ? dropped) or a connection string; no account key needed", () => {
    expect(
      resolveAzureTarget({
        url: `azure://acct.blob.core.windows.net/cache?${SAS}`,
      }),
    ).toEqual({
      endpoint: "https://acct.blob.core.windows.net",
      container: "cache",
      auth: { type: "sas", query: SAS },
    });
    expect(
      resolveAzureTarget({
        connection: {
          accountName: "acct",
          sasToken: ` ?${SAS}`,
          container: "c",
        },
      }),
    ).toEqual({
      endpoint: "https://acct.blob.core.windows.net",
      container: "c",
      auth: { type: "sas", query: SAS },
    });
    expect(
      resolveAzureTarget({
        connection: {
          connectionString: `BlobEndpoint=https://acct.blob.core.windows.net/;SharedAccessSignature=${SAS}`,
          container: "c",
        },
      }),
    ).toEqual({
      endpoint: "https://acct.blob.core.windows.net",
      container: "c",
      auth: { type: "sas", query: SAS },
    });
    expect(
      parseConnectionString(
        `BlobEndpoint=http://127.0.0.1:10000/devstoreaccount1;SharedAccessSignature=?${SAS}`,
      ).sasToken,
    ).toBe(`?${SAS}`);
    expect(() =>
      resolveAzureTarget({
        connection: { accountName: "a", sasToken: "sv=1&sp=r", container: "c" },
      }),
    ).toThrow("sasToken must be a SAS query with its signature");
    expect(() =>
      resolveAzureTarget({ connection: { sasToken: SAS, container: "c" } }),
    ).toThrow("no endpoint or accountName");
  });

  test("exactly one way to authorize: any two are a TypeError naming both and where each came from", () => {
    const credential: AzureTokenCredential = {
      getToken: async () => await Promise.resolve(null),
    };
    const cases: [AzureBlobDriverOptions, RegExp][] = [
      [
        { url: "azure://a:a2V5@h/c", connection: { sasToken: SAS } },
        /not accountKey \(from the url\) and sasToken \(from the connection's fields\)/,
      ],
      [
        { url: `azure://a:a2V5@h/c?${SAS}` },
        /not accountKey \(from the url\) and sasToken \(from the url\)/,
      ],
      [
        {
          connection: {
            connectionString: "UseDevelopmentStorage=true",
            container: "c",
            credential,
          },
        },
        /accountKey \(from the connection string\) and credential \(from the connection's fields\)/,
      ],
      [
        { url: `azure://h/c?${SAS}`, connection: { token: "t" } },
        /sasToken \(from the url\) and token \(from the connection's fields\)/,
      ],
      [
        { url: "azure://h/c", connection: { credential, token: () => "t" } },
        /credential \(from the connection's fields\) and token/,
      ],
    ];
    for (const [options, message] of cases) {
      expect(() => azureBlobDriver(options)).toThrow(message);
    }
    // The same way twice is no conflict: the url's key wins.
    expect(
      resolveAzureTarget({
        url: "azure://a:dXJs@h/c",
        connection: { accountName: "a", accountKey: "ZmllbGQ=" },
      }).auth,
    ).toEqual({ type: "shared-key", account: "a", key: "dXJs" });
    expect(() => azureBlobDriver({ url: "azure://h/c" })).toThrow(
      "no way to authorize",
    );
  });

  test("a credential needs getToken; a token is bare, a string or a function", () => {
    expect(() =>
      azureBlobDriver({
        url: "azure://h/c",
        connection: { credential: {} as AzureTokenCredential },
      }),
    ).toThrow("getToken");
    expect(() =>
      azureBlobDriver({
        url: "azure://h/c",
        connection: { token: "Bearer abc" },
      }),
    ).toThrow('without "Bearer "');
    expect(() =>
      azureBlobDriver({ url: "azure://h/c", connection: { token: "" } }),
    ).toThrow("no token");
    expect(() =>
      azureBlobDriver({
        url: "azure://h/c",
        connection: { token: 5 as unknown as string },
      }),
    ).toThrow("a string or a function");
    const driver = new AzureBlobCacheDriver({
      url: "azure://acct.blob.core.windows.net/c",
      connection: { token: "abc" },
    });
    expect(driver.target.auth.type).toBe("bearer");
    expect(driver.target.endpoint).toBe("https://acct.blob.core.windows.net");
  });

  test("the REST version sent is 2017-11-09 or later, as a bearer token needs", () => {
    expect(/^\d{4}-\d{2}-\d{2}$/.test(AZURE_API_VERSION)).toBe(true);
    expect(AZURE_API_VERSION >= "2017-11-09").toBe(true);
  });
});

describe("the credential's token cache", () => {
  const HOUR = 3_600_000;

  test("asks for Azure Storage's scope, and caches the token until 5 minutes before it expires", async () => {
    const clock = fakeClock(1_000_000);
    const credential = scriptedCredential([
      { token: "t1", expiresOnTimestamp: clock.now() + HOUR },
      { token: "t2", expiresOnTimestamp: clock.now() + 2 * HOUR },
    ]);
    const source = new CredentialTokenSource(credential, clock.now);
    expect(await source.token()).toBe("t1");
    expect(credential.calls).toEqual([AZURE_STORAGE_SCOPE]);
    expect(AZURE_STORAGE_SCOPE).toBe("https://storage.azure.com/.default");
    clock.advance(HOUR - TOKEN_REFRESH_MARGIN_MS - 1);
    expect(await source.token()).toBe("t1");
    expect(credential.calls).toHaveLength(1);
    clock.advance(1);
    expect(await source.token()).toBe("t2");
    expect(credential.calls).toHaveLength(2);
    expect(TOKEN_REFRESH_MARGIN_MS).toBe(5 * 60_000);
  });

  test("a token living under 10 minutes is replaced at half its life; refreshAfterTimestamp, when earlier, wins", async () => {
    const clock = fakeClock(1_000_000);
    const short = scriptedCredential([
      { token: "s1", expiresOnTimestamp: clock.now() + 60_000 },
      { token: "s2", expiresOnTimestamp: clock.now() + HOUR },
    ]);
    const source = new CredentialTokenSource(short, clock.now);
    expect(await source.token()).toBe("s1");
    clock.advance(29_999);
    expect(await source.token()).toBe("s1");
    clock.advance(1);
    expect(await source.token()).toBe("s2");

    const start = clock.now();
    const hinted = scriptedCredential([
      {
        token: "h1",
        expiresOnTimestamp: start + HOUR,
        refreshAfterTimestamp: start + 10_000,
      },
      { token: "h2", expiresOnTimestamp: start + HOUR },
    ]);
    const second = new CredentialTokenSource(hinted, clock.now);
    expect(await second.token()).toBe("h1");
    clock.advance(9_999);
    expect(await second.token()).toBe("h1");
    clock.advance(1);
    expect(await second.token()).toBe("h2");
  });

  test("concurrent callers share one getToken (single-flight), for a first token, a refresh and a renewal", async () => {
    let calls = 0;
    let gate = deferred<void>();
    const credential: AzureTokenCredential = {
      getToken: async () => {
        calls++;
        await gate.promise;
        return { token: `t${calls}`, expiresOnTimestamp: Date.now() + HOUR };
      },
    };
    const source = new CredentialTokenSource(credential);
    const first = Array.from({ length: 20 }, async () => await source.token());
    gate.resolve();
    expect(new Set(await Promise.all(first))).toEqual(new Set(["t1"]));
    expect(calls).toBe(1);
    gate = deferred<void>();
    const renewals = Array.from(
      { length: 20 },
      async () => await source.renew("t1"),
    );
    gate.resolve();
    expect(new Set(await Promise.all(renewals))).toEqual(new Set(["t2"]));
    expect(calls).toBe(2);
    // A renewal of a token already replaced asks nothing.
    expect(await source.renew("t1")).toBe("t2");
    expect(calls).toBe(2);
  });

  test("renew: a refused token is dropped and asked for again; the same token back is no renewal", async () => {
    const clock = fakeClock(1_000_000);
    const credential = scriptedCredential([
      { token: "a", expiresOnTimestamp: clock.now() + HOUR },
      { token: "a", expiresOnTimestamp: clock.now() + HOUR },
      { token: "b", expiresOnTimestamp: clock.now() + HOUR },
    ]);
    const source = new CredentialTokenSource(credential, clock.now);
    expect(await source.token()).toBe("a");
    expect(await source.renew("a")).toBeUndefined();
    expect(credential.calls).toHaveLength(2);
    expect(await source.renew("a")).toBe("b");
    expect(await source.token()).toBe("b");
    expect(credential.calls).toHaveLength(3);
  });

  test("no token is an error naming the credential; a failed refresh keeps a still-valid token, an expired one throws", async () => {
    const clock = fakeClock(1_000_000);
    await expect(
      new CredentialTokenSource(scriptedCredential([null]), clock.now).token(),
    ).rejects.toThrow("the credential answered no token");
    const credential = scriptedCredential([
      { token: "ok", expiresOnTimestamp: clock.now() + HOUR },
      new Error("identity endpoint down"),
    ]);
    const source = new CredentialTokenSource(credential, clock.now);
    expect(await source.token()).toBe("ok");
    clock.advance(HOUR - 60_000);
    expect(await source.token()).toBe("ok");
    expect(credential.calls).toHaveLength(2);
    clock.advance(60_000);
    await expect(source.token()).rejects.toThrow("identity endpoint down");
    await expect(
      new CredentialTokenSource(
        scriptedCredential([{ token: "Bearer x", expiresOnTimestamp: 1e15 }]),
      ).token(),
    ).rejects.toThrow('without "Bearer "');
  });

  test("a token function is asked on every call, and once more on a renewal; a string never renews", async () => {
    let calls = 0;
    const fn = new StaticTokenSource(() => `f${Math.min(++calls, 3)}`);
    expect(await fn.token()).toBe("f1");
    expect(await fn.token()).toBe("f2");
    expect(calls).toBe(2);
    expect(await fn.renew("f2")).toBe("f3");
    expect(await fn.renew("f3")).toBeUndefined();
    expect(calls).toBe(4);
    const fixed = new StaticTokenSource("s");
    expect(await fixed.token()).toBe("s");
    expect(await fixed.renew("s")).toBeUndefined();
    await expect(
      new StaticTokenSource(async () => await Promise.resolve("")).token(),
    ).rejects.toThrow("the token function answered no token");
  });
});

/** One request the fake service saw. */
interface SeenRequest {
  /** The method. */
  method: string;
  /** The path. */
  path: string;
  /** The raw query, `?…` or `""`. */
  search: string;
  /** `Authorization`, or `null`. */
  authorization: string | null;
  /** `x-ms-version`, or `null`. */
  version: string | null;
  /** `x-ms-date`, or `null`. */
  date: string | null;
  /** The answer's status. */
  status: number;
}

/**
 * A fake Blob service on 127.0.0.1 (port 0): one account `acct`, one
 * container `c`, blobs in memory with ETags and the conditions the driver
 * sends. It takes a Bearer token not in `refused` with `x-ms-version`
 * 2017-11-09 or later, or a query whose `sig` is `sas`, and records every
 * request.
 */
function fakeBlobService(
  options: {
    /** The SAS signature it takes, if any. */
    sas?: string;
  } = {},
) {
  const blobs = new Map<
    string,
    { body: Uint8Array; type: string; etag: string }
  >();
  const seen: SeenRequest[] = [];
  const refused = new Set<string>();
  let etags = 0;
  const xml = (text: string) =>
    text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const answer = (
    status: number,
    code?: string,
    headers: Record<string, string> = {},
  ) =>
    new Response(status === 204 ? null : (code ?? ""), {
      status,
      headers: {
        ...(code === undefined ? {} : { "x-ms-error-code": code }),
        ...headers,
      },
    });
  const handle = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const authorization = request.headers.get("authorization");
    const version = request.headers.get("x-ms-version");
    if (authorization?.startsWith("Bearer ")) {
      if (version === null || version < "2017-11-09") {
        return answer(400, "InvalidHeaderValue");
      }
      if (refused.has(authorization.slice(7))) {
        return answer(401, "InvalidAuthenticationInfo", {
          "www-authenticate":
            "Bearer authorization_uri=https://login.microsoftonline.com/x/oauth2/authorize resource_id=https://storage.azure.com",
        });
      }
    } else if (
      options.sas === undefined ||
      url.searchParams.get("sig") !== options.sas
    ) {
      return answer(403, "AuthenticationFailed");
    }
    const [, account, container, ...rest] = url.pathname.split("/");
    if (account !== "acct" || container !== "c") {
      return answer(404, "ContainerNotFound");
    }
    const name = rest.map(decodeURIComponent).join("/");
    if (url.searchParams.get("comp") === "list") {
      const prefix = url.searchParams.get("prefix") ?? "";
      const items = [...blobs]
        .filter(([key]) => key.startsWith(prefix))
        .map(
          ([key, blob]) =>
            `<Blob><Name>${xml(key)}</Name><Properties><Etag>${blob.etag}</Etag><Content-Length>${blob.body.byteLength}</Content-Length><Content-Type>${xml(blob.type)}</Content-Type></Properties></Blob>`,
        );
      return new Response(
        `<?xml version="1.0"?><EnumerationResults><Blobs>${items.join("")}</Blobs><NextMarker/></EnumerationResults>`,
      );
    }
    const held = blobs.get(name);
    const ifMatch = request.headers.get("if-match");
    if (ifMatch !== null && held?.etag !== ifMatch) {
      return answer(412, "ConditionNotMet");
    }
    if (request.method === "GET") {
      return held === undefined
        ? answer(404, "BlobNotFound")
        : new Response(held.body, {
            headers: { etag: held.etag, "content-type": held.type },
          });
    }
    if (request.method === "PUT") {
      if (request.headers.get("if-none-match") === "*" && held !== undefined) {
        return answer(409, "BlobAlreadyExists");
      }
      const etag = `0x${(++etags).toString(16)}`;
      blobs.set(name, {
        body: new Uint8Array(await request.arrayBuffer()),
        type: request.headers.get("content-type") ?? "",
        etag,
      });
      return answer(201, undefined, { etag });
    }
    if (request.method === "DELETE") {
      return blobs.delete(name) ? answer(202) : answer(404, "BlobNotFound");
    }
    return answer(405);
  };
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (request) => {
      const response = await handle(request);
      const url = new URL(request.url);
      seen.push({
        method: request.method,
        path: url.pathname,
        search: url.search,
        authorization: request.headers.get("authorization"),
        version: request.headers.get("x-ms-version"),
        date: request.headers.get("x-ms-date"),
        status: response.status,
      });
      return response;
    },
  });
  return {
    /** The driver's url for it, with no key. */
    url: `azure://127.0.0.1:${server.port}/acct/c?scheme=http`,
    /** Every request, in order. */
    seen,
    /** Tokens it answers 401 for. */
    refused,
    /** Stops it. */
    stop: async () => {
      await server.stop(true);
    },
  };
}

describe("the bearer path, against a fake Blob service", () => {
  test("every request carries Authorization: Bearer and x-ms-version 2017-11-09 or later — never Shared Key or a SAS — with the token cached", async () => {
    const service = fakeBlobService();
    try {
      const credential = mintingCredential();
      const driver = azureBlobDriver({
        url: service.url,
        connection: { credential },
      });
      await driver.connect!();
      await driver.set("ns", entry("k", [1, 2]));
      expect((await driver.get("ns", "k"))?.value).toEqual(
        new Uint8Array([1, 2]),
      );
      expect(await driver.increment!("ns", "n", 2, null)).toBe(2);
      expect(await driver.acquireLock!("ns", "l", "me", 60_000)).toBe(true);
      expect(await driver.releaseLock!("ns", "l", "me")).toBe(true);
      expect(await driver.delete("ns", ["k", "n"])).toBe(2);
      await driver.sweep!(Date.now(), 100);
      expect(service.seen.length).toBeGreaterThan(8);
      for (const request of service.seen) {
        expect(request.authorization).toMatch(/^Bearer ey/);
        expect(request.version).toBe(AZURE_API_VERSION);
        expect(request.date).not.toBeNull();
        expect(request.search).not.toContain("sig=");
        expect([400, 401, 403]).not.toContain(request.status);
      }
      expect(new Set(service.seen.map((r) => r.authorization)).size).toBe(1);
      expect(credential.calls).toEqual([AZURE_STORAGE_SCOPE]);
    } finally {
      await service.stop();
    }
  });

  test("a refused token is renewed and the request resent once; a credential answering the refused token again fails, naming it", async () => {
    const service = fakeBlobService();
    try {
      const credential = mintingCredential();
      const driver = azureBlobDriver({
        url: service.url,
        connection: { credential },
      });
      await driver.set("ns", entry("k", [1]));
      const first = service.seen[0].authorization!;
      service.refused.add(first.slice(7));
      service.seen.length = 0;
      await driver.set("ns", entry("k", [2]));
      expect(service.seen.map((r) => [r.method, r.status])).toEqual([
        ["PUT", 401],
        ["PUT", 201],
      ]);
      expect(service.seen[1].authorization).not.toBe(first);
      expect(credential.calls).toHaveLength(2);
      // Every later request uses the renewed token, with no new getToken.
      service.seen.length = 0;
      expect((await driver.get("ns", "k"))?.value).toEqual(new Uint8Array([2]));
      expect(service.seen.map((r) => r.status)).toEqual([200]);
      expect(credential.calls).toHaveLength(2);

      const stuck = scriptedCredential([
        { token: "same", expiresOnTimestamp: Date.now() + 3_600_000 },
      ]);
      service.refused.add("same");
      const refused = azureBlobDriver({
        url: service.url,
        connection: { credential: stuck },
      });
      service.seen.length = 0;
      await expect(refused.set("ns", entry("k", [3]))).rejects.toThrow(
        /401 InvalidAuthenticationInfo \(the bearer token was refused/,
      );
      expect(service.seen).toHaveLength(1);
      expect(stuck.calls).toHaveLength(2);
    } finally {
      await service.stop();
    }
  });

  test("concurrent requests with no token yet share one getToken; concurrent refusals one renewal", async () => {
    const service = fakeBlobService();
    try {
      let calls = 0;
      const credential: AzureTokenCredential = {
        getToken: async () => {
          calls++;
          await Bun.sleep(20);
          return {
            token: mintStorageJwt(),
            expiresOnTimestamp: Date.now() + 3_600_000,
          };
        },
      };
      const driver = azureBlobDriver({
        url: service.url,
        connection: { credential },
      });
      await Promise.all(
        Array.from(
          { length: 20 },
          async (_, i) => await driver.get("ns", `k${i}`),
        ),
      );
      expect(calls).toBe(1);
      service.refused.add(service.seen[0].authorization!.slice(7));
      service.seen.length = 0;
      await Promise.all(
        Array.from(
          { length: 20 },
          async (_, i) => await driver.get("ns", `k${i}`),
        ),
      );
      expect(calls).toBe(2);
      expect(service.seen.filter((r) => r.status === 401)).toHaveLength(20);
      expect(service.seen.filter((r) => r.status === 404)).toHaveLength(20);
    } finally {
      await service.stop();
    }
  });

  test("a token function is asked on every request, and once more on a refusal; a token string is never renewed", async () => {
    const service = fakeBlobService();
    try {
      let calls = 0;
      let current = "first";
      const driver = azureBlobDriver({
        url: service.url,
        connection: {
          token: async () => {
            calls++;
            return await Promise.resolve(current);
          },
        },
      });
      await driver.set("ns", entry("k", [1]));
      await driver.get("ns", "k");
      await driver.get("ns", "k");
      expect(calls).toBe(3);
      expect(
        service.seen.every((r) => r.authorization === "Bearer first"),
      ).toBe(true);
      service.refused.add("first");
      current = "second";
      // A function whose cache still answers the refused token, then a new one.
      let stale = true;
      const rotating = azureBlobDriver({
        url: service.url,
        connection: {
          token: () => {
            calls++;
            const answer = stale ? "first" : current;
            stale = false;
            return answer;
          },
        },
      });
      service.seen.length = 0;
      expect((await rotating.get("ns", "k"))?.value).toEqual(
        new Uint8Array([1]),
      );
      expect(service.seen.map((r) => [r.authorization, r.status])).toEqual([
        ["Bearer first", 401],
        ["Bearer second", 200],
      ]);
      expect(calls).toBe(5);

      const fixed = azureBlobDriver({
        url: service.url,
        connection: { token: "first" },
      });
      service.seen.length = 0;
      await expect(fixed.get("ns", "k")).rejects.toThrow(
        /GET .* answered 401 InvalidAuthenticationInfo \(the bearer token was refused/,
      );
      expect(service.seen).toHaveLength(1);
    } finally {
      await service.stop();
    }
  });

  test("a SAS is appended to every request's own query, a leading ? dropped, with no Authorization", async () => {
    const service = fakeBlobService({ sas: "s1g/+=" });
    try {
      const sas = `?sv=2022-11-02&sp=rwdl&sig=${encodeURIComponent("s1g/+=")}`;
      const driver = azureBlobDriver({
        connection: {
          endpoint: service.url.replace(
            /^azure:\/\/(.*)\/c\?scheme=http$/,
            "http://$1",
          ),
          container: "c",
          sasToken: sas,
        },
      });
      await driver.connect!();
      await driver.set("ns", entry("k", [7]));
      expect((await driver.get("ns", "k"))?.value).toEqual(new Uint8Array([7]));
      await driver.clear("ns");
      for (const request of service.seen) {
        expect(request.authorization).toBeNull();
        expect(request.status).toBeLessThan(400);
        expect(
          request.search.endsWith(`&${sas.slice(1)}`) || request.search === sas,
        ).toBe(true);
      }
      const listing = service.seen.find((r) => r.search.includes("comp=list"))!;
      expect(listing.search).toMatch(/^\?restype=container&comp=list&prefix=/);
    } finally {
      await service.stop();
    }
  });
});

const azure = azureBackend();
/** This run's blob prefixes, by the Shared Key url of the server that holds them. */
const created = new Map<string, Set<string>>();
const run = `bun-cache-test/${process.pid}-${Date.now().toString(36)}-auth`;
/** A prefix of this run's on `server`, recorded so the end of the file deletes its blobs. */
function prefixOn(server: string, suffix: string): string {
  const value = `${run}/${suffix}`;
  const set = created.get(server) ?? new Set<string>();
  set.add(value);
  created.set(server, set);
  return value;
}

/** The driver url for `server`'s container with no key, and `query` (a SAS) appended. */
function keylessUrl(server: string, query = ""): string {
  const target = resolveAzureTarget({ url: server });
  const endpoint = new URL(target.endpoint);
  const scheme = endpoint.protocol === "http:" ? "scheme=http" : "";
  const params = [scheme, query].filter((part) => part !== "").join("&");
  return `azure://${endpoint.host}${endpoint.pathname.replace(/\/$/, "")}/${target.container}${params === "" ? "" : `?${params}`}`;
}

let restoreFetch: (() => void) | undefined;
afterAll(async () => {
  try {
    for (const [server, prefixes] of created) {
      for (const each of prefixes) {
        await deleteAzurePrefix(server, each);
      }
    }
  } finally {
    restoreFetch?.();
  }
});

if (azure.url === undefined) {
  reportNotConfigured("azure (SAS)", azure.variable);
} else {
  const unreachable = await azureReachError(azure.url);
  if (unreachable !== undefined) {
    reportUnreachable("azure (SAS)", azure.variable, unreachable);
  } else {
    await registerSasSuite(azure.url);
  }
}

const OAUTH_VARIABLE = "BUN_CACHE_TEST_AZURE_OAUTH_URL";
const oauthUrl = process.env[OAUTH_VARIABLE] || undefined;
if (oauthUrl === undefined) {
  reportNotConfigured(
    "azure (Entra ID)",
    OAUTH_VARIABLE,
    "an HTTPS Azurite with --oauth basic; see the bun-cache README's Azure section",
  );
} else {
  restoreFetch = trustOrigin(
    new URL(resolveAzureTarget({ url: oauthUrl }).endpoint).origin,
  );
  const unreachable = await azureReachError(oauthUrl);
  if (unreachable !== undefined) {
    reportUnreachable("azure (Entra ID)", OAUTH_VARIABLE, unreachable);
  } else {
    await registerBearerSuite(oauthUrl);
  }
}

/** The kit and the SAS cases on the Azurite `server` (a Shared Key url) names. */
async function registerSasSuite(server: string): Promise<void> {
  const target = resolveAzureTarget({ url: server });
  if (target.auth.type !== "shared-key") {
    throw new TypeError(`${azure.variable} must carry the account key`);
  }
  const { account, key } = target.auth;
  const accountSas = (permissions = "rwdl", expiry?: number) =>
    mintAccountSas({ account, key, permissions, expiry });
  const containerSas = (permissions = "rwdl") =>
    mintContainerSas({
      account,
      key,
      container: target.container,
      permissions,
    });

  const kitOptions = {
    url: keylessUrl(server, accountSas()),
    prefix: prefixOn(server, "kit-sas"),
  };
  await runCacheDriverConformance(
    "azure-blob over an account SAS",
    () => ({
      driver: azureBlobDriver(kitOptions),
      rawDump: async () => await azureRawDump(server, kitOptions.prefix),
    }),
    {
      crossProcess: {
        module: new URL("../../lib/drivers/azure.ts", import.meta.url).pathname,
        export: "azureBlobDriver",
        options: kitOptions,
      },
    },
  );

  describe("azureBlobDriver over a SAS, on Azurite", () => {
    test("a container SAS in sasToken (a leading ?) and a SAS connection string both work, sending no Authorization and the SAS on every request", async () => {
      const seen: { auth: string | null; sig: string | null }[] = [];
      const real = globalThis.fetch;
      globalThis.fetch = (async (
        input: Parameters<typeof fetch>[0],
        init?: RequestInit,
      ) => {
        const url = new URL(
          input instanceof Request ? input.url : input.toString(),
        );
        seen.push({
          auth: new Headers(init?.headers).get("authorization"),
          sig: url.searchParams.get("sig"),
        });
        return await real(input, init);
      }) as typeof fetch;
      try {
        const sas = containerSas();
        const fields = azureBlobDriver({
          connection: {
            endpoint: target.endpoint,
            container: target.container,
            sasToken: `?${sas}`,
          },
          prefix: prefixOn(server, "container-sas"),
        });
        const fromString = azureBlobDriver({
          connection: {
            connectionString: `BlobEndpoint=${target.endpoint};SharedAccessSignature=${sas}`,
            container: target.container,
          },
          prefix: prefixOn(server, "container-sas"),
        });
        await fields.connect!();
        await fields.set("ns", entry("k", [5]));
        expect((await fromString.get("ns", "k"))?.value).toEqual(
          new Uint8Array([5]),
        );
        expect(await fields.increment!("ns", "n", 3, null)).toBe(3);
        expect(await fromString.acquireLock!("ns", "l", "a", 60_000)).toBe(
          true,
        );
        expect(await fields.acquireLock!("ns", "l", "b", 60_000)).toBe(false);
        expect(await fromString.releaseLock!("ns", "l", "a")).toBe(true);
        await fields.clear("ns");
        expect(await fromString.get("ns", "k")).toBeUndefined();
        expect(seen.length).toBeGreaterThan(8);
        const sig = new URLSearchParams(sas).get("sig");
        expect(
          seen.every((each) => each.auth === null && each.sig === sig),
        ).toBe(true);
      } finally {
        globalThis.fetch = real;
      }
    });

    test("Azurite checks the SAS: a tampered signature and an expired SAS are refused, named", async () => {
      const tampered = accountSas().replace(/sig=[^&]/, (s) =>
        s.endsWith("A") ? "sig=B" : "sig=A",
      );
      const bad = azureBlobDriver({
        url: keylessUrl(server, tampered),
        prefix: prefixOn(server, "sas-refused"),
      });
      await expect(bad.connect!()).rejects.toThrow(/answered 403 .*sp=rwdl/);
      const expired = azureBlobDriver({
        url: keylessUrl(server, accountSas("rwdl", Date.now() - 60_000)),
        prefix: prefixOn(server, "sas-refused"),
      });
      await expect(expired.connect!()).rejects.toThrow(
        /answered 403 .*within its start and expiry/,
      );
    });

    test("the driver needs read, write, delete and list: a SAS lacking any one fails the operation that needs it, naming sp=rwdl", async () => {
      for (const mint of [accountSas, containerSas]) {
        const prefix = prefixOn(server, "permissions");
        const full = azureBlobDriver({
          url: keylessUrl(server, mint("rwdl")),
          prefix,
        });
        const lacking = (permissions: string) =>
          azureBlobDriver({
            url: keylessUrl(server, mint(permissions)),
            prefix,
          });
        await full.set("ns", entry("k", [1]));
        const hint =
          /answered 403 AuthorizationPermissionMismatch \(the SAS must grant read, write, delete and list — sp=rwdl/;
        // No list: connect (and the sweeper, and clear) cannot list.
        await expect(lacking("rwd").connect!()).rejects.toThrow(hint);
        await expect(lacking("rwd").clear("ns")).rejects.toThrow(hint);
        // No read: get cannot read.
        await expect(lacking("wdl").get("ns", "k")).rejects.toThrow(hint);
        // No write: set cannot replace.
        await expect(lacking("rdl").set("ns", entry("k", [2]))).rejects.toThrow(
          hint,
        );
        // No delete: delete cannot delete.
        await expect(lacking("rwl").delete("ns", ["k"])).rejects.toThrow(hint);
        // Create without write makes a blob but cannot replace one: write is needed.
        const createOnly = lacking("rcdl");
        await createOnly.set("ns", entry("fresh", [1]));
        await expect(createOnly.set("ns", entry("fresh", [2]))).rejects.toThrow(
          hint,
        );
        expect(await full.delete("ns", ["k", "fresh"])).toBe(2);
      }
    });
  });
}

/** The kit over a credential and over a token, and the refusal cases, on the HTTPS `--oauth basic` Azurite `server` (a Shared Key url) names. */
async function registerBearerSuite(server: string): Promise<void> {
  const url = keylessUrl(server);
  const insecureOrigin = new URL(resolveAzureTarget({ url: server }).endpoint)
    .origin;
  const fixture = new URL("./azure-auth-fixtures.ts", import.meta.url).pathname;

  for (const mode of ["credential", "token"] as const) {
    const prefix = prefixOn(server, `kit-${mode}`);
    const credential = mintingCredential();
    await runCacheDriverConformance(
      `azure-blob over a ${mode} (Entra ID)`,
      () => ({
        driver: azureBlobDriver({
          url,
          prefix,
          connection:
            mode === "credential"
              ? { credential }
              : { token: () => mintStorageJwt() },
        }),
        rawDump: async () => await azureRawDump(server, prefix),
      }),
      {
        crossProcess: {
          module: fixture,
          export: "azureBearerTestDriver",
          options: { url, mode, prefix, insecureOrigin },
        },
      },
    );
  }

  describe("azureBlobDriver over Entra ID, on Azurite with --oauth basic", () => {
    test("Azurite checks the token: a credential's expired token is refused, renewed, and the request goes through", async () => {
      let calls = 0;
      const credential: AzureTokenCredential = {
        getToken: async () => {
          calls++;
          // The first token claims an hour but is already past its exp: only
          // the server's refusal can show it.
          return await Promise.resolve({
            token: mintStorageJwt(calls === 1 ? -60 : 3600),
            expiresOnTimestamp: Date.now() + 3_600_000,
          });
        },
      };
      const driver = azureBlobDriver({
        url,
        prefix: prefixOn(server, "renewed"),
        connection: { credential },
      });
      await driver.set("ns", entry("k", [9]));
      expect((await driver.get("ns", "k"))?.value).toEqual(new Uint8Array([9]));
      expect(calls).toBe(2);
    });

    test("a token string Azurite refuses fails at once, naming the refusal; Shared Key still works beside it", async () => {
      const driver = azureBlobDriver({
        url,
        prefix: prefixOn(server, "refused"),
        connection: { token: mintStorageJwt(-60) },
      });
      await expect(driver.connect!()).rejects.toThrow(
        /answered 403 AuthenticationFailed \(the bearer token was refused/,
      );
      const shared = azureBlobDriver({
        url: server,
        prefix: prefixOn(server, "refused"),
      });
      await shared.connect!();
    });
  });
}
