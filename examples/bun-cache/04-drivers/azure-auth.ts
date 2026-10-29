/**
 * The Azure Blob Storage driver's other ways to authorize — a shared access
 * signature (SAS) three ways, the rule that exactly one way may be given, and
 * the shape of a Microsoft Entra ID `credential` (PR #582).
 *
 * ```bash
 * bun scripts/setup-databases.ts --only=azure          # a local Azurite
 * eval "$(bun scripts/setup-databases.ts --print-env)"
 * EXAMPLE_AZURE_URL="$BUN_CACHE_TEST_AZURE_URL" bun 04-drivers/azure-auth.ts
 * ```
 *
 * - It runs when `EXAMPLE_AZURE_URL` (or `BUN_CACHE_TEST_AZURE_URL`) is set
 *   and otherwise prints `skipped:` and exits 0. A URL that is set but
 *   unreachable fails.
 * - The account key in that URL is used here only to mint a container SAS
 *   (`rwdl`, an hour) with `node:crypto`, the way Azure documents "Create a
 *   service SAS"; the caches then hold no key, only the SAS. Azurite checks
 *   SAS signatures and permissions, so a wrong one would be refused.
 * - The same SAS is given to the driver as `connection.sasToken`, as
 *   `SharedAccessSignature=` in a connection string, and as the query of an
 *   `azure://` url. Each writes under a prefix naming this process; at the end
 *   the example lists those prefixes with the SAS and deletes each blob it
 *   finds, even when a check failed. The container is never touched.
 * - Entra ID is not run: it needs HTTPS and a tenant. The last part shows the
 *   `credential` shape with a stub that mints nothing, and that combining
 *   ways is a `TypeError` naming both and where each came from.
 */
import { Buffer } from "node:buffer";
import { createHmac } from "node:crypto";
import process from "node:process";
import { azureBlobDriver, createCache } from "@kingsleyweb/bun-cache";
import type { AzureTokenCredential } from "@kingsleyweb/bun-cache";
import { check, checkEqual, summary } from "../shared/check";
import { show, step, title } from "../shared/console";

const url =
  process.env.EXAMPLE_AZURE_URL ?? process.env.BUN_CACHE_TEST_AZURE_URL;

if (!url) {
  console.log(
    "skipped: set EXAMPLE_AZURE_URL (for instance the azure://devstoreaccount1:…@127.0.0.1:10000/devstoreaccount1/bun-cache-test?scheme=http that `bun scripts/setup-databases.ts --print-env` prints for a local Azurite) to run this example",
  );
  process.exit(0);
}

title("the Azure Blob Storage driver: SAS and Entra ID authorization");

/** The URL's parts: the account, its key (used only to mint the SAS), the endpoint and the container. */
const parsed = new URL(url);
const account = decodeURIComponent(parsed.username);
const accountKey = decodeURIComponent(parsed.password);
const pathParts = parsed.pathname.split("/").filter((part) => part !== "");
const container = pathParts.pop() ?? "";
const scheme = parsed.searchParams.get("scheme") ?? "https";
const endpoint = `${scheme}://${parsed.host}${pathParts.map((part) => `/${part}`).join("")}`;

/** The three prefixes of this run: it names this process, so a run owns its blobs. */
const prefixes = {
  field: `bun-cache-example/${process.pid}-auth-field`,
  string: `bun-cache-example/${process.pid}-auth-string`,
  url: `bun-cache-example/${process.pid}-auth-url`,
};

/** A time as a SAS wants it: ISO 8601, UTC, whole seconds. */
function sasTime(epochMs: number): string {
  return `${new Date(epochMs).toISOString().slice(0, 19)}Z`;
}

/** The SAS version signed with (2020-12-06 and later have the encryption-scope line). */
const SAS_VERSION = "2022-11-02";

/**
 * A container SAS: permissions, start, expiry, the canonicalized resource
 * `/blob/<account>/<container>`, identifier, IP, protocol, version, resource
 * (`c`), then the snapshot time, encryption scope and five response headers,
 * newline-joined and signed with HMAC-SHA256 under the base64 account key.
 */
function mintContainerSas(permissions: string): string {
  const expiry = sasTime(Date.now() + 3_600_000);
  const protocol = "https,http";
  const toSign = [
    permissions,
    "",
    expiry,
    `/blob/${account}/${container}`,
    "",
    "",
    protocol,
    SAS_VERSION,
    "c",
    ...Array.from({ length: 7 }, () => ""),
  ].join("\n");
  const sig = createHmac("sha256", Buffer.from(accountKey, "base64"))
    .update(toSign, "utf8")
    .digest("base64");
  return new URLSearchParams({
    sv: SAS_VERSION,
    sp: permissions,
    se: expiry,
    spr: protocol,
    sr: "c",
    sig,
  }).toString();
}

const sas = mintContainerSas("rwdl");

/** Every blob name under `prefix`, listed with the SAS. */
async function listed(prefix: string): Promise<string[]> {
  const names: string[] = [];
  let marker = "";
  do {
    const target = new URL(`${endpoint}/${container}`);
    target.search = `${sas}&restype=container&comp=list&prefix=${encodeURIComponent(`${prefix}/`)}${marker === "" ? "" : `&marker=${encodeURIComponent(marker)}`}`;
    const response = await fetch(target);
    if (!response.ok) {
      throw new Error(`listing answered ${response.status}`);
    }
    const xml = await response.text();
    for (const [, name] of xml.matchAll(/<Name>([^<]*)<\/Name>/g)) {
      names.push(name ?? "");
    }
    marker = /<NextMarker>([^<]*)<\/NextMarker>/.exec(xml)?.[1] ?? "";
  } while (marker !== "");
  return names;
}

/** Deletes the blob `name` with the SAS. */
async function remove(name: string): Promise<void> {
  const target = new URL(
    `${endpoint}/${container}/${name.split("/").map(encodeURIComponent).join("/")}`,
  );
  target.search = sas;
  await fetch(target, { method: "DELETE" });
}

try {
  await listed(prefixes.field);
} catch (error) {
  throw new Error("EXAMPLE_AZURE_URL is set but unreachable", { cause: error });
}

try {
  /* ------------------------------------------------------------------ */
  step("a SAS minted here, never an account key in the caches");

  show("SAS", sas.replace(/sig=[^&]*/, "sig=…"));
  check(
    "the token is a container SAS with a signature",
    sas.includes("sr=c") && sas.includes("sig="),
    sas,
  );

  /** A cache over `driver`, with a unique key per call so a re-run never meets old data. */
  const run = async (
    label: string,
    driver: ReturnType<typeof azureBlobDriver>,
    prefix: string,
  ) => {
    const cache = createCache({
      driver,
      namespace: "auth",
      ttl: 60_000,
      sweepInterval: 0,
    });
    checkEqual(
      `${label}: set stores a value`,
      await cache.set("k", `via ${label}`),
      true,
    );
    checkEqual(
      `${label}: get reads it back`,
      await cache.get("k"),
      `via ${label}`,
    );
    let loads = 0;
    const load = () => {
      loads++;
      return Promise.resolve(42);
    };
    await cache.getOrSet("n", load);
    await cache.getOrSet("n", load);
    checkEqual(`${label}: getOrSet loaded once`, loads, 1);
    checkEqual(
      `${label}: a counter counts`,
      await cache.increment("hits", 2),
      2,
    );
    await cache.close();
    check(
      `${label}: its blobs are under ${prefix}`,
      (await listed(prefix)).length >= 3,
      await listed(prefix),
    );
  };

  /* ------------------------------------------------------------------ */
  step("connection.sasToken");

  await run(
    "sasToken",
    azureBlobDriver({
      prefix: prefixes.field,
      connection: { endpoint, container, sasToken: sas },
    }),
    prefixes.field,
  );

  /* ------------------------------------------------------------------ */
  step("SharedAccessSignature= in a connection string");

  await run(
    "connection string",
    azureBlobDriver({
      prefix: prefixes.string,
      connection: {
        connectionString: `BlobEndpoint=${endpoint};SharedAccessSignature=${sas}`,
        container,
      },
    }),
    prefixes.string,
  );

  /* ------------------------------------------------------------------ */
  step("the SAS as the query of an azure:// url");

  const sasUrl = `azure://${parsed.host}${parsed.pathname}?scheme=${scheme}&${sas}`;
  await run(
    "url",
    azureBlobDriver({ url: sasUrl, prefix: prefixes.url }),
    prefixes.url,
  );

  /* ------------------------------------------------------------------ */
  step("a SAS without the permission is refused");

  const readOnly = createCache({
    driver: azureBlobDriver({
      prefix: prefixes.field,
      connection: { endpoint, container, sasToken: mintContainerSas("r") },
    }),
    namespace: "auth",
    sweepInterval: 0,
  });
  const errors: string[] = [];
  readOnly.on("error", (event) => errors.push(String(event.error)));
  let refused: unknown;
  try {
    await readOnly.set("denied", "x");
  } catch (error) {
    refused = error;
  }
  show("a write with a read-only SAS", refused ?? errors);
  check(
    "…as one error event naming the 403",
    refused === undefined &&
      errors.length === 1 &&
      errors[0]?.includes("403") === true,
    { refused, errors },
  );
  checkEqual("and nothing was stored", await readOnly.get("denied"), undefined);
  await readOnly.close();

  /* ------------------------------------------------------------------ */
  step("exactly one way to authorize: any two are a TypeError");

  /** The `TypeError` message `make` throws, or `undefined` when it does not throw. */
  const typeErrorOf = (make: () => unknown): string | undefined => {
    try {
      make();
    } catch (error) {
      return error instanceof TypeError
        ? error.message
        : `not a TypeError: ${String(error)}`;
    }
    return undefined;
  };

  const keyAndSas = typeErrorOf(() =>
    azureBlobDriver({ url, connection: { sasToken: sas } }),
  );
  show("an account key (url) and a sasToken", keyAndSas);
  check(
    "a key in the url and a sasToken is a TypeError naming both",
    keyAndSas?.includes("accountKey") === true &&
      keyAndSas.includes("sasToken") === true,
    keyAndSas,
  );

  const sasTwice = typeErrorOf(() => azureBlobDriver({ url: `${url}&${sas}` }));
  show("a url with both a key and a SAS", sasTwice);
  check(
    "a url with a key and a SAS is a TypeError",
    sasTwice?.includes("accountKey") === true &&
      sasTwice.includes("sasToken") === true,
    sasTwice,
  );

  const noSig = typeErrorOf(() =>
    azureBlobDriver({ url: "azure://h/c?sv=2022-11-02&sp=rwdl" }),
  );
  show("a SAS query with no signature", noSig);
  check(
    "a query with no sig is refused",
    noSig?.includes("no sig") === true,
    noSig,
  );

  /* ------------------------------------------------------------------ */
  step("Microsoft Entra ID: the credential's shape (not run)");

  /** Anything with `getToken(scopes)` will do, `@azure/identity`'s credentials included; this stub mints nothing. */
  const credential: AzureTokenCredential = {
    getToken: async (scopes) => {
      show("asked for", scopes);
      return await Promise.resolve(null);
    },
  };
  const bearer = typeErrorOf(() =>
    azureBlobDriver({
      url: "azure://myacct.blob.core.windows.net/cache",
      connection: { credential },
    }),
  );
  checkEqual(
    "a credential on a url with no key builds a driver (no request is made yet)",
    bearer,
    undefined,
  );

  const credentialAndSas = typeErrorOf(() =>
    azureBlobDriver({
      url: "azure://myacct.blob.core.windows.net/cache",
      connection: { credential, sasToken: sas },
    }),
  );
  show("a credential and a sasToken", credentialAndSas);
  check(
    "a credential and a sasToken is a TypeError",
    credentialAndSas?.includes("credential") === true &&
      credentialAndSas.includes("sasToken") === true,
    credentialAndSas,
  );

  const credentialAndToken = typeErrorOf(() =>
    azureBlobDriver({
      url: "azure://myacct.blob.core.windows.net/cache",
      connection: { credential, token: () => "t" },
    }),
  );
  show("a credential and a token", credentialAndToken);
  check(
    "a credential and a token is a TypeError",
    credentialAndToken?.includes("credential") === true &&
      credentialAndToken.includes("token") === true,
    credentialAndToken,
  );

  const bearerWord = typeErrorOf(() =>
    azureBlobDriver({
      url: "azure://myacct.blob.core.windows.net/cache",
      connection: { token: "Bearer abc" },
    }),
  );
  check(
    'a raw token is sent without "Bearer ", and the driver says so',
    bearerWord?.includes("Bearer") === true,
    bearerWord,
  );
} finally {
  /* ---------------------------------------------------------------- */
  step("cleanup: the blobs this run wrote");
  let removed = 0;
  for (const prefix of Object.values(prefixes)) {
    for (const name of await listed(prefix)) {
      await remove(name);
      removed++;
    }
  }
  show("deleted", removed);
  checkEqual(
    "nothing is left under this run's prefixes",
    (await Promise.all(Object.values(prefixes).map(listed))).flat(),
    [],
  );
}

summary();
