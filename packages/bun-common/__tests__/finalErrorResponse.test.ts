import type { FinalErrorLogContext } from "../lib/BunHttpAdapter";
import { describe, expect, it } from "bun:test";
import {
  BunHttpAdapter,
  errorStatusCode,
  finalErrorResponse,
} from "../lib/index";

function page(message: string): string {
  return `<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<title>Error</title>\n</head>\n<body>\n<pre>${message}</pre>\n</body>\n</html>\n`;
}

describe("errorStatusCode", () => {
  it("uses status, then statusCode, when it is 4xx/5xx", () => {
    expect(errorStatusCode({ status: 404 })).toBe(404);
    expect(errorStatusCode({ statusCode: 503 })).toBe(503);
    expect(errorStatusCode({ status: 413, statusCode: 400 })).toBe(413);
    expect(errorStatusCode({ status: 200, statusCode: 422 })).toBe(422);
  });

  it("falls back to 500 otherwise", () => {
    expect(errorStatusCode(new Error("boom"))).toBe(500);
    expect(errorStatusCode({ status: 302 })).toBe(500);
    expect(errorStatusCode({ status: 600 })).toBe(500);
    expect(errorStatusCode({ status: "404" })).toBe(500);
    expect(errorStatusCode("nope")).toBe(500);
    expect(errorStatusCode(null)).toBe(500);
    expect(errorStatusCode(undefined)).toBe(500);
  });
});

describe("finalErrorResponse", () => {
  it("answers 500 with the status page for a plain error", async () => {
    const res = finalErrorResponse(new Error("secret detail"));
    expect(res.status).toBe(500);
    expect(res.statusText).toBe("Internal Server Error");
    const body = await res.text();
    expect(body).toBe(page("Internal Server Error"));
    expect(body).not.toContain("secret detail");
  });

  it("takes the status from the error, and its message from STATUS_CODES", async () => {
    const err = Object.assign(new Error("too big: 12MB"), { statusCode: 413 });
    const res = finalErrorResponse(err, { method: "POST" });
    expect(res.status).toBe(413);
    expect(res.statusText).toBe("Payload Too Large");
    const body = await res.text();
    expect(body).toBe(page("Payload Too Large"));
    expect(body).not.toContain("12MB");
    expect(body).not.toContain("at ");
  });

  it("uses the number itself for a status Node has no message for", async () => {
    const res = finalErrorResponse({ status: 599 });
    expect(res.status).toBe(599);
    expect(await res.text()).toBe(page("599"));
  });

  it("escapes the status message into the HTML", async () => {
    // 418's message contains an apostrophe.
    const res = finalErrorResponse({ status: 418 });
    expect(await res.text()).toBe(page("I&#39;m a Teapot"));
  });

  it("sets the security and content-type headers", () => {
    const res = finalErrorResponse(new Error("x"));
    expect(res.headers.get("content-security-policy")).toBe(
      "default-src 'none'",
    );
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
  });

  it("applies err.headers, stringified, without overriding the fixed ones", () => {
    const err = {
      status: 429,
      headers: {
        "Retry-After": 30,
        "X-Custom": "yes",
        "Content-Type": "application/json",
      },
    };
    const res = finalErrorResponse(err);
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("30");
    expect(res.headers.get("x-custom")).toBe("yes");
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
  });

  it("ignores err.headers that is not an object", () => {
    const res = finalErrorResponse({ status: 400, headers: "X-Bad: 1" });
    expect(res.status).toBe(400);
    expect(res.headers.get("x-bad")).toBeNull();
  });

  it("sends no body for HEAD, but the same status and headers", async () => {
    const res = finalErrorResponse(
      { status: 404, headers: { "X-Custom": "1" } },
      { method: "HEAD" },
    );
    expect(res.status).toBe(404);
    expect(res.body).toBeNull();
    expect(await res.text()).toBe("");
    expect(res.headers.get("x-custom")).toBe("1");
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
  });

  it("sends the page for any other method", async () => {
    for (const method of ["GET", "POST", "head", undefined]) {
      const res = finalErrorResponse({ status: 404 }, { method });
      expect(await res.text()).toBe(page("Not Found"));
    }
  });

  it("calls log once with the message, the error and the context", () => {
    const calls: [string, unknown, FinalErrorLogContext][] = [];
    const err = Object.assign(new Error("boom"), { status: 422 });
    finalErrorResponse(err, {
      method: "PUT",
      path: "/items/1",
      log: (message, error, context) => {
        calls.push([message, error, context]);
      },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual([
      "Unhandled error while handling a request",
      err,
      { status: 422, method: "PUT", path: "/items/1" },
    ]);
    expect(calls[0]![1]).toBe(err);
  });

  it("calls log with no method or path when none were given", () => {
    const contexts: FinalErrorLogContext[] = [];
    finalErrorResponse("thrown string", {
      log: (_message, error, context) => {
        expect(error).toBe("thrown string");
        contexts.push(context);
      },
    });
    expect(contexts).toEqual([
      { status: 500, method: undefined, path: undefined },
    ]);
  });

  it("does not require a log callback", () => {
    expect(() => finalErrorResponse(new Error("quiet"))).not.toThrow();
  });

  it("matches what BunHttpAdapter sends for an unhandled route error, byte for byte", async () => {
    const adapter = new BunHttpAdapter();
    const err = Object.assign(new Error("nope"), {
      status: 403,
      headers: { "X-Reason": "denied" },
    });
    adapter.all("/fail", () => {
      throw err;
    });

    for (const method of ["GET", "HEAD"] as const) {
      const viaAdapter = await adapter.fetch("/fail", { method });
      const direct = finalErrorResponse(err, { method });
      expect(viaAdapter.status).toBe(direct.status);
      expect(viaAdapter.statusText).toBe(direct.statusText);
      expect(await viaAdapter.text()).toBe(await direct.text());
      for (const name of [
        "content-type",
        "content-security-policy",
        "x-content-type-options",
        "x-reason",
      ]) {
        expect(viaAdapter.headers.get(name)).toBe(direct.headers.get(name));
      }
    }
  });
});
