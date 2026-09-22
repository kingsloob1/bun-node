import type { DriverEvent } from "../lib/index";
import process from "node:process";
import { afterAll, describe, expect, it } from "bun:test";
import { MONGO_COLLECTIONS, MongoDriver } from "../lib/index";
import { queueEvent } from "../lib/shared/events";
import { testNamespace, waitFor } from "./helpers";

/**
 * A MongoDB subscriber hears every event, whichever process published it.
 *
 * Events used to be followed by `_id`. An ObjectId is made by the client and
 * only its first four bytes are time, to the second, so two processes
 * publishing within a second are ordered by random bytes — and a subscriber
 * that had seen one process's event passed over the other's for good about
 * half the time. A notifier then never heard a second child's `active`.
 *
 * Reproduced here without a second process: the first event gets its number,
 * the second is published and heard, and only then does the first land — with
 * an ObjectId from a second earlier, as a process whose clock reads earlier
 * would give it.
 */

const MONGODB = process.env.BUN_JOBS_TEST_MONGODB_URL;
const drivers: MongoDriver[] = [];

afterAll(async () => {
  await Promise.allSettled(drivers.map(async (driver) => await driver.close()));
});

describe.skipIf(!MONGODB)("MongoDB events", () => {
  it("delivers an event that lands after a later one, with an earlier id", async () => {
    const prefix = `ev_${Math.random().toString(36).slice(2, 8)}_`;
    const driver = new MongoDriver({ url: MONGODB, collectionPrefix: prefix });
    drivers.push(driver);
    await driver.connect();

    const namespace = testNamespace("events");
    const heard: string[] = [];
    const unsubscribe = await driver.subscribe(
      namespace,
      "queue",
      "orders",
      (event) => heard.push((event.payload as { id: string }).id),
    );

    const event = (id: string): DriverEvent =>
      queueEvent(
        { ns: namespace, target: "orders", type: "added", origin: "test" },
        { id },
      );

    const { MongoClient, ObjectId } = await import("mongodb");
    const client = new MongoClient(MONGODB!);
    await client.connect();

    try {
      const db = client.db();
      // The first event takes its number, as a publish would, and stalls.
      const counter = await db
        .collection<{
          _id: string;
          ns: string;
          key: string;
          counters?: { seq?: number };
        }>(`${prefix}kv`)
        .findOneAndUpdate(
          { _id: `${namespace}:__events_seq:queue:orders` },
          {
            $inc: { "counters.seq": 1 },
            $setOnInsert: {
              ns: namespace,
              key: "__events_seq:queue:orders",
            },
          },
          { upsert: true, returnDocument: "after" },
        );

      // The second is published in full, and heard.
      await driver.publish(event("second"));
      await waitFor(() => heard.includes("second"), { timeout: 5_000 });

      // The first lands now, with an id from a second before the second's.
      const first = event("first");
      await db.collection(`${prefix}events`).insertOne({
        _id: ObjectId.createFromTime(Math.floor(Date.now() / 1000) - 1),
        ns: namespace,
        channel: "queue:orders",
        seq: counter?.counters?.seq,
        payload: JSON.stringify(first),
        at: first.at,
      });

      await waitFor(() => heard.includes("first"), {
        timeout: 5_000,
        message:
          "an event from an earlier-clocked publisher was never delivered",
      });
      expect(heard.toSorted()).toEqual(["first", "second"]);
    } finally {
      await unsubscribe();
      // Closed before the drops: a closing driver writes back what it has
      // buffered, which would recreate a collection dropped ahead of it.
      await driver.close();
      // Every collection the driver creates, from its own list, so one added
      // later cannot be forgotten here. Exact names only — never a prefix
      // sweep: other sessions share the server.
      for (const name of MONGO_COLLECTIONS) {
        await client
          .db()
          .collection(`${prefix}${name}`)
          .drop()
          .catch(() => undefined);
      }
      await client.close();
    }
  }, 30_000);
});
