import type { SpecDocument } from "../../../../app/api/docs";
import type { DocOperation } from "../../../../app/screens/docs/http/model";
import type { TryItRequest } from "../../../../app/screens/docs/http/tryIt";
import { beforeAll, describe, expect, it } from "bun:test";
import { listOperations } from "../../../../app/screens/docs/http/model";
import {
  bodySchema,
  buildRequest,
  clientHeaders,
  curlSnippet,
  fetchSnippet,
  initialBodyText,
  inputKind,
  isDestructive,
  requestUrl,
  tryItGate,
} from "../../../../app/screens/docs/http/tryIt";
import { openApiFixture } from "./openapiFixture";

let doc: SpecDocument;
let operations: DocOperation[];

/** One operation by id. */
function op(id: string): DocOperation {
  const found = operations.find((operation) => operation.id === id);
  if (!found) {
    throw new Error(`no operation ${id}`);
  }
  return found;
}

/** Builds a request that must succeed. */
function build(
  id: string,
  values: Record<string, string | string[]>,
  body?: unknown,
): TryItRequest {
  const result = buildRequest(op(id), doc, values, body);
  if (!result.ok) {
    throw new Error(JSON.stringify(result.errors));
  }
  return result.request;
}

beforeAll(async () => {
  doc = await openApiFixture();
  operations = listOperations(doc);
});

describe("inputs from the schema", () => {
  it("picks an input per parameter type", () => {
    const params = Object.fromEntries(
      op("listJobs").parameters.map((parameter) => [
        parameter.name,
        inputKind(parameter, doc).kind,
      ]),
    );
    expect(params).toMatchObject({
      queue: "text",
      state: "enum-list", // array of a $ref'd enum
      offset: "number",
      order: "enum",
      name: "list",
      total: "boolean",
    });
  });
});

describe("buildRequest", () => {
  it("percent-encodes path parameters as one segment", () => {
    expect(
      build("getJob", { "path:queue": "a/b c", "path:id": "1?x" }).path,
    ).toBe("/queues/a%2Fb%20c/jobs/1%3Fx");
  });

  it("types query values: arrays, numbers, booleans; empty ones left out", () => {
    const request = build("listJobs", {
      "path:queue": "emails",
      "query:state": ["dead", "failed"],
      "query:limit": "5",
      "query:total": "true",
      "query:name": "send, build ,",
      "query:search": "",
    });
    expect(request.query).toEqual({
      state: ["dead", "failed"],
      limit: 5,
      total: true,
      name: ["send", "build"],
    });
    expect(requestUrl(request, "/jobs-api")).toBe(
      "/jobs-api/queues/emails/jobs?state=dead&state=failed&limit=5&name=send&name=build&total=true",
    );
  });

  it("reports a missing path parameter and a malformed number", () => {
    const result = buildRequest(
      op("listJobs"),
      doc,
      { "query:limit": "1.5" },
      undefined,
    );
    expect(result).toEqual({
      ok: false,
      errors: {
        "path:queue": "queue is required",
        "query:limit": "limit must be an integer",
      },
    });
  });

  it("requires a required body, and passes one through", () => {
    const missing = buildRequest(
      op("cleanQueue"),
      doc,
      { "path:queue": "q" },
      undefined,
    );
    expect(missing.ok).toBe(false);
    const body = { state: "completed", olderThan: 0 };
    expect(build("cleanQueue", { "path:queue": "q" }, body).body).toEqual(body);
  });
});

describe("bodies", () => {
  it("prefills a body from the schema's required fields", () => {
    expect(JSON.parse(initialBodyText(op("cleanQueue"), doc))).toEqual({
      state: "completed",
      olderThan: 0,
    });
  });

  it("offers no editor for a bodiless POST that only requires the media type", () => {
    expect(op("pauseQueue").requestBody).toBeDefined();
    expect(bodySchema(op("pauseQueue"))).toBeUndefined();
    expect(initialBodyText(op("pauseQueue"), doc)).toBe("");
  });
});

describe("headers and snippets", () => {
  it("restates the client's rules: Content-Type on POST/PUT/PATCH, CSRF on mutations", () => {
    expect(clientHeaders("GET", "x-bun-jobs-csrf")).toEqual({
      Accept: "application/json",
    });
    expect(clientHeaders("POST", "x-bun-jobs-csrf")).toEqual({
      Accept: "application/json",
      "Content-Type": "application/json",
      "x-bun-jobs-csrf": "1",
    });
    expect(clientHeaders("DELETE", "x-bun-jobs-csrf")).toEqual({
      Accept: "application/json",
      "x-bun-jobs-csrf": "1",
    });
    expect(clientHeaders("POST", null)).toEqual({
      Accept: "application/json",
      "Content-Type": "application/json",
    });
  });

  const context = {
    apiBase: "/jobs-api",
    origin: "https://ops.example",
    csrfHeader: "x-bun-jobs-csrf",
  };

  it("writes a curl command with the CSRF header, Content-Type and the cookie note", () => {
    const snippet = curlSnippet(
      build("pauseQueue", { "path:queue": "it's" }),
      context,
    );
    expect(snippet).toContain(
      "curl -X POST 'https://ops.example/jobs-api/queues/it'\\''s/pause'",
    );
    expect(snippet).toContain("-H 'Content-Type: application/json'");
    expect(snippet).toContain("-H 'x-bun-jobs-csrf: 1'");
    expect(snippet).toContain("cookies");
    expect(snippet).not.toContain("--data");

    const withBody = curlSnippet(
      build(
        "cleanQueue",
        { "path:queue": "q" },
        { state: "dead", olderThan: 5 },
      ),
      context,
    );
    expect(withBody).toContain(`--data '{"state":"dead","olderThan":5}'`);
  });

  it("writes a GET curl with no Content-Type and no CSRF header", () => {
    const snippet = curlSnippet(build("getMeta", {}), context);
    expect(snippet).toContain(
      "curl -X GET 'https://ops.example/jobs-api/meta'",
    );
    expect(snippet).not.toContain("Content-Type");
    expect(snippet).not.toContain("x-bun-jobs-csrf");
  });

  it("writes a fetch() call with the same headers, credentials and body", () => {
    const snippet = fetchSnippet(
      build(
        "cleanQueue",
        { "path:queue": "q" },
        { state: "dead", olderThan: 5 },
      ),
      context,
    );
    expect(snippet).toContain('await fetch("/jobs-api/queues/q/clean", {');
    expect(snippet).toContain('method: "POST"');
    expect(snippet).toContain('"Content-Type": "application/json"');
    expect(snippet).toContain('"x-bun-jobs-csrf": "1"');
    expect(snippet).toContain('credentials: "same-origin"');
    expect(snippet).toContain('"state": "dead"');
  });
});

describe("gating", () => {
  it("treats DELETE and remove/drain/clean/kill actions as destructive", () => {
    expect(isDestructive(op("removeJob"))).toBe(true);
    expect(isDestructive(op("removeJobs"))).toBe(true);
    expect(isDestructive(op("drainQueue"))).toBe(true);
    expect(isDestructive(op("cleanQueue"))).toBe(true);
    expect(isDestructive(op("killRunner"))).toBe(true);
    expect(isDestructive(op("pauseQueue"))).toBe(false);
    expect(isDestructive(op("getMeta"))).toBe(false);
  });

  it("turns the panel off for a mutation on a read-only API, or a missing permission", () => {
    expect(
      tryItGate(op("pauseQueue"), { readOnly: false, permitted: true }),
    ).toEqual({
      enabled: true,
    });
    expect(
      tryItGate(op("pauseQueue"), { readOnly: true, permitted: true }),
    ).toEqual({
      enabled: false,
      reason: "This API is read-only: it refuses every change.",
    });
    // A read stays usable on a read-only API.
    expect(
      tryItGate(op("getMeta"), { readOnly: true, permitted: true }).enabled,
    ).toBe(true);
    expect(
      tryItGate(op("getMeta"), { readOnly: false, permitted: false }),
    ).toEqual({
      enabled: false,
      reason: "You do not have the meta.read permission.",
    });
  });
});
