import type { SpecDocument } from "../../../../app/api/docs";
import type { DocOperation } from "../../../../app/screens/docs/http/model";
import { beforeAll, describe, expect, it } from "bun:test";
import {
  componentSchemaNames,
  filterGroups,
  groupByTag,
  listOperations,
  readInfo,
  resolveServerUrl,
} from "../../../../app/screens/docs/http/model";
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

beforeAll(async () => {
  doc = await openApiFixture();
  operations = listOperations(doc);
});

describe("reading a real generated document", () => {
  it("lists every operation with its id, method and path", () => {
    expect(operations.length).toBeGreaterThan(30);
    expect(new Set(operations.map((operation) => operation.id)).size).toBe(
      operations.length,
    );
    expect(op("getMeta")).toMatchObject({ method: "GET", path: "/meta" });
    expect(op("removeJob")).toMatchObject({
      method: "DELETE",
      path: "/queues/{queue}/jobs/{id}",
    });
  });

  it("reads the bun-jobs extensions", () => {
    const pause = op("pauseQueue");
    expect(pause.action).toBe("queues.pause");
    expect(pause.mutation).toBe(true);
    expect(pause.csrf).toEqual({
      header: "x-bun-jobs-csrf",
      requireJson: true,
    });
    expect(op("getMeta").mutation).toBe(false);
    expect(op("getMeta").csrf).toBeUndefined();
    expect(op("getQueueThroughput").requires).toEqual(["getThroughput"]);
  });

  it("reads parameters with style/explode, and problem responses with their codes", () => {
    const list = op("listJobs");
    const state = list.parameters.find(
      (parameter) => parameter.name === "state",
    )!;
    expect(state).toMatchObject({
      in: "query",
      required: false,
      style: "form",
      explode: true,
    });
    const queue = list.parameters.find(
      (parameter) => parameter.name === "queue",
    )!;
    expect(queue.required).toBe(true);
    const notFound = list.responses.find(
      (response) => response.status === "404",
    )!;
    expect(notFound.codes).toContain("QUEUE_NOT_FOUND");
    expect(notFound.content[0]!.contentType).toBe("application/problem+json");
    // `default` is a $ref to components.responses.Problem, resolved.
    const fallback = list.responses.find(
      (response) => response.status === "default",
    )!;
    expect(fallback.ref).toBe("#/components/responses/Problem");
    expect(fallback.description).toContain("RFC 9457");
  });

  it("groups by tag in the document's tags order", () => {
    const groups = groupByTag(doc, operations);
    expect(groups.map((group) => group.name)).toEqual([
      "Meta",
      "Docs",
      "Queues",
      "Jobs",
      "Runners",
    ]);
    expect(groups[0]!.operations.map((operation) => operation.id)).toContain(
      "getMeta",
    );
    expect(groups[0]!.description).toBeTruthy();
  });

  it("filters by path, operation id and summary, every term required", () => {
    const groups = groupByTag(doc, operations);
    const ids = (query: string) =>
      filterGroups(groups, query).flatMap((group) =>
        group.operations.map((operation) => operation.id),
      );
    expect(ids("pausequeue")).toEqual(["pauseQueue"]);
    expect(ids("/runners/{runner}/kill")).toEqual(["killRunner"]);
    expect(ids("post pause")).toEqual(["pauseQueue", "pauseRunner"]);
    expect(ids("no-such-thing")).toEqual([]);
  });

  it("reads the header, and names the component schemas", () => {
    const info = readInfo(doc);
    expect(info.title).toBe("bun-jobs management API (shop)");
    expect(info.openapi).toBe("3.1.0");
    expect(info.servers).toEqual([
      { url: "/jobs-api", description: undefined },
    ]);
    expect(componentSchemaNames(doc)).toContain("Problem");
  });
});

describe("resolveServerUrl", () => {
  it("resolves a relative server against the page, or an absolute API base's origin", () => {
    expect(
      resolveServerUrl("/jobs-api", "/jobs-api", "https://ops.example"),
    ).toBe("https://ops.example/jobs-api");
    expect(
      resolveServerUrl(
        "/jobs-api",
        "https://api.example:8443/jobs-api",
        "https://ops.example",
      ),
    ).toBe("https://api.example:8443/jobs-api");
    expect(
      resolveServerUrl(
        "https://elsewhere.example/v1",
        "/jobs-api",
        "https://ops.example",
      ),
    ).toBe("https://elsewhere.example/v1");
  });
});

describe("a read-only API's document", () => {
  // The premise of try-it's "This API is read-only" reason: a real read-only
  // createJobsApi neither routes nor documents a mutation, so that reason can
  // only show for a stale or foreign document.
  it("lists no mutation operation", async () => {
    const readOnly = listOperations(await openApiFixture({ readOnly: true }));
    expect(readOnly.length).toBeGreaterThan(0);
    expect(
      readOnly
        .filter((operation) => operation.mutation)
        .map((operation) => operation.id),
    ).toEqual([]);
    expect(readOnly.map((operation) => operation.id)).not.toContain(
      "pauseQueue",
    );
    // The control: the same API, writable, documents its mutations.
    expect(operations.filter((operation) => operation.mutation).length).toBe(
      operations.length - readOnly.length,
    );
  });
});
