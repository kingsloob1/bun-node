/**
 * A control plane with agents (memory store) and agents connected to it
 * over its socket-free `fetch`, on one fake clock, for the agent tests.
 */
import { generateKeyPairSync, sign as edSign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestLogger } from "@kingsleyweb/bun-common";
import type {
  AgentAlert,
  ConnectAgentOptions,
  SecurityAgent,
} from "../../lib/agent/index";
import { connectAgent } from "../../lib/agent/index";
import { bundlePublicKey } from "../../lib/control/index";
import type { SecurityApiOptions } from "../../lib/control/index";
import { createSecurity } from "../../lib/index";
import type { Security } from "../../lib/index";
import { testApi } from "../control/helpers";

/** Temporary directories, removed by {@link cleanUp}. */
const dirs: string[] = [];

/** A fresh temporary directory. */
export function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "bun-security-agent-"));
  dirs.push(dir);
  return dir;
}

/** Removes every temporary directory. */
export function cleanUp(): void {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
}

/** A control plane with agents, a service `checkout` in group `payments`, and a published global policy. */
export async function controlPlane(options: Partial<SecurityApiOptions> = {}) {
  const artefactDir = tempDir();
  const bundleKey = generateKeyPairSync("ed25519");
  const test = testApi({
    agents: { allowEphemeralStore: true, artefacts: { dir: artefactDir } },
    signing: { keyId: "sk_test", privateKey: bundleKey.privateKey },
    ...options,
  });
  const { call } = test;
  await call("POST", "/groups", { id: "payments", name: "Payments" });
  await call("POST", "/services", {
    id: "checkout",
    name: "Checkout",
    groups: ["payments"],
  });
  await call("POST", "/services", { id: "blog", name: "Blog" });
  await call("PUT", "/policies/global/draft", { policy: {}, revision: null });
  await call("POST", "/policies/global/publish", { expectedHead: null });
  const created = await call("POST", "/agents", {
    id: "checkout-1",
    service: "checkout",
  });
  if (created.status !== 201)
    throw new Error(`agent not created: ${JSON.stringify(created.body)}`);
  /** The public key EPs are deployed with. */
  const keys = { sk_test: bundleKey.publicKey };
  return {
    ...test,
    secret: created.body.secret as string,
    keys,
    artefactDir,
    /** Signs bytes with the bundle key, as the control plane does. */
    signer: {
      keyId: "sk_test",
      sign: async (bytes: Uint8Array) =>
        edSign(null, bytes, bundleKey.privateKey),
    },
  };
}

/** An engine, an agent on it, and what the agent alerted. */
export function agentOn(
  cp: Awaited<ReturnType<typeof controlPlane>>,
  over: Partial<ConnectAgentOptions> = {},
): {
  agent: SecurityAgent;
  security: Security;
  alerts: AgentAlert[];
  stateFile: string;
} {
  const alerts: AgentAlert[] = [];
  const security = createSecurity({
    policy: {},
    logger: () => {},
    now: cp.clock.now,
  });
  const stateFile = over.stateFile ?? join(tempDir(), "state.json");
  const { logger } = createTestLogger();
  const agent = connectAgent({
    url: `http://cp.test${cp.api.basePath}`,
    agent: "checkout-1",
    secret: cp.secret,
    service: "checkout",
    publicKeys: cp.keys,
    security,
    stateFile,
    artefactDir: tempDir(),
    start: false,
    fetch: (url, init) => cp.app.fetch(new Request(url, init)),
    logger,
    onAlert: (alert) => alerts.push(alert),
    now: cp.clock.now,
    ...over,
  });
  return { agent, security, alerts, stateFile };
}

export { bundlePublicKey };
