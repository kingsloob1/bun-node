import type { JobsApiConfig } from "../../lib/api/config";
import {
  decodeJobId,
  encodeJobId,
  JOBS_API_WS_SUBPROTOCOL,
  MAX_NAME_LENGTH,
  NAME_PARAM_PATTERN,
} from "@kingsleyweb/bun-jobs/api/contract";
import addFormats from "ajv-formats";
import Ajv2020 from "ajv/dist/2020";
import { afterAll, describe, expect, it } from "bun:test";
import { resolveConfig } from "../../lib/api/config";
import { createJobsApi } from "../../lib/api/createJobsApi";
import { parseChannel } from "../../lib/api/ws/channels";
import {
  QUEUE_EVENTS,
  RUNNER_EVENTS,
  WORKER_EVENTS,
} from "../../lib/api/ws/events";
import { apiConfig, openContexts } from "./fixtures";

/**
 * What the UI's docs viewer asked of the AsyncAPI document: the subprotocol as
 * a structured field (G19), an example on every message, each valid against
 * its own payload schema (G20), the job-id encoding named on the job channel
 * (G21), and the name rule on queue and runner parameters (G22).
 */

afterAll(async () => {
  await Promise.all(openContexts.map((jobs) => jobs.close()));
});

/** One message example, as the document carries it. */
interface MessageExample {
  /** Its name. */
  name: string;
  /** Its summary. */
  summary: string;
  /** The example frame. */
  payload: unknown;
}

/** One message, as far as these tests read it. */
interface MessageDoc {
  /** The message name. */
  name: string;
  /** The payload schema (a `$ref` into `components.schemas`, or inline). */
  payload: object;
  /** Its examples. */
  examples?: MessageExample[];
}

/** One channel parameter, as far as these tests read it. */
interface ParameterDoc {
  /** Its description. */
  description: string;
  /** The value schema, as an extension. */
  "x-bun-jobs-schema"?: Record<string, unknown>;
  /** Must not appear: AsyncAPI 3.0 has no `schema` on a parameter. */
  schema?: unknown;
}

/** The parts of the document these tests read. */
interface AsyncDoc {
  /** Servers, by id. */
  servers: Record<string, Record<string, unknown>>;
  /** Channels, by id. */
  channels: Record<
    string,
    Record<string, unknown> & {
      /** Address parameters, by name. */
      parameters?: Record<string, ParameterDoc>;
    }
  >;
  /** Components. */
  components: {
    /** Messages, by id. */
    messages: Record<string, MessageDoc>;
    /** Schemas, by name. */
    schemas: Record<string, unknown>;
  };
}

/** The AsyncAPI document for a configuration. */
async function documentFor(
  overrides: Partial<JobsApiConfig> = {},
): Promise<AsyncDoc> {
  const api = createJobsApi(apiConfig(overrides));
  const document = api.asyncapi() as unknown as AsyncDoc;
  await api.close();
  return document;
}

/** Every mode, since each prunes a different set of messages. */
const MODES = ["jobs", "runner", "both"] as const;

describe("G19: the subprotocol, as a structured field", () => {
  it("is on the server and the connection channel, from the contract's constant", async () => {
    const document = await documentFor();
    expect(JOBS_API_WS_SUBPROTOCOL).toBe("bun-jobs.v1");
    expect(document.servers.api!["x-bun-jobs-subprotocol"]).toBe(
      JOBS_API_WS_SUBPROTOCOL,
    );
    expect(document.channels.connection!["x-bun-jobs-subprotocol"]).toBe(
      JOBS_API_WS_SUBPROTOCOL,
    );
  });

  it("survives serving the document, and a fixed server", async () => {
    const api = createJobsApi(apiConfig());
    const served = (await (
      await api.router.fetch("/asyncapi.json", {
        headers: { host: "ops.example" },
      })
    ).json()) as AsyncDoc;
    await api.close();
    expect(served.servers.api!["x-bun-jobs-subprotocol"]).toBe(
      JOBS_API_WS_SUBPROTOCOL,
    );
    const fixed = await documentFor({
      docs: { asyncapiServer: { host: "jobs.example", protocol: "wss" } },
    });
    expect(fixed.servers.api!["x-bun-jobs-subprotocol"]).toBe(
      JOBS_API_WS_SUBPROTOCOL,
    );
  });
});

describe("G20: an example on every message", () => {
  /** Validates a value against a message's payload schema, with the document's components. */
  function payloadValidator(document: AsyncDoc) {
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    addFormats(ajv);
    const base = "urn:bun-jobs:test:asyncapi-examples";
    ajv.addSchema({ $id: base, components: document.components });
    return (message: MessageDoc, value: unknown) => {
      const schema = JSON.parse(
        JSON.stringify(message.payload).replaceAll(
          '"#/components/',
          `"${base}#/components/`,
        ),
      ) as object;
      const validate = ajv.compile(schema);
      return validate(value) ? null : validate.errors;
    };
  }

  it("has at least one on every message, in every mode", async () => {
    for (const mode of MODES) {
      const document = await documentFor({ mode });
      const messages = Object.entries(document.components.messages);
      expect(messages.length).toBeGreaterThan(9);
      for (const [id, message] of messages) {
        expect({ mode, id, has: (message.examples?.length ?? 0) > 0 }).toEqual({
          mode,
          id,
          has: true,
        });
      }
    }
  });

  it("covers every control frame and every event type", async () => {
    const document = await documentFor({ mode: "both" });
    const withExamples = Object.entries(document.components.messages)
      .filter(([, message]) => (message.examples?.length ?? 0) > 0)
      .map(([id]) => id)
      .sort();
    expect(withExamples).toEqual(
      [
        "subscribe",
        "unsubscribe",
        "ping",
        "hello",
        "ack",
        "gap",
        "heartbeat",
        "pong",
        "error",
        ...[...QUEUE_EVENTS, ...RUNNER_EVENTS, ...WORKER_EVENTS].map(
          (event) => event.messageName,
        ),
      ].sort(),
    );
  });

  it("validates every example against its own message's payload schema, in every mode", async () => {
    let checked = 0;
    for (const mode of MODES) {
      const document = await documentFor({ mode });
      const check = payloadValidator(document);
      for (const [id, message] of Object.entries(
        document.components.messages,
      )) {
        for (const example of message.examples ?? []) {
          expect({ mode, id, errors: check(message, example.payload) }).toEqual(
            { mode, id, errors: null },
          );
          expect(example.name).toBeString();
          expect(example.summary).toBeString();
          checked++;
        }
      }
    }
    // jobs: 9 control + 21 queue + 3 worker; runner: 9 + 9 (`logs`, the
    // run-log hint, is the ninth runner event); both: 9 + 33.
    expect(checked).toBe(33 + 18 + 42);
  });

  it("is checked against the message's own schema, not any frame's (the controls)", async () => {
    const document = await documentFor({ mode: "both" });
    const check = payloadValidator(document);
    const { messages } = document.components;
    // Another message's example fails: each schema pins its own type.
    expect(
      check(
        messages["queue.added"]!,
        messages["queue.removed"]!.examples![0]!.payload,
      ),
    ).not.toBeNull();
    expect(
      check(messages.hello!, messages.heartbeat!.examples![0]!.payload),
    ).not.toBeNull();
    // A drifted example fails.
    const hello = structuredClone(
      messages.hello!.examples![0]!.payload,
    ) as Record<string, unknown>;
    hello.protocol = 2;
    expect(check(messages.hello!, hello)).not.toBeNull();
    const failed = structuredClone(
      messages["queue.failed"]!.examples![0]!.payload,
    ) as { event: { payload: { error: Record<string, unknown> } } };
    delete failed.event.payload.error.message;
    expect(check(messages["queue.failed"]!, failed)).not.toBeNull();
  });
});

describe("G21: the job channel's id encoding", () => {
  it("names encodeJobId and its %uXXXX form for a lone surrogate", async () => {
    const { job } = (await documentFor()).channels;
    const description = job!.parameters!.jobId!.description;
    expect(description).toContain("encodeJobId");
    expect(description).toContain("encodeURIComponent");
    expect(description).toContain("%uXXXX");
    expect(description).toContain("lone UTF-16 surrogate");
  });

  it("describes what the channel parser actually accepts", () => {
    const config = resolveConfig(apiConfig());
    const lone = "job-\uD800-1";
    const encoded = encodeJobId(lone);
    expect(encoded).toBe("job-%uD800-1");
    expect(decodeJobId(encoded)).toBe(lone);
    const parsed = parseChannel(`queue/mail/job/${encoded}`, config);
    expect(parsed.ok && parsed.channel.target.jobId).toBe(lone);
  });
});

describe("G22: the name rule on queue and runner parameters", () => {
  const expected = {
    type: "string",
    pattern: NAME_PARAM_PATTERN,
    maxLength: MAX_NAME_LENGTH,
  };

  it("carries the OpenAPI parameters' schema, as x-bun-jobs-schema", async () => {
    const document = await documentFor({ mode: "both" });
    const { channels } = document;
    expect(channels.queue!.parameters!.queue!["x-bun-jobs-schema"]).toEqual(
      expected,
    );
    expect(channels.job!.parameters!.queue!["x-bun-jobs-schema"]).toEqual(
      expected,
    );
    expect(channels.runner!.parameters!.runner!["x-bun-jobs-schema"]).toEqual(
      expected,
    );
    // A job id is escaped, so any string is a valid segment: no rule.
    expect(
      channels.job!.parameters!.jobId!["x-bun-jobs-schema"],
    ).toBeUndefined();
    // AsyncAPI 3.0's Parameter Object has no `schema`: it is never emitted.
    for (const channel of Object.values(channels)) {
      for (const parameter of Object.values(channel.parameters ?? {})) {
        expect(parameter.schema).toBeUndefined();
      }
    }
    // The description states the same rule, from the same constants.
    expect(channels.queue!.parameters!.queue!.description).toContain(
      NAME_PARAM_PATTERN,
    );
    expect(channels.runner!.parameters!.runner!.description).toContain(
      `at most ${MAX_NAME_LENGTH} characters`,
    );
    // The OpenAPI path parameter says exactly the same.
    const api = createJobsApi(apiConfig());
    const openapi = api.openapi() as unknown as {
      paths: Record<
        string,
        Record<string, { parameters: { name: string; schema: object }[] }>
      >;
    };
    await api.close();
    expect(
      openapi.paths["/queues/{queue}"]!.get!.parameters.find(
        (parameter) => parameter.name === "queue",
      )!.schema,
    ).toMatchObject(expected);
  });

  it("agrees with the channel parser on what a name may be", async () => {
    const config = resolveConfig(apiConfig());
    const schema = (await documentFor()).channels.queue!.parameters!.queue![
      "x-bun-jobs-schema"
    ]!;
    const ajv = new Ajv2020({ strict: false });
    const validate = ajv.compile(schema);
    for (const name of [
      "mail",
      "mail.v2",
      "a-b_c",
      ".",
      "..",
      "...",
      "bad name",
      "a".repeat(MAX_NAME_LENGTH),
      "a".repeat(MAX_NAME_LENGTH + 1),
    ]) {
      expect({ name, schema: validate(name) }).toEqual({
        name,
        schema: parseChannel(`queue/${name}`, config).ok,
      });
    }
  });
});

describe("the `logs` runner event says it is not a state change", () => {
  // A client that invalidates cached runner state on every runner event would
  // re-read the runner's detail, stats, history and open logs on each `logs`
  // hint, up to twice a second per run. The document is where a client
  // author reads what an event means, so it says so in the message itself.
  // A deliberate pin: change the summary and this has to change with it.
  const NOT_A_STATE_CHANGE =
    "Not a state change: it changes no runner state, so a client caching runner detail, stats or history should not invalidate them on it; re-read the run's log with `?since=` instead.";

  it("in the message summary, in every mode that carries runner events", async () => {
    for (const mode of ["runner", "both"] as const) {
      const message = (await documentFor({ mode })).components.messages[
        "runner.logs"
      ] as MessageDoc & { summary: string };
      expect({ mode, summary: message.summary }).toEqual({
        mode,
        summary: expect.stringContaining(NOT_A_STATE_CHANGE),
      });
    }
  });

  it("on no other runner event (the control)", () => {
    for (const descriptor of RUNNER_EVENTS) {
      expect({
        type: descriptor.type,
        says: descriptor.summary.includes("Not a state change"),
      }).toEqual({ type: descriptor.type, says: descriptor.type === "logs" });
    }
  });
});
