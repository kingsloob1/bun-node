/**
 * A stateful fake of the policy routes for the policy editor's and the
 * versions screen's tests (PR-U4), over the lists' fake (`policyApi`): the
 * OpenAPI document with the policy's JSON Schema as its `SecurityPolicy`
 * component (the API's own, `policySchema.fixture.json`, kept equal to
 * bun-security's by a server test), the draft's diff, the version history
 * and rollback.
 */
import type { MockCall, MockHandler, MockReply } from "./mockApi";
import type { PolicyApiOptions } from "./listsApi";
import { policyApi } from "./listsApi";
import { problem } from "./mockApi";
import schema from "./policySchema.fixture.json";

/** One version in the history. */
export interface VersionFixture {
  /** Its id. */
  readonly id: string;
  /** Its number. */
  readonly number: number;
  /** Its message. */
  readonly message?: string;
}

/** Options of {@link editorApi}. */
export interface EditorApiOptions extends PolicyApiOptions {
  /** The draft's changes (`GET /policies/:scope/diff`). */
  readonly diff?: readonly {
    path: string;
    before?: unknown;
    after?: unknown;
  }[];
  /** The history, newest first (the head first). */
  readonly versions?: readonly VersionFixture[];
  /** A rollback's answer; default publishes the version as the next one. */
  readonly rollback?: MockHandler;
}

/** `GET /openapi.json` with the policy's component. */
export const OPENAPI_WITH_POLICY: MockReply = {
  body: {
    openapi: "3.1.0",
    info: { title: "Security API", version: "1" },
    paths: {},
    components: { schemas: { SecurityPolicy: schema } },
  },
};

/** The draft PUT calls made. */
export function draftBodies(calls: readonly MockCall[]): unknown[] {
  return calls
    .filter((call) => call.method === "PUT" && call.path.endsWith("/draft"))
    .map((call) => (call.body as { policy: unknown }).policy);
}

/** See the module's description. */
export function editorApi(options: EditorApiOptions = {}) {
  const base = policyApi({ head: [], ...options });
  const versions = [...(options.versions ?? [{ id: "pv_3", number: 3 }])];
  const version = (v: VersionFixture) => ({
    scope: "global",
    id: v.id,
    number: v.number,
    policy: {},
    createdAt: 1_700_000_000_000 + v.number,
    createdBy: "op",
    message: v.message ?? null,
    status: v.id === base.state.head?.id ? "published" : "superseded",
  });
  const rollback: MockHandler = (call) => {
    const body = call.body as {
      versionId: string;
      expectedHead: string | null;
    };
    if (body.expectedHead !== (base.state.head?.id ?? null))
      return problem(409, "conflict");
    const number = (base.state.head?.number ?? 0) + 1;
    base.state.head = { id: `pv_${number}`, number, policy: {} };
    versions.unshift({
      id: `pv_${number}`,
      number,
      message: `rollback to ${body.versionId}`,
    });
    return { body: { version: version(versions[0]), bundles: [] } };
  };
  const routes: Record<string, MockHandler | MockReply> = {
    ...base.routes,
    "GET /openapi.json": OPENAPI_WITH_POLICY,
    "GET /policies/:scope/diff": {
      body: { from: "head", to: "draft", changes: options.diff ?? [] },
    },
    "GET /policies/:scope/versions": () => ({
      body: { items: versions.map(version) },
    }),
    "POST /policies/:scope/rollback": options.rollback ?? rollback,
  };
  return { routes, state: base.state, versions };
}
