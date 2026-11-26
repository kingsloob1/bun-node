/**
 * `bunPassword()` with a real better-auth: sign-up and sign-in through its
 * handler, a user whose password better-auth hashed with its default scrypt
 * still signing in, `onLegacyHash` and `rehash()`, and the wrong password
 * refused on both kinds of hash. Each claim has a negative control showing
 * the test can tell the difference.
 *
 * Storage is better-auth's memory adapter: what is tested is the hashing, and
 * the stored hash is read straight out of its `account` rows.
 */
import type { BetterAuthOptions } from "better-auth";
import type { LegacyHashEvent } from "../../lib/password";
import { describe, expect, test } from "bun:test";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { hashPassword, verifyPassword } from "better-auth/crypto";
import { bunPassword, isBunPasswordHash } from "../../lib/password";

const BASE = "http://localhost:3000";
const PASSWORD = "correct horse battery staple";
const WRONG = "incorrect horse battery staple";

/** A memory database better-auth's adapter can share between instances. */
type Database = Record<string, Record<string, unknown>[]>;

/** An empty database with better-auth's core tables. */
function database(): Database {
  return { user: [], session: [], account: [], verification: [] };
}

/** better-auth over `db`, with `password` as its hooks (or its own default). */
function makeAuth(
  db: Database,
  password?: NonNullable<BetterAuthOptions["emailAndPassword"]>["password"],
) {
  return betterAuth({
    baseURL: BASE,
    secret: "bun-auth-password-tests-secret-0123456789",
    database: memoryAdapter(db),
    emailAndPassword: { enabled: true, ...(password ? { password } : {}) },
    logger: { disabled: true },
  });
}

/** A JSON POST to better-auth's handler. */
async function post(
  auth: ReturnType<typeof makeAuth>,
  path: string,
  body: unknown,
): Promise<Response> {
  return auth.handler(
    new Request(`${BASE}/api/auth${path}`, {
      method: "POST",
      headers: { origin: BASE, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

/** Signs a new user up through `auth` and returns their email. */
async function signUp(auth: ReturnType<typeof makeAuth>): Promise<string> {
  const email = `${crypto.randomUUID().slice(0, 8)}@example.com`;
  const response = await post(auth, "/sign-up/email", {
    email,
    password: PASSWORD,
    name: "Ada",
  });
  expect(response.status).toBe(200);
  return email;
}

/** The status of a sign-in attempt. */
async function signIn(
  auth: ReturnType<typeof makeAuth>,
  email: string,
  password: string,
): Promise<number> {
  return (await post(auth, "/sign-in/email", { email, password })).status;
}

/** The credential account's stored hash for `email`. */
function storedHash(db: Database, email: string): string {
  const user = db.user.find((row) => row.email === email)!;
  const account = db.account.find(
    (row) => row.userId === user.id && row.providerId === "credential",
  )!;
  return String(account.password);
}

/** The user id for `email`. */
function userIdOf(db: Database, email: string): string {
  return String(db.user.find((row) => row.email === email)!.id);
}

describe("hashes", () => {
  test("new hashes are Bun.password's: argon2id by default, bcrypt when asked", async () => {
    expect(await bunPassword().hash(PASSWORD)).toStartWith("$argon2id$");
    expect(
      await bunPassword({ algorithm: { algorithm: "bcrypt", cost: 4 } }).hash(
        PASSWORD,
      ),
    ).toMatch(/^\$2[aby]\$04\$/);
  });

  test("recognises Bun.password's formats and not better-auth's scrypt", async () => {
    expect(isBunPasswordHash(await Bun.password.hash(PASSWORD))).toBe(true);
    expect(
      isBunPasswordHash(await Bun.password.hash(PASSWORD, "argon2i")),
    ).toBe(true);
    expect(
      isBunPasswordHash(
        await Bun.password.hash(PASSWORD, { algorithm: "bcrypt", cost: 4 }),
      ),
    ).toBe(true);
    expect(isBunPasswordHash(await hashPassword(PASSWORD))).toBe(false);
  });

  test("verifies both kinds outside an endpoint; the legacy event has no account to rehash", async () => {
    const events: LegacyHashEvent[] = [];
    const hooks = bunPassword({
      onLegacyHash: (event) => void events.push(event),
    });
    const bun = await hooks.hash(PASSWORD);
    const scrypt = await hashPassword(PASSWORD);
    expect(await hooks.verify({ hash: bun, password: PASSWORD })).toBe(true);
    expect(await hooks.verify({ hash: bun, password: WRONG })).toBe(false);
    expect(await hooks.verify({ hash: scrypt, password: WRONG })).toBe(false);
    expect(events).toHaveLength(0);
    expect(await hooks.verify({ hash: scrypt, password: PASSWORD })).toBe(true);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      userId: null,
      accountId: null,
      hash: scrypt,
    });
    expect(await events[0].rehash()).toBe(false);
  });

  test("negative control: Bun.password.verify alone throws on better-auth's scrypt hash", async () => {
    const scrypt = await hashPassword(PASSWORD);
    expect(await verifyPassword({ hash: scrypt, password: PASSWORD })).toBe(
      true,
    );
    await expect(Bun.password.verify(PASSWORD, scrypt)).rejects.toThrow();
  });
});

describe("with better-auth", () => {
  test("sign-up stores a Bun.password hash; sign-in takes the password and refuses a wrong one", async () => {
    const db = database();
    const auth = makeAuth(db, bunPassword());
    const email = await signUp(auth);
    expect(storedHash(db, email)).toStartWith("$argon2id$");
    expect(await signIn(auth, email, PASSWORD)).toBe(200);
    expect(await signIn(auth, email, WRONG)).toBe(401);
  });

  test("negative control: without bunPassword, better-auth stores its own scrypt hash", async () => {
    const db = database();
    const email = await signUp(makeAuth(db));
    expect(isBunPasswordHash(storedHash(db, email))).toBe(false);
    expect(storedHash(db, email)).toMatch(/^[\da-f]+:[\da-f]+$/);
  });

  test("a user with better-auth's scrypt hash still signs in; a wrong password is refused; onLegacyHash fires once per sign-in", async () => {
    const db = database();
    const email = await signUp(makeAuth(db));
    const legacy = storedHash(db, email);

    const events: LegacyHashEvent[] = [];
    const auth = makeAuth(
      db,
      bunPassword({ onLegacyHash: (event) => void events.push(event) }),
    );
    expect(await signIn(auth, email, WRONG)).toBe(401);
    expect(events).toHaveLength(0);

    expect(await signIn(auth, email, PASSWORD)).toBe(200);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      userId: userIdOf(db, email),
      hash: legacy,
    });
    expect(events[0].accountId).toBeString();
    // Not rehashed: the hash is still the old one, and the next sign-in reports it again.
    expect(storedHash(db, email)).toBe(legacy);
    expect(await signIn(auth, email, PASSWORD)).toBe(200);
    expect(events).toHaveLength(2);
  });

  test("rehash() moves the user to a Bun.password hash; later sign-ins no longer report it", async () => {
    const db = database();
    const email = await signUp(makeAuth(db));
    let calls = 0;
    const auth = makeAuth(
      db,
      bunPassword({
        onLegacyHash: async ({ rehash }) => {
          calls++;
          expect(await rehash()).toBe(true);
        },
      }),
    );
    expect(await signIn(auth, email, PASSWORD)).toBe(200);
    expect(calls).toBe(1);
    expect(storedHash(db, email)).toStartWith("$argon2id$");

    expect(await signIn(auth, email, PASSWORD)).toBe(200);
    expect(await signIn(auth, email, WRONG)).toBe(401);
    expect(calls).toBe(1);
  });

  test("an onLegacyHash that throws does not fail the sign-in", async () => {
    const db = database();
    const email = await signUp(makeAuth(db));
    const auth = makeAuth(
      db,
      bunPassword({
        onLegacyHash: () => {
          throw new Error("the app's callback failed");
        },
      }),
    );
    expect(await signIn(auth, email, PASSWORD)).toBe(200);
  });

  // better-auth turns the throw into a 500 and prints it to the console as
  // `# SERVER_ERROR:`, past its logger (evidence E4): that output is expected.
  test("negative control: hooks with Bun.password only lock a scrypt user out", async () => {
    const db = database();
    const email = await signUp(makeAuth(db));
    const auth = makeAuth(db, {
      hash: async (password) => Bun.password.hash(password),
      verify: async ({ hash, password }) => Bun.password.verify(password, hash),
    });
    expect(await signIn(auth, email, PASSWORD)).toBe(500);
  });
});
