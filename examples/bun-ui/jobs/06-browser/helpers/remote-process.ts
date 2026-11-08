/**
 * The parent's side of `remote-worker.ts`: starts it as a child process and
 * talks to it line by line. Shared by `06-browser/live-events.ts` and
 * `06-browser/workers.ts`.
 */
import process from "node:process";

/** A running `remote-worker.ts` child. */
export interface RemoteProcess {
  /** Its worker's per-incarnation id, from its `ready <id>` line. */
  id: string;
  /** Its pid. */
  pid: number;
  /** When its `ready` line was read, in epoch milliseconds: the worker's first start was published by then. */
  readyAt: number;
  /** Sends `pause` or `resume`, and resolves once the child answers that it is done. */
  send: (command: "pause" | "resume") => Promise<void>;
  /** Ends its stdin and waits for it to exit; safe to call more than once. */
  close: () => Promise<void>;
}

/**
 * Starts `remote-worker.ts` on the file-driver directory `root`, in
 * `namespace`, with one worker on `queue` in service `service`, and resolves
 * once its worker has started. Fails, with what it printed, if it ends first
 * or takes longer than `timeoutMs`.
 */
export async function startRemoteWorker(options: {
  /** The file driver's directory, shared with the parent. */
  root: string;
  /** The namespace, shared with the parent. */
  namespace: string;
  /** The queue its worker consumes: one the parent's API has not seen. */
  queue: string;
  /** Its `service`. */
  service: string;
  /** How long to wait for `ready`. Defaults to 15 s. */
  timeoutMs?: number;
}): Promise<RemoteProcess> {
  const child = Bun.spawn({
    cmd: [
      process.execPath,
      new URL("./remote-worker.ts", import.meta.url).pathname,
      options.root,
      options.namespace,
      options.queue,
      options.service,
    ],
    stdin: "pipe",
    stdout: "pipe",
    stderr: "inherit",
  });
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  /** Resolves with the next line the child prints; rejects on a timeout or its end. */
  const nextLine = async (what: string, timeoutMs: number): Promise<string> => {
    const deadline = Date.now() + timeoutMs;
    while (!buffered.includes("\n")) {
      const left = deadline - Date.now();
      if (left <= 0) {
        throw new Error(
          `remote-worker: no ${what} within ${timeoutMs} ms (printed so far: ${JSON.stringify(buffered)})`,
        );
      }
      let timer: Timer | undefined;
      const read = await Promise.race([
        reader.read(),
        new Promise<"timeout">((resolve) => {
          timer = setTimeout(resolve, left, "timeout");
        }),
      ]);
      clearTimeout(timer);
      if (read === "timeout") {
        continue;
      }
      if (read.done) {
        throw new Error(
          `remote-worker ended before its ${what} (printed: ${JSON.stringify(buffered)})`,
        );
      }
      buffered += decoder.decode(read.value);
    }
    const newline = buffered.indexOf("\n");
    const line = buffered.slice(0, newline).trim();
    buffered = buffered.slice(newline + 1);
    return line;
  };

  let closed = false;
  const close = async (): Promise<void> => {
    if (!closed) {
      closed = true;
      void child.stdin.end();
    }
    await child.exited;
  };

  try {
    const ready = await nextLine("ready line", options.timeoutMs ?? 15_000);
    const id = /^ready (\S+)$/.exec(ready)?.[1];
    if (id === undefined) {
      throw new Error(
        `remote-worker printed ${JSON.stringify(ready)}, not "ready <id>"`,
      );
    }
    return {
      id,
      pid: child.pid,
      readyAt: Date.now(),
      send: async (command) => {
        void child.stdin.write(`${command}\n`);
        void child.stdin.flush();
        const answer = await nextLine(`answer to ${command}`, 15_000);
        const expected = command === "pause" ? "paused" : "resumed";
        if (answer !== expected) {
          throw new Error(
            `remote-worker answered ${JSON.stringify(answer)} to ${command}, not ${expected}`,
          );
        }
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
