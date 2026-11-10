import type { SseItem } from "../../lib/remote/protocol/sse";
import * as common from "@kingsleyweb/bun-common/sse";
import { describe, expect, it } from "bun:test";
import { nodeHmacSha256 } from "../../lib/remote/host/mac";
import {
  decodeTextFrame,
  encodeTextFrame,
} from "../../lib/remote/protocol/frame";
import * as protocol from "../../lib/remote/protocol/sse";
import { keysOf } from "../../lib/remote/signing";

/**
 * The remote protocol's Server-Sent Events: bun-common's parser and encoder
 * (`@kingsleyweb/bun-common/sse`), re-exported by `lib/remote/protocol/sse.ts`
 * (bun-native-routes plan §16.7, PR-sse5). The standard's cases (every line
 * end, the BOM, comments, multi-line data, `id`, `retry`, every split point,
 * the length bound) are bun-common's `__tests__/sse/parser.test.ts`, lifted
 * verbatim from this file; what stays here is the protocol's own: signed
 * text frames carried as events, written with the encoder an executor's
 * `http-stream` writer uses and read back with the gateway's parser.
 */

const { encodeSseEvent, readSse, SseParser } = protocol;

/** Parses a stream fed in the given pieces. */
function parseChunks(chunks: string[]): SseItem[] {
  const parser = new SseParser();
  const out = chunks.flatMap((chunk) => parser.push(chunk));
  parser.end();
  return out;
}

/** A remote attempt's messages, one of them with a line end in a field. */
const MESSAGES = [
  { op: "accepted", job: "j", attempt: 1, fence: "f", duplicate: false },
  { op: "log", job: "j", attempt: 1, level: "info", message: "a: b\nc" },
  { op: "result", job: "j", attempt: 1, fence: "f", status: "completed" },
  { op: "close", code: "COMPLETE" },
];

/** Each message as a signed text frame line, `seq` from 1. */
async function frames(key: Uint8Array, sid: string): Promise<string[]> {
  const lines: string[] = [];
  for (const [index, message] of MESSAGES.entries()) {
    lines.push(
      await encodeTextFrame(message, {
        key,
        sid,
        dir: "e",
        seq: index + 1,
        ack: 0,
        mac: nodeHmacSha256,
      }),
    );
  }
  return lines;
}

describe("the protocol's SSE is bun-common's, not a copy", () => {
  it("re-exports bun-common's parser, reader and encoder themselves", () => {
    // A copy, however faithful, is a different class and function: the
    // drift PR-sse5 removes. The control: put the old file back and these fail.
    expect(protocol.SseParser).toBe(common.SseParser);
    expect(protocol.readSse).toBe(common.readSse);
    expect(protocol.encodeSseEvent).toBe(common.encodeSseEvent);
    expect(protocol.formatSseEvent).toBe(common.formatSseEvent);
  });

  it("the identity check tells a copy from the original (the control)", () => {
    // A subclass is the cheapest faithful copy: it parses identically and
    // still fails `toBe`, which is what the check above relies on.
    class Copy extends common.SseParser {}
    expect(new Copy().push("data: x\n\n")).toEqual(
      new common.SseParser().push("data: x\n\n"),
    );
    expect(Copy).not.toBe(common.SseParser);
  });
});

describe("text frames carried as SSE events (the http-stream mapping)", () => {
  it("each frame is one event; every one verifies after a parse in arbitrary chunks", async () => {
    const [key] = keysOf("sse-frame-secret");
    const sid = "inv_01JB7Q2M9S0P";
    const lines = await frames(key, sid);
    let stream = ": open\n\n";
    for (const [index, message] of MESSAGES.entries()) {
      stream += `id: ${index + 1}\nevent: ${message.op}\ndata: ${lines[index]}\n\n`;
    }
    const chunks: string[] = [];
    for (let at = 0; at < stream.length; at += 37) {
      chunks.push(stream.slice(at, at + 37));
    }
    const events = parseChunks(chunks).filter((item) => item.kind === "event");
    expect(events).toHaveLength(4);
    for (const [index, item] of events.entries()) {
      if (item.kind !== "event") {
        throw new Error("unreachable");
      }
      expect(item.id).toBe(String(index + 1));
      const decoded = await decodeTextFrame(item.data, {
        keys: [key],
        sid,
        dir: "e",
        mac: nodeHmacSha256,
      });
      expect(decoded.ok && decoded.frame.message).toEqual(MESSAGES[index]);
      expect(item.event).toBe(MESSAGES[index].op);
    }
  });

  it("the encoder writes the same events, byte for byte, and readSse reads them back verified", async () => {
    const [key] = keysOf("sse-frame-secret");
    const sid = "inv_01JB7Q2M9S0P";
    const lines = await frames(key, sid);
    const blocks = MESSAGES.map((message, index) =>
      encodeSseEvent({ id: index + 1, event: message.op, data: lines[index] }),
    );
    // What the hand-written stream above spells out, so the writer's framing
    // is the one the gateway has always parsed.
    const text = new TextDecoder();
    expect(blocks.map((block) => text.decode(block))).toEqual(
      MESSAGES.map(
        (message, index) =>
          `event: ${message.op}\nid: ${index + 1}\ndata: ${lines[index]}\n\n`,
      ),
    );
    const body = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encodeSseEvent({ comment: "open" }));
          for (const block of blocks) {
            // Split each block, as a socket may.
            controller.enqueue(block.subarray(0, 11));
            controller.enqueue(block.subarray(11));
          }
          controller.close();
        },
      }),
    ).body!;
    const decoded: unknown[] = [];
    const comments: string[] = [];
    for await (const item of readSse(body)) {
      if (item.kind === "comment") {
        comments.push(item.text);
        continue;
      }
      const frame = await decodeTextFrame(item.data, {
        keys: [key],
        sid,
        dir: "e",
        mac: nodeHmacSha256,
      });
      decoded.push(frame.ok && frame.frame.message);
    }
    expect(comments).toEqual([" open"]);
    expect(decoded).toEqual(MESSAGES);
  });

  it("a frame tampered with in transit fails its MAC after the parse (the control)", async () => {
    const [key] = keysOf("sse-frame-secret");
    const sid = "inv_01JB7Q2M9S0P";
    const [line] = await frames(key, sid);
    const tampered = line.replace('"duplicate":false', '"duplicate":true');
    expect(tampered).not.toBe(line);
    const [item] = new SseParser().push(
      new TextDecoder().decode(encodeSseEvent({ data: tampered })),
    );
    expect(item.kind).toBe("event");
    const decoded = await decodeTextFrame((item as { data: string }).data, {
      keys: [key],
      sid,
      dir: "e",
      mac: nodeHmacSha256,
    });
    expect(decoded.ok).toBe(false);
  });
});
