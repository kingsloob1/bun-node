import type { FetchLike } from "../../app/api/client";
import { describe, expect, it } from "bun:test";
import {
  createApiClient,
  CSRF_HEADER_VALUE,
  serializeQuery,
} from "../../app/api/client";
import { ApiError, isApiError } from "../../app/api/errors";
import { problem, queueListFixture } from "./fixtures";
import { mockFetch } from "./mockFetch";

const CSRF = "x-bun-jobs-csrf";

/** A client over a mock answering every request with `reply`. */
function clientWith(
  reply: Parameters<typeof mockFetch>[0][string],
  csrfHeader: string | null = CSRF,
) {
  const mock = mockFetch({
    "GET /x": reply,
    "POST /x": reply,
    "PUT /x": reply,
    "PATCH /x": reply,
    "DELETE /x": reply,
  });
  const client = createApiClient(
    { apiBase: "/jobs-api", csrfHeader },
    { fetch: mock.fetch },
  );
  return { client, calls: mock.calls };
}

/** Awaits a rejection and returns it as an ApiError. */
async function rejection(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (error) {
    if (isApiError(error)) {
      return error;
    }
    throw error;
  }
  throw new Error("expected a rejection");
}

describe("serializeQuery", () => {
  it("repeats keys for arrays, never comma-joins", () => {
    expect(serializeQuery({ state: ["failed", "dead"], limit: 20 })).toBe(
      "?state=failed&state=dead&limit=20",
    );
  });

  it("sends an empty array as a bare key, which the API reads as []", () => {
    expect(serializeQuery({ state: [] })).toBe("?state=");
  });

  it("skips undefined and null, keeps false and 0", () => {
    expect(
      serializeQuery({ a: undefined, b: null, total: false, offset: 0 }),
    ).toBe("?total=false&offset=0");
  });

  it("returns an empty string for no query", () => {
    expect(serializeQuery(undefined)).toBe("");
    expect(serializeQuery({ a: undefined })).toBe("");
  });

  it("percent-encodes values", () => {
    expect(serializeQuery({ search: "a b&c" })).toBe("?search=a+b%26c");
  });
});

describe("createApiClient: request headers", () => {
  it("prefixes apiBase (trailing slash trimmed) and sends Accept + same-origin credentials", async () => {
    const mock = mockFetch({ "GET /meta": { body: {} } });
    const client = createApiClient(
      { apiBase: "/jobs-api/", csrfHeader: null },
      { fetch: mock.fetch },
    );
    await client.request("GET", "/meta");
    expect(mock.calls[0]!.url).toBe("/jobs-api/meta");
    expect(mock.calls[0]!.headers.accept).toBe("application/json");
    expect(mock.calls[0]!.credentials).toBe("same-origin");
  });

  it("sends Content-Type: application/json on a bodiless POST, and no body", async () => {
    const { client, calls } = clientWith({ body: { paused: true } });
    await client.request("POST", "/x");
    expect(calls[0]!.headers["content-type"]).toBe("application/json");
    expect(calls[0]!.body).toBeUndefined();
  });

  it("sends Content-Type on PUT and PATCH, with the JSON body", async () => {
    const { client, calls } = clientWith({ body: {} });
    await client.request("PUT", "/x", { body: { a: 1 } });
    await client.request("PATCH", "/x", { body: null });
    expect(calls[0]!.headers["content-type"]).toBe("application/json");
    expect(calls[0]!.body).toBe('{"a":1}');
    expect(calls[1]!.headers["content-type"]).toBe("application/json");
    expect(calls[1]!.body).toBe("null");
  });

  it("sends no Content-Type on GET or a bodiless DELETE", async () => {
    const { client, calls } = clientWith({ status: 204 });
    await client.request("GET", "/x");
    await client.request("DELETE", "/x");
    expect(calls[0]!.headers["content-type"]).toBeUndefined();
    expect(calls[1]!.headers["content-type"]).toBeUndefined();
  });

  it("adds the CSRF header on every mutation and never on a read", async () => {
    const { client, calls } = clientWith({ status: 204 });
    for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"] as const) {
      await client.request(method, "/x");
    }
    const sent: Record<string, string | undefined> = Object.fromEntries(
      calls.map((call) => [call.method, call.headers[CSRF]]),
    );
    expect(sent).toEqual({
      GET: undefined,
      POST: CSRF_HEADER_VALUE,
      PUT: CSRF_HEADER_VALUE,
      PATCH: CSRF_HEADER_VALUE,
      DELETE: CSRF_HEADER_VALUE,
    });
  });

  it("sends no CSRF header when the config has none", async () => {
    const { client, calls } = clientWith({ status: 204 }, null);
    await client.request("POST", "/x");
    expect(Object.keys(calls[0]!.headers).sort()).toEqual([
      "accept",
      "content-type",
    ]);
  });
});

describe("createApiClient: responses", () => {
  it("parses a JSON body", async () => {
    const list = queueListFixture();
    const { client } = clientWith({ body: list });
    expect(await client.request<unknown>("GET", "/x")).toEqual(list);
  });

  it("resolves undefined for a 204", async () => {
    const { client } = clientWith({ status: 204 });
    expect(await client.request("DELETE", "/x")).toBeUndefined();
  });

  it("turns problem+json into an ApiError with every field", async () => {
    const body = problem(400, "VALIDATION", "Validation failed", {
      detail: "The request is invalid",
      instance: "/jobs-api/x",
      issues: [{ target: "query", path: "minutes", message: "too big" }],
      context: { max: 1440 },
    });
    const { client } = clientWith({ status: 400, body });
    const error = await rejection(client.request("GET", "/x"));
    expect(error).toBeInstanceOf(ApiError);
    expect(error.kind).toBe("problem");
    expect(error.status).toBe(400);
    expect(error.code).toBe("VALIDATION");
    expect(error.title).toBe("Validation failed");
    expect(error.detail).toBe("The request is invalid");
    expect(error.type).toBe("urn:bun-jobs:error:VALIDATION");
    expect(error.issues).toEqual(body.issues!);
    expect(error.context).toEqual({ max: 1440 });
    expect(error.instance).toBe("/jobs-api/x");
    expect(error.message).toBe("The request is invalid");
  });

  it("maps a non-JSON error (a proxy's HTML 502) onto the same shape", async () => {
    const { client } = clientWith(
      new Response("<h1>Bad gateway</h1>", {
        status: 502,
        statusText: "Bad Gateway",
        headers: { "content-type": "text/html" },
      }),
    );
    const error = await rejection(client.request("GET", "/x"));
    expect(error.kind).toBe("http");
    expect(error.status).toBe(502);
    expect(error.code).toBe("HTTP_502");
    expect(error.detail).toBe("<h1>Bad gateway</h1>");
    expect(error.issues).toEqual([]);
  });

  it("does not trust a JSON error body that is not a problem", async () => {
    const { client } = clientWith({
      status: 500,
      body: { oops: true },
      contentType: "application/json",
    });
    const error = await rejection(client.request("GET", "/x"));
    expect(error.kind).toBe("http");
    expect(error.code).toBe("HTTP_500");
  });

  it("rejects a 2xx that is not JSON", async () => {
    const { client } = clientWith(
      new Response("<html></html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
    );
    const error = await rejection(client.request("GET", "/x"));
    expect(error.kind).toBe("parse");
    expect(error.code).toBe("INVALID_RESPONSE");
  });

  it("wraps a network failure", async () => {
    const failing: FetchLike = async () => {
      throw new TypeError("Failed to fetch");
    };
    const client = createApiClient(
      { apiBase: "/api", csrfHeader: null },
      { fetch: failing },
    );
    const error = await rejection(client.getMeta());
    expect(error.kind).toBe("network");
    expect(error.status).toBe(0);
    expect(error.code).toBe("NETWORK_ERROR");
    expect(error.detail).toBe("Failed to fetch");
    expect(error.cause).toBeInstanceOf(TypeError);
  });

  it("lets an abort through untouched, so query cancellation works", async () => {
    const aborting: FetchLike = async () => {
      throw new DOMException("aborted", "AbortError");
    };
    const client = createApiClient(
      { apiBase: "/api", csrfHeader: null },
      { fetch: aborting },
    );
    const controller = new AbortController();
    controller.abort();
    const error = await client.getMeta(controller.signal).catch((e) => e);
    expect(isApiError(error)).toBe(false);
    expect((error as Error).name).toBe("AbortError");
  });
});

describe("createApiClient: endpoints", () => {
  it("builds each milestone-1 request", async () => {
    const mock = mockFetch({
      "GET /meta": { body: {} },
      "GET /meta/permissions": { body: { actions: {} } },
      "GET /overview": { body: {} },
      "GET /queues": { body: { items: [], truncated: false } },
      "GET /queues/a%2Fb/throughput": { body: {} },
      "GET /workers": { body: { items: [] } },
      "POST /queues/emails/pause": { body: { paused: true } },
      "POST /queues/emails/resume": { body: { paused: false } },
    });
    const client = createApiClient(
      { apiBase: "/jobs-api", csrfHeader: CSRF },
      { fetch: mock.fetch },
    );
    await client.getMeta();
    await client.getPermissions();
    await client.getPermissions({ queue: "emails" });
    await client.getOverview();
    await client.getOverview(15);
    await client.listQueues();
    await client.listQueues("");
    await client.listQueues("mail");
    await client.getQueueThroughput("a/b", 30);
    await client.listWorkers();
    expect(await client.pauseQueue("emails")).toEqual({ paused: true });
    expect(await client.resumeQueue("emails")).toEqual({ paused: false });

    expect(mock.calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      "GET /jobs-api/meta",
      "GET /jobs-api/meta/permissions",
      "GET /jobs-api/meta/permissions?queue=emails",
      "GET /jobs-api/overview",
      "GET /jobs-api/overview?minutes=15",
      "GET /jobs-api/queues",
      "GET /jobs-api/queues",
      "GET /jobs-api/queues?search=mail",
      "GET /jobs-api/queues/a%2Fb/throughput?minutes=30",
      "GET /jobs-api/workers",
      "POST /jobs-api/queues/emails/pause",
      "POST /jobs-api/queues/emails/resume",
    ]);
    const pause = mock.calls.at(-2)!;
    expect(pause.headers["content-type"]).toBe("application/json");
    expect(pause.headers[CSRF]).toBe("1");
  });

  it("works with an origin-qualified apiBase", async () => {
    const mock = mockFetch({ "GET /meta": { body: {} } }, "/api");
    const client = createApiClient(
      { apiBase: "https://jobs.example.com/api", csrfHeader: null },
      { fetch: mock.fetch },
    );
    await client.getMeta();
    expect(mock.calls[0]!.url).toBe("https://jobs.example.com/api/meta");
  });
});
