/**
 * The event-stream encoder (`lib/sse/format.ts`, bun-native-routes plan
 * §16.5): each rule as a vector, every vector read back through the
 * standard parser (`SseParser`) and the response check's framer
 * (`SseFramer`), so the writer and both readers cannot drift.
 */
import type { SseMessage } from "../../lib/sse";
import { describe, expect, it } from "bun:test";
import { SseFramer } from "../../lib/responseBodies";
import { encodeSseEvent, formatSseEvent, SseParser } from "../../lib/sse";

/** The events the standard parser dispatches from `text`. */
function parsed(text: string) {
  const parser = new SseParser();
  const items = parser.push(text);
  parser.end();
  return { items, retry: parser.retry, lastEventId: parser.lastEventId };
}

describe("formatSseEvent", () => {
  const vectors: [string, SseMessage, string][] = [
    ["a string as it is", { data: "hello" }, "data: hello\n\n"],
    ["an object as JSON", { data: { n: 1 } }, 'data: {"n":1}\n\n'],
    ["0 is sent", { data: 0 }, "data: 0\n\n"],
    ['"" is sent, as an empty data line', { data: "" }, "data:\n\n"],
    ["false is sent", { data: false }, "data: false\n\n"],
    ["null is sent as JSON", { data: null }, "data: null\n\n"],
    [
      "LF, CR and CRLF each end a data line",
      { data: "a\nb\rc\r\nd" },
      "data: a\ndata: b\ndata: c\ndata: d\n\n",
    ],
    [
      "a leading space is kept (one is added after the colon)",
      { data: " x" },
      "data:  x\n\n",
    ],
    [
      "every field, in order",
      { comment: "c", event: "tick", id: 7, retry: 1000, data: "d" },
      ": c\nevent: tick\nid: 7\nretry: 1000\ndata: d\n\n",
    ],
    [
      "a named event without data gets one empty data line",
      { event: "gap" },
      "event: gap\ndata:\n\n",
    ],
    ["an id alone is not an event", { id: "42" }, "id: 42\n\n"],
    ["an empty id resets the last event ID", { id: "" }, "id:\n\n"],
    ["a retry alone", { retry: 0 }, "retry: 0\n\n"],
    ["a comment", { comment: "ok" }, ": ok\n\n"],
    ["the heartbeat is a bare colon", { comment: "" }, ":\n\n"],
    ["a multi-line comment", { comment: "a\nb" }, ": a\n: b\n\n"],
  ];
  for (const [name, message, wire] of vectors) {
    it(name, () => {
      expect(formatSseEvent(message)).toBe(wire);
      expect(new TextDecoder().decode(encodeSseEvent(message))).toBe(wire);
    });
  }

  it("refuses an event or id with a line end, an id with NUL, and a bad retry", () => {
    expect(() => formatSseEvent({ event: "a\nb" })).toThrow(TypeError);
    expect(() => formatSseEvent({ event: "a\rb" })).toThrow(TypeError);
    expect(() => formatSseEvent({ id: "1\n2" })).toThrow(TypeError);
    expect(() => formatSseEvent({ id: "1\u00002" })).toThrow(TypeError);
    expect(() => formatSseEvent({ id: Number.NaN })).toThrow(TypeError);
    expect(() => formatSseEvent({ retry: -1 })).toThrow(TypeError);
    expect(() => formatSseEvent({ retry: 1.5 })).toThrow(TypeError);
    // The control: the same fields, well formed, pass.
    expect(() =>
      formatSseEvent({ event: "a b", id: "1 2", retry: 0 }),
    ).not.toThrow();
  });

  it("writes no byte order mark", () => {
    expect(encodeSseEvent({ data: "x" })[0]).toBe("d".charCodeAt(0));
  });
});

describe("what the readers make of it", () => {
  it("the standard parser reads every field back", () => {
    const text =
      formatSseEvent({ data: "a\r\nb" }) +
      formatSseEvent({ event: "tick", id: 7, data: { n: 1 } }) +
      formatSseEvent({ retry: 2500 }) +
      formatSseEvent({ comment: "" }) +
      formatSseEvent({ event: "gap" }) +
      formatSseEvent({ data: "" });
    const { items, retry, lastEventId } = parsed(text);
    expect(items).toEqual([
      { kind: "event", event: "message", data: "a\nb", id: "" },
      { kind: "event", event: "tick", data: '{"n":1}', id: "7" },
      { kind: "comment", text: "" },
      { kind: "event", event: "gap", data: "", id: "7" },
      { kind: "event", event: "message", data: "", id: "7" },
    ]);
    expect(retry).toBe(2500);
    expect(lastEventId).toBe("7");
  });

  it("a named event without data is dispatched by the standard parser (the control: without its data line it is not)", () => {
    expect(parsed(formatSseEvent({ event: "gap" })).items).toHaveLength(1);
    // What the line buys: the same block without it is dropped, as
    // EventSource drops it.
    expect(parsed("event: gap\n\n").items).toHaveLength(0);
  });

  it("the response check's framer sees the same events, a data-less one as empty", () => {
    const framer = new SseFramer();
    const frames = framer.push(
      formatSseEvent({ event: "tick", data: { n: 1 } }) +
        formatSseEvent({ event: "gap" }) +
        formatSseEvent({ comment: "ok" }) +
        formatSseEvent({ id: 3 }),
    );
    expect(frames).toEqual([
      { name: "tick", data: '{"n":1}' },
      { name: "gap", data: "" },
    ]);
  });
});
