/**
 * Topology (c) with real processes (plan §11.4, PR-T1): two control-plane
 * instances (`__tests__/fixtures/cp-process.ts`) on one Postgres store,
 * each served on port 0, and four agents (`__tests__/fixtures/agent-process.ts`)
 * in their own processes over real HTTP, connected to one instance or the
 * other. Across the processes:
 *
 * - a publish on one instance reaches every agent, those on the other
 *   instance through the store's pushed feed (`store.subscribe`, the
 *   cross-instance nudge), with a poll-only agent as the negative control;
 * - a ban reaches every agent within its bound (the nudge, or the 5 s
 *   poll), and its lift too;
 * - the audit chain stays one line while both instances write at once;
 * - the break-glass lockout is shared by both instances;
 * - event batches arrive once, a batch replayed to the other instance
 *   included;
 * - an instance dying mid-publish leaves no fork: one line of versions,
 *   one audit chain, the change reconciled, and the other instance
 *   publishes on;
 * - an agent restarted while every instance is down enforces its last
 *   known good.
 *
 * Postgres needs `BUN_SECURITY_TEST_POSTGRES_URL` (or bun-cache's, or
 * bun-jobs'): unset skips visibly, set but unreachable fails. Each run uses
 * its own table prefix and drops it. Every wait is a condition with a
 * deadline, never a fixed sleep. A heavy job: run it through the heavy-run
 * wrapper.
 */
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  AGENT_HEADER,
  AGENT_SIGNATURE_HEADER,
  agentEnvelope,
} from "../../lib/agent/protocol";
import { base32Decode, totpCode } from "../../lib/control/audit/breakglass";
import {
  dropStore,
  freshPrefix,
  POSTGRES_URL,
  reachError,
  VARIABLE,
} from "../store/pgBackend";

const CP = join(import.meta.dir, "..", "fixtures", "cp-process.ts");
const AGENT = join(import.meta.dir, "..", "fixtures", "agent-process.ts");
const FLEET_SECRET = "topology-fleet-secret-0123456789abcdef";
const TOTP = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";
const PASSWORD = "break the glass, topology";
const BLOCKED = "203.0.113.200";

/** A spawned process, driven over IPC. */
interface Child {
  /** The ready message (a control plane's `url`). */
  readonly ready: Record<string, unknown>;
  /** Sends a request and resolves its answer. */
  readonly ask: (
    request: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>;
  /** Resolves with the exit code. */
  readonly exited: Promise<number>;
  /** Asks it to close and waits for it. */
  readonly close: () => Promise<void>;
}

/** Every process spawned, killed by its own PID if still running. */
const spawned: ReturnType<typeof Bun.spawn>[] = [];

/** Spawns `fixture` with `config` and waits for it to be ready. */
async function spawn(
  fixture: string,
  config: Record<string, unknown>,
): Promise<Child> {
  let next = 0;
  const waiting = new Map<number, (answer: Record<string, unknown>) => void>();
  let onReady: (message: Record<string, unknown>) => void = () => {};
  const started = new Promise<Record<string, unknown>>((resolve) => {
    onReady = resolve;
  });
  const child = Bun.spawn({
    cmd: [process.execPath, fixture, JSON.stringify(config)],
    stdout: "inherit",
    stderr: "inherit",
    ipc(message: Record<string, unknown>) {
      if (message.ready === true) {
        onReady(message);
        return;
      }
      const id = message.id as number;
      waiting.get(id)?.(message);
      waiting.delete(id);
    },
  });
  spawned.push(child);
  const ready = await Promise.race([
    started,
    child.exited.then((code) => {
      throw new Error(`${fixture} exited with ${code} before it was ready`);
    }),
  ]);
  const ask = (request: Record<string, unknown>) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      const id = next++;
      waiting.set(id, resolve);
      void child.exited.then((code) =>
        reject(new Error(`exited with ${code}`)),
      );
      child.send({ ...request, id });
    });
  return {
    ready,
    ask,
    exited: child.exited,
    close: async () => {
      if (child.exitCode !== null) return;
      await ask({ op: "close" }).catch(() => undefined);
      await child.exited;
    },
  };
}

/** Waits until `check` holds, at most `ms`; how long it took. */
async function until(
  what: string,
  check: () => Promise<boolean>,
  ms = 15_000,
): Promise<number> {
  const start = performance.now();
  for (;;) {
    if (await check()) return performance.now() - start;
    if (performance.now() - start > ms)
      throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(25);
  }
}

/** An operator's call to a control plane over HTTP; the status and the parsed body. */
async function call(
  base: string,
  method: string,
  path: string,
  body?: unknown,
  op = "alice",
): Promise<{ status: number; body: any }> {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      "x-bun-security-csrf": "1",
      ...(op === "" ? {} : { "x-op": op }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let parsed: unknown = text;
  try {
    parsed = text === "" ? undefined : JSON.parse(text);
  } catch {
    // Not JSON.
  }
  return { status: response.status, body: parsed };
}

/** Publishes `policy` globally through `base`, on the head it reads. */
async function publish(
  base: string,
  policy: Record<string, unknown>,
): Promise<{ status: number; body: any }> {
  const head =
    (await call(base, "GET", "/policies/global")).body.head?.id ?? null;
  await call(base, "PUT", "/policies/global/draft", { policy, revision: null });
  return await call(base, "POST", "/policies/global/publish", {
    expectedHead: head,
    confirm: "global",
  });
}

if (POSTGRES_URL === undefined) {
  describe.skip(`topology (c): not configured (${VARIABLE})`, () => {
    it("skipped: set the Postgres URL (bun scripts/setup-databases.ts --print-env) to run it", () => {});
  });
} else {
  describe("topology (c): two control-plane instances on Postgres, agents in their own processes", () => {
    const prefix = freshPrefix();
    const work = mkdtempSync(join(tmpdir(), "bun-security-topology-c-"));
    const signing = generateKeyPairSync("ed25519");
    const audit = generateKeyPairSync("ed25519");
    const signingKey = signing.privateKey
      .export({ format: "pem", type: "pkcs8" })
      .toString();
    const publicKey = signing.publicKey
      .export({ format: "pem", type: "spki" })
      .toString();
    const auditKey = audit.privateKey
      .export({ format: "pem", type: "pkcs8" })
      .toString();
    let a: Child;
    let b: Child;
    let urlA: string;
    let urlB: string;
    const agents: Child[] = [];
    const secrets: Record<string, string> = {};
    let passwordHash: string;

    /** A control-plane instance on the shared store. */
    const controlPlane = async () =>
      await spawn(CP, {
        url: POSTGRES_URL,
        prefix,
        signingKey,
        auditKey,
        fleetSecret: FLEET_SECRET,
        breakGlass: { passwordHash, totpSecret: TOTP },
      });

    /** An agent process. */
    const agent = async (
      id: string,
      url: string,
      over: Record<string, unknown> = {},
    ) =>
      await spawn(AGENT, {
        url,
        agent: id,
        secret: secrets[id],
        service: "checkout",
        publicKey,
        stateFile: join(work, `${id}.json`),
        fleetSecret: FLEET_SECRET,
        poll: "1h",
        banPoll: "1h",
        nudge: true,
        ...over,
      });

    /** The bundle version an agent enforces. */
    const versionOf = async (child: Child) =>
      (
        (await child.ask({ op: "status" })).status as {
          bundle: { version: number } | null;
        }
      ).bundle?.version ?? 0;

    beforeAll(async () => {
      const unreachable = await reachError();
      if (unreachable !== undefined) {
        throw new Error(
          `${VARIABLE} is set but the server cannot be reached: ${unreachable.message}`,
        );
      }
      passwordHash = await Bun.password.hash(PASSWORD, {
        algorithm: "argon2id",
        memoryCost: 4096,
        timeCost: 1,
      });
      a = await controlPlane();
      b = await controlPlane();
      urlA = a.ready.url as string;
      urlB = b.ready.url as string;
      expect(
        (
          await call(urlA, "POST", "/groups", {
            id: "payments",
            name: "Payments",
          })
        ).status,
      ).toBe(201);
      expect(
        (
          await call(urlB, "POST", "/services", {
            id: "checkout",
            name: "Checkout",
            groups: ["payments"],
          })
        ).status,
      ).toBe(201);
      expect(
        (await publish(urlA, { lists: [{ ip: BLOCKED, action: "block" }] }))
          .status,
      ).toBe(200);
      for (const id of ["ag1", "ag2", "ag3", "ag4"]) {
        const made = await call(id === "ag1" ? urlA : urlB, "POST", "/agents", {
          id,
          service: "checkout",
        });
        expect(made.status).toBe(201);
        secrets[id] = made.body.secret as string;
      }
      // Nudged agents on both instances; ag4 polls (5 s) without a nudge.
      agents.push(
        await agent("ag1", urlA),
        await agent("ag2", urlB),
        await agent("ag3", urlB),
        await agent("ag4", urlB, { nudge: false, poll: "5s", banPoll: "5s" }),
      );
      await until("every agent on the first bundle", async () =>
        (await Promise.all(agents.map(versionOf))).every(
          (version) => version > 0,
        ),
      );
    }, 90_000);

    afterAll(async () => {
      for (const child of [...agents, a, b])
        await child?.close().catch(() => undefined);
      for (const child of spawned) if (child.exitCode === null) child.kill();
      rmSync(work, { recursive: true, force: true });
      await dropStore(prefix);
    });

    it("a publish on one instance reaches every agent, the other instance's by the store's pushed feed", async () => {
      const published = await publish(urlA, {
        lists: [
          { ip: BLOCKED, action: "block" },
          { ip: "198.51.100.0/24", action: "block" },
        ],
      });
      expect(published.status).toBe(200);
      // The bundle this publish made, not merely a newer one: a case run
      // before it (a repair pass, a publish cut off) can still be moving a
      // version on, and an agent past the old version is not yet on this one.
      const target = (
        published.body.bundles as { service: string; version: number }[]
      ).find((bundle) => bundle.service === "checkout")!.version;
      const before = target - 1;
      // ag2 and ag3 talk to B, poll hourly: only B's nudge, woken by A's write through Postgres, brings it.
      const took = await until(
        "the nudged agents on the new bundle",
        async () =>
          (await Promise.all(agents.slice(0, 3).map(versionOf))).every(
            (version) => version >= target,
          ),
      );
      expect(took).toBeLessThan(10_000);
      for (const child of agents.slice(0, 3)) {
        expect(
          (await child.ask({ op: "evaluate", client: "198.51.100.9" })).action,
        ).toBe("block");
      }
      // The poll-only agent gets it on its own 5 s poll, not before a nudge could have.
      await until(
        "the polling agent on the new bundle",
        async () => (await versionOf(agents[3]!)) > before,
        15_000,
      );
    }, 60_000);

    it("a ban reaches every agent within its bound, and its lift too", async () => {
      const made = await call(urlB, "POST", "/bans", {
        ip: "192.0.2.77",
        reason: "topology",
      });
      expect(made.status).toBe(201);
      const has = async (child: Child) =>
        ((await child.ask({ op: "bans" })).bans as string[]).includes(
          "192.0.2.77",
        );
      const nudged = await until("the ban on the nudged agents", async () =>
        (await Promise.all(agents.slice(0, 3).map(has))).every(Boolean),
      );
      expect(nudged).toBeLessThan(5_000);
      // The polling agent within its 5 s poll (plus the request's time).
      const polled = await until(
        "the ban on the polling agent",
        async () => await has(agents[3]!),
        8_000,
      );
      expect(polled).toBeLessThan(8_000);
      for (const child of agents) {
        expect(
          (await child.ask({ op: "evaluate", client: "192.0.2.77" })).action,
        ).toBe("ban");
      }
      expect(
        (await call(urlA, "POST", `/bans/${made.body.id}/lift`)).status,
      ).toBe(200);
      await until(
        "the lift on every agent",
        async () => !(await Promise.all(agents.map(has))).some(Boolean),
        8_000,
      );
      for (const child of agents) {
        expect(
          (await child.ask({ op: "evaluate", client: "192.0.2.77" })).action,
        ).toBe("allow");
      }
    }, 60_000);

    /** Bans written at once through both instances; the answers. */
    const race = async (base: number) =>
      await Promise.all(
        Array.from({ length: 12 }, (_, i) =>
          call(i % 2 === 0 ? urlA : urlB, "POST", "/bans", {
            ip: `192.0.2.${base + i}`,
            reason: "audit race",
            duration: "1h",
          }),
        ),
      );

    it("the audit chain stays one line while both instances write at once", async () => {
      const answers = await race(100);
      for (const instance of [a, b]) {
        const verify = (await instance.ask({ op: "verifyAudit" })).verify as {
          ok: boolean;
          problems: unknown[];
          unconfirmed: unknown[];
        };
        expect(verify.problems).toEqual([]);
        expect(verify.ok).toBe(true);
      }
      // Each change that landed has its intent in the one chain, and its done or, should a done
      // ever fail to be written, a reconciliation as completed-unconfirmed (before #846 a done
      // could lose the race to the other instance); a refused one (503) wrote nothing at all.
      const landed = answers.filter((answer) => answer.status === 201).length;
      expect(
        answers.every(
          (answer) => answer.status === 201 || answer.status === 503,
        ),
      ).toBe(true);
      const entries = (
        await call(urlA, "GET", "/audit?action=ban.create&limit=200")
      ).body.items as {
        phase: string;
        status?: string;
        entry: {
          reason?: string;
          outcome?: string;
          after?: { reason?: string };
        };
      }[];
      // This case's own writes, by address (another case writes "audit race" bans too).
      const mine = new Set(
        Array.from({ length: 12 }, (_, n) => `192.0.2.${100 + n}`),
      );
      const intents = entries.filter(
        (item) =>
          item.phase === "intent" &&
          mine.has(
            (item.entry as { after?: { subject?: { value?: string } } }).after
              ?.subject?.value ?? "",
          ),
      );
      expect(intents).toHaveLength(landed);
      expect(
        intents.every(
          (item) =>
            item.status === "done" || item.status === "completed-unconfirmed",
        ),
      ).toBe(true);
    }, 60_000);

    // Found by T1 (#846): the audit log read the head outside the store's write lock and lost
    // its compare-and-set three times running to the other instance, refusing changes with 503
    // audit_unavailable. It now appends at the head inside the store's serialised transaction.
    it("every change lands while both instances write at once", async () => {
      const answers = await race(150);
      expect(answers.map((answer) => answer.status)).toEqual(
        Array.from({ length: 12 }, () => 201),
      );
    }, 60_000);

    it("the break-glass lockout is shared by both instances", async () => {
      const login = async (base: string, password: string) =>
        (
          await call(
            base,
            "POST",
            "/break-glass/session",
            {
              password,
              code: totpCode(
                base32Decode(TOTP),
                Math.floor(Date.now() / 30_000),
              ),
            },
            "",
          )
        ).status;
      for (const base of [urlA, urlB, urlA, urlB])
        expect(await login(base, "wrong")).toBe(401);
      expect(await login(urlB, "wrong")).toBe(429);
      // Locked on both: the right password and code are refused on the other instance too.
      expect(await login(urlA, PASSWORD)).toBe(429);
      expect(await login(urlB, PASSWORD)).toBe(429);
    }, 60_000);

    it("event batches arrive once, a batch replayed to the other instance included", async () => {
      // Each agent's engine blocks BLOCKED once this publish reaches it: offered events, then a flush.
      expect(
        (await publish(urlA, { lists: [{ ip: BLOCKED, action: "block" }] }))
          .status,
      ).toBe(200);
      await until("every agent blocking BLOCKED", async () =>
        (
          await Promise.all(
            agents.map((child) =>
              child.ask({ op: "evaluate", client: BLOCKED }),
            ),
          )
        ).every((answer) => answer.action === "block"),
      );
      let offered = 0;
      for (const child of agents) {
        for (let i = 0; i < 3; i++) {
          const answer = await child.ask({ op: "offer", client: BLOCKED });
          if (answer.offered === "kept") offered++;
        }
        expect((await child.ask({ op: "flush" })).queued).toBe(0);
      }
      expect(offered).toBeGreaterThan(0);
      const { SQL } = await import("bun");
      const sql = new SQL(POSTGRES_URL!);
      const count = async () =>
        Number(
          (
            (await sql.unsafe(`SELECT count(*) AS n FROM ${prefix}events`)) as {
              n: number | bigint;
            }[]
          )[0]!.n,
        );
      try {
        expect(await count()).toBe(offered);
        // One batch, signed by ag1, sent to both instances: stored once.
        const batch = JSON.stringify({
          route: "events",
          format: "bun-security.events/1",
          batchId: `replayed-${prefix}`,
          service: "checkout",
          sentAt: Date.now(),
          events: [
            {
              id: `ev-${prefix}`,
              at: Date.now(),
              service: "checkout",
              action: "block",
            },
          ],
          counters: [],
        });
        // Each send signed anew a second apart: the same bytes signed in the same second are one
        // signature, which the nonce store refuses as a replay before the batch's id is read.
        let at = Date.now();
        const send = async (base: string) => {
          at += 1_000;
          const signature = await agentEnvelope.signEnvelope(batch, {
            direction: "request",
            secret: secrets.ag1!,
            now: at,
          });
          const response = await fetch(`${base}/agent/events`, {
            method: "POST",
            headers: {
              [AGENT_HEADER]: "ag1",
              [AGENT_SIGNATURE_HEADER]: signature,
              "content-type": "application/json",
            },
            body: batch,
          });
          return {
            status: response.status,
            body: (await response.json()) as { duplicate: boolean },
          };
        };
        expect(await send(urlA)).toEqual({
          status: 200,
          body: { duplicate: false },
        });
        expect(await send(urlB)).toEqual({
          status: 200,
          body: { duplicate: true },
        });
        expect(await count()).toBe(offered + 1);
      } finally {
        await sql.close();
      }
    }, 60_000);

    it("an instance dying mid-publish leaves no fork: one line of versions, one chain, and the other publishes on", async () => {
      // An instance of its own (C), so the other cases keep A and B.
      const c = await controlPlane();
      const urlC = c.ready.url as string;
      try {
        const head =
          (await call(urlB, "GET", "/policies/global")).body.head?.id ?? null;
        const versionsBefore = (
          await call(urlB, "GET", "/policies/global/versions?limit=200")
        ).body.items.length as number;
        // C dies after appending the version, before compiling a bundle.
        await c.ask({ op: "die", on: "putBundle" });
        await call(urlC, "PUT", "/policies/global/draft", {
          policy: { lists: [{ ip: "198.51.100.0/24", action: "block" }] },
          revision: null,
        });
        const answer = await fetch(`${urlC}/policies/global/publish`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-bun-security-csrf": "1",
            "x-op": "alice",
          },
          body: JSON.stringify({ expectedHead: head, confirm: "global" }),
        }).then(
          (response) => response.status,
          () => "died",
        );
        expect(answer).toBe("died");
        expect(await c.exited).toBe(70);
        // B sees one line: the version C appended is the head, once.
        const after = (
          await call(urlB, "GET", "/policies/global/versions?limit=200")
        ).body.items as { id: string }[];
        expect(after.length).toBe(versionsBefore + 1);
        expect(new Set(after.map((version) => version.id)).size).toBe(
          after.length,
        );
        const verify = (await b.ask({ op: "verifyAudit" })).verify as {
          ok: boolean;
          problems: unknown[];
          unconfirmed: { action: string; status: string }[];
        };
        expect(verify.problems).toEqual([]);
        expect(verify.unconfirmed).toContainEqual(
          expect.objectContaining({
            action: "policy.publish",
            status: "completed-unconfirmed",
          }),
        );
        // B publishes on from that head, and B's agents get it.
        const newHead = (await call(urlB, "GET", "/policies/global")).body.head
          .id as string;
        expect(newHead).not.toBe(head);
        const before = await versionOf(agents[1]!);
        expect(
          (await publish(urlB, { lists: [{ ip: BLOCKED, action: "block" }] }))
            .status,
        ).toBe(200);
        await until("the agents on B's publish", async () =>
          (await Promise.all([agents[1]!, agents[2]!].map(versionOf))).every(
            (version) => version > before,
          ),
        );
      } finally {
        await c.close();
      }
    }, 60_000);

    // Found by T1 (#847): a crash between appending a version and compiling its bundles left
    // every service on the previous bundle until the next change. The other instances' repair
    // pass (here every second) now recompiles a bundle whose policy versions are behind the head.
    it("a publish cut off before its bundles is repaired: the bundle catches up with the head", async () => {
      const c = await controlPlane();
      const urlC = c.ready.url as string;
      try {
        const head =
          (await call(urlB, "GET", "/policies/global")).body.head?.id ?? null;
        await c.ask({ op: "die", on: "putBundle" });
        await call(urlC, "PUT", "/policies/global/draft", {
          policy: { lists: [{ ip: "198.51.100.77", action: "block" }] },
          revision: null,
        });
        await fetch(`${urlC}/policies/global/publish`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-bun-security-csrf": "1",
            "x-op": "alice",
          },
          body: JSON.stringify({ expectedHead: head, confirm: "global" }),
        }).catch(() => undefined);
        expect(await c.exited).toBe(70);
        const newHead = (await call(urlB, "GET", "/policies/global")).body.head
          .id as string;
        expect(newHead).not.toBe(head);
        await until(
          "the bundle compiled from the new head",
          async () => {
            const bundle = (
              await call(urlB, "GET", "/services/checkout/bundle")
            ).body as { policyVersions?: string[] };
            return bundle.policyVersions?.includes(newHead) === true;
          },
          5_000,
        );
      } finally {
        await c.close();
      }
    }, 60_000);

    it("an agent restarted while every instance it knows is down enforces its last known good", async () => {
      // An instance (D) and an agent (ag5) of their own, so the other cases keep A, B and theirs.
      const d = await controlPlane();
      const urlD = d.ready.url as string;
      const made = await call(urlB, "POST", "/agents", {
        id: "ag5",
        service: "checkout",
      });
      expect(made.status).toBe(201);
      secrets.ag5 = made.body.secret as string;
      expect(
        (
          await publish(urlB, {
            lists: [{ ip: "192.0.2.250", action: "block" }],
          })
        ).status,
      ).toBe(200);
      let ag5 = await agent("ag5", urlD, { poll: "1s" });
      try {
        await until(
          "ag5 on the bundle that blocks 192.0.2.250",
          async () =>
            (await ag5.ask({ op: "evaluate", client: "192.0.2.250" }))
              .action === "block",
        );
        const version = await versionOf(ag5);
        await ag5.close();
        await d.close();
        ag5 = await agent("ag5", urlD);
        expect(await versionOf(ag5)).toBe(version);
        expect(
          (await ag5.ask({ op: "evaluate", client: "192.0.2.250" })).action,
        ).toBe("block");
        // Negative control: a fresh agent with no last known good stays on the host's own policy.
        const fresh = await spawn(AGENT, {
          url: urlD,
          agent: "ag5",
          secret: secrets.ag5,
          service: "checkout",
          publicKey,
          stateFile: join(work, "fresh.json"),
          fleetSecret: FLEET_SECRET,
          poll: "1h",
          banPoll: "1h",
          nudge: false,
        });
        expect(await versionOf(fresh)).toBe(0);
        expect(
          (await fresh.ask({ op: "evaluate", client: "192.0.2.250" })).action,
        ).toBe("allow");
        await fresh.close();
      } finally {
        await ag5.close();
        await d.close();
      }
    }, 60_000);
  });
}
