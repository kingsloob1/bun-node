/**
 * `bun-client watch` (typed-client plan §3.3, PR-C3): keeps generated files
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
 * **Several targets** (issue #768): one watcher keeps one file per target,
 * each from the server's unnamed document or from a named one
 * (`devTypes()`'s `documents`, served at `<url>/<name>`). They share the
 * server, the token and the channel; each has its own hash, so a change that
 * moves one document's hash regenerates only that target. A target whose
 * document the server does not name (its token file's `documents`) waits,
 * with a notice, as for a server not yet running.
 *
 * A refused token (the endpoint answers as if it did not exist) is logged
 * once per token file and retried, so a server restarting with a new token
 * is picked up. It stops when `signal` aborts (the CLI's SIGINT or SIGTERM).
 */
import type { DevServer } from "./devServer";
import type { ZodTarget } from "./emit";
import { chooseDevServer, readDevServers, tokenDirectory } from "./devServer";
import {
  emitModule,
  formatWarnings,
  headerHash,
  readExisting,
  writeIfChanged,
} from "./emit";
import { documentsFromResponse } from "./load";

/** One file a watcher keeps generated. */
export interface WatchTarget {
  /**
   * The named document it is generated from (`devTypes()`'s `documents`,
   * served at `<url>/<name>`). Default: the unnamed document, at `<url>`.
   */
  readonly document?: string | undefined;
  /** The file to keep generated, absolute. */
  readonly out: string;
  /** The file as the user named it, for messages. */
  readonly display: string;
  /**
   * The zod module to keep generated beside it (`--zod`, plan §5.2), with
   * its name as the user gave it. Default: none.
   */
  readonly zod?: ZodTarget & {
    /** The zod file as the user named it, for messages. */
    readonly display: string;
  };
}

/** What {@link watchDevServer} runs with. */
export interface WatchOptions {
  /** The files to keep generated: at least one, no two with the same `out` or the same `document`. */
  readonly targets: readonly WatchTarget[];
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

/** A target and what the watcher knows of it. */
interface TargetState {
  /** The target. */
  readonly target: WatchTarget;
  /** The hash the file records: what a `hello`/`changed` is compared with. */
  current: string | undefined;
  /** Whether this run has generated it once: until then a fetch is unconditional. */
  verified: boolean;
  /** The warnings printed last, so an unchanged set is not printed again. */
  lastWarnings: string;
  /** The fetch running now, when one is. */
  syncing: Promise<void> | undefined;
  /** Whether a hash was announced while it ran, so it fetches once more after. */
  again: boolean;
}

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

/** The endpoint a target is fetched from: the server's, or its named document's under it. */
function endpointOf(server: DevServer, target: WatchTarget): string {
  return target.document === undefined
    ? server.url
    : `${server.url.replace(/\/+$/, "")}/${target.document}`;
}

/** The hash a `hello`/`changed` announces for `target`; `undefined` when it names none. */
function announcedHash(
  data: { hash?: unknown; documents?: unknown },
  target: WatchTarget,
): string | undefined {
  if (target.document === undefined) {
    return typeof data.hash === "string" ? data.hash : undefined;
  }
  const documents = data.documents;
  if (typeof documents !== "object" || documents === null) return undefined;
  const hash = (documents as Record<string, unknown>)[target.document];
  return typeof hash === "string" ? hash : undefined;
}

/**
 * Runs the watcher until `options.signal` aborts.
 *
 * @returns The exit status: `0` when stopped, `2` when several dev servers
 *   run at the start and nothing says which to follow.
 */
export async function watchDevServer(options: WatchOptions): Promise<number> {
  const { signal } = options;
  const initialMs = options.backoff?.initialMs ?? 50;
  const maxMs = options.backoff?.maxMs ?? 2000;
  const fetchTimeoutMs = options.fetchTimeoutMs ?? 10_000;

  const states: TargetState[] = [];
  for (const target of options.targets) {
    states.push({
      target,
      current: headerHash((await readExisting(target.out)) ?? ""),
      verified: false,
      lastWarnings: "",
      syncing: undefined,
      again: false,
    });
  }
  let attempt = 0;
  /** The endpoint followed last (kept across restarts on the same port). */
  let last: string | undefined;
  /** The endpoint a "following" line was written for. */
  let announced: string | undefined;
  /** Whether a channel has opened in this run. */
  let everConnected = false;
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

  /** Fetches one target's endpoint and regenerates it; logs one line per regeneration. */
  const sync = async (
    server: DevServer,
    state: TargetState,
  ): Promise<SyncOutcome> => {
    const { target } = state;
    const url = endpointOf(server, target);
    const from =
      target.document === undefined ? "" : `document ${target.document}, `;
    const started = performance.now();
    let response: Response;
    try {
      response = await fetch(url, {
        headers: {
          accept: "application/json",
          authorization: `Bearer ${server.token}`,
          ...(state.verified && state.current !== undefined
            ? { "if-none-match": `"${state.current}"` }
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
        `${PREFIX}: ${url} answered ${status}; ${target.display} is left as it is\n`,
      );
      return "failed";
    }
    let outcome: "written" | "unchanged";
    let hash: string;
    try {
      const emitted = emitModule(
        await documentsFromResponse(response, url),
        target.zod,
      );
      hash = emitted.hash;
      const warnings = [
        emitted.warnings.length === 0
          ? ""
          : formatWarnings(PREFIX, emitted.warnings),
        emitted.zod === undefined || emitted.zod.warnings.length === 0
          ? ""
          : formatWarnings(`${PREFIX} --zod`, emitted.zod.warnings),
      ].join("");
      if (warnings !== state.lastWarnings) {
        state.lastWarnings = warnings;
        if (warnings !== "") options.stderr(warnings);
      }
      // The zod module first: the route map's header hash is what the
      // watcher compares, so it is written last.
      const zodOutcome =
        target.zod === undefined || emitted.zod === undefined
          ? "unchanged"
          : await writeIfChanged(target.zod.path, emitted.zod.code);
      outcome = await writeIfChanged(target.out, emitted.code);
      if (zodOutcome === "written")
        options.stdout(
          `${PREFIX}: wrote ${target.zod!.display} (${from}typesHash ${emitted.hash})\n`,
        );
    } catch (error) {
      options.stderr(
        `${PREFIX}: regenerating ${target.display} failed: ${(error as Error).message}\n`,
      );
      return "failed";
    }
    state.current = hash;
    state.verified = true;
    const ms = Math.round(performance.now() - started);
    options.stdout(
      `${PREFIX}: ${outcome === "written" ? "wrote" : "unchanged"} ${target.display} (${from}typesHash ${hash}, ${ms} ms)\n`,
    );
    return "ok";
  };

  /** Follows the server's channel until it closes; whether it opened. */
  const follow = (server: DevServer): Promise<boolean> => {
    const { promise, resolve } = Promise.withResolvers<boolean>();
    let opened = false;
    /** Closes the channel, so the loop reconnects (with the token file read again). */
    let reconnect = (_reason: string): void => {};

    /** Fetches one target again, one fetch at a time; a hash announced meanwhile fetches once more after. */
    const trigger = (state: TargetState) => {
      if (state.syncing !== undefined) {
        state.again = true;
        return;
      }
      state.syncing = (async () => {
        do {
          state.again = false;
          const outcome = await sync(server, state);
          if (outcome === "refused") {
            options.stderr(
              `${PREFIX}: ${endpointOf(server, state.target)} refused the token in ${server.file} (the server's token changed, or it no longer serves that document?); reconnecting\n`,
            );
            reconnect("token refused");
            return;
          }
        } while (state.again && !signal.aborted);
      })().finally(() => {
        state.syncing = undefined;
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
        data?: { hash?: unknown; documents?: unknown };
      };
      if ((type !== "hello" && type !== "changed") || data === undefined) {
        return;
      }
      for (const state of states) {
        // A frame that names no hash for the target (a server that does not
        // announce named documents) fetches it, as a moved hash does: the
        // `If-None-Match` makes an unchanged one a `304`.
        const hash = announcedHash(data, state.target);
        if (hash === undefined || hash !== state.current) trigger(state);
      }
    };
    socket.onclose = () => {
      signal.removeEventListener("abort", stop);
      void Promise.all(
        states.flatMap((state) =>
          state.syncing === undefined ? [] : [state.syncing],
        ),
      ).then(() => resolve(opened));
    };
    return promise;
  };

  outer: while (!signal.aborted) {
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
    // A named document the server does not serve: wait for one that does
    // (a restart with the new `documents`), rather than fetch a 404.
    const served = new Set(server.documents ?? []);
    const missing = states
      .map((state) => state.target.document)
      .filter(
        (name): name is string => name !== undefined && !served.has(name),
      );
    if (missing.length > 0) {
      const serves =
        served.size === 0
          ? "it serves no named documents (devTypes()'s `documents` option)"
          : `it serves ${[...served].join(", ")}`;
      notice(
        `missing:${server.file}:${missing.join(",")}:${[...served].join(",")}`,
        `${server.url} has no document named ${missing.join(", ")} (${serves}); waiting`,
      );
      await backoff();
      continue;
    }
    for (const state of states) {
      const outcome = await sync(server, state);
      if (outcome === "aborted") break outer;
      if (outcome === "refused") {
        // Logged at once: a wrong token does not fix itself in a second.
        lookingSince ??= Date.now();
        if (!noticed.has(`refused:${server.file}:${server.token}`)) {
          noticed.add(`refused:${server.file}:${server.token}`);
          options.stderr(
            `${PREFIX}: ${endpointOf(server, state.target)} refused the token in ${server.file} (a stale token file, or not a devTypes() endpoint); retrying\n`,
          );
        }
        await backoff();
        continue outer;
      }
      if (outcome === "down") {
        notice(`down:${server.url}`, `${server.url} does not answer; retrying`);
        await backoff();
        continue outer;
      }
      // "ok", or "failed" (logged): either way the channel says when to try again.
    }
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
