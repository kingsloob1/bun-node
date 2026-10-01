#!/usr/bin/env bun
/**
 * Generates the text frame's test vectors (`remote-transports.md` §11.5,
 * appendix V): for a fixed secret, session id, role, `seq`, `ack` and
 * message, the exact MAC input, the MAC and the frame line; and frames a
 * correct implementation must refuse, with why. An implementer in another
 * language checks their codec against these without running Bun.
 *
 * ```bash
 * bun scripts/generate-frame-vectors.ts          # rewrite the vectors file
 * bun scripts/generate-frame-vectors.ts --check  # exit 1 if it is stale
 * ```
 *
 * `__tests__/remote/remote-frame-vectors.test.ts` runs the same generator
 * and fails when the committed file differs, so the file cannot drift from
 * the code; it also checks every vector with an HMAC written independently
 * of the codec, and against two MACs computed with `openssl`.
 */

import process from "node:process";
import {
  encodeTextFrame,
  HELLO_SID,
  sessionId,
} from "../lib/remote/protocol/frame";

/** Where the vectors are committed. */
export const VECTORS_PATH = new URL(
  "../__tests__/remote/fixtures/text-frame-vectors.json",
  import.meta.url,
).pathname;

/** The secret every vector is MAC'd with. */
export const VECTOR_SECRET = "bun-jobs-test-secret";
/** The dialler's `hello` nonce. */
const NONCE_DIALLER = "q3JtZ2FfZ3c0bE1uUXpXRA";
/** The dialled side's `welcome` nonce. */
const NONCE_DIALLED = "Ym9iX2V4ZWN1dG9yX25vbg";
/** The session id the two make. */
const SID = sessionId(NONCE_DIALLER, NONCE_DIALLED);
/** An `http-stream` response's sid: the invoke envelope's id. */
const INVOKE_ID = "inv_01JB7Q2M9S0P";

/** A frame that verifies. */
export interface AcceptVector {
  /** What it shows. */
  name: string;
  /** The session id it is MAC'd with. */
  sid: string;
  /** The sender's role. */
  dir: "g" | "e";
  /** Its sequence number. */
  seq: number;
  /** Its acknowledgement. */
  ack: number;
  /** The message, exactly as serialised. */
  json: string;
  /** The bytes MAC'd, as a string (UTF-8). */
  macInput: string;
  /** The MAC in hex, for comparing with `openssl dgst -sha256 -hmac`. */
  macHex: string;
  /** The MAC as it is sent: unpadded base64url. */
  mac: string;
  /** The whole frame line. */
  frame: string;
  /** For an `http-stream` frame, the SSE event that carries it. */
  sse?: string;
}

/** A frame a correct implementation refuses. */
export interface RejectVector {
  /** What is wrong with it. */
  name: string;
  /** The session id the receiver expects. */
  sid: string;
  /** The sender role the receiver expects. */
  dir: "g" | "e";
  /** The line received. */
  frame: string;
  /** Why it is refused: `mac` (does not verify), `malformed` (not a frame) or `context` (authentic, but its seq or sid does not fit its op). */
  reason: "mac" | "malformed" | "context";
}

/** The vectors file. */
export interface FrameVectors {
  /** What the file is. */
  description: string;
  /** The script that writes it. */
  generatedBy: string;
  /** The key: this string's UTF-8 bytes. */
  secret: string;
  /** The frame's grammar. */
  frameFormat: string;
  /** The MAC's input. */
  macInputFormat: string;
  /** Frames that verify. */
  accept: AcceptVector[];
  /** Frames that must be refused. */
  reject: RejectVector[];
}

/** The inputs of each accepted vector. */
const INPUTS: {
  name: string;
  sid: string;
  dir: "g" | "e";
  seq: number;
  ack: number;
  message: { op: string; [field: string]: unknown };
  sse?: boolean;
}[] = [
  {
    name: 'hello, from a dialling gateway: sid "-", seq 0',
    sid: HELLO_SID,
    dir: "g",
    seq: 0,
    ack: 0,
    message: {
      op: "hello",
      v: 1,
      protocols: [1],
      role: "gateway",
      nonce: NONCE_DIALLER,
      t: 1790000000,
      at: 1790000000000,
    },
  },
  {
    name: "welcome, from the executor: sid is the hello's nonce, seq 0",
    sid: NONCE_DIALLER,
    dir: "e",
    seq: 0,
    ack: 0,
    message: {
      op: "welcome",
      v: 1,
      protocol: 1,
      role: "executor",
      nonce: NONCE_DIALLED,
      names: ["resize-image"],
      maxBatch: 25,
      maxDurationMs: 3300000,
      capacity: { inFlight: 0, max: 8, accepting: true },
      now: 1790000000123,
      at: 1790000000123,
    },
  },
  {
    name: "invoke, gateway to executor: the session's first sequenced frame",
    sid: SID,
    dir: "g",
    seq: 1,
    ack: 0,
    message: {
      op: "invoke",
      v: 1,
      id: "inv_01JB7Q2M9S0P",
      kind: "job",
      now: 1790000000456,
      deadlineAt: 1790000025456,
      namespace: "shop",
      queue: "media",
      jobs: [
        {
          id: "01JB7Q2M8ZRT9V",
          name: "resize-image",
          data: { url: "https://example.com/a.png" },
          attempt: 1,
          maxAttempts: 3,
          timeoutMs: 20000,
          idempotencyKey: "shop:media:01JB7Q2M8ZRT9V:1",
          fence: "h7f3-4211-1789:1790000000400",
          delivery: 1,
        },
      ],
      at: 1790000000456,
    },
  },
  {
    name: "accepted, executor to gateway: seq 1, acknowledging the invoke",
    sid: SID,
    dir: "e",
    seq: 1,
    ack: 1,
    message: {
      op: "accepted",
      job: "01JB7Q2M8ZRT9V",
      attempt: 1,
      fence: "h7f3-4211-1789:1790000000400",
      duplicate: false,
      at: 1790000000470,
    },
  },
  {
    name: "a bare ack, gateway to executor: seq 0, MAC'd in the session",
    sid: SID,
    dir: "g",
    seq: 0,
    ack: 1,
    message: { op: "ack" },
  },
  {
    name: "a log line outside ASCII: the JSON is MAC'd as UTF-8",
    sid: SID,
    dir: "e",
    seq: 2,
    ack: 1,
    message: {
      op: "log",
      job: "01JB7Q2M8ZRT9V",
      attempt: 1,
      level: "info",
      message: "café ☕ — 100 %",
      at: 1790000001201,
    },
  },
  {
    name: "the largest seq and ack: 2^53 - 1, in decimal",
    sid: SID,
    dir: "e",
    seq: 9007199254740991,
    ack: 9007199254740991,
    message: {
      op: "heartbeat",
      running: [],
      capacity: { inFlight: 0, max: 8, accepting: true },
      at: 1790000010470,
    },
  },
  {
    name: "http-stream: sid is the invoke envelope's id, dir e, seq from 1",
    sid: INVOKE_ID,
    dir: "e",
    seq: 1,
    ack: 0,
    message: {
      op: "accepted",
      job: "01JB7Q2M8ZRT9V",
      attempt: 1,
      fence: "h7f3-4211-1789:1790000000400",
      duplicate: false,
      at: 1790000000470,
    },
    sse: true,
  },
];

/** A frame line with one field replaced, its MAC left alone. */
function withField(frame: string, field: 1 | 2, value: string): string {
  const parts = frame.split(" ");
  parts[field] = value;
  return parts.join(" ");
}

/** Hex of some bytes. */
function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Builds every vector from {@link INPUTS}. Deterministic: the same code gives the same file. */
export async function generateFrameVectors(): Promise<FrameVectors> {
  const key = new TextEncoder().encode(VECTOR_SECRET);
  const accept: AcceptVector[] = [];
  for (const input of INPUTS) {
    const frame = await encodeTextFrame(input.message, {
      key,
      sid: input.sid,
      dir: input.dir,
      seq: input.seq,
      ack: input.ack,
    });
    const mac = frame.split(" ")[3]!;
    const json = JSON.stringify(input.message);
    const macBytes = Uint8Array.from(
      atob(mac.replaceAll("-", "+").replaceAll("_", "/").padEnd(44, "=")),
      (char) => char.charCodeAt(0),
    );
    accept.push({
      name: input.name,
      sid: input.sid,
      dir: input.dir,
      seq: input.seq,
      ack: input.ack,
      json,
      macInput: `BJ1\n${input.sid}\n${input.dir}\n${input.seq}\n${input.ack}\n${json}`,
      macHex: hex(macBytes),
      mac,
      frame,
      ...(input.sse
        ? {
            sse: `id: ${input.seq}\nevent: ${input.message.op}\ndata: ${frame}\n\n`,
          }
        : {}),
    });
  }

  const accepted = accept.find((vector) => vector.name.startsWith("accepted"))!;
  const hello = accept[0]!;
  const lastByte = accepted.frame.length - 2;
  const reject: RejectVector[] = [
    {
      name: "reflected: the executor's accepted, checked as if the gateway had sent it",
      sid: SID,
      dir: "g",
      frame: accepted.frame,
      reason: "mac",
    },
    {
      name: "another session: the same frame, checked under the http-stream sid",
      sid: INVOKE_ID,
      dir: "e",
      frame: accepted.frame,
      reason: "mac",
    },
    {
      name: "seq changed from 1 to 2, MAC kept",
      sid: SID,
      dir: "e",
      frame: withField(accepted.frame, 1, "2"),
      reason: "mac",
    },
    {
      name: "ack changed from 1 to 0, MAC kept",
      sid: SID,
      dir: "e",
      frame: withField(accepted.frame, 2, "0"),
      reason: "mac",
    },
    {
      name: "one byte of the JSON changed",
      sid: SID,
      dir: "e",
      frame: `${accepted.frame.slice(0, lastByte)}1${accepted.frame.slice(lastByte + 1)}`,
      reason: "mac",
    },
    {
      name: "a leading zero in seq",
      sid: SID,
      dir: "e",
      frame: withField(accepted.frame, 1, "01"),
      reason: "malformed",
    },
    {
      name: "the MAC padded with =",
      sid: SID,
      dir: "e",
      frame: accepted.frame.replace(accepted.mac, `${accepted.mac}=`),
      reason: "malformed",
    },
    {
      name: "another protocol version's magic",
      sid: SID,
      dir: "e",
      frame: accepted.frame.replace(/^BJ1 /, "BJ2 "),
      reason: "malformed",
    },
    {
      name: "a hello checked as a session frame: its sid is -, not the session's",
      sid: SID,
      dir: "g",
      frame: hello.frame,
      reason: "mac",
    },
  ];

  return {
    description:
      "Text frame test vectors for the bun-jobs remote-worker protocol, version 1 (remote-transports.md §4.3.1, §4.4.1). Every MAC is HMAC-SHA256 keyed with the UTF-8 bytes of `secret`.",
    generatedBy: "packages/bun-jobs/scripts/generate-frame-vectors.ts",
    secret: VECTOR_SECRET,
    frameFormat: '"BJ1" SP seq SP ack SP mac SP json',
    macInputFormat: '"BJ1" LF sid LF dir LF seq LF ack LF json',
    accept,
    reject,
  };
}

/** The file's text: two-space JSON and a final newline. */
export async function renderFrameVectors(): Promise<string> {
  return `${JSON.stringify(await generateFrameVectors(), null, 2)}\n`;
}

if (import.meta.main) {
  const text = await renderFrameVectors();
  if (process.argv.includes("--check")) {
    const current = await Bun.file(VECTORS_PATH)
      .text()
      .catch(() => "");
    if (current !== text) {
      process.stderr.write(
        `${VECTORS_PATH} is stale: run bun scripts/generate-frame-vectors.ts\n`,
      );
      process.exit(1);
    }
    process.stdout.write("The frame vectors are current.\n");
  } else {
    await Bun.write(VECTORS_PATH, text);
    process.stdout.write(`Wrote ${VECTORS_PATH}\n`);
  }
}
