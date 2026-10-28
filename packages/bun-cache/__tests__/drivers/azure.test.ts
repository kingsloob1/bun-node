/**
 * The Azure Blob Storage driver: the Shared Key signer against Microsoft's
 * documented strings to sign, the URL, connection-string and option rules,
 * and the listing parser — all without a server — then the conformance kit
 * (with its two-process pass) and the driver's specifics on the server
 * `BUN_CACHE_TEST_AZURE_URL` names: Azurite from
 * `bun scripts/setup-databases.ts --print-env`, which checks signatures.
 *
 * Test data: every blob carries this run's prefix
 * (`bun-cache-test/<pid>-<time>/…`), and the end of the file deletes exactly
 * the blobs under the prefixes it used. Unset, the backend skips visibly; set
 * but unreachable, it fails, naming the variable.
 */
import { Buffer } from "node:buffer";
import { createHmac } from "node:crypto";
import process from "node:process";
import { afterAll, describe, expect, test } from "bun:test";
import type { StoredEntry } from "../../lib/index";
import { azureBlobDriver, createCache } from "../../lib/index";
import type { AzureBlobDriverOptions } from "../../lib/drivers/azure";
import {
  AzureBlobCacheDriver,
  parseAzureUrl,
  parseBlobList,
  parseConnectionString,
  resolveAzureTarget,
} from "../../lib/drivers/azure";
import {
  azureEncode,
  azureFetch,
  azureStringToSign,
  canonicalizedResource,
  signAzureRequest,
} from "../../lib/drivers/azure-sign";
import { parseContentType } from "../../lib/drivers/blob-frame";
import { runCacheDriverConformance } from "../../lib/testing/index";
import { azureBackend, azureReachError, deleteAzurePrefix } from "./backends";
import { reportNotConfigured, reportUnreachable } from "./sqlSuite";

/** Azurite's published development key (not a secret). */
const DEV_KEY =
  "Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==";

/** An entry for the specifics. */
function entry(
  key: string,
  bytes: number[],
  tags: readonly string[] = [],
  expiresAt: number | null = null,
): StoredEntry {
  return { key, value: new Uint8Array(bytes), expiresAt, tags };
}

/** The URL a `fetch` call was given. */
function urlOf(input: Parameters<typeof fetch>[0]): URL {
  return new URL(input instanceof Request ? input.url : input.toString());
}

/** The hex SHA-256 of a name, as the driver's blob names use it. */
function sha(name: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(name);
  return hasher.digest("hex");
}

describe("the Shared Key signer", () => {
  // "Authorize with Shared Key" (Microsoft Learn), its worked strings to sign.
  const date = "Fri, 26 Jun 2015 23:39:12 GMT";

  test("Get Container Metadata: the documented string to sign", () => {
    expect(
      azureStringToSign("myaccount", {
        method: "GET",
        url: new URL(
          "http://myaccount.blob.core.windows.net/mycontainer?restype=container&comp=metadata&timeout=20",
        ),
        headers: { "x-ms-date": date, "x-ms-version": "2015-02-21" },
      }),
    ).toBe(
      `GET\n\n\n\n\n\n\n\n\n\n\n\nx-ms-date:${date}\nx-ms-version:2015-02-21\n/myaccount/mycontainer\ncomp:metadata\nrestype:container\ntimeout:20`,
    );
  });

  test("Create Container, Content-Length 0: signed as an empty line (version 2015-02-21 and later)", () => {
    expect(
      azureStringToSign("myaccount", {
        method: "PUT",
        url: new URL(
          "http://myaccount.blob.core.windows.net/mycontainer?restype=container&timeout=30",
        ),
        headers: { "x-ms-version": "2015-02-21", "x-ms-date": date },
        contentLength: 0,
      }),
    ).toBe(
      `PUT\n\n\n\n\n\n\n\n\n\n\n\nx-ms-date:${date}\nx-ms-version:2015-02-21\n/myaccount/mycontainer\nrestype:container\ntimeout:30`,
    );
  });

  test("the documented canonicalized resources: sorted names, several values sorted and comma-joined, the account once", () => {
    expect(
      canonicalizedResource(
        "myaccount",
        new URL(
          "http://myaccount.blob.core.windows.net/mycontainer?restype=container&comp=metadata",
        ),
      ),
    ).toBe("/myaccount/mycontainer\ncomp:metadata\nrestype:container");
    expect(
      canonicalizedResource(
        "myaccount",
        new URL(
          "http://myaccount.blob.core.windows.net/mycontainer?restype=container&comp=list&include=snapshots&include=metadata&include=uncommittedblobs",
        ),
      ),
    ).toBe(
      "/myaccount/mycontainer\ncomp:list\ninclude:metadata,snapshots,uncommittedblobs\nrestype:container",
    );
    expect(
      canonicalizedResource(
        "myaccount",
        new URL(
          "https://myaccount-secondary.blob.core.windows.net/mycontainer/myblob",
        ),
      ),
    ).toBe("/myaccount/mycontainer/myblob");
    // Against the emulator, the account appears twice, as the docs say.
    expect(
      canonicalizedResource(
        "devstoreaccount1",
        new URL("http://127.0.0.1:10000/devstoreaccount1/c/b?comp=lease"),
      ),
    ).toBe("/devstoreaccount1/devstoreaccount1/c/b\ncomp:lease");
    // Query values are decoded; names lower-cased.
    expect(
      canonicalizedResource(
        "a",
        new URL("http://h/c?Prefix=x%2Fy%20z&marker=m"),
      ),
    ).toBe("/a/c\nmarker:m\nprefix:x/y z");
  });

  test("the standard headers take their slots; every x-ms-* header is signed, sorted, whitespace folded", () => {
    expect(
      azureStringToSign("a", {
        method: "put",
        url: new URL("http://h/c/b"),
        headers: {
          "Content-Type": "application/x-bun-cache; exp=5",
          "If-Match": '"0x1"',
          "If-None-Match": "*",
          Range: "bytes=0-1",
          "x-ms-version": "2025-01-05",
          "X-MS-Date": "d",
          "x-ms-blob-type": "  Block   Blob ",
        },
        contentLength: 3,
      }).split("\n"),
    ).toEqual([
      "PUT",
      "",
      "",
      "3",
      "",
      "application/x-bun-cache; exp=5",
      "",
      "",
      '"0x1"',
      "*",
      "",
      "bytes=0-1",
      "x-ms-blob-type:Block Blob",
      "x-ms-date:d",
      "x-ms-version:2025-01-05",
      "/a/c/b",
    ]);
  });

  test("the signature is base64 HMAC-SHA256 of the string under the base64-decoded key", () => {
    const url = new URL("http://127.0.0.1:10000/devstoreaccount1/c/b");
    const when = new Date("2026-10-28T12:00:00Z");
    const headers = signAzureRequest(
      { account: "devstoreaccount1", key: DEV_KEY },
      { method: "GET", url, date: when },
    );
    expect(headers["x-ms-date"]).toBe("Wed, 28 Oct 2026 12:00:00 GMT");
    expect(headers["x-ms-version"]).toBe("2025-01-05");
    const expected = createHmac("sha256", Buffer.from(DEV_KEY, "base64"))
      .update(
        azureStringToSign("devstoreaccount1", { method: "GET", url, headers }),
        "utf8",
      )
      .digest("base64");
    expect(headers.authorization).toBe(
      `SharedKey devstoreaccount1:${expected}`,
    );
    expect(azureEncode("a b!'()*~._-é")).toBe("a%20b%21%27%28%29%2A~._-%C3%A9");
  });
});

describe("azureBlobDriver options", () => {
  test("parseAzureUrl: the endpoint is everything before the last path segment, the container that segment", () => {
    expect(
      parseAzureUrl(
        `azure://devstoreaccount1:${encodeURIComponent(DEV_KEY)}@127.0.0.1:10000/devstoreaccount1/bun-cache-test?scheme=http`,
      ),
    ).toEqual({
      endpoint: "http://127.0.0.1:10000/devstoreaccount1",
      container: "bun-cache-test",
      accountName: "devstoreaccount1",
      accountKey: DEV_KEY,
    });
    expect(
      parseAzureUrl("azure://acct:a2V5@acct.blob.core.windows.net/cache"),
    ).toEqual({
      endpoint: "https://acct.blob.core.windows.net",
      container: "cache",
      accountName: "acct",
      accountKey: "a2V5",
    });
    expect(() => parseAzureUrl("https://a:k@h/c")).toThrow(
      "must start with azure://",
    );
    expect(() => parseAzureUrl("azure://a:k@h")).toThrow("/<container>");
    expect(() => parseAzureUrl("azure://a:k@h/c?scheme=ftp")).toThrow(
      "https or http",
    );
    expect(() => parseAzureUrl("not a url")).toThrow("not a URL");
  });

  test("parseConnectionString: Azure's forms, keys in any case, a key's = kept, SAS refused", () => {
    expect(
      parseConnectionString(
        "DefaultEndpointsProtocol=https;AccountName=acct;AccountKey=a2V5==;EndpointSuffix=core.chinacloudapi.cn",
      ),
    ).toEqual({
      accountName: "acct",
      accountKey: "a2V5==",
      endpoint: "https://acct.blob.core.chinacloudapi.cn",
    });
    expect(
      parseConnectionString(
        "accountname=acct;ACCOUNTKEY=a2V5;BlobEndpoint=http://127.0.0.1:10000/acct;",
      ),
    ).toEqual({
      accountName: "acct",
      accountKey: "a2V5",
      endpoint: "http://127.0.0.1:10000/acct",
    });
    expect(parseConnectionString("UseDevelopmentStorage=true")).toEqual({
      accountName: "devstoreaccount1",
      accountKey: DEV_KEY,
      endpoint: "http://127.0.0.1:10000/devstoreaccount1",
    });
    expect(() =>
      parseConnectionString(
        "BlobEndpoint=https://h;SharedAccessSignature=sv=1",
      ),
    ).toThrow("SharedAccessSignature");
    expect(() => parseConnectionString("AccountName")).toThrow("name=value");
  });

  test("the URL wins over the fields, which win over the connection string; what is missing is named", () => {
    const target = resolveAzureTarget({
      url: "azure://u:dXJs@h.example/from-url",
      connection: {
        connectionString: "AccountName=cs;AccountKey=Y3M=",
        accountName: "field",
        container: "from-field",
      },
    });
    expect(target).toEqual({
      endpoint: "https://h.example",
      account: "u",
      key: "dXJs",
      container: "from-url",
    });
    expect(
      resolveAzureTarget({
        connection: {
          connectionString: "AccountName=cs;AccountKey=Y3M=",
          container: "c",
        },
      }),
    ).toEqual({
      endpoint: "https://cs.blob.core.windows.net",
      account: "cs",
      key: "Y3M=",
      container: "c",
    });
    expect(() => resolveAzureTarget({})).toThrow("needs a url or a connection");
    expect(() =>
      resolveAzureTarget({
        connection: { accountName: "a", accountKey: "a2V5" },
      }),
    ).toThrow("no container");
    expect(() =>
      resolveAzureTarget({ connection: { container: "c" } }),
    ).toThrow("no accountName, accountKey");
    // A key whose "+" was decoded to a space (not percent-encoded): refused, named.
    expect(() => resolveAzureTarget({ url: "azure://a:k%20ey@h/c" })).toThrow(
      "base64 key",
    );
    expect(() =>
      resolveAzureTarget({
        connection: {
          accountName: "a",
          accountKey: "not base64!",
          container: "c",
        },
      }),
    ).toThrow("base64 key");
  });

  test("refuses bad options, and has stamps, a sweeper, counters and locks, no bus", () => {
    const url = "azure://a:a2V5@127.0.0.1:1/a/c?scheme=http";
    expect(() => azureBlobDriver({ url, prefix: "" })).toThrow("prefix");
    expect(() => azureBlobDriver({ url, prefix: "/abs" })).toThrow("prefix");
    expect(() => azureBlobDriver({ url, maxEntries: 0 })).toThrow("maxEntries");
    expect(() => azureBlobDriver({ url, maxBytes: 1.5 })).toThrow("maxBytes");
    expect(new AzureBlobCacheDriver({ url, prefix: "p/" }).prefix).toBe("p");
    expect(new AzureBlobCacheDriver({ url }).prefix).toBe("bun-cache");
    expect(azureBlobDriver({ url }).capabilities).toEqual({
      multiProcess: true,
      ttl: "sweep",
      atomicIncrement: true,
      lock: true,
      tags: "stamps",
      fence: "atomic",
      bus: "none",
      maxEntryBytes: 5000 * 1024 ** 2 - 1024 ** 2,
    });
    expect(azureBlobDriver({ url }).name).toBe("azure-blob");
  });

  test("parseBlobList reads names, ETags, sizes, types and the next marker, decoding entities", () => {
    const xml =
      '<?xml version="1.0"?><EnumerationResults><Prefix>p/</Prefix><Marker/><Blobs>' +
      "<Blob><Name>p/a&amp;b&lt;c&gt;&apos;&quot;&#233;</Name><Properties><Last-Modified>Wed, 28 Oct 2026 17:13:41 GMT</Last-Modified><Etag>0x21ED</Etag><Content-Length>3</Content-Length><Content-Type>application/x-bun-cache; exp=5; at=4</Content-Type></Properties><Metadata><exp>9</exp></Metadata></Blob>" +
      "<Blob><Name>p/b</Name><Properties><Etag>0x1</Etag><Content-Length>0</Content-Length></Properties></Blob>" +
      "</Blobs><NextMarker>2!8!bWFy</NextMarker></EnumerationResults>";
    expect(parseBlobList(xml)).toEqual({
      blobs: [
        {
          name: "p/a&b<c>'\"é",
          etag: "0x21ED",
          size: 3,
          type: "application/x-bun-cache; exp=5; at=4",
          lastModified: Date.parse("Wed, 28 Oct 2026 17:13:41 GMT"),
        },
        { name: "p/b", etag: "0x1", size: 0, type: "", lastModified: 0 },
      ],
      next: "2!8!bWFy",
    });
    expect(
      parseBlobList(
        "<EnumerationResults><Blobs/><NextMarker/></EnumerationResults>",
      ),
    ).toEqual({ blobs: [], next: undefined });
  });
});

const azure = azureBackend();
if (azure.url === undefined) {
  reportNotConfigured("azure", azure.variable);
} else {
  const unreachable = await azureReachError(azure.url);
  if (unreachable !== undefined) {
    reportUnreachable("azure", azure.variable, unreachable);
  } else {
    await registerAzureSuite(azure.url);
  }
}

/** Registers the kit and the specifics against the server at `url`. */
async function registerAzureSuite(url: string): Promise<void> {
  const run = `bun-cache-test/${process.pid}-${Date.now().toString(36)}`;
  const prefixes = new Set<string>();
  /** A prefix of this run's, recorded so the end of the file deletes its blobs. */
  const prefix = (suffix: string): string => {
    const value = `${run}/${suffix}`;
    prefixes.add(value);
    return value;
  };
  /** A driver on this run's blobs. */
  const make = (
    suffix: string,
    extra: Partial<AzureBlobDriverOptions> = {},
  ): AzureBlobCacheDriver =>
    new AzureBlobCacheDriver({ url, prefix: prefix(suffix), ...extra });
  const target = resolveAzureTarget({ url });
  /** Every blob under a driver's prefix, as the listing reports them. */
  const listed = async (driver: AzureBlobCacheDriver) => {
    const response = await azureFetch(target, {
      method: "GET",
      blob: "",
      query: {
        restype: "container",
        comp: "list",
        prefix: `${driver.prefix}/`,
      },
    });
    return parseBlobList(await response.text()).blobs;
  };
  /** The requests the driver sends while `body` runs, by method (it swaps `fetch` for the duration). */
  const recording = async (
    body: () => Promise<void>,
    hold?: { method: string; until: Promise<void> },
  ): Promise<string[]> => {
    const sent: string[] = [];
    const real = globalThis.fetch;
    globalThis.fetch = (async (
      input: Parameters<typeof fetch>[0],
      init?: RequestInit,
    ) => {
      const method = init?.method ?? "GET";
      const where = urlOf(input);
      sent.push(`${method} ${where.searchParams.get("comp") ?? "blob"}`);
      if (hold !== undefined && method === hold.method) {
        await hold.until;
      }
      return await real(input, init);
    }) as typeof fetch;
    try {
      await body();
    } finally {
      globalThis.fetch = real;
    }
    return sent;
  };

  afterAll(async () => {
    for (const each of prefixes) {
      await deleteAzurePrefix(url, each);
    }
  });

  const kitOptions = { url, prefix: prefix("kit") };
  await runCacheDriverConformance(
    "azure-blob",
    () => ({ driver: azureBlobDriver(kitOptions) }),
    {
      crossProcess: {
        module: new URL("../../lib/drivers/azure.ts", import.meta.url).pathname,
        export: "azureBlobDriver",
        options: kitOptions,
      },
    },
  );

  describe("azureBlobDriver specifics", () => {
    test("the layout: entries and counters under e/<hh>/, stamps under s/, locks under l/, each typed in the listing", async () => {
      const driver = make("layout");
      const before = Date.now();
      await driver.set(
        "App",
        entry("some:key", [1, 2, 3], ["t"], before + 60_000),
      );
      await driver.setStamps("App", ["users"], before, before + 60_000);
      await driver.increment("App", "hits", 3, null);
      expect(await driver.acquireLock("App", "held", "owner", 60_000)).toBe(
        true,
      );
      const ns = `${driver.prefix}/^app`;
      const keySha = sha("some:key");
      const hitsSha = sha("hits");
      const blobs = await listed(driver);
      expect(blobs.map((blob) => blob.name).sort()).toEqual(
        [
          `${ns}/e/${keySha.slice(0, 2)}/${keySha}`,
          `${ns}/e/${hitsSha.slice(0, 2)}/${hitsSha}`,
          `${ns}/l/${sha("held")}`,
          `${ns}/s/${sha("users")}`,
        ].sort(),
      );
      const typeOf = (name: string) =>
        parseContentType(blobs.find((blob) => blob.name === name)?.type);
      const typed = typeOf(`${ns}/e/${keySha.slice(0, 2)}/${keySha}`);
      expect(typed.kind).toBe("entry");
      expect(typed.expiresAt).toBe(before + 60_000);
      expect(typed.at).toBeGreaterThanOrEqual(before);
      expect(typeOf(`${ns}/e/${hitsSha.slice(0, 2)}/${hitsSha}`).kind).toBe(
        "counter",
      );
      expect(typeOf(`${ns}/l/${sha("held")}`).kind).toBe("lock");
      expect(typeOf(`${ns}/s/${sha("users")}`).expiresAt).toBe(before + 60_000);
    });

    test("namespaces of dots, and ones differing in case, are distinct and never resolved away", async () => {
      const driver = make("segments");
      for (const [index, ns] of [".", "..", "...", "a", "A"].entries()) {
        await driver.set(ns, entry("k", [index]));
      }
      for (const [index, ns] of [".", "..", "...", "a", "A"].entries()) {
        expect((await driver.get(ns, "k"))?.value).toEqual(
          new Uint8Array([index]),
        );
      }
      const blobs = await listed(driver);
      expect(blobs).toHaveLength(5);
      expect(blobs.every((blob) => !/\/\.+\//.test(blob.name))).toBe(true);
    });

    test("an entry and a counter share their key's blob; delete counts with one request per key", async () => {
      const driver = make("share");
      await driver.set("ns", entry("k", [9]));
      expect(await driver.increment("ns", "k", 2, null)).toBe(2);
      expect(await driver.get("ns", "k")).toBeUndefined();
      expect((await driver.getCounter("ns", "k"))?.value).toBe(2);
      await driver.set("ns", entry("k", [8]));
      expect(await driver.getCounter("ns", "k")).toBeUndefined();
      expect((await driver.get("ns", "k"))?.value).toEqual(new Uint8Array([8]));
      await driver.increment("ns", "c", 1, null);
      let count = 0;
      const sent = await recording(async () => {
        count = await driver.delete("ns", ["k", "c", "none"]);
      });
      expect(count).toBe(2);
      expect(sent).toEqual(["DELETE blob", "DELETE blob", "DELETE blob"]);
    });

    test("a lapsed counter starts again, with the expiry of the call that recreates it", async () => {
      const driver = make("lapsed");
      await driver.increment("ns", "c", 5, Date.now() + 30);
      await Bun.sleep(50);
      const fresh = Date.now() + 60_000;
      expect(await driver.increment("ns", "c", 1, fresh)).toBe(1);
      expect((await driver.getCounter("ns", "c"))?.expiresAt).toBe(fresh);
    });

    test("concurrent increments of one key are batched: each caller gets its own value, in a few writes", async () => {
      const driver = make("batch");
      let results: number[] = [];
      const sent = await recording(async () => {
        results = await Promise.all(
          Array.from(
            { length: 50 },
            async (_, index) =>
              await driver.increment("ns", "c", index % 2 === 0 ? 1 : 2, null),
          ),
        );
      });
      expect(Math.max(...results)).toBe(75);
      expect(new Set(results).size).toBe(50);
      expect((await driver.getCounter("ns", "c"))?.value).toBe(75);
      // One batch: one read and one create, not 50 contenders.
      expect(
        sent.filter((line) => line === "PUT blob").length,
      ).toBeLessThanOrEqual(2);
    });

    test("two drivers incrementing one key lose nothing (compare-and-swap across instances)", async () => {
      const a = make("cas");
      const b = new AzureBlobCacheDriver({ url, prefix: a.prefix });
      const results = await Promise.all(
        Array.from(
          { length: 60 },
          async (_, index) =>
            await (index % 2 === 0 ? a : b).increment("ns", "c", 1, null),
        ),
      );
      expect(new Set(results).size).toBe(60);
      expect((await a.getCounter("ns", "c"))?.value).toBe(60);
    });

    test("a lapsed lock is taken over by exactly one of many contenders, and the old owner cannot release it", async () => {
      const driver = make("takeover");
      expect(await driver.acquireLock("ns", "k", "old", 30)).toBe(true);
      await Bun.sleep(60);
      const outcomes = await Promise.all(
        Array.from(
          { length: 20 },
          async (_, index) =>
            await driver.acquireLock("ns", "k", `new-${index}`, 30_000),
        ),
      );
      expect(outcomes.filter(Boolean)).toHaveLength(1);
      expect(await driver.releaseLock("ns", "k", "old")).toBe(false);
      const winner = `new-${outcomes.indexOf(true)}`;
      expect(await driver.acquireLock("ns", "k", winner, 30_000)).toBe(true);
      expect(await driver.acquireLock("ns", "k", "late", 30_000)).toBe(false);
      expect(await driver.releaseLock("ns", "k", winner)).toBe(true);
      expect(await driver.releaseLock("ns", "k", winner)).toBe(false);
    });

    test("across instances, only the store's conditions decide: one of ten takes a free lock, one of ten a lapsed one", async () => {
      // Separate instances share no in-process queue, as separate processes.
      const first = make("instances");
      const drivers = [
        first,
        ...Array.from(
          { length: 9 },
          () => new AzureBlobCacheDriver({ url, prefix: first.prefix }),
        ),
      ];
      const free = await Promise.all(
        drivers.map(
          async (driver, index) =>
            await driver.acquireLock("ns", "free", `d-${index}`, 60_000),
        ),
      );
      expect(free.filter(Boolean)).toHaveLength(1);
      expect(await first.acquireLock("ns", "lapsed", "old", 30)).toBe(true);
      await Bun.sleep(60);
      const lapsed = await Promise.all(
        drivers.map(
          async (driver, index) =>
            await driver.acquireLock("ns", "lapsed", `d-${index}`, 60_000),
        ),
      );
      expect(lapsed.filter(Boolean)).toHaveLength(1);
    });

    test("touch rewrites an entry's expiry and type, keeping its value and tags; and a counter's", async () => {
      const driver = make("touch");
      await driver.set("ns", entry("k", [1, 2], ["a"], Date.now() + 60_000));
      expect(await driver.touch("ns", "k", null)).toBe(true);
      expect(await driver.get("ns", "k")).toEqual(
        entry("k", [1, 2], ["a"], null),
      );
      expect(
        parseContentType((await listed(driver))[0].type).expiresAt,
      ).toBeNull();
      await driver.increment("ns", "c", 4, null);
      const until = Date.now() + 60_000;
      expect(await driver.touch("ns", "c", until)).toBe(true);
      expect(await driver.getCounter("ns", "c")).toMatchObject({
        value: 4,
        expiresAt: until,
      });
      expect(await driver.touch("ns", "missing", until)).toBe(false);
    });

    test("an expired entry is a miss, and its blob is deleted in the background", async () => {
      const driver = make("lazy");
      await driver.set("ns", entry("k", [1], [], Date.now() - 1));
      expect(await driver.get("ns", "k")).toBeUndefined();
      const deadline = Date.now() + 5_000;
      while ((await listed(driver)).length > 0) {
        if (Date.now() > deadline) {
          throw new Error("the expired blob was never deleted");
        }
        await Bun.sleep(20);
      }
    });

    test("the background delete of an expired entry spares a write that landed after the read", async () => {
      const driver = make("lazy-race");
      const writer = new AzureBlobCacheDriver({ url, prefix: driver.prefix });
      await driver.set("ns", entry("k", [1], [], Date.now() - 1));
      let release!: () => void;
      const until = new Promise<void>((resolve) => {
        release = resolve;
      });
      // The read sees the expired entry; its DELETE is held until a new
      // value has been written, then let go.
      const sent = await recording(
        async () => {
          expect(await driver.get("ns", "k")).toBeUndefined();
        },
        { method: "DELETE", until },
      );
      expect(sent).toEqual(["GET blob", "DELETE blob"]);
      await writer.set("ns", entry("k", [2]));
      release();
      await Bun.sleep(200);
      expect((await writer.get("ns", "k"))?.value).toEqual(new Uint8Array([2]));
    });

    test("a stamp only moves forward: an older invalidation landing last does not undo a newer one", async () => {
      const driver = make("stamps");
      const now = Date.now();
      await driver.setStamps("ns", ["t"], now, now + 60_000);
      await driver.setStamps("ns", ["t"], now - 500, now + 30_000);
      expect((await driver.getStamps("ns", ["t"])).get("t")).toBe(now);
      await driver.setStamps("ns", ["t"], now + 5, now + 10_000);
      expect((await driver.getStamps("ns", ["t"])).get("t")).toBe(now + 5);
      expect(parseContentType((await listed(driver))[0].type).expiresAt).toBe(
        now + 60_000,
      );
      const other = new AzureBlobCacheDriver({ url, prefix: driver.prefix });
      await Promise.all([
        driver.setStamps("ns", ["u"], now + 100, now + 60_000),
        other.setStamps("ns", ["u"], now + 50, now + 60_000),
        driver.setStamps("ns", ["u"], now + 10, now + 60_000),
      ]);
      expect((await driver.getStamps("ns", ["u"])).get("u")).toBe(now + 100);
    });

    test("clear deletes the namespace's entries and counters, and leaves its stamps, locks and neighbours", async () => {
      const driver = make("clear");
      await driver.set("ns", entry("k", [1]));
      await driver.set("other", entry("k", [2]));
      await driver.increment("ns", "c", 1, null);
      await driver.setStamps("ns", ["t"], Date.now(), Date.now() + 60_000);
      await driver.acquireLock("ns", "l", "me", 60_000);
      await driver.clear("ns");
      expect(await driver.get("ns", "k")).toBeUndefined();
      expect(await driver.getCounter("ns", "c")).toBeUndefined();
      expect((await driver.get("other", "k"))?.value).toEqual(
        new Uint8Array([2]),
      );
      expect((await driver.getStamps("ns", ["t"])).has("t")).toBe(true);
      expect(await driver.acquireLock("ns", "l", "other", 60_000)).toBe(false);
    });

    test("clear finishes past a blob it cannot delete (leased by someone else), and deletes the rest", async () => {
      const driver = make("clear-leased");
      await driver.set("ns", entry("held", [1]));
      await driver.set("ns", entry("free", [2]));
      const held = (await listed(driver)).find((blob) =>
        blob.name.endsWith(sha("held")),
      )!.name;
      const lease = async (headers: Record<string, string>) => {
        const response = await azureFetch(target, {
          method: "PUT",
          blob: held,
          query: { comp: "lease" },
          headers,
        });
        await response.body?.cancel();
        return response.status;
      };
      expect(
        await lease({
          "x-ms-lease-action": "acquire",
          "x-ms-lease-duration": "-1",
          "x-ms-proposed-lease-id": crypto.randomUUID(),
        }),
      ).toBe(201);
      try {
        await Promise.race([
          driver.clear("ns"),
          Bun.sleep(3_000).then(() => {
            throw new Error("clear did not finish");
          }),
        ]);
        expect(await driver.get("ns", "free")).toBeUndefined();
        expect((await driver.get("ns", "held"))?.value).toEqual(
          new Uint8Array([1]),
        );
      } finally {
        // Broken at once, so the run's cleanup can delete it.
        await lease({
          "x-ms-lease-action": "break",
          "x-ms-lease-break-period": "0",
        });
      }
    });

    test("the sweeper deletes expired entries, counters, stamps and locks, keeps live ones, and reads only the listing", async () => {
      const driver = make("sweep");
      const now = Date.now();
      await driver.set("ns", entry("dead", [1], [], now - 1));
      await driver.set("ns", entry("live", [2], [], now + 60_000));
      await driver.set("ns", entry("forever", [3]));
      await driver.increment("ns", "dead-counter", 1, now + 20);
      await driver.setStamps("ns", ["old"], now - 2_000, now - 1);
      await driver.acquireLock("ns", "old-lock", "me", 20);
      await Bun.sleep(40);
      let swept = 0;
      const sent = await recording(async () => {
        swept = await driver.sweep(Date.now(), 1_000);
      });
      // The expired entry and counter are counted; the stamp and lock go too.
      expect(swept).toBe(2);
      expect(sent.sort()).toEqual([
        "DELETE blob",
        "DELETE blob",
        "DELETE blob",
        "DELETE blob",
        "GET list",
      ]);
      expect(await listed(driver)).toHaveLength(2);
      expect((await driver.get("ns", "live"))?.value).toEqual(
        new Uint8Array([2]),
      );
      expect((await driver.get("ns", "forever"))?.value).toEqual(
        new Uint8Array([3]),
      );
      // A limit bounds a pass.
      await driver.set("ns", entry("d1", [1], [], now - 1));
      await driver.set("ns", entry("d2", [1], [], now - 1));
      expect(await driver.sweep(Date.now(), 1)).toBe(1);
      expect(await driver.sweep(Date.now(), 1)).toBe(1);
      expect(await driver.sweep(Date.now(), 1)).toBe(0);
    });

    test("the sweeper's delete spares a blob rewritten after it was listed", async () => {
      const driver = make("sweep-race");
      const writer = new AzureBlobCacheDriver({ url, prefix: driver.prefix });
      await driver.set("ns", entry("k", [1], [], Date.now() - 1));
      let release!: () => void;
      const until = new Promise<void>((resolve) => {
        release = resolve;
      });
      let swept = -1;
      const sweeping = recording(
        async () => {
          swept = await driver.sweep(Date.now(), 1_000);
        },
        { method: "DELETE", until },
      );
      // Rewritten (live now) while the sweeper's DELETE waits.
      await Bun.sleep(100);
      await writer.set("ns", entry("k", [2], [], Date.now() + 60_000));
      release();
      await sweeping;
      expect(swept).toBe(0);
      expect((await writer.get("ns", "k"))?.value).toEqual(new Uint8Array([2]));
    });

    test("the sweeper pages through more blobs than one listing holds", async () => {
      // 5000 a page is Azure's ceiling; a smaller page proves the marker loop.
      const driver = make("pages");
      await Promise.all(
        Array.from(
          { length: 12 },
          async (_, index) =>
            await driver.set(
              "ns",
              entry(`k${index}`, [index], [], Date.now() - 1),
            ),
        ),
      );
      const real = globalThis.fetch;
      let lists = 0;
      globalThis.fetch = (async (
        input: Parameters<typeof fetch>[0],
        init?: RequestInit,
      ) => {
        const where = urlOf(input);
        if (where.searchParams.get("comp") === "list") {
          lists++;
          // A smaller page, signed again: the query is in the signature.
          where.searchParams.set("maxresults", "5");
          return await real(where, {
            ...init,
            headers: signAzureRequest(target, { method: "GET", url: where }),
          });
        }
        return await real(input, init);
      }) as typeof fetch;
      let swept: number;
      try {
        swept = await driver.sweep(Date.now(), 1_000);
      } finally {
        globalThis.fetch = real;
      }
      expect(swept).toBe(12);
      expect(lists).toBe(3);
    });

    test("maxEntries and maxBytes evict the oldest writes first; counters are never counted or evicted", async () => {
      const capped = make("caps", { maxEntries: 2 });
      await capped.increment("ns", "counter", 1, null);
      for (const key of ["old", "mid", "new"]) {
        await capped.set("ns", entry(key, [1]));
        await Bun.sleep(5); // the write time is in ms; Last-Modified is not
      }
      await capped.sweep(Date.now(), 1_000);
      expect(await capped.get("ns", "old")).toBeUndefined();
      expect(await capped.get("ns", "mid")).toBeDefined();
      expect(await capped.get("ns", "new")).toBeDefined();
      expect((await capped.getCounter("ns", "counter"))?.value).toBe(1);

      const bytes = make("bytes", { maxBytes: 250 });
      for (const key of ["a", "b", "c"]) {
        await bytes.set(
          "ns",
          entry(
            key,
            Array.from({ length: 100 }, () => 7),
          ),
        );
        await Bun.sleep(5);
      }
      await bytes.sweep(Date.now(), 1_000);
      expect(await bytes.get("ns", "a")).toBeUndefined();
      expect(await bytes.get("ns", "b")).toBeDefined();
      expect(await bytes.get("ns", "c")).toBeDefined();
    });

    test("the store checks signatures, so the signing is proven: a wrong key is refused", async () => {
      const wrong = new AzureBlobCacheDriver({
        connection: {
          accountName: target.account,
          accountKey: Buffer.from("not-the-key").toString("base64"),
          endpoint: target.endpoint,
          container: target.container,
        },
        prefix: prefix("wrong"),
      });
      await expect(wrong.connect()).rejects.toThrow(/403/);
      await expect(wrong.set("ns", entry("k", [1]))).rejects.toThrow(/403/);
    });

    test("a missing blob container is named when connecting", async () => {
      const driver = new AzureBlobCacheDriver({
        connection: {
          accountName: target.account,
          accountKey: target.key,
          endpoint: target.endpoint,
          container: `no-such-${process.pid}`,
        },
      });
      await expect(driver.connect()).rejects.toThrow(`no-such-${process.pid}`);
      await expect(driver.connect()).rejects.toThrow("ContainerNotFound");
    });

    test.skipIf(target.endpoint !== "http://127.0.0.1:10000/devstoreaccount1")(
      "UseDevelopmentStorage=true reaches the local Azurite",
      async () => {
        const driver = new AzureBlobCacheDriver({
          connection: {
            connectionString: "UseDevelopmentStorage=true",
            container: target.container,
          },
          prefix: prefix("devstorage"),
        });
        await driver.set("ns", entry("k", [4]));
        expect((await driver.get("ns", "k"))?.value).toEqual(
          new Uint8Array([4]),
        );
      },
    );

    test("a cache on the driver: tags invalidate through the stamps, counters count", async () => {
      const cache = createCache({ driver: make("cache"), namespace: "app" });
      await cache.set("user:1", { name: "a" }, { tags: ["users"] });
      expect(await cache.get("user:1")).toEqual({ name: "a" });
      await cache.invalidateTags(["users"]);
      expect(await cache.get("user:1")).toBeUndefined();
      expect(await cache.increment("hits")).toBe(1);
      expect(await cache.increment("hits", 4)).toBe(5);
      await cache.close();
    });
  });
}
