/**
 * `connectAgent` (PR-CP4) against a real control plane over its
 * socket-free `fetch`: the bundle pulled, verified and loaded; the last
 * known good re-verified at start; the version floor; refused bundles and
 * ban batches (forged, another key, replayed), each alerted once; answers
 * not signed with the agent's key; the bans applied by scope; artefacts;
 * heartbeats; the nudge. Each refusal has its negative control.
 */
import { generateKeyPairSync, sign as edSign } from "node:crypto";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "bun:test";
import {
  AGENT_SIGNATURE_HEADER,
  agentEnvelope,
} from "../../lib/agent/protocol";
import { banBatchSigningBytes, verifyBanBatch } from "../../lib/bundle/index";
import type { BanBatch } from "../../lib/bundle/index";
import { signBundle } from "../../lib/control/index";
import type { SecurityBundle } from "../../lib/index";
import { agentOn, cleanUp, controlPlane } from "./fixture";

afterAll(cleanUp);

/** Answers `body` signed with `secret` (as a control plane would), for a forged-answer fetch. */
async function signedAnswer(
  body: string,
  secret: string,
  now: number,
  init: ResponseInit = {},
): Promise<Response> {
  const signature = await agentEnvelope.signEnvelope(body, {
    direction: "response",
    secret,
    now,
  });
  return new Response(body, {
    ...init,
    headers: {
      "content-type": "application/json",
      [AGENT_SIGNATURE_HEADER]: signature,
      ...(init.headers as Record<string, string>),
    },
  });
}

/** Publishes `policy` globally on `cp`, at its current head. */
async function publish(
  cp: Awaited<ReturnType<typeof controlPlane>>,
  policy: Record<string, unknown>,
) {
  const head = (await cp.call("GET", "/policies/global")).body.head?.id ?? null;
  expect(
    (await cp.call("PUT", "/policies/global/draft", { policy, revision: null }))
      .status,
  ).toBe(200);
  const published = await cp.call("POST", "/policies/global/publish", {
    expectedHead: head,
    confirm: "global",
  });
  expect(published.status).toBe(200);
}

describe("bundles", () => {
  it("pulls, verifies and loads the service's bundle, writes the last known good 0600, and answers 304 after", async () => {
    const cp = await controlPlane();
    const { agent, stateFile, alerts } = agentOn(cp);
    await agent.ready;
    expect(agent.status().bundle).toBeNull();
    await agent.sync();
    const status = agent.status();
    expect(status.bundle).toMatchObject({ keyId: "sk_test", expired: false });
    expect(status.health).toBe("ok");
    expect(statSync(stateFile).mode & 0o777).toBe(0o600);
    const state = JSON.parse(readFileSync(stateFile, "utf8"));
    expect(state.floor).toBe(status.bundle!.version);
    expect(state.etag).toBe(`"${status.bundle!.version}"`);
    // Unchanged: the ETag answers 304 and nothing reloads.
    await agent.sync();
    expect(agent.status().bundle!.version).toBe(status.bundle!.version);
    expect(alerts).toEqual([]);
  });

  it("starts on the last known good before asking the control plane, and keeps it while the control plane is down", async () => {
    const cp = await controlPlane();
    const first = agentOn(cp);
    await first.agent.sync();
    const version = first.agent.status().bundle!.version;
    await first.agent.close();
    let asked = 0;
    const second = agentOn(cp, {
      stateFile: first.stateFile,
      fetch: async () => {
        asked++;
        throw new Error("the control plane is down");
      },
    });
    await second.agent.ready;
    expect(asked).toBe(0);
    expect(second.agent.status()).toMatchObject({
      bundle: { version },
      floor: version,
    });
    await second.agent.sync();
    expect(second.agent.status().bundle!.version).toBe(version);
    expect(second.alerts).toEqual([]);
  });

  it("ignores a tampered last known good with a critical alert, on the host's own policy", async () => {
    const cp = await controlPlane();
    const first = agentOn(cp);
    await first.agent.sync();
    await first.agent.close();
    const state = JSON.parse(readFileSync(first.stateFile, "utf8"));
    state.bundle.effective = {
      ...state.bundle.effective,
      lists: [{ id: "x", ip: "0.0.0.0/1", action: "allow" }],
    };
    writeFileSync(first.stateFile, JSON.stringify(state));
    const second = agentOn(cp, { stateFile: first.stateFile });
    await second.agent.ready;
    expect(second.agent.status().bundle).toBeNull();
    expect(second.alerts.map((alert) => [alert.kind, alert.severity])).toEqual([
      ["state.invalid", "critical"],
    ]);
    // Its floor is kept: a replay below it is still refused once the agent pulls.
    expect(second.agent.status().floor).toBe(state.floor);
  });

  it("refuses a validly signed older bundle (a replay) with one alert, keeping the newer in force", async () => {
    const cp = await controlPlane();
    const { agent } = agentOn(cp);
    await agent.sync();
    const old = (await cp.store.getBundle("checkout")) as {
      bundle: SecurityBundle;
    };
    await publish(cp, {
      limits: [{ id: "per-ip-x", limit: 100, window: "1m" }],
    });
    await agent.sync();
    const newer = agent.status().bundle!.version;
    expect(newer).toBeGreaterThan(old.bundle.version);
    // An agent already running the newer one, restarted, then offered the old one
    // (a forged answer: the old bundle, the envelope signed with the agent's own key).
    const alerts: string[] = [];
    const real = agentOn(cp);
    await real.agent.sync();
    const restarted = agentOn(cp, {
      stateFile: real.stateFile,
      onAlert: (alert) => alerts.push(alert.kind),
      fetch: async (url, init) =>
        url.includes("/agent/bundle")
          ? await signedAnswer(
              JSON.stringify(old.bundle),
              cp.secret,
              cp.clock.now(),
              { headers: { etag: `"x"` } },
            )
          : await cp.app.fetch(new Request(url, init)),
    });
    await restarted.agent.ready;
    await restarted.agent.sync();
    await restarted.agent.sync();
    expect(restarted.agent.status().bundle!.version).toBe(newer);
    expect(alerts.filter((kind) => kind === "bundle.replayed")).toHaveLength(1);
    expect(restarted.agent.status().health).toBe("signature-failing");
    // Negative control: an agent with no floor takes the same old bundle.
    const fresh = agentOn(cp, {
      fetch: async (url, init) =>
        url.includes("/agent/bundle")
          ? await signedAnswer(
              JSON.stringify(old.bundle),
              cp.secret,
              cp.clock.now(),
              { headers: { etag: `"x"` } },
            )
          : await cp.app.fetch(new Request(url, init)),
    });
    await fresh.agent.sync();
    expect(fresh.agent.status().bundle!.version).toBe(old.bundle.version);
  });

  it("refuses a bundle not signed by a deployed key, alerting once per version, and reports signature-failing", async () => {
    const cp = await controlPlane();
    const { agent } = agentOn(cp);
    await agent.sync();
    const good = agent.status().bundle!.version;
    const stored = (await cp.store.getBundle("checkout")) as {
      bundle: SecurityBundle;
    };
    const attacker = generateKeyPairSync("ed25519");
    const { signature: _s, ...unsigned } = stored.bundle;
    const forged = await signBundle(
      {
        ...unsigned,
        version: good + 5,
        effective: { ...unsigned.effective, lists: [] },
      },
      {
        keyId: "sk_test",
        sign: async (bytes: Uint8Array) =>
          edSign(null, bytes, attacker.privateKey),
      },
    );
    const alerts: string[] = [];
    const victim = agentOn(cp, {
      onAlert: (alert) => alerts.push(alert.kind),
      fetch: async (url, init) =>
        url.includes("/agent/bundle")
          ? await signedAnswer(
              JSON.stringify(forged),
              cp.secret,
              cp.clock.now(),
              { headers: { etag: `"${good + 5}"` } },
            )
          : await cp.app.fetch(new Request(url, init)),
    });
    await victim.agent.sync();
    await victim.agent.sync();
    expect(alerts.filter((kind) => kind === "bundle.refused")).toHaveLength(1);
    expect(victim.agent.status()).toMatchObject({
      bundle: null,
      health: "signature-failing",
    });
    // Its heartbeat tells the control plane, which records it once.
    await victim.agent.heartbeat();
    const listed = (await cp.call("GET", "/agents/checkout-1")).body;
    expect(listed.status).toBe("signature-failing");
    const events = (
      await cp.call("GET", "/audit?action=agent.signatureFailing")
    ).body.items;
    expect(events).toHaveLength(1);
    expect(events[0].entry.actor).toEqual({ id: "checkout-1", kind: "agent" });
    // Negative control: the genuine bundle verifies and the health recovers.
    await agent.sync();
    expect(agent.status().health).toBe("ok");
  });

  it("refuses an answer not signed with the agent's key", async () => {
    const cp = await controlPlane();
    const { agent } = agentOn(cp, {
      fetch: async (url, init) => {
        const real = await cp.app.fetch(new Request(url, init));
        const body = await real.text();
        return await signedAnswer(body, "not-the-agent-secret", cp.clock.now());
      },
    });
    await agent.sync();
    expect(agent.status()).toMatchObject({
      bundle: null,
      health: "signature-failing",
    });
    expect(agent.status().lastError).toContain(
      "not signed with this agent's key",
    );
  });
});

describe("bans", () => {
  it("applies the control plane's bans on its scopes (global, its groups, itself), and takes lifted ones away", async () => {
    const cp = await controlPlane();
    const { agent, security } = agentOn(cp);
    await agent.sync();
    await cp.call("POST", "/bans", { ip: "203.0.113.1", reason: "global" });
    await cp.call("POST", "/bans", {
      scope: "group:payments",
      ip: "203.0.113.2",
      reason: "group",
    });
    await cp.call("POST", "/bans", {
      scope: "service:checkout",
      user: "u1",
      reason: "own",
    });
    const blog = await cp.call("POST", "/bans", {
      scope: "service:blog",
      ip: "203.0.113.4",
      reason: "another service",
    });
    expect(blog.status).toBe(201);
    await agent.sync();
    const ids = () =>
      security
        .bans()
        .map((ban) => ban.subject.value)
        .sort();
    expect(ids()).toEqual(
      expect.arrayContaining(["203.0.113.1", "203.0.113.2"]),
    );
    expect(ids()).not.toContain("203.0.113.4");
    expect(agent.status().bans.count).toBe(3);
    // `scope=global` lists everything under it; the global ban is the one on that scope.
    const global = (await cp.call("GET", "/bans?scope=global")).body.items.find(
      (ban: { scope: string }) => ban.scope === "global",
    );
    expect((await cp.call("POST", `/bans/${global.id}/lift`)).status).toBe(200);
    await agent.sync();
    expect(ids()).not.toContain("203.0.113.1");
    expect(agent.status().bans.count).toBe(2);
  });

  it("a full reconcile takes away a ban whose lift the agent missed", async () => {
    const cp = await controlPlane();
    const { agent, security } = agentOn(cp);
    await agent.sync();
    const ban = (
      await cp.call("POST", "/bans", { ip: "198.51.100.7", reason: "x" })
    ).body;
    await agent.sync();
    expect(security.bans()).toHaveLength(1);
    // The lift happens; the agent's delta skips past it (as a lost poll would).
    await cp.call("POST", `/bans/${ban.id}/lift`);
    await cp.call("POST", "/services", { id: "other", name: "Other" });
    await agent.reconcile();
    expect(security.bans()).toHaveLength(0);
  });

  it("refuses a forged batch, one signed with another key, and a replayed older batch, each alerted", async () => {
    const cp = await controlPlane();
    await cp.call("POST", "/bans", { ip: "203.0.113.50", reason: "x" });
    const attacker = generateKeyPairSync("ed25519");
    let served: BanBatch | undefined;
    const alerts: string[] = [];
    const victim = agentOn(cp, {
      onAlert: (alert) => alerts.push(alert.kind),
      fetch: async (url, init) => {
        if (served !== undefined && url.includes("/agent/bans")) {
          return await signedAnswer(
            JSON.stringify(served),
            cp.secret,
            cp.clock.now(),
          );
        }
        return await cp.app.fetch(new Request(url, init));
      },
    });
    await victim.agent.sync();
    // Capture a real batch by letting one through, then replay it.
    let captured: BanBatch | undefined;
    const recorder = agentOn(cp, {
      fetch: async (url, init) => {
        const answer = await cp.app.fetch(new Request(url, init));
        if (url.includes("/agent/bans"))
          captured = JSON.parse(await answer.clone().text()) as BanBatch;
        return answer;
      },
    });
    await recorder.agent.reconcile();
    expect(captured).toBeDefined();
    const batch = captured!;
    // 1. Forged: a ban added after signing.
    served = {
      ...batch,
      bans: [
        ...batch.bans,
        {
          ...batch.bans[0]!,
          id: "ban_forged",
          subject: { type: "ip", value: "192.0.2.66" },
        },
      ],
    };
    await victim.agent.reconcile();
    // 2. Signed with a key no EP was deployed with.
    const other = {
      ...batch,
      signature: { ...batch.signature, keyId: "sk_attacker" },
    };
    served = {
      ...other,
      signature: {
        ...other.signature,
        value: edSign(
          null,
          banBatchSigningBytes(other),
          attacker.privateKey,
        ).toString("base64"),
      },
    };
    await victim.agent.reconcile();
    // 3. A genuine batch, replayed for a later request.
    served = batch;
    await victim.agent.reconcile();
    expect(alerts).toEqual(["bans.refused", "bans.refused", "bans.replayed"]);
    expect(
      victim.security.bans().map((ban) => ban.subject.value),
    ).not.toContain("192.0.2.66");
    // Negative controls: each passes a check that leaves out what caught it.
    const keys = { ...cp.keys, sk_attacker: attacker.publicKey };
    expect(
      verifyBanBatch(served, keys, {
        service: "checkout",
        since: BigInt(batch.since),
        request: batch.request,
      }).ok,
    ).toBe(true);
    const attackerSigned = {
      ...other,
      signature: {
        ...other.signature,
        value: edSign(
          null,
          banBatchSigningBytes(other),
          attacker.privateKey,
        ).toString("base64"),
      },
    };
    expect(
      verifyBanBatch(attackerSigned, keys, {
        service: "checkout",
        since: BigInt(batch.since),
        request: batch.request,
      }).ok,
    ).toBe(true);
    const forgedResigned = { ...batch, bans: [] };
    const resigned = {
      ...forgedResigned,
      signature: {
        ...batch.signature,
        value: (
          await cp.signer.sign(banBatchSigningBytes(forgedResigned))
        ).toString("base64"),
      },
    };
    expect(
      verifyBanBatch(resigned, cp.keys, {
        service: "checkout",
        since: BigInt(batch.since),
        request: batch.request,
      }).ok,
    ).toBe(true);
  });
});

describe("heartbeats and the nudge", () => {
  it("beats with what it enforces; the control plane shows it ok, then late and offline", async () => {
    const cp = await controlPlane();
    const { agent } = agentOn(cp);
    await agent.sync();
    await agent.heartbeat();
    let listed = (await cp.call("GET", "/agents/checkout-1")).body;
    expect(listed).toMatchObject({
      status: "ok",
      reported: { health: "ok", bundleKeyId: "sk_test" },
    });
    cp.clock.advance(4 * 30_000);
    listed = (await cp.call("GET", "/agents/checkout-1")).body;
    expect(listed.status).toBe("late");
    cp.clock.advance(8 * 30_000);
    listed = (await cp.call("GET", "/agents/checkout-1")).body;
    expect(listed.status).toBe("offline");
    // The first contact is in the audit log, as the agent.
    const first = (await cp.call("GET", "/audit?action=agent.firstContact"))
      .body.items;
    expect(first).toHaveLength(1);
  });

  it("is nudged on a ban and pulls at once, long before its poll", async () => {
    const cp = await controlPlane();
    const { agent, security } = agentOn(cp, {
      start: true,
      pollInterval: "1h",
      banPollInterval: "1h",
      reconcileInterval: "1h",
      heartbeatInterval: "1h",
    });
    await agent.ready;
    const until = async (what: () => boolean) => {
      for (let i = 0; i < 200 && !what(); i++) await Bun.sleep(10);
      return what();
    };
    expect(
      await until(
        () => agent.status().nudged && agent.status().bundle !== null,
      ),
    ).toBe(true);
    await cp.call("POST", "/bans", { ip: "203.0.113.77", reason: "nudged" });
    expect(
      await until(() =>
        security.bans().some((ban) => ban.subject.value === "203.0.113.77"),
      ),
    ).toBe(true);
    await agent.close();
  });
});

describe("artefacts", () => {
  it("fetches a bundle's artefacts, checks their hash, writes them 0600, and hands their paths over before loading", async () => {
    const cp = await controlPlane();
    const bytes = new TextEncoder().encode("a pretend MMDB");
    const { sha256 } = await cp.api.addArtefact(bytes);
    const stored = (await cp.store.getBundle("checkout")) as {
      version: number;
      bundle: SecurityBundle;
    };
    const { signature: _s, ...unsigned } = stored.bundle;
    const withArtefact = await signBundle(
      {
        ...unsigned,
        version: stored.version + 1,
        artefacts: [
          { kind: "mmdb-country", sha256, url: `/agent/artefacts/${sha256}` },
        ],
      },
      cp.signer,
    );
    expect(
      (
        await cp.store.putBundle(
          "checkout",
          { version: stored.version + 1, bundle: withArtefact },
          stored.version,
        )
      ).ok,
    ).toBe(true);
    const handed: string[] = [];
    const { agent } = agentOn(cp, {
      onArtefacts: (artefacts) =>
        void handed.push(...artefacts.map((a) => a.path)),
    });
    await agent.sync();
    expect(agent.status().bundle!.version).toBe(stored.version + 1);
    expect(handed).toHaveLength(1);
    expect(readFileSync(handed[0]!, "utf8")).toBe("a pretend MMDB");
    expect(statSync(handed[0]!).mode & 0o777).toBe(0o600);
  });

  it("negative control: an artefact whose bytes do not match its hash keeps the bundle out, alerted", async () => {
    const cp = await controlPlane({
      agents: {
        allowEphemeralStore: true,
        artefacts: {
          get: async () => new TextEncoder().encode("tampered"),
          put: async () => {},
        },
      },
    });
    const sha256 = "a".repeat(64);
    const stored = (await cp.store.getBundle("checkout")) as {
      version: number;
      bundle: SecurityBundle;
    };
    const { signature: _s, ...unsigned } = stored.bundle;
    const withArtefact = await signBundle(
      {
        ...unsigned,
        version: stored.version + 1,
        artefacts: [
          { kind: "mmdb-asn", sha256, url: `/agent/artefacts/${sha256}` },
        ],
      },
      cp.signer,
    );
    await cp.store.putBundle(
      "checkout",
      { version: stored.version + 1, bundle: withArtefact },
      stored.version,
    );
    const { agent, alerts } = agentOn(cp);
    await agent.sync();
    expect(agent.status().bundle).toBeNull();
    expect(alerts.map((alert) => [alert.kind, alert.message])).toEqual([
      ["artefact.mismatch", expect.any(String)],
    ]);
  });
});

describe("closing", () => {
  it("waits for a pull in flight, so the last known good holds what the agent enforced (found by T1)", async () => {
    const cp = await controlPlane();
    const { agent, stateFile } = agentOn(cp);
    await agent.ready;
    const pulling = agent.sync();
    await agent.close();
    const enforced = agent.status().bundle?.version ?? 0;
    const saved = existsSync(stateFile)
      ? ((
          JSON.parse(readFileSync(stateFile, "utf8")) as {
            bundle: { version: number } | null;
          }
        ).bundle?.version ?? 0)
      : 0;
    expect(saved).toBe(enforced);
    expect(saved).toBeGreaterThan(0);
    await pulling;
  });
});
