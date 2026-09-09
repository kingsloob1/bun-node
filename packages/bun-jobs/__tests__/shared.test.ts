import { deserializeError, serializeError } from "@kingsleyweb/bun-common";
import { describe, expect, it } from "bun:test";
import {
  assertJsonSafe,
  assertNamespace,
  assertSegment,
  ChildExitError,
  ConfigError,
  DriverError,
  HOST,
  JobsError,
  JobTimeoutError,
  LockLostError,
  newId,
  newToken,
  parseToken,
  queueKey,
  runnerKey,
  safeJsonParse,
  SerializationError,
  stringifyBounded,
  TypedEmitterBase,
  UnrecoverableJobError,
} from "../lib/index";

describe("errors", () => {
  it("gives every error a stable code and a name", () => {
    const cases: [JobsError, string][] = [
      [new ConfigError("bad"), "CONFIG"],
      [new LockLostError("r:1"), "LOCK_LOST"],
      [new JobTimeoutError(500), "JOB_TIMEOUT"],
      [new UnrecoverableJobError("never"), "UNRECOVERABLE_JOB"],
      [new ChildExitError(1, null), "CHILD_EXIT"],
      [new DriverError("redis", "claimJob", new Error("conn")), "DRIVER_ERROR"],
      [new SerializationError("job.data"), "SERIALIZATION"],
    ];

    for (const [error, code] of cases) {
      expect(error).toBeInstanceOf(JobsError);
      expect(error).toBeInstanceOf(Error);
      expect(error.code).toBe(code);
      expect(error.name).toBe(error.constructor.name);
      expect(error.message.length).toBeGreaterThan(0);
    }
  });

  it("keeps the backend's error as the cause", () => {
    const cause = new Error("ECONNREFUSED");
    const error = new DriverError("redis", "acquireLock", cause, {
      key: "r:1",
    });

    expect(error.cause).toBe(cause);
    expect(error.driver).toBe("redis");
    expect(error.operation).toBe("acquireLock");
    expect(error.context).toMatchObject({ key: "r:1" });
  });

  it("survives the round trip across a process boundary", () => {
    // The class is gone on the far side, so `name` and `code` are what a
    // caller has left to branch on.
    const restored = deserializeError(
      serializeError(new JobTimeoutError(1500, { jobId: "j1" })),
    );

    expect(restored.name).toBe("JobTimeoutError");
    expect((restored as Error & { code?: string }).code).toBe("JOB_TIMEOUT");
    expect(restored.message).toContain("1500ms");
  });

  it("exposes the timeout budget and child exit detail", () => {
    expect(new JobTimeoutError(250).ms).toBe(250);

    const exit = new ChildExitError(null, "SIGKILL");
    expect(exit.exitCode).toBeNull();
    expect(exit.signalCode).toBe("SIGKILL");
    expect(exit.message).toContain("SIGKILL");
  });
});

describe("keys", () => {
  it("accepts the characters a key may safely hold", () => {
    for (const value of ["account", "a", "a-b_c.d", "Service1"]) {
      expect(assertNamespace(value)).toBe(value);
    }
  });

  it("rejects anything unsafe in a key, path or column", () => {
    for (const value of [
      "",
      " ",
      "a b",
      "a:b",
      "a/b",
      "../x",
      ".",
      "..",
      "a*",
    ]) {
      expect(() => assertNamespace(value)).toThrow(ConfigError);
    }
    expect(() => assertNamespace("x".repeat(201))).toThrow(/longer than/);
  });

  it("names what was wrong", () => {
    expect(() => assertSegment("", "queue name")).toThrow(
      /queue name is required/,
    );
    expect(() => assertSegment("a b", "runner id")).toThrow(/runner id may/);
  });

  it("derives the runner and queue keys", () => {
    expect(runnerKey("cleanup")).toBe("r:cleanup");
    expect(queueKey("mail")).toBe("q:mail");
  });
});

describe("ids", () => {
  it("mints time-sortable ids", async () => {
    const first = newId();
    await Bun.sleep(2);
    const second = newId();

    expect(first).not.toBe(second);
    // UUIDv7 sorts lexicographically by creation time, which is what makes it
    // usable as a FIFO tie-break.
    expect([second, first].sort()).toEqual([first, second]);
  });

  it("embeds host and pid in a lock token", () => {
    const token = newToken("run-1");
    const parsed = parseToken(token);

    expect(parsed?.host).toBe(HOST);
    expect(parsed?.pid).toBe(process.pid);
    expect(parsed?.scope).toBe("run-1");
    expect(newToken()).not.toBe(newToken());
  });

  it("reports a token it did not mint", () => {
    expect(parseToken("garbage")).toBeNull();
    expect(parseToken("host:notanumber:id")).toBeNull();
  });
});

describe("json", () => {
  it("parses defensively", () => {
    expect(safeJsonParse('{"a":1}', {})).toEqual({ a: 1 });
    expect(safeJsonParse("not json", { fallback: true })).toEqual({
      fallback: true,
    });
    expect(safeJsonParse(null, 7)).toBe(7);
    expect(safeJsonParse("", 7)).toBe(7);
  });

  it("names the field that could not be serialised", () => {
    expect(assertJsonSafe({ a: 1 }, "job.data")).toEqual({ a: 1 });
    expect(() => assertJsonSafe({ big: 1n }, "job.data")).toThrow(
      SerializationError,
    );
    expect(() => assertJsonSafe({ big: 1n }, "job.data")).toThrow(/job.data/);
  });

  it("bounds a value that would otherwise be unbounded", () => {
    expect(stringifyBounded({ a: 1 }, 1000)).toBe('{"a":1}');
    expect(stringifyBounded({ a: 1 }, 0)).toBe('{"a":1}');

    const truncated = JSON.parse(
      stringifyBounded({ blob: "x".repeat(5000) }, 200),
    ) as { __truncated?: boolean; bytes?: number };
    expect(truncated.__truncated).toBe(true);
    expect(truncated.bytes).toBeGreaterThan(5000);
  });

  it("keeps an unserialisable value visible rather than throwing", () => {
    const marked = JSON.parse(stringifyBounded({ big: 1n }, 1000)) as {
      __unserializable?: boolean;
    };
    expect(marked.__unserializable).toBe(true);
  });
});

describe("TypedEmitterBase", () => {
  /**
   * Events for the subject below. A `type`, not an `interface`: interfaces
   * are open to augmentation and so lack the implicit index signature
   * `TypedEmitterBase`'s `Record<string, …>` constraint needs.
   */
  // eslint-disable-next-line ts/consistent-type-definitions
  type Events = {
    /** Something started, with its id. */
    started: (id: string) => void;
    /** Something failed, with the error. */
    failed: (error: Error) => void;
  };

  class Subject extends TypedEmitterBase<Events> {
    /** Emits `started`, as a real subsystem would. */
    start(id: string): boolean {
      return this.emit("started", id);
    }
  }

  it("costs nothing until something listens", () => {
    const subject = new Subject();

    // No listener, no emitter: `emit` reports that nothing was delivered.
    expect(subject.start("a")).toBe(false);
    expect(subject.eventNames()).toEqual([]);
    expect(subject.listenerCount("started")).toBe(0);
  });

  it("delivers to listeners, once or repeatedly", () => {
    const subject = new Subject();
    const all: string[] = [];
    const first: string[] = [];

    subject.on("started", (id) => all.push(id));
    subject.once("started", (id) => first.push(id));

    subject.start("a");
    subject.start("b");

    expect(all).toEqual(["a", "b"]);
    expect(first).toEqual(["a"]);
    expect(subject.listenerCount("started")).toBe(1);
  });

  it("respects listener ordering", () => {
    const subject = new Subject();
    const order: string[] = [];

    subject.on("started", () => order.push("second"));
    subject.prependListener("started", () => order.push("first"));

    subject.start("a");
    expect(order).toEqual(["first", "second"]);
  });

  it("removes one listener or all of them", () => {
    const subject = new Subject();
    const seen: string[] = [];
    const listener = (id: string) => seen.push(id);

    subject.on("started", listener);
    subject.on("failed", () => seen.push("failed"));

    subject.off("started", listener);
    subject.start("a");
    expect(seen).toEqual([]);

    subject.on("started", listener);
    // No argument means "every event" — forwarding `undefined` would remove
    // nothing, which is a bug this repo has already had once.
    subject.removeAllListeners();
    subject.start("b");
    subject.emit("failed", new Error("x"));
    expect(seen).toEqual([]);
  });

  it("removes listeners for one event only", () => {
    const subject = new Subject();
    const seen: string[] = [];

    subject.on("started", () => seen.push("started"));
    subject.on("failed", () => seen.push("failed"));

    subject.removeAllListeners("started");
    subject.start("a");
    subject.emit("failed", new Error("x"));

    expect(seen).toEqual(["failed"]);
  });

  it("does not cap listeners", () => {
    const subject = new Subject();
    for (let i = 0; i < 20; i++) {
      subject.on("started", () => {});
    }

    expect(subject.listenerCount("started")).toBe(20);
    expect(subject.getMaxListeners()).toBe(0);
  });
});
