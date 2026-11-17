/**
 * The OpenAPI document `bun run gen:client` turns into the security app's
 * route map (`app/security/api/routes.gen.ts`): served by a real
 * `createSecurityApi()` with every optional part on (agents, break-glass,
 * alerting),
 * so every route the UI may call is in it. Throwaway keys; nothing is kept.
 */
import { generateKeyPairSync } from "node:crypto";
import { createSecurityApi } from "@kingsleyweb/bun-security/control";
import { memoryStore } from "@kingsleyweb/bun-security/store";

/** The document of every route the UI may call. */
export default async function routesOpenApi(): Promise<{
  /** The OpenAPI 3.1 document. */
  openapi: Record<string, unknown>;
}> {
  const passwordHash = await Bun.password.hash("unused", {
    algorithm: "argon2id",
    memoryCost: 4096,
    timeCost: 1,
  });
  const api = createSecurityApi({
    store: memoryStore(),
    authenticate: () => ({ id: "gen" }),
    owners: ["gen"],
    allowWithoutStepUp: true,
    signing: {
      keyId: "sk_gen",
      privateKey: generateKeyPairSync("ed25519").privateKey,
    },
    audit: {
      signing: {
        keyId: "ak_gen",
        privateKey: generateKeyPairSync("ed25519").privateKey,
      },
      allowNoExternalCheckpoints: true,
    },
    bans: { secret: "routes-openapi-fleet-secret-0123456789" },
    agents: { allowEphemeralStore: true },
    // Alerting's routes are mounted only when it is configured; no timers run.
    alerts: { timers: false },
    breakGlass: {
      passwordHash,
      totpSecret: "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP",
    },
    // The routes are keyed relative to it; its value reaches only `servers`.
    basePath: "/security/api",
    logger: () => {},
  });
  const openapi = api.openapi();
  api.live.close();
  api.close();
  return { openapi };
}
