/**
 * When an upload's stored files cannot be removed: a `"custom"` storage whose
 * `removeFile` rejects, behind `FileInterceptor`. The client still gets the
 * handler's reply, the failure is logged through the application's Nest
 * logger, and the process carries on serving — each asserted.
 *
 * ```bash
 * bun 03-file-uploads/removal-errors.ts
 * ```
 *
 * Worth knowing:
 *
 * - Every file interceptor (`FileInterceptor`, `FilesInterceptor`,
 *   `FileFieldsInterceptor`, `AnyFilesInterceptor`, `NoFilesInterceptor`)
 *   runs the storage's `removeAll()` once the handler's result is emitted.
 *   It is not awaited, so it never holds the response: below, `removeFile`
 *   waits until the example has the reply in hand, and only then rejects.
 * - A rejection there is caught and logged through a Nest `Logger` named
 *   `BunFileInterceptor`, as
 *   `error("Removing an upload's stored files failed", <the error's stack>)`.
 *   It goes wherever the application's logger goes — here a capturing
 *   `LoggerService` given to `app.useLogger()`; with `logger: false`, nowhere.
 * - Left unhandled, that rejection would end a served Bun application. This
 *   example listens for `unhandledRejection` while it runs and asserts that
 *   nothing arrives — so a regression shows up as a failed check, not as a
 *   process that stopped — then sends more requests to show the server is
 *   still answering.
 * - `MemoryStorage` and `DiskStorage` do not normally reject; this is for a
 *   storage of your own — an object store, a quota service — that can.
 * - Each upload is sent over the socket and through `adapter.fetch()`.
 */
import type { MemoryStorageFile } from "@kingsleyweb/bun-common";
import type { LoggerService } from "@nestjs/common";
import process from "node:process";
import { MemoryStorage } from "@kingsleyweb/bun-common";
import {
  BunHttpAdapter,
  FileInterceptor,
  UploadedFile,
} from "@kingsleyweb/bun-nest";
import {
  Controller,
  HttpCode,
  Module,
  Post,
  UseInterceptors,
} from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { check, checkEqual, summary } from "../shared/check";
import { show, step, title, waitFor } from "../shared/console";
import "reflect-metadata";

/** The message the interceptors log when a removal fails. */
const REMOVAL_FAILED = "Removing an upload's stored files failed";

/** The context their Nest `Logger` carries. */
const CONTEXT = "BunFileInterceptor";

/**
 * A `"custom"` storage: memory storage whose `removeFile` always rejects, as
 * a remote store's delete might when the store is unreachable. Each removal
 * waits for {@link RejectingStorage.release} first, so the example decides
 * when it fails.
 */
class RejectingStorage extends MemoryStorage {
  /** Names of the files `removeFile` was asked to remove, in order. */
  readonly removals: string[] = [];

  /** Removals still waiting to be released. */
  pending = 0;

  /** Lets the waiting removals go on (and reject); replaced on each `hold()`. */
  release: () => void = () => {};

  /** What a removal waits on before rejecting. */
  #gate: Promise<void> = Promise.resolve();

  /** Holds every removal from now on until `release()` is called. */
  hold(): void {
    const { promise, resolve } = Promise.withResolvers<void>();
    this.#gate = promise;
    this.release = resolve;
  }

  override async removeFile(file: unknown): Promise<void> {
    const name = (file as MemoryStorageFile).originalFilename;
    this.removals.push(name);
    this.pending++;
    await this.#gate;
    this.pending--;
    throw new Error(`object store unreachable: could not delete ${name}`);
  }
}

/** One call a {@link CapturingLogger} received. */
interface LogEntry {
  /** The logger method called: `log`, `error`, `warn`, … */
  level: string;
  /** Its first argument. */
  message: unknown;
  /** The rest, as Nest passes them: for a named `Logger`, its context last. */
  params: unknown[];
}

/** A Nest `LoggerService` that keeps every call, so the example can read them. */
class CapturingLogger implements LoggerService {
  /** Every call received, in order. */
  readonly entries: LogEntry[] = [];

  log(message: unknown, ...params: unknown[]): void {
    this.entries.push({ level: "log", message, params });
  }

  error(message: unknown, ...params: unknown[]): void {
    this.entries.push({ level: "error", message, params });
  }

  warn(message: unknown, ...params: unknown[]): void {
    this.entries.push({ level: "warn", message, params });
  }

  debug(message: unknown, ...params: unknown[]): void {
    this.entries.push({ level: "debug", message, params });
  }

  verbose(message: unknown, ...params: unknown[]): void {
    this.entries.push({ level: "verbose", message, params });
  }

  fatal(message: unknown, ...params: unknown[]): void {
    this.entries.push({ level: "fatal", message, params });
  }
}

const storage = new RejectingStorage();

@Controller("uploads")
class UploadsController {
  /** One file through the rejecting storage; the reply describes it. */
  @Post("avatar")
  @HttpCode(202)
  @UseInterceptors(
    FileInterceptor("avatar", { storageType: "custom", storage }),
  )
  avatar(@UploadedFile() file: MemoryStorageFile) {
    return {
      name: file.originalFilename,
      size: file.size,
      text: file.buffer.toString("utf8"),
    };
  }
}

@Module({ controllers: [UploadsController] })
class UploadModule {}

title("A storage whose removeFile rejects");

const logger = new CapturingLogger();
const adapter = new BunHttpAdapter();
const app = await NestFactory.create(UploadModule, adapter, {
  logger: false,
  abortOnError: false,
});
app.useLogger(logger);
await app.listen(0);
const url = await app.getUrl();
show("listening on", url);

/** Every `unhandledRejection` the process sees while the example runs. */
const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => {
  unhandled.push(reason);
  show("unhandledRejection", String(reason));
};
process.on("unhandledRejection", onUnhandled);

/** The entries logged with the interceptors' context. */
const interceptorLogs = () => {
  return logger.entries.filter((entry) => entry.params.at(-1) === CONTEXT);
};

/** What the client got back. */
interface Reply {
  /** The HTTP status. */
  status: number;
  /** The parsed JSON body. */
  body: unknown;
}

/**
 * Answers `promise`'s value, or `"timed out"` after `ms` milliseconds. The
 * timer is cleared once `promise` settles, so it never keeps the process up.
 */
async function within<T>(ms: number, promise: Promise<T>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timed out">((resolve) => {
    timer = setTimeout(resolve, ms, "timed out");
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Uploads `name` through `send`, with the storage's removal held until the
 * reply has arrived, then lets the removal reject and checks what followed.
 */
async function uploadThroughRejectingStorage(
  how: string,
  name: string,
  send: (init: RequestInit) => Promise<Response>,
): Promise<void> {
  const body = new FormData();
  body.append("avatar", new File([`hello from ${name}`], name));
  const logsBefore = interceptorLogs().length;
  const unhandledBefore = unhandled.length;

  storage.hold();
  const reply = await within(
    5000,
    send({ method: "POST", body }).then(async (response): Promise<Reply> => ({
      status: response.status,
      body: await response.json(),
    })),
  );
  show(`${how}: POST /uploads/avatar`, reply);
  checkEqual(`${how}: the handler's status and body arrive intact`, reply, {
    status: 202,
    body: { name, size: 11 + name.length, text: `hello from ${name}` },
  });
  checkEqual(
    `${how}: the reply came while removeFile was still pending`,
    { pending: storage.pending, last: storage.removals.at(-1) },
    { pending: 1, last: name },
  );

  storage.release();
  try {
    await waitFor(
      "the rejection to be logged or reported unhandled",
      () =>
        interceptorLogs().length > logsBefore ||
        unhandled.length > unhandledBefore,
      { timeout: 5000 },
    );
  } catch (error) {
    show("neither happened", String(error));
  }
  // Give a second report, of either kind, the chance to arrive.
  await Bun.sleep(50);

  const logged = interceptorLogs().slice(logsBefore);
  show(
    `${how}: logged (the stack's first line)`,
    logged.map(({ level, message, params: [stack, ...rest] }) => ({
      level,
      message,
      params: [String(stack).split("\n")[0], ...rest],
    })),
  );
  checkEqual(
    `${how}: one error logged, context "${CONTEXT}", with the message`,
    logged.map((entry) => [entry.level, entry.message, entry.params.at(-1)]),
    [["error", REMOVAL_FAILED, CONTEXT]],
  );
  const stack = logged[0]?.params[0];
  check(
    `${how}: the logged stack carries the error's text`,
    typeof stack === "string" &&
      stack.includes(`object store unreachable: could not delete ${name}`),
    { stack },
  );
  checkEqual(
    `${how}: no unhandledRejection`,
    unhandled.slice(unhandledBefore).map(String),
    [],
  );
}

/** Sends the upload over the socket. */
const served = (init: RequestInit) => fetch(`${url}/uploads/avatar`, init);

/** Sends the upload through `adapter.fetch()`, with no socket. */
const fetched = (init: RequestInit) => adapter.fetch("/uploads/avatar", init);

/* ------------------------------------------------------------------ */
step("Over the socket");
await uploadThroughRejectingStorage("served", "first.txt", served);

/* ------------------------------------------------------------------ */
step("Through adapter.fetch(), no socket");
await uploadThroughRejectingStorage("fetch()", "second.txt", fetched);

/* ------------------------------------------------------------------ */
step("The process is still serving");
await uploadThroughRejectingStorage("served again", "third.txt", served);
await uploadThroughRejectingStorage("fetch() again", "fourth.txt", fetched);

checkEqual(
  "every upload's removal was attempted, once each",
  storage.removals,
  ["first.txt", "second.txt", "third.txt", "fourth.txt"],
);
checkEqual(
  "nothing but those four removals was logged as an error",
  logger.entries
    .filter((entry) => entry.level === "error")
    .map((entry) => entry.message),
  Array.from({ length: 4 }).fill(REMOVAL_FAILED),
);
checkEqual(
  "no unhandledRejection over the whole run",
  unhandled.map(String),
  [],
);

process.off("unhandledRejection", onUnhandled);
await app.close();
show("closed");
summary();
