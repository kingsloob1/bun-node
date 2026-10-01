import { describe, expect, it } from "bun:test";
import { nodeHmacSha256 } from "../../lib/remote/host/mac";
import {
  decodeTextFrame,
  encodeTextFrame,
  sessionId,
} from "../../lib/remote/protocol/frame";
import { TextFrameWindow } from "../../lib/remote/protocol/sequence";
import { keysOf } from "../../lib/remote/signing";

/**
 * §4.4.2's replay rules on a text transport, and §4.4.1's acknowledgement
 * rule: exactly last + 1 is delivered, lower is a silent duplicate, higher
 * is a gap; the peer's ack only moves forward and never past what was sent.
 */

describe("the receive window", () => {
  it("delivers 1, 2, 3 in order and acknowledges each", () => {
    const window = new TextFrameWindow();
    for (const seq of [1, 2, 3]) {
      expect(window.admit({ seq, ack: 0 })).toEqual({
        verdict: "deliver",
        acked: 0,
      });
      expect(window.delivered).toBe(seq);
    }
  });

  it("drops a duplicate silently, at any depth, and moves nothing", () => {
    const window = new TextFrameWindow();
    window.admit({ seq: 1, ack: 0 });
    window.admit({ seq: 2, ack: 2 }, 5);
    for (const seq of [1, 2]) {
      expect(window.admit({ seq, ack: 5 }, 5)).toEqual({
        verdict: "duplicate",
      });
    }
    expect([window.delivered, window.peerAck]).toEqual([2, 2]);
  });

  it("calls a jump a gap, naming what was due, and moves nothing", () => {
    const window = new TextFrameWindow();
    window.admit({ seq: 1, ack: 0 });
    expect(window.admit({ seq: 3, ack: 1 }, 1)).toEqual({
      verdict: "gap",
      expected: 2,
      received: 3,
    });
    expect([window.delivered, window.peerAck]).toEqual([1, 0]);
    // The first frame of a session must be 1.
    expect(new TextFrameWindow().admit({ seq: 2, ack: 0 })).toMatchObject({
      verdict: "gap",
      expected: 1,
    });
  });

  it("reorder: 1, 3, 2 is a gap at 3, and 2 then delivers", () => {
    const window = new TextFrameWindow();
    expect(window.admit({ seq: 1, ack: 0 }).verdict).toBe("deliver");
    expect(window.admit({ seq: 3, ack: 0 }).verdict).toBe("gap");
    expect(window.admit({ seq: 2, ack: 0 }).verdict).toBe("deliver");
    expect(window.admit({ seq: 3, ack: 0 }).verdict).toBe("deliver");
  });

  it("passes seq 0 on without moving the sequence, and takes its ack", () => {
    const window = new TextFrameWindow();
    window.admit({ seq: 1, ack: 0 });
    expect(window.admit({ seq: 0, ack: 4 }, 4)).toEqual({
      verdict: "unsequenced",
      acked: 4,
    });
    expect([window.delivered, window.peerAck]).toEqual([1, 4]);
    expect(window.admit({ seq: 2, ack: 4 }, 4).verdict).toBe("deliver");
  });

  it("a replayed bare ack is a no-op: the peer's ack only moves forward", () => {
    const window = new TextFrameWindow();
    expect(window.admit({ seq: 0, ack: 3 }, 5)).toEqual({
      verdict: "unsequenced",
      acked: 3,
    });
    expect(window.admit({ seq: 0, ack: 2 }, 5)).toEqual({
      verdict: "unsequenced",
      acked: 0,
    });
    expect(window.admit({ seq: 0, ack: 3 }, 5)).toEqual({
      verdict: "unsequenced",
      acked: 0,
    });
    expect(window.admit({ seq: 0, ack: 5 }, 5)).toEqual({
      verdict: "unsequenced",
      acked: 2,
    });
    expect(window.peerAck).toBe(5);
  });

  it("refuses an ack past what this side has sent, and moves nothing", () => {
    const window = new TextFrameWindow();
    expect(window.admit({ seq: 1, ack: 4 }, 3)).toEqual({
      verdict: "ack-ahead",
      sent: 3,
      received: 4,
    });
    expect([window.delivered, window.peerAck]).toEqual([0, 0]);
    expect(window.admit({ seq: 0, ack: 4 }, 3).verdict).toBe("ack-ahead");
    // Exactly what was sent is fine (the control).
    expect(window.admit({ seq: 1, ack: 3 }, 3)).toEqual({
      verdict: "deliver",
      acked: 3,
    });
  });

  it("a receive-only stream, with nothing sent to bound it, takes any ack", () => {
    const window = new TextFrameWindow();
    expect(window.admit({ seq: 1, ack: 0 })).toEqual({
      verdict: "deliver",
      acked: 0,
    });
  });

  it("a resumed session carries its window over", () => {
    const window = new TextFrameWindow({ delivered: 41, peerAck: 7 });
    expect(window.admit({ seq: 41, ack: 9 }, 10).verdict).toBe("duplicate");
    expect(window.admit({ seq: 42, ack: 9 }, 10)).toEqual({
      verdict: "deliver",
      acked: 2,
    });
  });
});

describe("the codec and the window together: a stream of frames", () => {
  const [key] = keysOf("sequence-secret");
  const sid = sessionId("q3JtZ2FfZ3c0bE1uUXpXRA", "Ym9iX2V4ZWN1dG9yX25vbg");

  /** The executor's frames 1..n, each acknowledging the gateway's frame 1. */
  async function frames(n: number): Promise<string[]> {
    const out: string[] = [];
    for (let seq = 1; seq <= n; seq++) {
      const message = { op: "progress", job: "j", pseq: seq, progress: seq };
      const options = { key: key!, sid, seq, ack: 1, mac: nodeHmacSha256 };
      out.push(await encodeTextFrame(message, { ...options, dir: "e" }));
    }
    return out;
  }

  /** What a receiver makes of a sequence of lines: each verdict in turn. */
  async function receive(lines: string[]): Promise<string[]> {
    const window = new TextFrameWindow();
    const out: string[] = [];
    for (const line of lines) {
      const decoded = await decodeTextFrame(line, {
        keys: [key!],
        sid,
        dir: "e",
        mac: nodeHmacSha256,
      });
      out.push(
        decoded.ok
          ? `${decoded.frame.seq}:${window.admit(decoded.frame, 1).verdict}`
          : decoded.reason,
      );
    }
    return out;
  }

  it("a resumed replay: duplicates dropped, then the new frames delivered", async () => {
    const [f1, f2, f3, f4] = await frames(4);
    expect(await receive([f1!, f2!, f1!, f2!, f3!, f4!])).toEqual([
      "1:deliver",
      "2:deliver",
      "1:duplicate",
      "2:duplicate",
      "3:deliver",
      "4:deliver",
    ]);
  });

  it("a withheld frame: the next is a gap", async () => {
    const [f1, , f3] = await frames(3);
    expect(await receive([f1!, f3!])).toEqual(["1:deliver", "3:gap"]);
  });

  it("a forged frame never reaches the window, so it cannot move it", async () => {
    const [f1, f2] = await frames(2);
    const forged = f2!.replace('"progress":2', '"progress":100');
    expect(forged).not.toBe(f2!);
    expect(await receive([f1!, forged, f2!])).toEqual([
      "1:deliver",
      "mac",
      "2:deliver",
    ]);
  });
});
