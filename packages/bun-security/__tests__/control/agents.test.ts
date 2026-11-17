/**
 * Agents on the control plane (PR-CP4): keys made with a step-up and shown
 * once, never listed or audited; rotation (the old secret accepted until
 * the agent uses the new one, or 24 hours) and revocation; the agent
 * routes' refusals (an unknown agent, a revoked key, a bad or stale or
 * replayed signature, another route, the rate limit), each refused
 * known-agent request audited at most once a minute; the health states;
 * the store refused when not durable; the secrets sealed at rest; the bans
 * routes and what each agent is sent. Each refusal has its negative control.
 */
import { Buffer } from "node:buffer";
import { Database } from "bun:sqlite";
import { generateKeyPairSync } from "node:crypto";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "bun:test";
import { ConfigError } from "@kingsleyweb/bun-common";
import {
  AGENT_HEADER,
  AGENT_REQUEST_ID_HEADER,
  AGENT_SIGNATURE_HEADER,
  agentEnvelope,
  agentRequestId,
} from "../../lib/agent/protocol";
import type { AgentRoute } from "../../lib/agent/protocol";
import { createSecurityApi } from "../../lib/control/index";
import { sealedFields } from "../../lib/sealing/index";
import { memoryStore, sqliteStore } from "../../lib/store/index";
import { agentOn, cleanUp, controlPlane, tempDir } from "../agent/fixture";
import { createSecurity } from "../../lib/index";
import { Keyring } from "../../lib/sensitive/keys";
import { existsSync, readFileSync } from "node:fs";
import { FLEET_SECRET, testApi } from "./helpers";

afterAll(cleanUp);

type ControlPlaneFixture = Awaited<ReturnType<typeof controlPlane>>;

/** Sends a signed agent request; the status, the text, the headers. */
async function agentCall(
  cp: ControlPlaneFixture,
  route: AgentRoute,
  path: string,
  options: {
    secret?: string;
    agent?: string;
    body?: string;
    id?: string;
    at?: number;
    signature?: string;
  } = {},
): Promise<{
  status: number;
  text: string;
  headers: Headers;
  signature: string;
}> {
  const id =
    options.body === undefined ? (options.id ?? agentRequestId(route)) : null;
  const signature =
    options.signature ??
    (await agentEnvelope.signEnvelope(options.body ?? null, {
      direction: "request",
      secret: options.secret ?? cp.secret,
      now: options.at ?? cp.clock.now(),
      ...(id === null ? {} : { id }),
    }));
  const response = await cp.app.fetch(
    new Request(`http://cp.test${cp.api.basePath}${path}`, {
      method: options.body === undefined ? "GET" : "POST",
      headers: {
        [AGENT_HEADER]: options.agent ?? "checkout-1",
        [AGENT_SIGNATURE_HEADER]: signature,
        ...(id === null ? {} : { [AGENT_REQUEST_ID_HEADER]: id }),
        ...(options.body === undefined
          ? {}
          : { "content-type": "application/json" }),
      },
      ...(options.body === undefined ? {} : { body: options.body }),
    }),
  );
  return {
    status: response.status,
    text: await response.text(),
    headers: response.headers,
    signature,
  };
}

/** A heartbeat body. */
const beat = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    route: "heartbeat",
    sentAt: 1,
    agentVersion: "test",
    bundle: null,
    bans: { seq: "0", count: 0 },
    health: "ok",
    ...over,
  });

describe("agent keys", () => {
  it("are made with a step-up, the secret shown once and never listed or audited", async () => {
    const cp = await controlPlane();
    const listed = (await cp.call("GET", "/agents/checkout-1")).body;
    expect(listed).toMatchObject({
      id: "checkout-1",
      service: "checkout",
      status: "never-seen",
    });
    expect(JSON.stringify(listed)).not.toContain(cp.secret);
    expect(
      JSON.stringify((await cp.call("GET", "/agents")).body),
    ).not.toContain(cp.secret);
    const audit = JSON.stringify(
      (await cp.call("GET", "/audit?limit=200")).body,
    );
    expect(audit).toContain("agent.create");
    expect(audit).not.toContain(cp.secret);
    // An unknown service, a taken id, a bad id.
    expect((await cp.call("POST", "/agents", { service: "nope" })).status).toBe(
      404,
    );
    expect(
      (
        await cp.call("POST", "/agents", {
          id: "checkout-1",
          service: "checkout",
        })
      ).status,
    ).toBe(409);
    expect(
      (await cp.call("POST", "/agents", { id: "a b", service: "checkout" }))
        .status,
    ).toBe(400);
  });

  it("need a step-up: refused when the hook says no, and under approvals with no hook", async () => {
    let fresh = false;
    const hooked = testApi({
      allowWithoutStepUp: undefined,
      stepUp: { verify: () => fresh, challenge: () => "/mfa" },
      agents: { allowEphemeralStore: true },
    });
    await hooked.call("POST", "/services", { id: "s", name: "S" });
    const asked = await hooked.call("POST", "/agents", { service: "s" });
    expect([asked.status, asked.body.code]).toEqual([401, "step_up_required"]);
    fresh = true;
    expect(
      (await hooked.call("POST", "/agents", { service: "s" })).status,
    ).toBe(201);
    const approvals = testApi({
      allowWithoutStepUp: undefined,
      approvals: "two-person",
      agents: { allowEphemeralStore: true },
    });
    await approvals.call("POST", "/services", { id: "s", name: "S" });
    expect(
      (await approvals.call("POST", "/agents", { service: "s" })).status,
    ).toBe(403);
  });

  it("refuse a store that does not survive a restart, unless told", () => {
    const base = {
      authenticate: () => ({ id: "x" }),
      owners: ["x"],
      allowWithoutStepUp: true,
      bans: { apiKeys: false },
      signing: {
        keyId: "k",
        privateKey: generateKeyPairSync("ed25519").privateKey,
      },
      audit: {
        signing: {
          keyId: "ak",
          privateKey: generateKeyPairSync("ed25519").privateKey,
        },
        allowNoExternalCheckpoints: true,
      },
    };
    expect(() =>
      createSecurityApi({ ...base, store: memoryStore(), agents: {} }),
    ).toThrow(ConfigError);
    expect(() =>
      createSecurityApi({
        ...base,
        store: memoryStore(),
        agents: { allowEphemeralStore: true },
      }),
    ).not.toThrow();
    expect(() =>
      createSecurityApi({
        ...base,
        store: sqliteStore({ path: join(tempDir(), "s.sqlite") }),
        agents: {},
      }),
    ).not.toThrow();
    // Negative control: without agents, a memory store is fine.
    expect(() =>
      createSecurityApi({ ...base, store: memoryStore() }),
    ).not.toThrow();
  });

  it("keep their secrets sealed at rest (agentKey.secret and agentKey.previous.secret)", async () => {
    const path = join(tempDir(), "sealed.sqlite");
    const codec = sealedFields({
      keys: [{ id: "k1", key: new Uint8Array(32).fill(7) }],
    });
    const store = sqliteStore({ path, codec });
    await store.connect();
    const cp = await controlPlane({ store, agents: {} });
    const rotated = await cp.call("POST", "/agents/checkout-1/rotate", {
      revision: 1,
    });
    expect(rotated.status).toBe(200);
    const db = new Database(path);
    const row = db
      .query(`SELECT doc FROM bun_security_docs WHERE kind = 'agentKey'`)
      .get() as { doc: string };
    db.close();
    expect(row.doc).not.toContain(cp.secret);
    expect(row.doc).not.toContain(rotated.body.secret);
    expect(row.doc).toContain("$sealed");
    // Negative control: unsealed, the secret is there in the clear.
    const plain = join(tempDir(), "plain.sqlite");
    const open = sqliteStore({ path: plain });
    await open.connect();
    const cpPlain = await controlPlane({ store: open, agents: {} });
    const raw = new Database(plain);
    const clear = raw
      .query(`SELECT doc FROM bun_security_docs WHERE kind = 'agentKey'`)
      .get() as { doc: string };
    raw.close();
    expect(clear.doc).toContain(cpPlain.secret);
  });
});

describe("the agent routes' authentication", () => {
  it("answers a signed request, and signs its answer with the agent's key", async () => {
    const cp = await controlPlane();
    const answer = await agentCall(cp, "bundle", "/agent/bundle");
    expect(answer.status).toBe(200);
    const verdict = await agentEnvelope.verifyEnvelope(
      answer.text,
      answer.headers.get(AGENT_SIGNATURE_HEADER),
      {
        direction: "response",
        secret: cp.secret,
        now: cp.clock.now(),
      },
    );
    expect(verdict.ok).toBe(true);
    // Negative control: another key does not verify it.
    expect(
      (
        await agentEnvelope.verifyEnvelope(
          answer.text,
          answer.headers.get(AGENT_SIGNATURE_HEADER),
          {
            direction: "response",
            secret: "another",
            now: cp.clock.now(),
          },
        )
      ).ok,
    ).toBe(false);
  });

  it("refuses an unknown agent unsigned and unaudited; a known agent's refusal is audited once a minute", async () => {
    const cp = await controlPlane();
    const head = async () => (await cp.store.getAuditHead())!.n;
    const before = await head();
    const unknown = await agentCall(cp, "bundle", "/agent/bundle", {
      agent: "nobody",
    });
    expect(unknown.status).toBe(401);
    expect(unknown.headers.get(AGENT_SIGNATURE_HEADER)).toBeNull();
    expect(await head()).toBe(before);
    const bad = await agentCall(cp, "bundle", "/agent/bundle", {
      secret: "wrong",
    });
    expect(bad.status).toBe(401);
    expect(bad.headers.get(AGENT_SIGNATURE_HEADER)).not.toBeNull();
    expect(await head()).toBe(before + 1);
    // More within the minute: logged, not audited.
    for (let i = 0; i < 5; i++)
      await agentCall(cp, "bundle", "/agent/bundle", { secret: "wrong" });
    expect(await head()).toBe(before + 1);
    cp.clock.advance(61_000);
    await agentCall(cp, "bundle", "/agent/bundle", { secret: "wrong" });
    expect(await head()).toBe(before + 2);
    const refused = (await cp.call("GET", "/audit?action=agent.refused")).body
      .items;
    expect(refused[0].entry).toMatchObject({
      actor: { id: "checkout-1", kind: "agent" },
      outcome: "refused",
      route: "bundle",
    });
  });

  it("refuses a signature out of the ±60 s window, and a replayed one", async () => {
    const cp = await controlPlane();
    expect(
      (
        await agentCall(cp, "bundle", "/agent/bundle", {
          at: cp.clock.now() - 61_000,
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await agentCall(cp, "bundle", "/agent/bundle", {
          at: cp.clock.now() - 59_000,
        })
      ).status,
    ).toBe(200);
    const id = agentRequestId("bundle");
    const first = await agentCall(cp, "bundle", "/agent/bundle", { id });
    expect(first.status).toBe(200);
    const again = await agentCall(cp, "bundle", "/agent/bundle", {
      id,
      signature: first.signature,
    });
    expect(again.status).toBe(401);
    expect(again.text).toContain("already");
  });

  it("refuses a request signed for another route: a bodyless id's tag, a body's route", async () => {
    const cp = await controlPlane();
    // A captured bundle request sent to the bans route.
    expect(
      (
        await agentCall(cp, "bundle", "/agent/bans", {
          id: agentRequestId("bundle"),
        })
      ).status,
    ).toBe(401);
    // A heartbeat body naming another route.
    expect(
      (
        await agentCall(cp, "heartbeat", "/agent/heartbeat", {
          body: beat({ route: "events" }),
        })
      ).status,
    ).toBe(401);
    // Negative controls: bound to their own routes, both go through.
    expect((await agentCall(cp, "bans", "/agent/bans")).status).toBe(200);
    expect(
      (await agentCall(cp, "heartbeat", "/agent/heartbeat", { body: beat() }))
        .status,
    ).toBe(200);
  });

  it("refuses a revoked key at once", async () => {
    const cp = await controlPlane();
    expect((await agentCall(cp, "bundle", "/agent/bundle")).status).toBe(200);
    const revoked = await cp.call("POST", "/agents/checkout-1/revoke", {
      revision: (await cp.call("GET", "/agents/checkout-1")).body.revision,
    });
    expect(revoked.body.status).toBe("revoked");
    expect((await agentCall(cp, "bundle", "/agent/bundle")).status).toBe(401);
    expect(
      (
        await cp.call("POST", "/agents/checkout-1/rotate", {
          revision: revoked.body.revision,
        })
      ).status,
    ).toBe(409);
  });

  it("limits each agent's requests a minute (429 with Retry-After)", async () => {
    const cp = await controlPlane({
      agents: { allowEphemeralStore: true, rateLimit: 3 },
    });
    for (let i = 0; i < 3; i++)
      expect((await agentCall(cp, "bans", "/agent/bans")).status).toBe(200);
    const over = await agentCall(cp, "bans", "/agent/bans");
    expect(over.status).toBe(429);
    expect(Number(over.headers.get("retry-after"))).toBeGreaterThan(0);
    cp.clock.advance(60_000);
    expect((await agentCall(cp, "bans", "/agent/bans")).status).toBe(200);
  });
});

describe("rotation", () => {
  it("accepts the old secret until the agent first uses the new one, then never again", async () => {
    const cp = await controlPlane();
    const rotated = await cp.call("POST", "/agents/checkout-1/rotate", {
      revision: 1,
    });
    expect(rotated.body.agent.previousAcceptedUntil).toBe(
      cp.clock.now() + 86_400_000,
    );
    const next = rotated.body.secret as string;
    expect((await agentCall(cp, "bundle", "/agent/bundle")).status).toBe(200);
    expect(
      (await agentCall(cp, "bundle", "/agent/bundle", { secret: next })).status,
    ).toBe(200);
    expect((await agentCall(cp, "bundle", "/agent/bundle")).status).toBe(401);
    expect(
      (await cp.call("GET", "/agents/checkout-1")).body.previousAcceptedUntil,
    ).toBeNull();
    const switched = (await cp.call("GET", "/audit?action=agent.keyRotated"))
      .body.items;
    expect(switched).toHaveLength(1);
  });

  it("stops accepting the old secret after 24 hours even if the new one was never used", async () => {
    const cp = await controlPlane();
    await cp.call("POST", "/agents/checkout-1/rotate", { revision: 1 });
    cp.clock.advance(24 * 3_600_000 - 1_000);
    expect((await agentCall(cp, "bundle", "/agent/bundle")).status).toBe(200);
    cp.clock.advance(2_000);
    expect((await agentCall(cp, "bundle", "/agent/bundle")).status).toBe(401);
  });
});

describe("bans on the control plane", () => {
  it("are written and lifted with their audit entries, by those who may; each agent gets its scopes'", async () => {
    const cp = await controlPlane();
    await cp.call("POST", "/role-bindings", {
      operator: "vera",
      role: "viewer",
      scope: "global",
    });
    expect(
      (
        await cp.call(
          "POST",
          "/bans",
          { ip: "203.0.113.1", reason: "x" },
          "vera",
        )
      ).status,
    ).toBe(403);
    expect((await cp.call("GET", "/bans", undefined, "vera")).status).toBe(200);
    expect(
      (await cp.call("POST", "/bans", { ip: "0.0.0.0/0", reason: "everyone" }))
        .status,
    ).toBe(400);
    expect(
      (
        await cp.call("POST", "/bans", {
          ip: "203.0.113.1",
          user: "u",
          reason: "two",
        })
      ).status,
    ).toBe(400);
    const made = await cp.call("POST", "/bans", {
      scope: "group:payments",
      ip: "203.0.113.0/24",
      reason: "range",
      duration: null,
    });
    expect(made.body).toMatchObject({
      scope: "group:payments",
      subject: { type: "cidr", value: "203.0.113.0/24" },
      expiresAt: null,
      active: true,
    });
    await cp.call("POST", "/bans", {
      scope: "service:blog",
      ip: "198.51.100.1",
      reason: "blog",
    });
    const batch = JSON.parse((await agentCall(cp, "bans", "/agent/bans")).text);
    expect(batch.bans.map((ban: { scope: string }) => ban.scope)).toEqual([
      "group:payments",
    ]);
    const lifted = await cp.call("POST", `/bans/${made.body.id}/lift`);
    expect(lifted.body).toMatchObject({ active: false, liftedBy: "alice" });
    expect((await cp.call("POST", `/bans/${made.body.id}/lift`)).status).toBe(
      409,
    );
    const audit = (await cp.call("GET", "/audit?action=ban.create")).body.items;
    expect(audit.map((item: { phase: string }) => item.phase).sort()).toEqual([
      "done",
      "done",
      "intent",
      "intent",
    ]);
    expect(
      (await cp.call("GET", "/bans?active=false")).body.items,
    ).toHaveLength(1);
  });

  it("each ban batch is signed with the bundle key and bound to its request", async () => {
    const cp = await controlPlane();
    await cp.call("POST", "/bans", { ip: "203.0.113.9", reason: "x" });
    const id = agentRequestId("bans");
    const batch = JSON.parse(
      (await agentCall(cp, "bans", "/agent/bans", { id })).text,
    );
    expect(batch).toMatchObject({
      format: "bun-security.bans/1",
      service: "checkout",
      request: id,
      full: true,
      signature: { alg: "Ed25519", keyId: "sk_test" },
    });
    const { verifyBanBatch } = await import("../../lib/bundle/index");
    expect(
      verifyBanBatch(batch, cp.keys, {
        service: "checkout",
        since: 0n,
        request: id,
      }).ok,
    ).toBe(true);
  });
});

describe("bodies", () => {
  it("are capped at maxBodyBytes (8x decoded when gzip), and checked as their decoded content", async () => {
    const cp = await controlPlane({
      agents: { allowEphemeralStore: true, maxBodyBytes: 2_000 },
    });
    const { BunHttpAdapter } = await import("@kingsleyweb/bun-common");
    const deferred = new BunHttpAdapter(0, {
      logger: () => {},
      request: { deferBody: true },
    } as never);
    deferred.use(cp.api.basePath, cp.api.router);
    const send = async (text: string, gzip = false) => {
      const signature = await agentEnvelope.signEnvelope(text, {
        direction: "request",
        secret: cp.secret,
        now: cp.clock.now(),
      });
      const response = await deferred.fetch(
        new Request(`http://cp.test${cp.api.basePath}/agent/heartbeat`, {
          method: "POST",
          headers: {
            [AGENT_HEADER]: "checkout-1",
            [AGENT_SIGNATURE_HEADER]: signature,
            "content-type": "application/json",
            ...(gzip ? { "content-encoding": "gzip" } : {}),
          },
          body: gzip ? Bun.gzipSync(Buffer.from(text)) : text,
        }),
      );
      return response.status;
    };
    expect(await send(beat())).toBe(200);
    expect(await send(beat({ lastError: "x".repeat(400) }), true)).toBe(200);
    expect(
      await send(beat({ lastError: "x".repeat(450) }) + " ".repeat(3_000)),
    ).toBe(413);
  });
});

describe("API-key ban subjects are keyed on the control plane", () => {
  it("needs the fleet's secret unless API-key bans are off", () => {
    const base = {
      store: memoryStore(),
      authenticate: () => ({ id: "x" }),
      owners: ["x"],
      allowWithoutStepUp: true,
      signing: {
        keyId: "k",
        privateKey: generateKeyPairSync("ed25519").privateKey,
      },
      audit: {
        signing: {
          keyId: "ak",
          privateKey: generateKeyPairSync("ed25519").privateKey,
        },
        allowNoExternalCheckpoints: true,
      },
    };
    expect(() => createSecurityApi(base)).toThrow(/bans.secret is required/);
    expect(() =>
      createSecurityApi({ ...base, bans: { secret: "short" } }),
    ).toThrow(ConfigError);
    expect(() =>
      createSecurityApi({ ...base, bans: { secret: FLEET_SECRET } }),
    ).not.toThrow();
    const off = testApi({ bans: { apiKeys: false } });
    return off
      .call("POST", "/bans", { apiKey: "key_1", reason: "x" })
      .then((answer) => {
        expect(answer.status).toBe(400);
      });
  });

  it("stores and sends the key's HMAC, never the id; the agent bans that key as its engine keys it", async () => {
    const path = join(tempDir(), "bans.sqlite");
    const store = sqliteStore({ path });
    await store.connect();
    const cp = await controlPlane({ store, agents: {} });
    const raw = "key_live_8d1f0c2e";
    const made = await cp.call("POST", "/bans", {
      apiKey: raw,
      reason: "leaked key",
    });
    expect(made.status).toBe(201);
    // Shown to the operator in this answer only.
    expect(made.body.entered).toEqual({ apiKey: raw });
    expect(made.body.subject).toEqual({
      type: "apiKey",
      value: new Keyring(FLEET_SECRET).apiKey(raw),
    });
    expect(JSON.stringify((await cp.call("GET", "/bans")).body)).not.toContain(
      raw,
    );
    expect(
      JSON.stringify((await cp.call("GET", "/audit?limit=200")).body),
    ).not.toContain(raw);
    await store.close();
    const bytes = Buffer.concat(
      [path, `${path}-wal`, `${path}-shm`]
        .filter((file) => existsSync(file))
        .map((file) => readFileSync(file)),
    );
    expect(bytes.includes(Buffer.from(raw))).toBe(false);
    expect(
      bytes.includes(Buffer.from(new Keyring(FLEET_SECRET).apiKey(raw))),
    ).toBe(true);
    // The agent applies the keyed subject as it is; an engine on the fleet's secret keys the raw id the same.
    const fresh = await controlPlane({ agents: { allowEphemeralStore: true } });
    await fresh.call("POST", "/bans", { apiKey: raw, reason: "leaked key" });
    const security = createSecurity({
      policy: {},
      logger: () => {},
      secret: FLEET_SECRET,
      now: fresh.clock.now,
    });
    const { agent } = agentOn(fresh, { security });
    await agent.sync();
    const applied = security
      .bans()
      .find((ban) => ban.subject.type === "apiKey");
    const reference = createSecurity({
      policy: {},
      logger: () => {},
      secret: FLEET_SECRET,
    }).ban({ apiKey: raw });
    expect(applied?.subject.value).toBe(reference.subject.value);
    // Negative controls: keyed twice, or on another secret, it would miss the key.
    const twice = createSecurity({
      policy: {},
      logger: () => {},
      secret: FLEET_SECRET,
    }).ban({ apiKey: applied!.subject.value });
    expect(twice.subject.value).not.toBe(reference.subject.value);
    const other = createSecurity({
      policy: {},
      logger: () => {},
      secret: "another-fleet-secret-0123456789abcdef",
    }).ban({ apiKey: raw });
    expect(other.subject.value).not.toBe(applied?.subject.value);
  });

  it("refuses a raw id where a key's HMAC belongs, at the store", async () => {
    const store = memoryStore();
    await expect(
      store.upsertBan({
        scope: "global",
        subject: { type: "apiKey", value: "key_live_raw" },
        action: "ban",
        reason: "x",
        source: "manual",
        expiresAt: null,
      }),
    ).rejects.toThrow(ConfigError);
  });
});

describe("agent health", () => {
  it("ten heartbeats in a steady state add no change row", async () => {
    const cp = await controlPlane();
    expect(
      (await agentCall(cp, "heartbeat", "/agent/heartbeat", { body: beat() }))
        .status,
    ).toBe(200);
    const { head } = await cp.store.changesSince(0n, 1);
    for (let i = 0; i < 10; i++) {
      cp.clock.advance(30_000);
      expect(
        (
          await agentCall(cp, "heartbeat", "/agent/heartbeat", {
            body: beat({ sentAt: i }),
          })
        ).status,
      ).toBe(200);
    }
    expect((await cp.store.changesSince(head, 100)).changes).toEqual([]);
    expect((await cp.call("GET", "/agents/checkout-1")).body.status).toBe("ok");
    // Negative control: a change to the agent's key does add one.
    await cp.call("POST", "/agents/checkout-1/rotate", {
      revision: (await cp.call("GET", "/agents/checkout-1")).body.revision,
    });
    expect(
      (await cp.store.changesSince(head, 100)).changes.map(
        (change) => change.kind,
      ),
    ).toContain("agentKey");
  });
});
