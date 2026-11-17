/**
 * Checkpoint sinks (control-plane.md §6.2): where every signed checkpoint
 * is also written, somewhere the control plane's database role cannot
 * rewrite (an append-only file on other storage, a SIEM, an object-locked
 * bucket). A sink that can read its checkpoints back lets `verify` catch a
 * chain cut short in the store.
 */
import { Buffer } from "node:buffer";
import { createHmac } from "node:crypto";
import { appendFile, readFile } from "node:fs/promises";
import { ConfigError } from "@kingsleyweb/bun-common";
import type { AuditCheckpoint } from "../../store/types";

/** A checkpoint sink. */
export interface CheckpointSink {
  /** Its name, in `verify`'s report and alerts. */
  readonly name: string;
  /** Writes a checkpoint; rejects when it could not. */
  readonly write: (checkpoint: AuditCheckpoint) => Promise<void>;
  /** Reads back every checkpoint it holds, when it can. */
  readonly read?: () => Promise<readonly AuditCheckpoint[]>;
}

/** Parses JSON Lines of checkpoints, skipping a line that is not one. */
function parseLines(text: string): AuditCheckpoint[] {
  const out: AuditCheckpoint[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const value = JSON.parse(line) as AuditCheckpoint;
      if (Number.isSafeInteger(value.n) && typeof value.hash === "string")
        out.push(value);
    } catch {
      // A torn last line: skipped.
    }
  }
  return out;
}

/**
 * Appends each checkpoint as one JSON line to `path` (opened for append
 * only), and reads them back. Put the file where the control plane's
 * database credentials do not reach, ideally storage with append-only or
 * immutable attributes.
 */
export function fileCheckpointSink(path: string): CheckpointSink {
  if (typeof path !== "string" || path === "") {
    throw new ConfigError("fileCheckpointSink(): a file path is required");
  }
  return Object.freeze({
    name: `file:${path}`,
    write: async (checkpoint: AuditCheckpoint) => {
      await appendFile(path, `${JSON.stringify(checkpoint)}\n`, {
        mode: 0o600,
      });
    },
    read: async () => {
      try {
        return parseLines(await readFile(path, "utf8"));
      } catch (error) {
        if ((error as { code?: string }).code === "ENOENT") return [];
        throw error;
      }
    },
  });
}

/** Options for {@link webhookCheckpointSink}. */
export interface WebhookCheckpointSinkOptions {
  /** Where to POST each checkpoint (a SIEM's collector). */
  readonly url: string;
  /** The HMAC-SHA256 key the request is signed with (`x-bun-security-signature`), at least 32 bytes. */
  readonly secret: string;
  /** The fetch to use. Default the global `fetch`. */
  readonly fetch?: (
    url: string,
    init: {
      method: string;
      headers: Record<string, string>;
      body: string;
      signal: AbortSignal;
    },
  ) => Promise<Response>;
  /** How long a POST may take, ms. Default 5,000. */
  readonly timeoutMs?: number;
  /** Reads the checkpoints back from the collector, when it can. */
  readonly read?: () => Promise<readonly AuditCheckpoint[]>;
}

/**
 * POSTs each checkpoint as JSON, signed: `x-bun-security-timestamp` and
 * `x-bun-security-signature: sha256=<hex HMAC of "<timestamp>.<body>">`.
 * A non-2xx answer or a timeout is a failure.
 */
export function webhookCheckpointSink(
  options: WebhookCheckpointSinkOptions,
): CheckpointSink {
  if (typeof options.url !== "string" || !/^https?:\/\//.test(options.url)) {
    throw new ConfigError(
      "webhookCheckpointSink(): url must be an http(s) URL",
    );
  }
  if (
    typeof options.secret !== "string" ||
    Buffer.byteLength(options.secret) < 32
  ) {
    throw new ConfigError(
      "webhookCheckpointSink(): secret must be at least 32 bytes",
    );
  }
  const send = options.fetch ?? ((url, init) => fetch(url, init));
  const timeoutMs = options.timeoutMs ?? 5_000;
  return Object.freeze({
    name: `webhook:${new URL(options.url).host}`,
    write: async (checkpoint: AuditCheckpoint) => {
      const body = JSON.stringify(checkpoint);
      const timestamp = String(Date.now());
      const signature = createHmac("sha256", options.secret)
        .update(`${timestamp}.${body}`)
        .digest("hex");
      const response = await send(options.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-bun-security-timestamp": timestamp,
          "x-bun-security-signature": `sha256=${signature}`,
        },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
      await response.body?.cancel();
      if (!response.ok)
        throw new Error(`the collector answered ${response.status}`);
    },
    ...(options.read === undefined ? {} : { read: options.read }),
  });
}

/** A sink of the host's own: an object-locked bucket, syslog, an email to the owners. */
export function callbackCheckpointSink(options: {
  /** Its name. Default `callback`. */
  readonly name?: string;
  /** Writes a checkpoint. */
  readonly write: (checkpoint: AuditCheckpoint) => void | Promise<void>;
  /** Reads them back, when it can. */
  readonly read?: () =>
    readonly AuditCheckpoint[] | Promise<readonly AuditCheckpoint[]>;
}): CheckpointSink {
  if (typeof options?.write !== "function") {
    throw new ConfigError("callbackCheckpointSink(): write is required");
  }
  const read = options.read;
  return Object.freeze({
    name: options.name ?? "callback",
    write: async (checkpoint: AuditCheckpoint) => {
      await options.write(checkpoint);
    },
    ...(read === undefined ? {} : { read: async () => await read() }),
  });
}
