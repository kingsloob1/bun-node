import type { SseItem } from "../../lib/remote/protocol/sse";
import { describe, expect, it } from "bun:test";
import { nodeHmacSha256 } from "../../lib/remote/host/mac";
import {
  decodeTextFrame,
  encodeTextFrame,
} from "../../lib/remote/protocol/frame";
import { readSse, SseParser } from "../../lib/remote/protocol/sse";
import { keysOf } from "../../lib/remote/signing";

/**
 * The SSE parser, against the WHATWG "event stream interpretation": every
 * line ending, the BOM, comments, multi-line data, `id` and `retry`, and
 * text split at every possible point.
 */

/** U+FEFF, the byte order mark, spelled out so it is never an invisible literal. */
const BOM = String.fromCharCode(0xfeff);

/** Parses a whole stream at once. */
function parse(text: string): SseItem[] {
  const parser = new SseParser();
  const out = parser.push(text);
  parser.end();
  return out;
}

/** Parses a stream fed in the given pieces. */
function parseChunks(chunks: string[]): SseItem[] {
  const parser = new SseParser();
  const out = chunks.flatMap((chunk) => parser.push(chunk));
  parser.end();
  return out;
}

/** An event item. */
function event(data: string, type = "message", id = ""): SseItem {
  return { kind: "event", event: type, data, id };
}

describe("fields and dispatch", () => {
  it("dispatches on a blank line, with the default type message", () => {
    expect(parse("data: hello\n\n")).toEqual([event("hello")]);
  });

  it("joins multi-line data with LF, and drops the trailing one", () => {
    expect(parse("data: one\ndata: two\ndata:\ndata: four\n\n")).toEqual([
      event("one\ntwo\n\nfour"),
    ]);
  });

  it("takes the event type, and resets it after each event", () => {
    expect(parse("event: accepted\ndata: a\n\ndata: b\n\n")).toEqual([
      event("a", "accepted"),
      event("b"),
    ]);
  });

  it("drops exactly one space after the colon", () => {
    expect(parse("data:no-space\n\ndata:  two-spaces\n\n")).toEqual([
      event("no-space"),
      event(" two-spaces"),
    ]);
  });

  it("keeps colons in the value", () => {
    expect(parse('data: BJ1 1 0 x {"a":1}\n\n')).toEqual([
      event('BJ1 1 0 x {"a":1}'),
    ]);
  });

  it("a line without a colon is a field with an empty value", () => {
    expect(parse("data\ndata\n\n")).toEqual([event("\n")]);
    // An `event` with no value is the default type.
    expect(parse("event\ndata: x\n\n")).toEqual([event("x")]);
  });

  it("ignores unknown fields, and field names are case-sensitive", () => {
    expect(parse("Data: x\nfoo: bar\ndata: y\n\n")).toEqual([event("y")]);
  });

  it("does not dispatch an event with no data", () => {
    expect(parse("event: ping\n\n\n\n")).toEqual([]);
  });

  it("discards an event the stream ends in the middle of", () => {
    expect(parse("data: complete\n\ndata: cut off\n")).toEqual([
      event("complete"),
    ]);
    expect(parse("data: no newline at all")).toEqual([]);
  });
});

describe("id and retry", () => {
  it("each event carries the last event id, which persists until changed", () => {
    expect(parse("id: 1\ndata: a\n\ndata: b\n\nid: 3\ndata: c\n\n")).toEqual([
      event("a", "message", "1"),
      event("b", "message", "1"),
      event("c", "message", "3"),
    ]);
  });

  it("an id on an event with no data still counts", () => {
    const parser = new SseParser();
    expect(parser.push("id: 7\n\n")).toEqual([]);
    expect(parser.lastEventId).toBe("7");
    expect(parser.push("data: x\n\n")).toEqual([event("x", "message", "7")]);
  });

  it("an empty id resets it; an id containing NUL is ignored", () => {
    expect(parse("id: 1\ndata: a\n\nid\ndata: b\n\n")).toEqual([
      event("a", "message", "1"),
      event("b"),
    ]);
    expect(parse("id: 1\ndata: a\n\nid: 2\0\ndata: b\n\n")).toEqual([
      event("a", "message", "1"),
      event("b", "message", "1"),
    ]);
  });

  it("the id takes effect at dispatch, not when read", () => {
    const parser = new SseParser();
    parser.push("id: 5\ndata: x\n");
    expect(parser.lastEventId).toBe("");
    parser.push("\n");
    expect(parser.lastEventId).toBe("5");
  });

  it("honours retry only when it is all ASCII digits", () => {
    const parser = new SseParser();
    parser.push("retry: 1500\n");
    expect(parser.retry).toBe(1500);
    for (const bad of [
      "retry: -1\n",
      "retry: 1.5\n",
      "retry: 2s\n",
      "retry: \n",
      "retry: ２\n",
    ]) {
      parser.push(bad);
      expect(parser.retry).toBe(1500);
    }
    parser.push("retry: 0\n");
    expect(parser.retry).toBe(0);
  });
});

describe("comments", () => {
  it("returns comments in order, between events, without dispatching", () => {
    expect(parse(": open\ndata: a\n:keepalive\n\n: \n")).toEqual([
      { kind: "comment", text: " open" },
      { kind: "comment", text: "keepalive" },
      event("a"),
      { kind: "comment", text: " " },
    ]);
  });

  it("a comment line does not end an event", () => {
    expect(parse("data: a\n: note\ndata: b\n\n")).toEqual([
      { kind: "comment", text: " note" },
      event("a\nb"),
    ]);
  });
});

describe("line endings", () => {
  const stream = "event: e\ndata: a\ndata: b\n\ndata: c\n\n";
  const expected = [event("a\nb", "e"), event("c")];

  it("LF, CRLF and CR, and a mix of them, parse the same", () => {
    expect(parse(stream)).toEqual(expected);
    expect(parse(stream.replaceAll("\n", "\r\n"))).toEqual(expected);
    expect(parse(stream.replaceAll("\n", "\r"))).toEqual(expected);
    expect(parse("event: e\r\ndata: a\rdata: b\n\r\ndata: c\r\r")).toEqual(
      expected,
    );
  });

  it("CR then LF across a chunk boundary is one line ending, not two", () => {
    expect(parseChunks(["data: a\r", "\ndata: b\r\n\r", "\n"])).toEqual([
      event("a\nb"),
    ]);
  });

  it("a CR at a chunk's end followed by text is a line ending", () => {
    expect(parseChunks(["data: a\r", "data: b\r", "\r"])).toEqual([
      event("a\nb"),
    ]);
  });

  it("CR CR is two line endings: the event dispatches", () => {
    expect(parseChunks(["data: a\r", "\r"])).toEqual([event("a")]);
  });
});

describe("the byte order mark", () => {
  it("drops one leading BOM", () => {
    expect(parse(`${BOM}data: a\n\n`)).toEqual([event("a")]);
  });

  it("drops it when it arrives alone, or after empty chunks", () => {
    expect(parseChunks(["", BOM, "data: a\n\n"])).toEqual([event("a")]);
  });

  it("drops only the first: a second is part of the field name", () => {
    // BOM + "data" is not "data", so the line is an unknown field.
    expect(parse(`${BOM}${BOM}data: a\n\ndata: b\n\n`)).toEqual([event("b")]);
  });

  it("a BOM later in the stream is kept as text", () => {
    expect(parse(`data: ${BOM}a\n\n`)).toEqual([event(`${BOM}a`)]);
  });
});

describe("partial chunks", () => {
  const stream = `${BOM}: open\r\nid: 1\r\nevent: accepted\r\ndata: BJ1 1 0 mac {"op":"accepted"}\r\n\r\nretry: 250\ndata: two\ndata: lines\n\n:tail\r`;
  const whole = parse(stream);

  it("the whole stream (the reference)", () => {
    expect(whole).toEqual([
      { kind: "comment", text: " open" },
      event('BJ1 1 0 mac {"op":"accepted"}', "accepted", "1"),
      event("two\nlines", "message", "1"),
      { kind: "comment", text: "tail" },
    ]);
  });

  it("split at every single point gives the same items", () => {
    for (let at = 0; at <= stream.length; at++) {
      expect(parseChunks([stream.slice(0, at), stream.slice(at)])).toEqual(
        whole,
      );
    }
  });

  it("one character at a time gives the same items", () => {
    expect(parseChunks([...stream])).toEqual(whole);
  });

  it("split at every pair of points gives the same items", () => {
    for (let a = 0; a <= stream.length; a += 3) {
      for (let b = a; b <= stream.length; b += 5) {
        expect(
          parseChunks([
            stream.slice(0, a),
            stream.slice(a, b),
            stream.slice(b),
          ]),
        ).toEqual(whole);
      }
    }
  });
});

describe("the size bound", () => {
  it("throws when one event's line and data pass maxEventLength", () => {
    const parser = new SseParser({ maxEventLength: 20 });
    expect(parser.push("data: 0123456789\n")).toEqual([]);
    expect(() => parser.push("data: 0123456789\n")).toThrow(RangeError);
  });

  it("throws for a line that never ends", () => {
    const parser = new SseParser({ maxEventLength: 100 });
    expect(() => {
      for (let i = 0; i < 20; i++) {
        parser.push("data: xxxxxxxx");
      }
    }).toThrow(RangeError);
  });

  it("counts per event: many small events pass (the control)", () => {
    const parser = new SseParser({ maxEventLength: 20 });
    for (let i = 0; i < 100; i++) {
      expect(parser.push("data: 0123456789\n\n")).toHaveLength(1);
    }
  });

  it("refuses an unusable bound", () => {
    expect(() => new SseParser({ maxEventLength: 0 })).toThrow(RangeError);
    expect(() => new SseParser({ maxEventLength: 1.5 })).toThrow(RangeError);
  });
});

describe("readSse over a byte stream", () => {
  /** A stream of the given byte chunks. */
  function bytes(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
    return new ReadableStream({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(chunk);
        }
        controller.close();
      },
    });
  }

  /** Collects every item. */
  async function collect(
    stream: ReadableStream<Uint8Array>,
  ): Promise<SseItem[]> {
    const out: SseItem[] = [];
    for await (const item of readSse(stream)) {
      out.push(item);
    }
    return out;
  }

  it("decodes UTF-8 split inside a character, and drops the BOM's bytes", async () => {
    const encoded = new TextEncoder().encode(`${BOM}data: café ☕ 𝄞\n\n`);
    expect(encoded.slice(0, 3)).toEqual(new Uint8Array([0xef, 0xbb, 0xbf]));
    for (let at = 0; at <= encoded.length; at++) {
      expect(
        await collect(bytes([encoded.slice(0, at), encoded.slice(at)])),
      ).toEqual([event("café ☕ 𝄞")]);
    }
  });

  it("byte by byte", async () => {
    const encoded = new TextEncoder().encode(
      ": open\r\nid: 1\r\ndata: é\r\n\r\n",
    );
    const chunks = [...encoded].map((byte) => new Uint8Array([byte]));
    expect(await collect(bytes(chunks))).toEqual([
      { kind: "comment", text: " open" },
      event("é", "message", "1"),
    ]);
  });

  it("reads a fetch Response body, and stopping early cancels the stream", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new TextEncoder().encode("data: tick\n\n"));
      },
      cancel() {
        cancelled = true;
      },
    });
    const response = new Response(body, {
      headers: { "content-type": "text/event-stream" },
    });
    let seen = 0;
    for await (const item of readSse(response.body!)) {
      expect(item).toEqual(event("tick"));
      if (++seen === 3) {
        break;
      }
    }
    expect(cancelled).toBe(true);
  });
});

describe("text frames carried as SSE events (the http-stream mapping)", () => {
  it("each frame is one event; every one verifies after a parse in arbitrary chunks", async () => {
    const [key] = keysOf("sse-frame-secret");
    const sid = "inv_01JB7Q2M9S0P";
    const messages = [
      { op: "accepted", job: "j", attempt: 1, fence: "f", duplicate: false },
      { op: "log", job: "j", attempt: 1, level: "info", message: "a: b\nc" },
      { op: "result", job: "j", attempt: 1, fence: "f", status: "completed" },
      { op: "close", code: "COMPLETE" },
    ];
    let stream = ": open\n\n";
    for (const [index, message] of messages.entries()) {
      const line = await encodeTextFrame(message, {
        key: key!,
        sid,
        dir: "e",
        seq: index + 1,
        ack: 0,
        mac: nodeHmacSha256,
      });
      stream += `id: ${index + 1}\nevent: ${message.op}\ndata: ${line}\n\n`;
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
        keys: [key!],
        sid,
        dir: "e",
        mac: nodeHmacSha256,
      });
      expect(decoded.ok && decoded.frame.message).toEqual(messages[index]!);
      expect(item.event).toBe(messages[index]!.op);
    }
  });
});
