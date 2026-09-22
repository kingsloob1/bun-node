import { afterEach, describe, expect, it } from "bun:test";
import { DriverError, MemoryDriver } from "../../lib/index";
import { harness, jobsContext, openContexts, openHarnesses } from "./fixtures";

/**
 * `/meta` connects the driver before it reports, since a driver's
 * capabilities can depend on what connecting finds (the SQL driver's
 * `jobAttribution` is `false` until connect has confirmed the stamp's
 * columns). The end-to-end proof on every SQL engine is in
 * `api-attribution.test.ts`; this file pins the connect itself and what a
 * failed one looks like to a client.
 */

const SECRET = "postgres://admin:hunter2@db.internal:5432/jobs";

/** A memory driver that counts its connects and can be told to fail them. */
class ConnectingDriver extends MemoryDriver {
  /** How many times `connect()` was called. */
  connects = 0;
  /** What `connect()` throws; `undefined` connects normally. */
  failWith: Error | undefined;

  override async connect(): Promise<void> {
    this.connects++;
    if (this.failWith) {
      throw this.failWith;
    }
  }
}

afterEach(async () => {
  for (const created of openHarnesses) {
    expect(created.mismatches()).toEqual([]);
  }
  openHarnesses.length = 0;
  await Promise.all(openContexts.splice(0).map((jobs) => jobs.close()));
});

describe("/meta connects the driver", () => {
  it("connects before building, on every request", async () => {
    const driver = new ConnectingDriver();
    const h = harness({ jobs: jobsContext("meta-connect", driver) });
    const before = driver.connects;

    expect((await h.call("GET", "/meta")).status).toBe(200);
    expect(driver.connects).toBe(before + 1);
    expect((await h.call("GET", "/meta")).status).toBe(200);
    expect(driver.connects).toBe(before + 2);
  });

  it("maps a DriverError from connect to a 503 without its cause", async () => {
    const driver = new ConnectingDriver();
    const h = harness({ jobs: jobsContext("meta-connect", driver) });
    driver.failWith = new DriverError("sql", "connect", new Error(SECRET));

    const response = await h.call("GET", "/meta");
    expect(response.status).toBe(503);
    expect(response.body.code).toBe("DRIVER_ERROR");
    expect(response.text).not.toContain("hunter2");
  });

  it("maps any other connect failure to a bare 500", async () => {
    const driver = new ConnectingDriver();
    const h = harness({ jobs: jobsContext("meta-connect", driver) });
    driver.failWith = new Error(`connect ECONNREFUSED ${SECRET}`);

    const response = await h.call("GET", "/meta");
    expect(response.status).toBe(500);
    expect(response.body.code).toBe("INTERNAL");
    expect(response.text).not.toContain("hunter2");
    expect(response.text).not.toContain("ECONNREFUSED");
  });
});
