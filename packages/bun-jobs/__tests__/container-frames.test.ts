import { Buffer } from "node:buffer";
import { join } from "node:path";
import process from "node:process";
import { describe, expect, it } from "bun:test";
import {
  encodeFrames,
  FRAME_BYTES,
  FRAME_PAYLOAD,
  FrameDecoder,
} from "../lib/runner/bootstrap/container-frames";

/**
 * The container channel's frames: what the runner writes, what the worker
 * reads back, and what that costs in memory for a large non-ASCII message.
 */

const PREFIX = "c".repeat(32);

/** The message `frames` decode to, or what the decoder said instead. */
function decode(frames: Iterable<string>, max = 64 * 1024 * 1024): unknown {
  const decoder = new FrameDecoder(PREFIX, max);
  let out: unknown;
  for (const frame of frames) {
    for (const line of frame.split("\n")) {
      if (line.length === 0) {
        continue;
      }
      out = decoder.push(line);
    }
  }
  return out;
}

describe("the container channel's frames", () => {
  it("round-trips any text, each frame ASCII and at most PIPE_BUF bytes", () => {
    const json = JSON.stringify({
      s: "é😀\u007F\u0000ʃ ascii \n\t".repeat(5000),
    });
    const frames = [...encodeFrames(PREFIX, 7, json)];
    expect(frames.length).toBeGreaterThan(1);
    for (const frame of frames) {
      expect(Buffer.byteLength(frame, "utf8")).toBeLessThanOrEqual(FRAME_BYTES);
      expect(/^[\n\x20-\x7E]*$/.test(frame)).toBe(true);
    }
    expect(decode(frames)).toEqual({ message: json });
  });

  it("encodes a large non-ASCII message holding little beyond its UTF-8 bytes", async () => {
    // The peak RSS of a process that encodes the message, against one that
    // only takes its UTF-8 bytes: RSS, not the JS heap, since a large
    // string's characters live outside the heap, where `heapUsed` never saw
    // an earlier version's growth.
    const fixture = join(
      import.meta.dir,
      "fixtures",
      "container",
      "encode-peak.ts",
    );
    const peak = async (mode: "baseline" | "encode") => {
      const child = Bun.spawn([process.execPath, fixture, mode], {
        stdout: "pipe",
        stderr: "inherit",
        env: { PATH: process.env.PATH },
      });
      const out = await new Response(child.stdout).text();
      expect(await child.exited).toBe(0);
      const [frames, bytes] = out.trim().split(" ").map(Number) as [
        number,
        number,
      ];
      return { rss: child.resourceUsage()!.maxRSS, frames, bytes };
    };
    const baseline = await peak("baseline");
    const encoded = await peak("encode");
    expect(encoded.frames).toBe(Math.ceil(encoded.bytes / FRAME_PAYLOAD));
    // Measured: +17 MB. Escaping the whole JSON to ASCII before framing, as
    // an earlier version did: +738 MB, and a container OOM-killed at 256m.
    expect(encoded.rss - baseline.rss).toBeLessThan(64 * 1024 * 1024);
  }, 30_000);

  it("costs a forged first frame what it sent, not the message it claims", () => {
    // `<prefix> <id> 0 <count> ` with an empty part: 50-odd bytes claiming a
    // message of `count` frames. An earlier version allocated the claimed
    // message for each, 16 MB per line, which a container printing them
    // turned into a host event loop stalled for seconds.
    const max = 16 * 1024 * 1024;
    const most = Math.floor(max / FRAME_PAYLOAD) + 1;
    const forged = (count: number, n: number) =>
      Array.from(
        { length: n },
        (_, i) => `${PREFIX} ${(i % 1000).toString(36)} 0 ${count} `,
      );
    const claimingMost = forged(most, 2000);
    const claimingTwo = forged(2, 2000);
    const received = claimingMost.reduce((sum, line) => sum + line.length, 0);

    // What the decoder asks for: no more than a few times what it was sent.
    const spied = ["alloc", "allocUnsafe", "allocUnsafeSlow"] as const;
    const originals = spied.map((name) => Buffer[name]);
    let allocated = 0;
    for (const [i, name] of spied.entries()) {
      const original = originals[i]!;
      (Buffer as unknown as Record<string, unknown>)[name] = (
        size: number,
        ...rest: unknown[]
      ) => {
        allocated += size;
        return (original as (...args: unknown[]) => Buffer).call(
          Buffer,
          size,
          ...rest,
        );
      };
    }
    try {
      const decoder = new FrameDecoder(PREFIX, max);
      for (const line of claimingMost) {
        decoder.push(line);
      }
    } finally {
      for (const [i, name] of spied.entries()) {
        (Buffer as unknown as Record<string, unknown>)[name] = originals[i];
      }
    }
    expect(allocated).toBeLessThanOrEqual(received * 4);

    // And in time, whatever the allocator: as long as the same lines
    // claiming a two-frame message, measured in turns so load hits both.
    const time = (lines: string[]) => {
      const decoder = new FrameDecoder(PREFIX, max);
      const start = performance.now();
      for (const line of lines) {
        decoder.push(line);
      }
      return performance.now() - start;
    };
    let most_ = 0;
    let two = 0;
    for (let turn = 0; turn < 4; turn++) {
      most_ += time(claimingMost.slice(turn * 500, turn * 500 + 500));
      two += time(claimingTwo.slice(turn * 500, turn * 500 + 500));
    }
    // Measured: 2000 such lines took 480 ms when each allocated its claim.
    expect(most_).toBeLessThan(two * 5 + 50);
  });

  it("reassembles into one buffer, not a list of parts", () => {
    const json = JSON.stringify({ s: "é😀ʃ".repeat(400_000) });
    const frames = [...encodeFrames(PREFIX, 1, json)];
    expect(decode(frames)).toEqual({ message: json });
  });

  it("refuses a message over its limit from its first frame", () => {
    const json = JSON.stringify({ s: "x".repeat(100_000) });
    const frames = [...encodeFrames(PREFIX, 1, json)];
    const decoder = new FrameDecoder(PREFIX, 10_000);
    expect(decoder.push(frames[0]!.trim())).toMatchObject({
      tooLarge: expect.any(Number),
    });
  });

  it("reports a message cut off by the next one, and reads the next", () => {
    const first = [
      ...encodeFrames(PREFIX, 1, JSON.stringify({ a: "x".repeat(10_000) })),
    ];
    const second = [...encodeFrames(PREFIX, 2, JSON.stringify({ b: 1 }))];
    const decoder = new FrameDecoder(PREFIX, 1024 * 1024);
    expect(decoder.push(first[0]!.trim())).toBeUndefined();
    expect(decoder.push(second[0]!.trim())).toEqual({
      message: '{"b":1}',
      cutOff: true,
    });
  });

  it("keeps a line with the prefix that is not a frame as text", () => {
    const decoder = new FrameDecoder(PREFIX, 1024);
    expect(decoder.push(`${PREFIX} is my argv`)).toEqual({ text: true });
    expect(decoder.push(`${PREFIX} 1 0 1 not base64!`)).toEqual({ text: true });
  });

  /** A message `frames` frames long, as its frame lines without newlines. */
  const lines = (id: number, frames: number) =>
    [
      ...encodeFrames(
        PREFIX,
        id,
        JSON.stringify({ s: "x".repeat(FRAME_PAYLOAD * frames - 20) }),
      ),
    ].map((frame) => frame.trim());

  it("drops a frame of another message rather than joining it (the id)", () => {
    const first = lines(1, 2);
    const second = lines(2, 2);
    expect(first).toHaveLength(2);
    expect(second).toHaveLength(2);
    const decoder = new FrameDecoder(PREFIX, 1024 * 1024);
    expect(decoder.push(first[0]!)).toBeUndefined();
    // Same count, the next index: only the id says it is not this message's.
    expect(decoder.push(second[1]!)).toEqual({ broken: true });
    expect(decoder.push(first[1]!)).toEqual({ broken: true });
  });

  it("drops a message whose frames arrive out of order (the index)", () => {
    const frames = lines(1, 3);
    expect(frames).toHaveLength(3);
    const decoder = new FrameDecoder(PREFIX, 1024 * 1024);
    expect(decoder.push(frames[0]!)).toBeUndefined();
    expect(decoder.push(frames[2]!)).toEqual({ broken: true });
    // Dropped already: its later frames are not reported again.
    expect(decoder.push(frames[1]!)).toBeUndefined();
    // The next whole message is read.
    expect(decoder.push(lines(2, 1)[0]!)).toMatchObject({
      message: expect.any(String),
    });
  });

  it("reports a dropped message once, not once per frame", () => {
    const decoder = new FrameDecoder(PREFIX, 1024 * 1024);
    // Frames of a message whose first never arrived: one report.
    const stray = lines(1, 4);
    expect(decoder.push(stray[1]!)).toEqual({ broken: true });
    expect(decoder.push(stray[2]!)).toBeUndefined();
    expect(decoder.push(stray[3]!)).toBeUndefined();
    // The same id with another count is another message: reported.
    expect(decoder.push(lines(1, 5)[2]!)).toEqual({ broken: true });
    // A message cut off by the next: one report, and its later frames are
    // passed over while the next is assembled and read.
    const cut = lines(2, 3);
    const next = lines(3, 2);
    expect(decoder.push(cut[0]!)).toBeUndefined();
    expect(decoder.push(next[0]!)).toEqual({ broken: true });
    expect(decoder.push(cut[1]!)).toBeUndefined();
    // Read, and the cut was reported already, by its first frame.
    expect(decoder.push(next[1]!)).toEqual({ message: expect.any(String) });
    expect(decoder.push(cut[2]!)).toBeUndefined();
  });

  it("reports a message too large once, and passes over its later frames", () => {
    const decoder = new FrameDecoder(PREFIX, 4 * FRAME_PAYLOAD);
    const big = lines(1, 8);
    expect(decoder.push(big[0]!)).toEqual({ tooLarge: 8 * FRAME_PAYLOAD });
    for (const frame of big.slice(1)) {
      expect(decoder.push(frame)).toBeUndefined();
    }
    expect(decoder.push(lines(2, 1)[0]!)).toMatchObject({
      message: expect.any(String),
    });
  });

  it("takes no part longer than a frame carries, so a forged message cannot grow", () => {
    const decoder = new FrameDecoder(PREFIX, 64 * 1024 * 1024);
    const long = "a".repeat(4 * 1024 * 1024);
    // Every part of a message that is never finished: each is output, not a
    // part held for a message, whatever the count claims.
    for (let index = 0; index < 4; index++) {
      expect(decoder.push(`${PREFIX} zz ${index} 5 ${long}`)).toEqual({
        text: true,
      });
    }
    // One character over the most a frame carries is output too; the most
    // is a part.
    const most = (FRAME_PAYLOAD / 3) * 4;
    expect(decoder.push(`${PREFIX} zz 0 2 ${"a".repeat(most + 4)}`)).toEqual({
      text: true,
    });
    expect(
      decoder.push(`${PREFIX} zz 0 2 ${"a".repeat(most)}`),
    ).toBeUndefined();
    expect(decoder.push(lines(3, 1)[0]!)).toMatchObject({
      message: expect.any(String),
    });
  });
});

describe("writeWhole on a non-blocking stdout", () => {
  /**
   * Runs the write-whole fixture with its stdout piped into a reader that
   * starts reading only after `wait` ms (`sleep`, then `cat`): Bun's own
   * pipes read eagerly, so the pipe is a shell's.
   */
  async function writeThrough(bytes: number, patience: number, wait: number) {
    const fixture = join(
      import.meta.dir,
      "fixtures",
      "container",
      "write-whole.ts",
    );
    const child = Bun.spawn(
      [
        "sh",
        "-c",
        `"$0" "$1" ${bytes} ${patience} | { sleep ${wait / 1000}; cat; }`,
        process.execPath,
        fixture,
      ],
      { stdout: "pipe", stderr: "pipe", env: { PATH: process.env.PATH } },
    );
    try {
      const [out, err, code] = await Promise.all([
        new Response(child.stdout).arrayBuffer(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      return { bytes: out.byteLength, err, code };
    } finally {
      child.kill("SIGKILL");
    }
  }

  it("waits out a full pipe (EAGAIN) rather than failing the write", async () => {
    // 1 MiB into a 64 KiB pipe nobody reads for half a second.
    const run = await writeThrough(1024 * 1024, 20_000, 500);
    if (process.platform === "linux") {
      expect(run.err).toContain("nonblocking=true");
    }
    expect(run.err).toContain("written");
    expect(run.err).not.toContain("threw");
    expect(run.bytes).toBe(1024 * 1024);
  });

  it("gives up on a pipe that stays full past its patience", async () => {
    const run = await writeThrough(1024 * 1024, 300, 2000);
    expect(run.err).toContain("threw: stdout stayed full for 300 ms");
    expect(run.bytes).toBeLessThan(1024 * 1024);
  });
});
