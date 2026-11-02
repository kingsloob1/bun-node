/**
 * `bun-client watch` (typed-client plan §3.3, PR-C3): keeps a generated file
 * in step with a running dev server's documents.
 *
 * 1. It finds the server through its token file (`./devServer`), re-read on
 *    every attempt, since a restarted server has a new token (and perhaps a
 *    new port).
 * 2. It fetches the dev endpoint with the bearer token, regenerating through
 *    the same step as `generate` (`./emit`): written atomically, and only
 *    when the content changed. The first fetch of a run is unconditional, so
 *    a file written by another version of the generator is brought up to
 *    date; later ones send `If-None-Match` with the file's hash.
 * 3. It follows the `bun-types.v1` channel, offering the token as a
 *    `token.<t>` subprotocol; a `hello` or `changed` whose hash is not the
 *    file's fetches again.
 * 4. When the channel closes (a `bun --watch` restart, the server stopping)
 *    it goes back to 1 after a backoff of 50 ms doubling to 2 s; the backoff
 *    restarts once a channel opens.
 *
 * A refused token (the endpoint answers as if it did not exist) is logged
 * once per token file and retried, so a server restarting with a new token
 * is picked up. It stops when `signal` aborts (the CLI's SIGINT or SIGTERM).
 */
import type { DevServer } from "./devServer";
import { chooseDevServer, readDevServers, tokenDirectory } from "./devServer";
import {
  emitModule,
  formatWarnings,
  headerHash,
  readExisting,
  writeIfChanged,
} from "./emit";
import { documentsFromResponse } from "./load";

/** What {@link watchDevServer} runs with. */
export interface WatchOptions {
  /** The file to keep generated, absolute. */
  readonly out: string;
  /** The file as the user named it, for messages. */
  readonly display: string;
  /** The dev server to follow, by its endpoint or origin URL. Default: the only server running (see `chooseDevServer`). */
  readonly url?: string | undefined;
  /** A token file or a directory of them, absolute. Default: `tokenDirectory(cwd)`, looked up again on every attempt. */
  readonly tokenPath?: string | undefined;
  /** The directory the default token directory is looked up from. */
  readonly cwd: string;
  /** Stops the watcher: it closes the channel and resolves `0`. */
  readonly signal: AbortSignal;
  /** Receives one line per regeneration and the connection notices. */
  readonly stdout: (text: string) => void;
  /** Receives refusals, failures and warnings. */
  readonly stderr: (text: string) => void;
  /** The reconnection backoff: the first delay and the cap, in milliseconds. Default: `{ initialMs: 50, maxMs: 2000 }` (plan §3.3). */
  readonly backoff?: {
    /** The first delay. Default: `50`. */
    readonly initialMs: number;
    /** The longest delay. Default: `2000`. */
    readonly maxMs: number;
  };
  /** How long a fetch of the endpoint may take, in milliseconds. Default: `10000`. */
  readonly fetchTimeoutMs?: number;
}

/** The subprotocol of the dev channel (bun-common's `devTypes()`). */
const SUBPROTOCOL = "bun-types.v1";
/** The prefix of every line the watcher writes. */
const PREFIX = "bun-client watch";
/** How long a server may be missing or refusing before the watcher says so (a `--watch` restart takes ~0.2 s). */
const QUIET_MS = 1000;

/** How one fetch of the endpoint ended. */
type SyncOutcome = "ok" | "refused" | "down" | "failed" | "aborted";

/** Waits `ms`, or less when `signal` aborts. */
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

/**
 * Runs the watcher until `options.signal` aborts.
 *
 * @returns The exit status: `0` when stopped, `2` when several dev servers
 *   run at the start and nothing says which to follow.
 */
export async function watchDevServer(options: WatchOptions): Promise<number> {
  const { out, display, signal } = options;
  const initialMs = options.backoff?.initialMs ?? 50;
  const maxMs = options.backoff?.maxMs ?? 2000;
  const fetchTimeoutMs = options.fetchTimeoutMs ?? 10_000;

  /** The hash the file records: what a `hello`/`changed` is compared with. */
  let current = headerHash((await readExisting(out)) ?? "");
  /** Whether this run has generated once: until then a fetch is unconditional. */
  let verified = false;
  let attempt = 0;
  /** The endpoint followed last (kept across restarts on the same port). */
  let last: string | undefined;
  /** The endpoint a "following" line was written for. */
  let announced: string | undefined;
  /** Whether a channel has opened in this run. */
  let everConnected = false;
  /** The warnings printed last, so an unchanged set is not printed again. */
  let lastWarnings = "";
  /** The notices printed since the watcher last synced, by key. */
  const noticed = new Set<string>();
  /** When the watcher started looking without success, for {@link QUIET_MS}. */
  let lookingSince: number | undefined;

  /** Prints `text` once per key until the next successful sync, after {@link QUIET_MS} of trying (at once on the first attempt). */
  const notice = (key: string, text: string, stream = options.stderr) => {
    const now = Date.now();
    lookingSince ??= now;
    if (noticed.has(key)) return;
    if (everConnected && now - lookingSince < QUIET_MS) return;
    noticed.add(key);
    stream(`${PREFIX}: ${text}\n`);
  };

  const backoff = () =>
    pause(Math.min(maxMs, initialMs * 2 ** attempt++), signal);

  /** Fetches the endpoint and regenerates; logs one line per regeneration. */
  const sync = async (server: DevServer): Promise<SyncOutcome> => {
    const started = performance.now();
    let response: Response;
    try {
      response = await fetch(server.url, {
        headers: {
          accept: "application/json",
          authorization: `Bearer ${server.token}`,
          ...(verified && current !== undefined
            ? { "if-none-match": `"${current}"` }
            : {}),
        },
        signal: AbortSignal.any([signal, AbortSignal.timeout(fetchTimeoutMs)]),
      });
    } catch {
      return signal.aborted ? "aborted" : "down";
    }
    if (response.status === 304) {
      void response.body?.cancel();
      return "ok";
    }
    if (
      response.status === 404 ||
      response.status === 401 ||
      response.status === 403
    ) {
      void response.body?.cancel();
      return "refused";
    }
    if (!response.ok) {
      void response.body?.cancel();
      const status = `${response.status} ${response.statusText}`.trimEnd();
      options.stderr(
        `${PREFIX}: ${server.url} answered ${status}; the file is left as it is\n`,
      );
      return "failed";
    }
    let outcome: "written" | "unchanged";
    let hash: string;
    try {
      const emitted = emitModule(
        await documentsFromResponse(response, server.url),
      );
      hash = emitted.hash;
      const warnings =
        emitted.warnings.length === 0
          ? ""
          : formatWarnings(PREFIX, emitted.warnings);
      if (warnings !== lastWarnings) {
        lastWarnings = warnings;
        if (warnings !== "") options.stderr(warnings);
      }
      outcome = await writeIfChanged(out, emitted.code);
    } catch (error) {
      options.stderr(
        `${PREFIX}: regenerating ${display} failed: ${(error as Error).message}\n`,
      );
      return "failed";
    }
    current = hash;
    verified = true;
    const ms = Math.round(performance.now() - started);
    options.stdout(
      `${PREFIX}: ${outcome === "written" ? "wrote" : "unchanged"} ${display} (typesHash ${hash}, ${ms} ms)\n`,
    );
    return "ok";
  };

  /** Follows the server's channel until it closes; whether it opened. */
  const follow = (server: DevServer): Promise<boolean> => {
    const { promise, resolve } = Promise.withResolvers<boolean>();
    let opened = false;
    let syncing: Promise<void> | undefined;
    let again = false;
    /** Closes the channel, so the loop reconnects (with the token file read again). */
    let reconnect = (_reason: string): void => {};

    /** Fetches again, one fetch at a time; a hash announced meanwhile fetches once more after. */
    const trigger = () => {
      if (syncing !== undefined) {
        again = true;
        return;
      }
      syncing = (async () => {
        do {
          again = false;
          const outcome = await sync(server);
          if (outcome === "refused") {
            options.stderr(
              `${PREFIX}: ${server.url} refused the token in ${server.file} (the server's token changed?); reconnecting\n`,
            );
            reconnect("token refused");
            return;
          }
        } while (again && !signal.aborted);
      })().finally(() => {
        syncing = undefined;
      });
    };

    const socket = new WebSocket(server.ws, [
      SUBPROTOCOL,
      `token.${server.token}`,
    ]);
    reconnect = (reason) => {
      socket.close(1000, reason);
    };
    const stop = () => {
      socket.close(1000, "watcher stopping");
    };
    signal.addEventListener("abort", stop, { once: true });
    socket.onopen = () => {
      opened = true;
      everConnected = true;
      attempt = 0;
      noticed.clear();
      lookingSince = undefined;
      if (announced !== server.url) {
        announced = server.url;
        options.stdout(
          `${PREFIX}: following ${server.url} (token file ${server.file})\n`,
        );
      }
    };
    socket.onmessage = (event) => {
      let frame: unknown;
      try {
        frame = JSON.parse(String(event.data));
      } catch {
        return;
      }
      const { type, data } = (frame ?? {}) as {
        type?: unknown;
        data?: { hash?: unknown };
      };
      if (
        (type === "hello" || type === "changed") &&
        typeof data?.hash === "string" &&
        data.hash !== current
      ) {
        trigger();
      }
    };
    socket.onclose = () => {
      signal.removeEventListener("abort", stop);
      void (syncing ?? Promise.resolve()).then(() => resolve(opened));
    };
    return promise;
  };

  while (!signal.aborted) {
    const tokenPath = options.tokenPath ?? tokenDirectory(options.cwd);
    const choice = chooseDevServer(await readDevServers(tokenPath), {
      url: options.url,
      last,
    });
    if (choice.kind === "several") {
      const list = choice.servers
        .map((server) => `  - ${server.url} (${server.file})\n`)
        .join("");
      if (!everConnected) {
        options.stderr(
          `${PREFIX}: several dev servers are running; name one with --url:\n${list}`,
        );
        return 2;
      }
      notice(
        `several:${list}`,
        `several dev servers are running and the one followed is gone; name one with --url:\n${list.trimEnd()}`,
      );
      await backoff();
      continue;
    }
    if (choice.kind === "none") {
      notice(
        `none:${tokenPath}`,
        `waiting for a dev server${options.url === undefined ? "" : ` at ${options.url}`} (no token file for it in ${tokenPath})`,
        options.stdout,
      );
      await backoff();
      continue;
    }
    const server = choice.server;
    const outcome = await sync(server);
    if (outcome === "aborted") break;
    if (outcome === "refused") {
      // Logged at once: a wrong token does not fix itself in a second.
      lookingSince ??= Date.now();
      if (!noticed.has(`refused:${server.file}:${server.token}`)) {
        noticed.add(`refused:${server.file}:${server.token}`);
        options.stderr(
          `${PREFIX}: ${server.url} refused the token in ${server.file} (a stale token file, or not a devTypes() endpoint); retrying\n`,
        );
      }
      await backoff();
      continue;
    }
    if (outcome === "down") {
      notice(`down:${server.url}`, `${server.url} does not answer; retrying`);
      await backoff();
      continue;
    }
    // "ok", or "failed" (logged): either way the channel says when to try again.
    last = server.url;
    const opened = await follow(server);
    if (!opened && !signal.aborted) {
      notice(
        `channel:${server.ws}`,
        `the channel ${server.ws} did not open (is a BunWebSocket attached to the app?); checking the endpoint every ${maxMs} ms instead`,
      );
    }
    if (!signal.aborted) await backoff();
  }
  options.stdout(`${PREFIX}: stopped\n`);
  return 0;
}
