/**
 * The management API answers the host's body errors as the client's (#883):
 * with `deferBody`, bun-common reads a body on the route's first need and
 * throws an `http-errors`-shaped error for one it refuses. A body over the
 * host's `maxContentLength` is a `413 too_large`, malformed JSON a
 * `400 invalid_request`, a refused charset or coding a
 * `415 unsupported_encoding`; none is an `internal` problem or an error log.
 */
import { describe, expect, it } from "bun:test";
import { BunHttpAdapter } from "@kingsleyweb/bun-common";
import type { LogEvent } from "@kingsleyweb/bun-common";
import { clientErrorProblem } from "../../lib/control/problems";
import { testApi } from "./helpers";

/** An API on a host that defers its bodies, capped at 100 KiB; what it logged. */
function deferredHost() {
  const logged: LogEvent[] = [];
  const { api } = testApi({ logger: (event) => logged.push(event) });
  const app = new BunHttpAdapter(0, {
    logger: () => {},
    request: { parseBody: { maxContentLength: "100kb" }, deferBody: true },
  });
  app.use(api.basePath, api.router);
  const send = async (
    method: string,
    path: string,
    body: string,
    headers: Record<string, string> = {},
  ): Promise<{ status: number; body: any }> => {
    const response = await app.fetch(`${api.basePath}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        "x-bun-security-csrf": "1",
        "x-op": "alice",
        ...headers,
      },
      body,
    });
    return { status: response.status, body: await response.json() };
  };
  const put = (body: string, headers: Record<string, string> = {}) =>
    send("PUT", "/services/demo", body, headers);
  return { api, put, send, logged };
}

const errorsLogged = (logged: readonly LogEvent[]) =>
  logged.filter((event) => event.level === "error" || event.level === "fatal");

describe("the host's body errors (#883)", () => {
  it("answers a body over the host's maxContentLength with 413 too_large", async () => {
    const { api, put, logged } = deferredHost();
    const answer = await put(
      JSON.stringify({ name: "demo", pad: "x".repeat(200 * 1024) }),
    );
    expect(answer.status).toBe(413);
    expect(answer.body.code).toBe("too_large");
    expect(answer.body.type).toBe("urn:bun-security:problem:too_large");
    expect(answer.body.detail).toMatch(/maximum allowed size of 102400/);
    expect(errorsLogged(logged)).toEqual([]);
    api.close();
  });

  it("answers malformed JSON with 400 invalid_request", async () => {
    const { api, put, logged } = deferredHost();
    const answer = await put("{not json");
    expect(answer.status).toBe(400);
    expect(answer.body.code).toBe("invalid_request");
    expect(answer.body.detail).toMatch(/JSON Parse error/);
    expect(errorsLogged(logged)).toEqual([]);
    api.close();
  });

  it("answers a refused charset or content coding with 415 unsupported_encoding", async () => {
    const { api, put, logged } = deferredHost();
    const charset = await put("{}", {
      "content-type": "application/json; charset=koi8-r",
    });
    expect(charset.status).toBe(415);
    expect(charset.body.code).toBe("unsupported_encoding");
    const coding = await put("{}", { "content-encoding": "x-unknown" });
    expect(coding.status).toBe(415);
    expect(coding.body.code).toBe("unsupported_encoding");
    expect(errorsLogged(logged)).toEqual([]);
    api.close();
  });

  it("still validates a body that fits, and serves a valid one", async () => {
    const { api, put, send, logged } = deferredHost();
    const invalid = await put(JSON.stringify({ name: 7 }));
    expect(invalid.status).toBe(400);
    expect(invalid.body.code).toBe("invalid_request");
    expect(invalid.body.issues.length).toBeGreaterThan(0);
    const created = await send(
      "POST",
      "/services",
      JSON.stringify({ id: "demo", name: "Demo" }),
    );
    expect(created.status).toBe(201);
    const updated = await put(JSON.stringify({ name: "Demo 2", revision: 1 }));
    expect(updated.status).toBe(200);
    expect(updated.body.revision).toBe(2);
    expect(errorsLogged(logged)).toEqual([]);
    api.close();
  });
});

describe("clientErrorProblem", () => {
  const httpError = (status: number, expose = true) =>
    Object.assign(new Error(`status ${status}`), {
      status,
      statusCode: status,
      expose,
    });

  it("maps an exposed 400, 413 or 415 to its problem, the message as detail", () => {
    expect(clientErrorProblem(httpError(400))?.toBody()).toMatchObject({
      status: 400,
      code: "invalid_request",
      detail: "status 400",
    });
    expect(clientErrorProblem(httpError(413))?.code).toBe("too_large");
    expect(clientErrorProblem(httpError(415))?.code).toBe(
      "unsupported_encoding",
    );
    // `statusCode` alone, as some libraries set it.
    expect(
      clientErrorProblem(
        Object.assign(new Error("x"), { statusCode: 413, expose: true }),
      )?.status,
    ).toBe(413);
  });

  it("leaves anything else to the internal error: unexposed, another status, not an Error", () => {
    expect(clientErrorProblem(httpError(400, false))).toBeUndefined();
    expect(clientErrorProblem(httpError(429))).toBeUndefined();
    expect(clientErrorProblem(httpError(500))).toBeUndefined();
    expect(clientErrorProblem(new Error("boom"))).toBeUndefined();
    expect(
      clientErrorProblem({ status: 400, expose: true, message: "x" }),
    ).toBeUndefined();
  });
});
