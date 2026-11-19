/**
 * A fleet (topology (c), plan §11.6 `03-fleet`): a control plane
 * (`createSecurityApi` behind `secureAdmin`) and two enforcement points in
 * processes of their own, each kept current by `connectAgent` over real HTTP.
 *
 * ```bash
 * bun 18-fleet/fleet.ts
 * ```
 *
 * - The operator registers a group, a service and two agents
 *   (`POST /agents` answers each agent's secret once) and publishes a
 *   policy. The control plane signs a bundle per service (Ed25519); an agent
 *   enforces only a bundle that verifies under the public key it was given.
 * - A second publish and a ban reach both agents through the control plane's
 *   nudge: the agents poll hourly, so what arrives within the wait was
 *   pushed. A lifted ban leaves both.
 * - With the control plane gone, an agent restarted from its state file
 *   enforces its last known good. The negative control: a new agent with no
 *   state file has nothing to enforce and allows the address.
 * - The control plane keeps its state in a SQLite file (agent keys, nonces
 *   and bans must outlive a restart, so agents refuse a memory store) and
 *   listens on `127.0.0.1`, port 0. Operators are named by an `x-op` header, the example's stand-in
 *   for a real sign-in; writes carry the CSRF header the API requires.
 * - Every process is closed at the end, and the files are deleted.
 */
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import {
  createSecurityApi,
  secureAdmin,
} from "@kingsleyweb/bun-security/control";
import { sqliteStore } from "@kingsleyweb/bun-security/store";
import { check, checkEqual, summary } from "../shared/check";
import { show, step, title, waitFor } from "../shared/console";

title("a control plane and two agents");

const AGENT = join(import.meta.dir, "helpers", "agent.ts");
const FLEET_SECRET = "an-example-fleet-secret-of-32-bytes!!";
const BLOCKED = "203.0.113.200";
const RANGE = "198.51.100.0/24";
const BANNED = "192.0.2.77";

const work = mkdtempSync(join(tmpdir(), "bun-security-example-fleet-"));
const keys = generateKeyPairSync("ed25519");
const signingKey = keys.privateKey
  .export({ format: "pem", type: "pkcs8" })
  .toString();
const publicKey = keys.publicKey
  .export({ format: "pem", type: "spki" })
  .toString();
const auditKey = generateKeyPairSync("ed25519")
  .privateKey.export({ format: "pem", type: "pkcs8" })
  .toString();

/** An agent process, driven over IPC. */
interface AgentProcess {
  /** Asks it something and resolves its answer. */
  readonly ask: (
    request: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>;
  /** The bundle version it enforces (0 for none). */
  readonly version: () => Promise<number>;
  /** What it does with a request from `client`. */
  readonly action: (client: string) => Promise<string>;
  /** Closes it and waits for it to exit. */
  readonly close: () => Promise<void>;
}

/** Every agent process started, so the end can close the ones still running. */
const started: ReturnType<typeof Bun.spawn>[] = [];

/** Starts an agent process and waits until it is ready. */
async function startAgent(
  config: Record<string, unknown>,
): Promise<AgentProcess> {
  let next = 0;
  const waiting = new Map<number, (answer: Record<string, unknown>) => void>();
  let ready: () => void = () => {};
  const isReady = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const child = Bun.spawn({
    cmd: [process.execPath, AGENT, JSON.stringify(config)],
    stdout: "inherit",
    stderr: "inherit",
    ipc(message: Record<string, unknown>) {
      if (message.ready === true) {
        ready();
        return;
      }
      waiting.get(message.id as number)?.(message);
      waiting.delete(message.id as number);
    },
  });
  started.push(child);
  await Promise.race([
    isReady,
    child.exited.then((code) => {
      throw new Error(`the agent exited with ${code} before it was ready`);
    }),
  ]);
  const ask = (request: Record<string, unknown>) =>
    new Promise<Record<string, unknown>>((resolve) => {
      const id = next++;
      waiting.set(id, resolve);
      child.send({ ...request, id });
    });
  return {
    ask,
    version: async () =>
      (
        (await ask({ op: "status" })).status as {
          bundle: { version: number } | null;
        }
      ).bundle?.version ?? 0,
    action: async (client) =>
      (await ask({ op: "evaluate", client })).action as string,
    close: async () => {
      if (child.exitCode !== null) return;
      await ask({ op: "close" });
      await child.exited;
    },
  };
}

/** The control plane: the API on a SQLite store (agents need a durable one), served on 127.0.0.1. */
const store = sqliteStore({ path: join(work, "control.sqlite") });
const api = createSecurityApi({
  store,
  authenticate: (req) => {
    const id = req.request.headers.get("x-op");
    return id === null ? null : { id };
  },
  owners: ["alice"],
  allowWithoutStepUp: true,
  signing: { keyId: "sk_example", privateKey: signingKey },
  audit: {
    signing: { keyId: "ak_example", privateKey: auditKey },
    allowNoExternalCheckpoints: true,
  },
  bans: { secret: FLEET_SECRET },
  agents: {},
  logger: () => {},
});
const admin = await secureAdmin({ port: 0, api, logger: () => {} });
const base = `${admin.url}${api.basePath}`;
let adminOpen = true;

/** An operator's call: the status and the parsed body, of the shape `T` the route answers. */
async function call<T = Record<string, unknown>>(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: T }> {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      "x-bun-security-csrf": "1",
      "x-op": "alice",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: (text === "" ? undefined : JSON.parse(text)) as T,
  };
}

/** Publishes `policy` globally, on the head it reads; the new bundle version for `checkout`. */
async function publish(policy: Record<string, unknown>): Promise<number> {
  const head =
    (await call<{ head?: { id: string } }>("GET", "/policies/global")).body.head
      ?.id ?? null;
  await call("PUT", "/policies/global/draft", { policy, revision: null });
  const published = await call<{
    bundles: { service: string; version: number }[];
  }>("POST", "/policies/global/publish", {
    expectedHead: head,
    confirm: "global",
  });
  checkEqual("published", published.status, 200);
  return published.body.bundles.find((bundle) => bundle.service === "checkout")!
    .version;
}

/** An agent's configuration. */
const agentConfig = (
  id: string,
  secret: string,
  stateFile = join(work, `${id}.json`),
) => ({
  url: base,
  agent: id,
  secret,
  service: "checkout",
  publicKey,
  stateFile,
  fleetSecret: FLEET_SECRET,
});

const agents: AgentProcess[] = [];
try {
  /* ------------------------------------------------------------------ */
  step("the operator sets up the fleet and publishes v1");
  checkEqual(
    "group created",
    (await call("POST", "/groups", { id: "payments", name: "Payments" }))
      .status,
    201,
  );
  checkEqual(
    "service created",
    (
      await call("POST", "/services", {
        id: "checkout",
        name: "Checkout",
        groups: ["payments"],
      })
    ).status,
    201,
  );
  const v1 = await publish({ lists: [{ ip: BLOCKED, action: "block" }] });
  const secrets: Record<string, string> = {};
  for (const id of ["checkout-1", "checkout-2"]) {
    const made = await call<{ secret: string }>("POST", "/agents", {
      id,
      service: "checkout",
    });
    checkEqual(`agent ${id} registered`, made.status, 201);
    secrets[id] = made.body.secret;
  }
  agents.push(
    await startAgent(agentConfig("checkout-1", secrets["checkout-1"])),
    await startAgent(agentConfig("checkout-2", secrets["checkout-2"])),
  );
  await waitFor("both agents on v1", async () =>
    (await Promise.all(agents.map((agent) => agent.version()))).every(
      (v) => v >= v1,
    ),
  );
  checkEqual(
    `${BLOCKED} blocked by both`,
    await Promise.all(agents.map((agent) => agent.action(BLOCKED))),
    ["block", "block"],
  );

  /* ------------------------------------------------------------------ */
  step("v2 adds a range: both agents are nudged onto it");
  const v2 = await publish({
    lists: [
      { ip: BLOCKED, action: "block" },
      { ip: RANGE, action: "block" },
    ],
  });
  await waitFor("both agents on v2", async () =>
    (await Promise.all(agents.map((agent) => agent.version()))).every(
      (v) => v >= v2,
    ),
  );
  checkEqual(
    "198.51.100.9 blocked by both",
    await Promise.all(agents.map((agent) => agent.action("198.51.100.9"))),
    ["block", "block"],
  );

  /* ------------------------------------------------------------------ */
  step("a ban reaches both agents, and its lift too");
  const ban = await call<{ id: string }>("POST", "/bans", {
    ip: BANNED,
    reason: "example",
  });
  checkEqual("ban made", ban.status, 201);
  await waitFor("the ban on both agents", async () =>
    (await Promise.all(agents.map((agent) => agent.action(BANNED)))).every(
      (a) => a === "ban",
    ),
  );
  check("both ban it", true);
  checkEqual(
    "lifted",
    (await call("POST", `/bans/${ban.body.id}/lift`)).status,
    200,
  );
  await waitFor("the lift on both agents", async () =>
    (await Promise.all(agents.map((agent) => agent.action(BANNED)))).every(
      (a) => a === "allow",
    ),
  );
  check("both allow it again", true);

  /* ------------------------------------------------------------------ */
  step("the control plane goes away; an agent restarts on its last known good");
  // The agents first: each holds the control plane's nudge stream open, and
  // a server waits for open requests before it stops.
  await agents[0].close();
  await agents[1].close();
  await admin.close();
  adminOpen = false;
  const restarted = await startAgent(
    agentConfig("checkout-1", secrets["checkout-1"]),
  );
  agents[0] = restarted;
  show("restarted on version", await restarted.version());
  checkEqual("the version it had", await restarted.version(), v2);
  checkEqual(
    "still blocks the range",
    await restarted.action("198.51.100.9"),
    "block",
  );
  // The negative control: the same agent, no state file, nothing to fall back on.
  const fresh = await startAgent(
    agentConfig("checkout-1", secrets["checkout-1"], join(work, "fresh.json")),
  );
  checkEqual("a fresh agent has no bundle", await fresh.version(), 0);
  checkEqual(
    "and allows the range",
    await fresh.action("198.51.100.9"),
    "allow",
  );
  await fresh.close();
} finally {
  for (const agent of agents) await agent.close().catch(() => undefined);
  for (const child of started) if (child.exitCode === null) child.kill();
  if (adminOpen) await admin.close();
  await store.close();
  rmSync(work, { recursive: true, force: true });
}

summary();
