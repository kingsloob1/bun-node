/**
 * The event-stream parser (`lib/sseParser.ts`; typed-client plan, `sse.md`
 * §3.1, §5): the HTML standard's rules over a corpus, and the same corpus
 * through bun-common's `SseFramer` (the server's response check), so the
 * client reads every event the server checks, and the two cannot drift.
 *
 * Each case runs three ways: in the chunks it lists, whole, and one byte at
 * a time (line ends and multi-byte characters split across chunks). The
 * framer is fed as the server feeds it (a default `TextDecoder`, which drops
 * a byte order mark); the parser as `sse()` feeds it (`ignoreBOM: true`, the
 * parser dropping the one mark the standard allows).
 *
 * The control: a framer that splits on `\n\n` alone, the usual shortcut,
 * disagrees with the corpus on the CR and CRLF cases.
 */
import { describe, expect, it } from "bun:test";
import { SseFramer } from "@kingsleyweb/bun-common/lib/responseBodies";
import { SseParser } from "../lib/sseParser";

/** One corpus case. */
interface Case {
  /** What it covers. */
  readonly name: string;
  /** The stream, in the chunks it arrives in. */
  readonly chunks: readonly string[];
  /** The events: name, data, and the parser's last event ID as of each. */
  readonly events: readonly {
    name: string;
    data: string | undefined;
    id?: string;
  }[];
  /** The parser's committed last event ID at the end. Default `""`. */
  readonly lastEventId?: string;
  /** The parser's reconnection time at the end. Default `undefined`. */
  readonly retry?: number;
}

const CORPUS: readonly Case[] = [
  {
    name: "one event, LF",
    chunks: ["data: hello\n\n"],
    events: [{ name: "message", data: "hello" }],
  },
  {
    name: "a named event",
    chunks: ["event: tick\ndata: 1\n\n"],
    events: [{ name: "tick", data: "1" }],
  },
  {
    name: "multi-line data, joined with LF",
    chunks: ["data: a\ndata: b\ndata:\n\n"],
    events: [{ name: "message", data: "a\nb\n" }],
  },
  {
    name: "CRLF line ends",
    chunks: ["event: x\r\ndata: 1\r\n\r\ndata: 2\r\n\r\n"],
    events: [
      { name: "x", data: "1" },
      { name: "message", data: "2" },
    ],
  },
  {
    name: "CR line ends",
    chunks: ["data: a\rdata: b\r\rdata: c\r\r"],
    events: [
      { name: "message", data: "a\nb" },
      { name: "message", data: "c" },
    ],
  },
  {
    name: "a CR ending one chunk and an LF opening the next are one line end",
    chunks: ["data: a\r", "\n\r", "\ndata: b\r", "\r"],
    events: [
      { name: "message", data: "a" },
      { name: "message", data: "b" },
    ],
  },
  {
    name: "mixed line ends",
    chunks: ["data: a\r\ndata: b\rdata: c\n\r\n"],
    events: [{ name: "message", data: "a\nb\nc" }],
  },
  {
    name: "comments, before, between and after fields",
    chunks: [": hello\ndata: x\n:\n: there\n\n:only a comment\n\n"],
    events: [{ name: "message", data: "x" }],
  },
  {
    name: "one space after the colon is dropped, no more",
    chunks: ["data:x\n\ndata:  y\n\n"],
    events: [
      { name: "message", data: "x" },
      { name: "message", data: " y" },
    ],
  },
  {
    name: "a field with no colon has an empty value",
    chunks: ["data\n\ndata\ndata\n\n"],
    events: [
      { name: "message", data: "" },
      { name: "message", data: "\n" },
    ],
  },
  {
    name: "an empty event name is message",
    chunks: ["event:\ndata: a\n\n"],
    events: [{ name: "message", data: "a" }],
  },
  {
    name: "data before the event line",
    chunks: ["data: a\nevent: late\n\n"],
    events: [{ name: "late", data: "a" }],
  },
  {
    name: "unknown fields are ignored",
    chunks: ["foo: bar\ndata: a\nDATA: no\nEvent: no\n\n"],
    events: [{ name: "message", data: "a" }],
  },
  {
    name: "ids: kept across events, reset by an empty id",
    chunks: ["id: 7\ndata: a\n\ndata: b\n\nid\ndata: c\n\n"],
    events: [
      { name: "message", data: "a", id: "7" },
      { name: "message", data: "b", id: "7" },
      { name: "message", data: "c", id: "" },
    ],
  },
  {
    name: "an id holding NUL is ignored",
    chunks: ["id: 1\ndata: a\n\nid: 2\u00003\ndata: b\n\n"],
    events: [
      { name: "message", data: "a", id: "1" },
      { name: "message", data: "b", id: "1" },
    ],
    lastEventId: "1",
  },
  {
    name: "an id-only block makes no event but commits the id",
    chunks: ["data: a\n\nid: 9\n\n"],
    events: [{ name: "message", data: "a", id: "" }],
    lastEventId: "9",
  },
  {
    name: "retry: ASCII digits only",
    chunks: ["retry: 1500\n\nretry: 15x\n\nretry: -1\n\nretry:  10\n\n"],
    events: [],
    retry: 1500,
  },
  {
    name: "one byte order mark is dropped",
    chunks: ["\uFEFFdata: a\n\n"],
    events: [{ name: "message", data: "a" }],
  },
  {
    name: "a second byte order mark is part of the field name",
    chunks: ["\uFEFF\uFEFFdata: a\n\ndata: b\n\n"],
    events: [{ name: "message", data: "b" }],
  },
  {
    name: "a byte order mark later in the stream is text",
    chunks: ["data: a\n\n", "\uFEFFdata: b\n\n"],
    events: [{ name: "message", data: "a" }],
  },
  {
    name: "an event line with no data line is an event, data undefined (bun-common's null events)",
    chunks: ["event: done\n\n"],
    events: [{ name: "done", data: undefined }],
  },
  {
    name: "blank lines alone make nothing",
    chunks: ["\n\n\r\n\r\r\n"],
    events: [],
  },
  {
    name: "an event not ended by a blank line is discarded at the end",
    chunks: ["data: a\n\nid: 4\ndata: b"],
    events: [{ name: "message", data: "a" }],
  },
  {
    name: "multi-byte characters",
    chunks: ["data: héllo 😀 世界\n\n"],
    events: [{ name: "message", data: "héllo 😀 世界" }],
  },
];

/** A case's bytes in the given chunking. */
function chunkings(
  item: Case,
): readonly (readonly [string, readonly Uint8Array[]])[] {
  const encoder = new TextEncoder();
  const whole = encoder.encode(item.chunks.join(""));
  return [
    ["as listed", item.chunks.map((chunk) => encoder.encode(chunk))],
    ["whole", [whole]],
    ["byte by byte", [...whole].map((byte) => new Uint8Array([byte]))],
  ];
}

/** Runs the client's parser over chunks as `sse()` does. */
function parse(chunks: readonly Uint8Array[]): {
  events: { name: string; data: string | undefined; id: string }[];
  parser: SseParser;
} {
  const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
  const parser = new SseParser();
  const events = chunks.flatMap((chunk) =>
    parser.push(decoder.decode(chunk, { stream: true })),
  );
  return { events: events.map((event) => ({ ...event })), parser };
}

/** Runs bun-common's framer over chunks as the server's response check does. */
function frame(
  chunks: readonly Uint8Array[],
  framer: {
    push: (
      text: string,
    ) => readonly { name: string; data: string | undefined }[];
  } = new SseFramer(),
): { name: string; data: string | undefined }[] {
  const decoder = new TextDecoder();
  return chunks.flatMap((chunk) =>
    framer
      .push(decoder.decode(chunk, { stream: true }))
      .map(({ name, data }) => ({ name, data })),
  );
}

describe("the parser over the corpus (the HTML standard's rules)", () => {
  for (const item of CORPUS) {
    for (const [how, chunks] of chunkings(item)) {
      it(`${item.name} (${how})`, () => {
        const { events, parser } = parse(chunks);
        expect(events.map(({ name, data }) => ({ name, data }))).toEqual(
          item.events.map(({ name, data }) => ({ name, data })),
        );
        for (const [index, expected] of item.events.entries()) {
          if (expected.id !== undefined)
            expect(events[index].id).toBe(expected.id);
        }
        expect(parser.lastEventId).toBe(
          item.lastEventId ?? item.events.at(-1)?.id ?? "",
        );
        expect(parser.retry).toBe(item.retry);
      });
    }
  }

  it("commits an id only at a blank line: a reconnection resumes from the last complete block", () => {
    const parser = new SseParser();
    parser.push("id: 1\ndata: a\n\nid: 2\ndata: b");
    expect(parser.lastEventId).toBe("1");
    parser.push("\n\n");
    expect(parser.lastEventId).toBe("2");
  });

  it("starts from a given last event ID (a reconnection carries it)", () => {
    const parser = new SseParser("41");
    expect(parser.lastEventId).toBe("41");
    expect(parser.push("data: a\n\n")).toEqual([
      { name: "message", data: "a", id: "41" },
    ]);
  });
});

describe("the shared corpus: bun-common's SseFramer frames the same events", () => {
  for (const item of CORPUS) {
    for (const [how, chunks] of chunkings(item)) {
      it(`${item.name} (${how})`, () => {
        expect(frame(chunks)).toEqual(
          parse(chunks).events.map(({ name, data }) => ({ name, data })),
        );
      });
    }
  }

  it("control: a framer that splits on \\n\\n alone disagrees on the CR and CRLF cases", () => {
    /** The shortcut: blocks split on a blank LF line, fields on LF. */
    class NaiveFramer {
      #text = "";
      push(text: string): { name: string; data: string | undefined }[] {
        this.#text += text;
        const blocks = this.#text.split("\n\n");
        this.#text = blocks.pop()!;
        return blocks.flatMap((block) => {
          let name = "";
          const data: string[] = [];
          for (const line of block.split("\n")) {
            if (line.startsWith("event:")) name = line.slice(6).trim();
            else if (line.startsWith("data:"))
              data.push(line.slice(5).trimStart());
          }
          return name === "" && data.length === 0
            ? []
            : [
                {
                  name: name || "message",
                  data: data.length === 0 ? undefined : data.join("\n"),
                },
              ];
        });
      }
    }
    const disagree = CORPUS.filter((item) => {
      const chunks = chunkings(item)[0][1];
      return !Bun.deepEquals(
        frame(chunks, new NaiveFramer()),
        parse(chunks).events.map(({ name, data }) => ({ name, data })),
      );
    }).map((item) => item.name);
    expect(disagree).toEqual(
      expect.arrayContaining([
        "CRLF line ends",
        "CR line ends",
        "a CR ending one chunk and an LF opening the next are one line end",
        "mixed line ends",
      ]),
    );
  });
});
