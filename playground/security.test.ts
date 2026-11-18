/**
 * The security demo (PR-X2, `security.ts`): mounted on an adapter bound to
 * port 0, its seed published (policies at every scope, alert rules, agents,
 * one change waiting for approval), its attacker loop sending every kind of
 * traffic and the control plane seeing what that does (refused events,
 * automatic bans the agents report, an alert firing, a crawler conflict in
 * a heartbeat), and its stop leaving nothing running.
 *
 * ```bash
 * cd playground && bun test security.test.ts
 * ```
 */
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { BunHttpAdapter } from "@kingsleyweb/bun-common";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { SecurityDemo } from "./security";
import {
  LOOP_KINDS,
  mountSecurityDemo,
  SECURITY_API_BASE,
  SECURITY_DEMO_BASE,
  SECURITY_UI_BASE,
} from "./security";

/** A fresh data directory under the playground's ignored `.data/`. */
function dataDir(): string {
  const parent = join(import.meta.dir, ".data");
  mkdirSync(parent, { recursive: true });
  return mkdtempSync(join(parent, "security-test-"));
}

let app: BunHttpAdapter;
let demo: SecurityDemo;
let origin: string;

/** A read of the control plane, as the browser's operator. */
async function read(path: string): Promise<Record<string, unknown>> {
  const response = await fetch(`${origin}${SECURITY_API_BASE}${path}`);
  expect(response.status).toBe(200);
  return (await response.json()) as Record<string, unknown>;
}

/** Waits until `check` holds, at most `ms`. */
async function until(
  check: () => Promise<boolean>,
  ms: number,
): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

beforeAll(async () => {
  app = new BunHttpAdapter(0, { logger: () => {} });
  demo = await mountSecurityDemo(app, {
    intervalMs: 0,
    dataDir: dataDir(),
  });
  const server = await app.listen(0, "127.0.0.1");
  origin = `http://127.0.0.1:${server.port}`;
  // Thirty ticks: every cadence of the loop comes round at least once.
  for (let i = 0; i < 30; i++) await demo.tick();
}, 120_000);

afterAll(async () => {
  await demo?.stop();
  await app?.close();
});

describe("the security demo", () => {
  it("listens on port 0 and serves the UI and its own page", async () => {
    expect(Number(new URL(origin).port)).toBeGreaterThan(0);
    expect((await fetch(`${origin}${SECURITY_UI_BASE}`)).status).toBe(200);
    const status = (await (
      await fetch(`${origin}${SECURITY_DEMO_BASE}/status`)
    ).json()) as {
      tick: number;
    };
    expect(status.tick).toBe(30);
  });

  it("seeds the services, their agents, policies at every scope and alert rules", async () => {
    const services = (await read("/services")).items as { id: string }[];
    expect(services.map((s) => s.id).sort()).toEqual([
      "accounts",
      "partner-api",
      "shop",
    ]);
    const agents = (await read("/agents")).items as { id: string }[];
    expect(agents.map((a) => a.id).sort()).toEqual([
      "accounts-1",
      "partner-api-1",
      "shop-1",
      "shop-2",
    ]);
    for (const scope of [
      "global",
      "group:storefront",
      "service:accounts",
      "service:partner-api",
    ]) {
      expect((await read(`/policies/${scope}`)).head).not.toBe(null);
    }
    expect(((await read("/alerts/rules")).items as unknown[]).length).toBe(4);
  });

  it("leaves one dangerous change waiting for the browser's operator to approve", async () => {
    const approvals = (await read("/approvals")).items as {
      status: string;
      author: string;
    }[];
    const pending = approvals.filter((a) => a.status === "pending");
    expect(pending).toHaveLength(1);
    expect(pending[0]?.author).toBe("reviewer");
  });

  it("sends every kind of traffic, and the engines refuse the attacks", () => {
    const figures = demo.figures();
    for (const kind of LOOP_KINDS)
      expect(figures[kind].runs).toBeGreaterThan(0);
    for (const kind of [
      "path-scan",
      "spoofed-crawler",
      "ipv6-rotation",
      "list-hits",
      "credential-stuffing",
      "api-key-abuse",
      "canary",
    ] as const) {
      expect(figures[kind].refused).toBeGreaterThan(0);
    }
    // Normal users are never refused.
    expect(figures.normal.refused).toBe(0);
  });

  it("the control plane sees it: refused events, a dry-run hit, automatic bans, a crawler conflict", async () => {
    const shown = await until(async () => {
      const events = (await read("/analytics/events?scope=global&limit=200"))
        .items as {
        action: string;
      }[];
      return events.some((e) => e.action === "block" || e.action === "ban");
    }, 15_000);
    expect(shown).toBe(true);
    const banned = await until(async () => {
      const bans = (await read("/bans?scope=global&source=auto&limit=50"))
        .items as unknown[];
      return bans.length > 0;
    }, 15_000);
    expect(banned).toBe(true);
    // The heartbeats carry the conflict the seed's scraper range makes.
    for (let i = 0; i < 3; i++) await demo.tick();
    const conflict = await until(async () => {
      const agents = (await read("/agents")).items as {
        reported: { crawlers?: { conflicts: { crawler: string }[] } } | null;
      }[];
      return agents.some((a) =>
        (a.reported?.crawlers?.conflicts ?? []).some(
          (c) => c.crawler === "google",
        ),
      );
    }, 20_000);
    expect(conflict).toBe(true);
  }, 60_000);

  it("an alert fires and its email is kept", async () => {
    await demo.api.alerts!.evaluate();
    const sent = await until(async () => {
      await demo.api.alerts!.flush();
      return demo.emails().length > 0;
    }, 20_000);
    expect(sent).toBe(true);
  }, 30_000);
});

describe("stopping", () => {
  it("stops cleanly: no timer or socket keeps the process alive", async () => {
    const local = new BunHttpAdapter(0, { logger: () => {} });
    const second = await mountSecurityDemo(local, {
      intervalMs: 50,
      dataDir: dataDir(),
    });
    second.start();
    await new Promise((resolve) => setTimeout(resolve, 300));
    await second.stop();
    const ticks = second.figures().normal.runs;
    await new Promise((resolve) => setTimeout(resolve, 300));
    // Nothing ticked after the stop.
    expect(second.figures().normal.runs).toBe(ticks);
    await local.close();
  }, 30_000);
});
