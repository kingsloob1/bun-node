/**
 * The redaction module (README §8.1, the user's rules of 2026-11-17),
 * adversarially: a password under a key no list names, a JWT in a query
 * value, a card number in a form body, a token in a path segment, a body
 * that is not JSON, credentials in headers and answers, and the caps. Each
 * case has a negative control: the same input without the trait that
 * should trigger redaction keeps its value, so the case cannot pass by
 * redacting everything.
 */
import { describe, expect, it } from "bun:test";
import {
  createRedactor,
  looksLikeCredential,
  REDACTED,
  REDACTED_SEGMENT,
  REDACTION_LIMITS,
  TRUNCATED,
} from "../../lib/analytics/index";

const redactor = createRedactor();
const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1MSJ9.c2lnbmF0dXJlLWJ5dGVzLWhlcmU";
const CARD = "4111 1111 1111 1111";
const NOT_A_CARD = "4111 1111 1111 1112";
const TOKEN =
  "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";

/** A sample's JSON, for "does this text appear anywhere" checks. */
const text = (value: unknown): string => JSON.stringify(value);

describe("keys", () => {
  it("redacts a sensitive key by substring, any case, ignoring _ and -", () => {
    const sample = redactor.sample({
      method: "POST",
      path: "/profile",
      body: {
        type: "application/json",
        text: JSON.stringify({
          "User_Pass-Word": "hunter2",
          apiKEY: "abc",
          nested: { session_id: "s1", note: "keep me" },
          username: "ada",
        }),
      },
    });
    expect(sample.body?.fields).toEqual({
      "User_Pass-Word": REDACTED,
      apiKEY: REDACTED,
      nested: { session_id: REDACTED, note: "keep me" },
      username: "ada",
    });
  });

  it("a password under an unlisted key: caught on a sensitive profile, where every value goes", () => {
    const body = {
      type: "application/json",
      text: JSON.stringify({ login: "ada", pw2: "hunter2" }),
    };
    const login = redactor.sample({
      method: "POST",
      path: "/login",
      profile: "login",
      body,
    });
    expect(login.body?.fields).toEqual({ login: REDACTED, pw2: REDACTED });
    expect(text(login)).not.toContain("hunter2");
    // The control: the same body on an ordinary route keeps the value, so
    // it is the profile that caught it (no key list can name every field).
    const plain = redactor.sample({ method: "POST", path: "/notes", body });
    expect(text(plain)).toContain("hunter2");
  });

  it("takes a policy's extra words", () => {
    const custom = createRedactor({ keys: ["pan"] });
    const body = {
      type: "application/json",
      text: JSON.stringify({ pan: "x", other: "y" }),
    };
    expect(
      custom.sample({ method: "POST", path: "/", body }).body?.fields,
    ).toEqual({
      pan: REDACTED,
      other: "y",
    });
    expect(
      redactor.sample({ method: "POST", path: "/", body }).body?.fields,
    ).toEqual({
      pan: "x",
      other: "y",
    });
  });
});

describe("values that look like credentials, whatever their key", () => {
  it("a JWT in a query value", () => {
    const sample = redactor.sample({
      method: "GET",
      path: "/cb",
      query: `next=${JWT}&page=2`,
    });
    expect(sample.query).toEqual({ next: REDACTED, page: "2" });
    expect(text(sample)).not.toContain("eyJ");
    // The control: an ordinary value under the same key stays.
    expect(
      redactor.sample({ method: "GET", path: "/cb", query: "next=/home" })
        .query,
    ).toEqual({
      next: "/home",
    });
  });

  it("a card number in a form body", () => {
    const form = (ref: string) =>
      redactor.sample({
        method: "POST",
        path: "/pay",
        body: {
          type: "application/x-www-form-urlencoded",
          text: new URLSearchParams({ amount: "10", ref }).toString(),
        },
      }).body?.fields;
    expect(form(CARD)).toEqual({ amount: "10", ref: REDACTED });
    // The control: sixteen digits that fail the Luhn check stay.
    expect(form(NOT_A_CARD)).toEqual({ amount: "10", ref: NOT_A_CARD });
  });

  it("a bearer credential, a long hex or base64 run with digits, but not a long word", () => {
    for (const value of [
      "Bearer abc.def",
      `token ${TOKEN}`,
      "c2VjcmV0LWtleS1ieXRlcy0xMjM0NTY3ODkw",
      JWT,
      CARD,
    ]) {
      expect(looksLikeCredential(value)).toBe(true);
    }
    for (const value of [
      "internationalizationprocesses",
      "hello world",
      "2026-11-17",
      NOT_A_CARD,
      "+234 803 123 4567",
    ]) {
      expect(looksLikeCredential(value)).toBe(false);
    }
  });
});

describe("paths", () => {
  it("a token in a path segment becomes :redacted", () => {
    const sample = redactor.sample({
      method: "GET",
      path: `/reset/${TOKEN}/confirm`,
    });
    expect(sample.path).toBe(`/reset/${REDACTED_SEGMENT}/confirm`);
    // The control: an ordinary id stays.
    expect(
      redactor.sample({ method: "GET", path: "/users/42/posts" }).path,
    ).toBe("/users/42/posts");
  });

  it("the route's template is kept where the route is known", () => {
    expect(
      redactor.sample({
        method: "GET",
        path: `/reset/${TOKEN}`,
        routeTemplate: "/reset/:token",
      }).path,
    ).toBe("/reset/:token");
  });
});

describe("bodies", () => {
  it("a body that is not JSON or a form keeps its type and length, never a byte", () => {
    const secret = "password=hunter2&card=4111111111111111";
    for (const type of [
      "text/plain",
      "multipart/form-data; boundary=x",
      "application/octet-stream",
      "application/xml",
    ]) {
      const sample = redactor.sample({
        method: "POST",
        path: "/upload",
        body: { type, text: secret },
      });
      expect(sample.body).toEqual({
        type: type.split(";")[0]!,
        length: secret.length,
      });
      expect(text(sample)).not.toContain("hunter2");
    }
    // The control: the same bytes as a form are read as fields (redacted by key).
    const form = redactor.sample({
      method: "POST",
      path: "/upload",
      body: { type: "application/x-www-form-urlencoded", text: secret },
    });
    expect(form.body?.fields).toEqual({ password: REDACTED, card: REDACTED });
  });

  it("an app's parsed body is used as it is; malformed JSON keeps no text", () => {
    expect(
      redactor.sample({
        method: "POST",
        path: "/",
        body: { type: "application/json", parsed: { a: 1 } },
      }).body?.fields,
    ).toEqual({ a: 1 });
    const broken = redactor.sample({
      method: "POST",
      path: "/",
      body: { type: "application/json", text: '{"password":"hunter2"' },
    });
    expect(broken.body).toEqual({
      type: "application/json",
      length: 21,
      truncated: true,
    });
  });

  it("caps depth at 5 and the body at 4 KB, saying so", () => {
    const deep = { a: { b: { c: { d: { e: { f: "too deep" } } } } } };
    const sample = redactor.sample({
      method: "POST",
      path: "/",
      body: { type: "application/json", parsed: deep },
    });
    expect(text(sample)).not.toContain("too deep");
    expect(sample.body?.truncated).toBe(true);
    const big = Object.fromEntries(
      Array.from({ length: 400 }, (_, i) => [`k${i}`, "v".repeat(40)]),
    );
    const capped = redactor.sample({
      method: "POST",
      path: "/",
      body: { type: "application/json", parsed: big },
    });
    expect(text(capped.body?.fields).length).toBeLessThanOrEqual(
      REDACTION_LIMITS.body + 200,
    );
    expect(capped.body?.truncated).toBe(true);
    // The control: a small body is whole.
    const small = redactor.sample({
      method: "POST",
      path: "/",
      body: { type: "application/json", parsed: { k: "v" } },
    });
    expect(small.body?.truncated).toBeUndefined();
    expect(text(small)).not.toContain(TRUNCATED);
  });
});

describe("headers and answers", () => {
  it("lower-cases headers, redacts credential headers and sensitive names, caps count and length", () => {
    const sample = redactor.sample({
      method: "GET",
      path: "/",
      headers: {
        Authorization: "Basic YWRhOmh1bnRlcjI=",
        Cookie: "sid=abc",
        "X-Session-Id": "s1",
        "User-Agent": "curl/8",
        "X-Long": "y".repeat(600),
      },
    });
    expect(sample.headers.authorization).toBe(REDACTED);
    expect(sample.headers.cookie).toBe(REDACTED);
    expect(sample.headers["x-session-id"]).toBe(REDACTED);
    expect(sample.headers["user-agent"]).toBe("curl/8");
    expect(sample.headers["x-long"]!.length).toBe(REDACTION_LIMITS.value);
    const many = Object.fromEntries(
      Array.from({ length: 70 }, (_, i) => [`h${i}`, "v"]),
    );
    expect(
      Object.keys(
        redactor.sample({ method: "GET", path: "/", headers: many }).headers,
      ),
    ).toHaveLength(60);
  });

  it("keeps an answer's body only when the engine answered; set-cookie is redacted", () => {
    const answer = {
      status: 200,
      headers: {
        "Set-Cookie": "sid=secret",
        "Content-Type": "application/json",
      },
      body: '{"accessToken":"t"}',
    };
    const app = redactor.sample({
      method: "POST",
      path: "/login",
      answer: { ...answer, byEngine: false },
    });
    expect(app.answer).toEqual({
      status: 200,
      headers: { "set-cookie": REDACTED, "content-type": "application/json" },
    });
    // The control: the engine's own answer keeps its body.
    const engine = redactor.sample({
      method: "POST",
      path: "/login",
      answer: { status: 403, body: '{"code":"blocked"}', byEngine: true },
    });
    expect(engine.answer?.body).toBe('{"code":"blocked"}');
  });
});
