/**
 * End to end: a real Chrome stores a dictionary advertised with
 * `Use-As-Dictionary`, offers it back with `Available-Dictionary`, and decodes
 * the `dcb`/`dcz` responses `compression()` and the static handler produce
 * (Compression Dictionary Transport, RFC 9842).
 *
 * Chrome is driven headless over the DevTools Protocol, spoken directly on
 * Bun's WebSocket — no browser-automation dependency. Opt-in, because it needs
 * Chrome installed and takes a few seconds:
 *
 * ```bash
 * BUN_COMMON_E2E_CHROME=1 bun test __tests__/compression.chrome.e2e.test.ts
 * ```
 *
 * `BUN_COMMON_E2E_CHROME_BIN` names the browser binary when it is not on
 * `PATH` as `google-chrome`, `google-chrome-stable`, `chromium` or
 * `chromium-browser`.
 */
import type { Subprocess } from "bun";
import type { DictionaryContentEncoding } from "../lib/utils/native";
import { Buffer } from "node:buffer";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as zlib from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { BunHttpAdapter } from "../lib/BunHttpAdapter";
import { compression, formatUseAsDictionary } from "../lib/compression";
import { compressionDictionaryHash } from "../lib/utils/native";

/** Whether the suite was asked for. */
const REQUESTED = process.env.BUN_COMMON_E2E_CHROME === "1";

/** The Chrome binary, or `null` when none is found. */
const CHROME: string | null = REQUESTED
  ? (process.env.BUN_COMMON_E2E_CHROME_BIN ??
    ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"]
      .map((name) => Bun.which(name))
      .find((path) => path !== null) ??
    null)
  : null;

/** Whether the suite runs. */
const ENABLED = REQUESTED && CHROME !== null;

/** Bounds every wait on the browser. */
const TIMEOUT_MS = 15_000;

/** A JSON body of a few kilobytes — the resource compressed. */
const BODY = {
  items: Array.from({ length: 120 }, (_, i) => ({
    id: i,
    name: `item ${i}`,
    tags: ["alpha", i % 2 ? "beta" : "gamma"],
  })),
};
const TEXT = JSON.stringify(BODY);

/** "The previous version" of the body: close enough to compress well against. */
const DICTIONARY = Buffer.from(TEXT.replace(/item 1(\d)\b/g, "item one-$1"));
/** The dictionary's SHA-256, as `Available-Dictionary` must carry it. */
const AVAILABLE_DICTIONARY = `:${compressionDictionaryHash(DICTIONARY).toString("base64")}:`;
/** The size of the body as plain `br` at compression()'s default quality. */
const PLAIN_BROTLI_SIZE = zlib.brotliCompressSync(TEXT, {
  params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4 },
}).length;

/** Headers the server saw on one request. */
interface SeenRequest {
  /** `Accept-Encoding`, or `null`. */
  acceptEncoding: string | null;
  /** `Available-Dictionary`, or `null`. */
  availableDictionary: string | null;
}

/** What the page saw for one `fetch`. */
interface PageResponse {
  /** The HTTP status. */
  status: number;
  /** `Content-Encoding`, or `null`. */
  encoding: string | null;
  /** `Vary`, or `null`. */
  vary: string | null;
  /** The decoded body, as the page's `fetch` read it. */
  text: string;
  /** Resource Timing's `encodedBodySize`: bytes on the wire, header included. */
  encodedBodySize: number;
}

/** A DevTools Protocol message: a reply (with `id`) or an event. */
interface CdpMessage {
  /** The command id this replies to; absent on events. */
  id?: number;
  /** The command's result. */
  result?: Record<string, unknown>;
  /** The command's failure. */
  error?: { message: string };
}

/** A DevTools Protocol connection over Bun's WebSocket. */
interface Cdp {
  /** Sends `method` (to `sessionId`'s target, when given) and resolves its result. */
  send: (
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string,
  ) => Promise<Record<string, unknown>>;
  /** Closes the connection. */
  close: () => void;
}

/** Rejects after `ms` with a message naming `what`. */
async function within<T>(
  what: string,
  ms: number,
  run: Promise<T>,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`timed out after ${ms} ms: ${what}`)),
      ms,
    );
  });
  try {
    return await Promise.race([run, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Opens a DevTools Protocol connection to `url`. */
async function connectCdp(url: string): Promise<Cdp> {
  const socket = new WebSocket(url);
  await within(
    "the DevTools WebSocket to open",
    TIMEOUT_MS,
    new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener(
        "error",
        () => reject(new Error("DevTools WebSocket error")),
        { once: true },
      );
    }),
  );

  let nextId = 0;
  const pending = new Map<
    number,
    { resolve: (message: CdpMessage) => void; reject: (error: Error) => void }
  >();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data)) as CdpMessage;
    if (message.id !== undefined) {
      pending.get(message.id)?.resolve(message);
      pending.delete(message.id);
    }
  });
  socket.addEventListener("close", () => {
    for (const waiter of pending.values()) {
      waiter.reject(new Error("DevTools WebSocket closed"));
    }
    pending.clear();
  });

  return {
    async send(method, params = {}, sessionId) {
      const id = ++nextId;
      const reply = await within(
        method,
        TIMEOUT_MS,
        new Promise<CdpMessage>((resolve, reject) => {
          pending.set(id, { resolve, reject });
          socket.send(JSON.stringify({ id, method, params, sessionId }));
        }),
      );
      if (reply.error) {
        throw new Error(`${method}: ${reply.error.message}`);
      }
      return reply.result ?? {};
    },
    close: () => socket.close(),
  };
}

/** Polls `check` until it answers `true`, or throws naming `what`. */
async function waitFor(
  what: string,
  check: () => Promise<boolean>,
): Promise<void> {
  const deadline = Date.now() + TIMEOUT_MS;
  while (!(await check())) {
    if (Date.now() > deadline) {
      throw new Error(`timed out after ${TIMEOUT_MS} ms: ${what}`);
    }
    await Bun.sleep(100);
  }
}

describe.skipIf(!ENABLED)(
  ENABLED
    ? `compression: dictionaries in a real Chrome (${CHROME})`
    : "compression: dictionaries in a real Chrome (skipped: set BUN_COMMON_E2E_CHROME=1 with Chrome installed)",
  () => {
    /** Scratch directory: static fixtures and Chrome's profile. */
    let scratch = "";
    /** The server under test. */
    let adapter: BunHttpAdapter | undefined;
    /** The browser process. */
    let chrome: Subprocess<"ignore", "ignore", "pipe"> | undefined;
    /** The browser-level DevTools connection. */
    let cdp: Cdp | undefined;
    /** The page's DevTools session. */
    let sessionId = "";
    /** The page's origin, `http://localhost:<port>`. */
    let origin = "";
    /** Request headers the server saw, by path and query. */
    const seen = new Map<string, SeenRequest>();
    /** Distinguishes every URL fetched, so nothing is served from cache. */
    let counter = 0;

    /** Evaluates `expression` in the page and answers its (awaited) value. */
    async function evaluate<T>(expression: string): Promise<T> {
      const result = await (cdp as Cdp).send(
        "Runtime.evaluate",
        { expression, awaitPromise: true, returnByValue: true },
        sessionId,
      );
      const details = result.exceptionDetails as
        | { text: string; exception?: { description?: string } }
        | undefined;
      if (details) {
        throw new Error(
          `page threw: ${details.exception?.description ?? details.text}`,
        );
      }
      return (result.result as { value: T }).value;
    }

    /**
     * Fetches `path` from the page with a unique query, answering what the
     * page saw and what the server saw.
     */
    async function pageFetch(
      path: string,
    ): Promise<{ page: PageResponse; server: SeenRequest }> {
      const url = `${path}?n=${++counter}`;
      const page = await evaluate<PageResponse>(`(async () => {
        const response = await fetch(${JSON.stringify(url)});
        const text = await response.text();
        const href = new URL(${JSON.stringify(url)}, location.href).href;
        await new Promise((resolve) => setTimeout(resolve, 50));
        const entry = performance.getEntriesByName(href).at(-1);
        return {
          status: response.status,
          encoding: response.headers.get("content-encoding"),
          vary: response.headers.get("vary"),
          text,
          encodedBodySize: entry ? entry.encodedBodySize : -1,
        };
      })()`);
      const server = seen.get(url);
      if (!server) {
        throw new Error(`the server never saw ${url}`);
      }
      return { page, server };
    }

    /** Asserts `path` came back `encoding`-compressed against the dictionary. */
    async function expectDictionaryCompressed(
      path: string,
      encoding: DictionaryContentEncoding,
    ): Promise<void> {
      const { page, server } = await pageFetch(path);
      expect(server.availableDictionary).toBe(AVAILABLE_DICTIONARY);
      expect(server.acceptEncoding?.split(/\s*,\s*/)).toContain(encoding);
      expect(page.status).toBe(200);
      expect(page.encoding).toBe(encoding);
      expect(page.vary?.toLowerCase()).toContain("accept-encoding");
      expect(page.vary?.toLowerCase()).toContain("available-dictionary");
      expect(page.text).toBe(TEXT);
      // The dictionary was really used: far smaller than plain brotli.
      expect(page.encodedBodySize).toBeGreaterThan(0);
      expect(page.encodedBodySize).toBeLessThan(PLAIN_BROTLI_SIZE);
    }

    beforeAll(async () => {
      if (!ENABLED) {
        return;
      }
      scratch = mkdtempSync(join(tmpdir(), "bun-common-chrome-e2e-"));
      const assets = join(scratch, "assets");
      const profile = join(scratch, "profile");
      const precompressed = join(scratch, "precompressed");
      for (const dir of [assets, profile, precompressed]) {
        mkdirSync(dir, { recursive: true });
      }
      writeFileSync(join(assets, "data.json"), TEXT);
      writeFileSync(join(precompressed, "data.json"), TEXT);
      writeFileSync(
        join(precompressed, "data.json.br"),
        zlib.brotliCompressSync(TEXT),
      );

      const dictionaryOptions = (encoding: DictionaryContentEncoding) => ({
        dictionaries: [DICTIONARY],
        dictionaryEncodings: [encoding],
      });

      adapter = new BunHttpAdapter();
      adapter.use((req, _res, next) => {
        seen.set(`${req.path}${req.search}`, {
          acceptEncoding: req.getHeader("Accept-Encoding"),
          availableDictionary: req.getHeader("Available-Dictionary"),
        });
        return next();
      });
      adapter.get("/", (_req, res) => {
        res.type("html").send("<!doctype html><title>e2e</title>");
      });
      // The dictionary itself, advertised for everything under /assets/.
      adapter.get("/dictionary.json", compression(), (_req, res) => {
        res.setHeader(
          "Use-As-Dictionary",
          formatUseAsDictionary({ match: "/assets/*" }),
        );
        res.setHeader("Cache-Control", "max-age=3600");
        res.type("json").send(DICTIONARY);
      });
      for (const encoding of ["dcb", "dcz"] as const) {
        adapter.get(
          `/assets/${encoding}/data.json`,
          compression(dictionaryOptions(encoding)),
          (_req, res) => {
            res.json(BODY);
          },
        );
        adapter.useStaticAssets(assets, {
          prefix: `/assets/static-${encoding}`,
          compression: dictionaryOptions(encoding),
        });
      }
      adapter.useStaticAssets(precompressed, {
        prefix: "/assets/precompressed",
        precompressed: true,
        compression: dictionaryOptions("dcz"),
      });
      // Outside the dictionary's `match`: Chrome must not offer it here.
      adapter.get(
        "/other/data.json",
        compression(dictionaryOptions("dcz")),
        (_req, res) => {
          res.json(BODY);
        },
      );
      await adapter.listen(0);
      origin = `http://localhost:${adapter.listeningPort}`;

      const args = [
        "--headless=new",
        "--remote-debugging-port=0",
        `--user-data-dir=${profile}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-extensions",
        "--disable-background-networking",
        "about:blank",
      ];
      // Chrome refuses to sandbox itself as root (containers, CI).
      if (process.getuid?.() === 0) {
        args.unshift("--no-sandbox");
      }
      chrome = Bun.spawn([CHROME as string, ...args], {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "pipe",
      });

      // DevTools announces its endpoint on stderr; keep draining afterwards
      // so a full pipe can never stall the browser.
      const reader = chrome.stderr.getReader();
      const decoder = new TextDecoder();
      let output = "";
      const endpoint = await within(
        "Chrome to announce its DevTools endpoint",
        TIMEOUT_MS,
        (async () => {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) {
              throw new Error(
                `Chrome exited before DevTools started:\n${output}`,
              );
            }
            output += decoder.decode(value, { stream: true });
            const match = /DevTools listening on (ws:\/\/\S+)/.exec(output);
            if (match) {
              return match[1];
            }
          }
        })(),
      );
      void (async () => {
        try {
          while (!(await reader.read()).done) {
            // Discard.
          }
        } catch {
          // The browser is gone.
        }
      })();

      cdp = await connectCdp(endpoint);
      const { targetId } = await cdp.send("Target.createTarget", {
        url: `${origin}/`,
      });
      ({ sessionId } = (await cdp.send("Target.attachToTarget", {
        targetId,
        flatten: true,
      })) as { sessionId: string });
      const loaded = `location.origin === ${JSON.stringify(origin)} && document.readyState === "complete"`;
      await waitFor("the page to load", async () => {
        try {
          return await evaluate<boolean>(loaded);
        } catch {
          return false;
        }
      });
    }, TIMEOUT_MS * 2);

    afterAll(async () => {
      cdp?.close();
      if (chrome) {
        chrome.kill();
        const exited = await Promise.race([
          chrome.exited.then(() => true),
          Bun.sleep(5_000).then(() => false),
        ]);
        if (!exited) {
          chrome.kill("SIGKILL");
          await chrome.exited;
        }
      }
      await adapter?.close();
      if (scratch) {
        rmSync(scratch, { recursive: true, force: true });
      }
    }, TIMEOUT_MS);

    it("treats localhost as a secure context", async () => {
      expect(await evaluate<boolean>("isSecureContext")).toBe(true);
    });

    it("without a dictionary, offers neither dcb nor dcz and gets br", async () => {
      const { page, server } = await pageFetch("/assets/dcz/data.json");
      expect(server.availableDictionary).toBeNull();
      const offered = server.acceptEncoding?.split(/\s*,\s*/) ?? [];
      expect(offered).toContain("br");
      expect(offered).not.toContain("dcb");
      expect(offered).not.toContain("dcz");
      expect(page.encoding).toBe("br");
      expect(page.text).toBe(TEXT);
    });

    it(
      "stores the Use-As-Dictionary response and offers its SHA-256",
      async () => {
        const dictionary = await evaluate<string>(
          `fetch("/dictionary.json").then((response) => response.text())`,
        );
        expect(dictionary).toBe(DICTIONARY.toString());
        // Registration is asynchronous: poll until Chrome offers it back.
        let last: SeenRequest | undefined;
        await waitFor("Chrome to offer the stored dictionary", async () => {
          last = (await pageFetch("/assets/probe")).server;
          return last.availableDictionary !== null;
        });
        expect(last?.availableDictionary).toBe(AVAILABLE_DICTIONARY);
      },
      TIMEOUT_MS * 2,
    );

    for (const encoding of ["dcb", "dcz"] as const) {
      it(`decodes ${encoding} from compression()`, async () => {
        await expectDictionaryCompressed(
          `/assets/${encoding}/data.json`,
          encoding,
        );
      });

      it(`decodes ${encoding} from a static file compressed on the fly`, async () => {
        await expectDictionaryCompressed(
          `/assets/static-${encoding}/data.json`,
          encoding,
        );
      });
    }

    it("serves a precompressed br sibling even when a dictionary is offered", async () => {
      // Siblings exist for br, zstd and gzip only; a matching one wins over
      // compressing on the fly, so no dictionary coding is produced.
      const { page, server } = await pageFetch(
        "/assets/precompressed/data.json",
      );
      expect(server.availableDictionary).toBe(AVAILABLE_DICTIONARY);
      expect(page.encoding).toBe("br");
      expect(page.text).toBe(TEXT);
    });

    it("does not offer the dictionary outside its match pattern", async () => {
      const { page, server } = await pageFetch("/other/data.json");
      expect(server.availableDictionary).toBeNull();
      expect(server.acceptEncoding?.split(/\s*,\s*/)).not.toContain("dcz");
      expect(page.encoding).toBe("br");
      expect(page.text).toBe(TEXT);
    });
  },
);
