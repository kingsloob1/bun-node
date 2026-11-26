/**
 * A real `betterAuth({ database: bunSqlAdapter(...) })` on every engine:
 * sign-up, the session, sign-out and sign-in through its HTTP handler; a
 * two-factor backup code redeemed by concurrent requests, which only one may
 * win; and an organisation's members read through the adapter's native
 * joins (`advanced.database.joins`).
 *
 * The adapter opens its own client from the URL here (SQLite: a temporary
 * file), so `close()` and SQLite's pragmas are exercised too.
 */
import type { BetterAuthOptions } from "better-auth";
import type { BunSqlAdapter } from "../../lib/sql";
import type { Engine } from "./helpers";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { betterAuth } from "better-auth";
import { organization, twoFactor } from "better-auth/plugins";
import { bunSqlAdapter } from "../../lib/sql";
import {
  createdTables,
  dropTables,
  forEachEngine,
  openClient,
  runPrefix,
} from "./helpers";

const BASE = "http://localhost:3000";

/** better-auth on `database`, with the plugins these tests use. */
function makeAuth(database: BetterAuthOptions["database"]) {
  return betterAuth({
    baseURL: BASE,
    secret: "bun-auth-sql-adapter-tests-secret-0123456789",
    emailAndPassword: { enabled: true },
    plugins: [twoFactor(), organization()],
    advanced: { database: { joins: true } },
    logger: { disabled: true },
    database,
  });
}

/** The `name=value` pairs of a response's cookies, as a `Cookie` header. */
function cookieHeader(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0])
    .filter((pair) => !pair.endsWith("="))
    .join("; ");
}

/** A JSON request to better-auth's handler. */
function call(
  auth: { handler: (request: Request) => Promise<Response> },
  path: string,
  init: { method?: string; body?: unknown; cookie?: string } = {},
): Promise<Response> {
  return auth.handler(
    new Request(`${BASE}/api/auth${path}`, {
      method: init.method ?? (init.body === undefined ? "GET" : "POST"),
      headers: {
        origin: BASE,
        ...(init.body === undefined
          ? {}
          : { "content-type": "application/json" }),
        ...(init.cookie ? { cookie: init.cookie } : {}),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    }),
  );
}

/** The adapter for an engine, on a client it opens itself. */
function adapterFor(
  engine: Engine,
  prefix: string,
  file: string,
): BunSqlAdapter {
  return bunSqlAdapter({
    url: engine.name === "sqlite" ? file : engine.url!,
    adapter: engine.name,
    prefix,
  });
}

/**
 * An adapter whose `incrementOne` is a read, a pause and a write: what a
 * compare-and-set without atomicity looks like. The negative control for the
 * concurrency case.
 */
function withRacyIncrement(
  adapter: BunSqlAdapter,
): BetterAuthOptions["database"] {
  return (options: BetterAuthOptions) => {
    const db = adapter(options);
    return {
      ...db,
      incrementOne: async <T>(data: Parameters<typeof db.incrementOne>[0]) => {
        const row = await db.findOne<{ id: string }>({
          model: data.model,
          where: data.where,
        });
        if (!row) {
          return null;
        }
        await Bun.sleep(30);
        return db.update<T>({
          model: data.model,
          where: [{ field: "id", value: row.id }],
          update: { ...data.set },
        });
      },
    };
  };
}

await forEachEngine(async (engine, client) => {
  await client.close();

  describe(`round trip on ${engine.name}`, () => {
    const prefix = runPrefix();
    const file = join(tmpdir(), `${prefix}roundtrip.sqlite`);
    let adapter: BunSqlAdapter;
    const created: string[] = [];

    beforeAll(async () => {
      adapter = adapterFor(engine, prefix, file);
      created.push(
        ...createdTables(await adapter.syncSchema(makeAuth(adapter).options)),
      );
    });

    afterAll(async () => {
      await adapter.close();
      if (engine.name === "sqlite") {
        // The whole database is this run's file: remove it and its journal.
        for (const suffix of ["", "-wal", "-shm"]) {
          await rm(`${file}${suffix}`, { force: true });
        }
        return;
      }
      const cleanup = openClient(engine);
      await dropTables(engine.name, cleanup, created);
      await cleanup.close();
    });

    test("creates better-auth's tables, plugins' included", () => {
      expect(created.map((table) => table.slice(prefix.length)).sort()).toEqual(
        [
          "account",
          "invitation",
          "member",
          "organization",
          "session",
          "twoFactor",
          "user",
          "verification",
        ].sort(),
      );
    });

    test("sign-up, session, sign-out and sign-in through the handler", async () => {
      const auth = makeAuth(adapter);
      const email = `${prefix}ada@example.com`;
      const password = "correct horse battery staple";

      const signUp = await call(auth, "/sign-up/email", {
        body: { email, password, name: "Ada" },
      });
      expect(signUp.status).toBe(200);
      const cookie = cookieHeader(signUp);
      expect(cookie).toContain("better-auth.session_token=");

      const session = await call(auth, "/get-session", { cookie });
      const body = (await session.json()) as {
        user: { email: string; emailVerified: boolean; createdAt: string };
      };
      expect(body.user.email).toBe(email);
      expect(body.user.emailVerified).toBe(false);
      expect(Number.isNaN(Date.parse(body.user.createdAt))).toBe(false);

      const signOut = await call(auth, "/sign-out", { body: {}, cookie });
      expect(signOut.status).toBe(200);
      expect(
        await (await call(auth, "/get-session", { cookie })).json(),
      ).toBeNull();

      const wrong = await call(auth, "/sign-in/email", {
        body: { email, password: "wrong password entirely" },
      });
      expect(wrong.status).toBe(401);

      const signIn = await call(auth, "/sign-in/email", {
        body: { email, password },
      });
      expect(signIn.status).toBe(200);
      const again = (await (
        await call(auth, "/get-session", { cookie: cookieHeader(signIn) })
      ).json()) as { user: { email: string } };
      expect(again.user.email).toBe(email);
    });

    /** Signs up a user, enables two factors and redeems one backup code from `attempts` requests at once. */
    async function redeemConcurrently(
      database: BetterAuthOptions["database"],
      attempts: number,
    ): Promise<number> {
      const auth = makeAuth(database);
      const email = `${prefix}${crypto.randomUUID().slice(0, 8)}@example.com`;
      const password = "correct horse battery staple";
      const signUp = await call(auth, "/sign-up/email", {
        body: { email, password, name: "Grace" },
      });
      const headers = new Headers({
        cookie: cookieHeader(signUp),
        origin: BASE,
      });
      const enabled = await auth.api.enableTwoFactor({
        body: { password },
        headers,
      });
      if (!("backupCodes" in enabled)) {
        throw new Error("enabling two factors returned no backup codes");
      }
      const [code] = enabled.backupCodes;
      const results = await Promise.allSettled(
        Array.from({ length: attempts }, () =>
          auth.api.verifyBackupCode({
            body: { code, disableSession: true },
            headers,
          }),
        ),
      );
      return results.filter((result) => result.status === "fulfilled").length;
    }

    test("a backup code redeemed by concurrent requests is accepted once", async () => {
      expect(await redeemConcurrently(adapter, 6)).toBe(1);
    });

    test("negative control: a non-atomic incrementOne lets the same code through more than once", async () => {
      expect(
        await redeemConcurrently(withRacyIncrement(adapter), 6),
      ).toBeGreaterThan(1);
    });

    test("an organisation's members, read through native joins", async () => {
      const auth = makeAuth(adapter);
      const password = "correct horse battery staple";
      const owner = await call(auth, "/sign-up/email", {
        body: { email: `${prefix}owner@example.com`, password, name: "Owner" },
      });
      const second = (await (
        await call(auth, "/sign-up/email", {
          body: {
            email: `${prefix}member@example.com`,
            password,
            name: "Member",
          },
        })
      ).json()) as { user: { id: string } };
      const headers = new Headers({
        cookie: cookieHeader(owner),
        origin: BASE,
      });

      const org = await auth.api.createOrganization({
        body: { name: "Acme", slug: `${prefix}acme`.replaceAll("_", "-") },
        headers,
      });
      expect(org?.id).toBeString();
      await auth.api.addMember({
        body: {
          userId: second.user.id,
          role: "member",
          organizationId: org.id,
        },
      });

      const full = await auth.api.getFullOrganization({
        query: { organizationId: org.id },
        headers,
      });
      const members = (full?.members ?? [])
        .map((member) => ({ role: member.role, email: member.user.email }))
        .sort((a, b) => a.email.localeCompare(b.email));
      expect(members).toEqual([
        { role: "member", email: `${prefix}member@example.com` },
        { role: "owner", email: `${prefix}owner@example.com` },
      ]);
    });
  });
});

/** Compile-time: a `BunSqlAdapter` is a better-auth `database`. */
export type AdapterIsADatabase =
  BunSqlAdapter extends NonNullable<BetterAuthOptions["database"]>
    ? true
    : never;
