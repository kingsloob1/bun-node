/**
 * The generator — `bun-client generate` writes the route map, the manifest
 * and the zod schemas from the server's OpenAPI document, `--check` keeps the
 * committed copy honest, and the generated map types the same calls (plus
 * `api.op` and a narrowed error `code`). Each step is asserted.
 *
 * ```bash
 * bun 14-typed-client/generate-client.ts
 * bun run gen:client     # in examples/bun-common: rewrite the committed files
 * bun run check:client   # the same with --check: exit 1 when they are stale
 * ```
 *
 * - **The files beside this one** (`helpers/api.gen.ts`,
 *   `helpers/api.zod.gen.ts`) are committed output of
 *   `bun-client generate --module helpers/api.ts`. The module is read
 *   in process: no server is started to document it.
 * - **`--check`** writes nothing and exits `1` when the file is missing or
 *   differs from what would be written. Here it also runs against a copy
 *   edited by hand, to show it failing.
 * - **The generated map beats `RoutesOf`** in two ways the registry's types
 *   cannot match: `.describe({ errors: ["NOT_FOUND"] })` narrows the
 *   error `code` to that literal, and each route's `operationId` becomes a
 *   name for `api.op.getUser(...)`.
 * - **The manifest** also lists the statuses each route declares, so a
 *   status it does not (a 418 from a proxy) throws `UnexpectedStatusError`
 *   rather than being read as a declared result.
 * - **Validation on the client**: with the generated zod module as the
 *   client's `schemas`, a bad request is refused *before* it is sent
 *   (`ValidationError`; the server saw nothing), and a response that
 *   drifted from its schema is reported through the client's `logger`.
 */
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createClient,
  UnexpectedStatusError,
  ValidationError,
} from "@kingsleyweb/bun-client";
import { runCli } from "@kingsleyweb/bun-client/codegen";
import { BunHttpAdapter, noopLogger } from "@kingsleyweb/bun-common";
import { check, checkEqual, checkRejects, summary } from "../shared/check";
import { show, step, title } from "../shared/console";
import { createApi } from "./helpers/api";
import { manifest } from "./helpers/api.gen";
import type { Routes } from "./helpers/api.gen";

title("The generator: bun-client generate, --check, and the generated map");

/** `examples/bun-common`: where the committed files' relative paths start. */
const root = join(import.meta.dir, "..");

/** The arguments `bun run gen:client` passes, with the output under `out`. */
const generateArgs = (out: string, zod: string): string[] => [
  "generate",
  "--module",
  join(import.meta.dir, "helpers/api.ts"),
  "--out",
  out,
  "--zod",
  zod,
];

/** Runs `bun-client` in process: its exit status and output. */
async function bunClient(...argv: string[]) {
  let stdout = "";
  let stderr = "";
  const code = await runCli(argv, {
    cwd: root,
    stdout: (text) => void (stdout += text),
    stderr: (text) => void (stderr += text),
  });
  return { code, stdout, stderr };
}

const committedMap = join(import.meta.dir, "helpers/api.gen.ts");
const committedZod = join(import.meta.dir, "helpers/api.zod.gen.ts");
const scratch = await mkdtemp(join(tmpdir(), "typed-client-generate-"));

try {
  /* ---------------------------------------------------------------- */
  step("The committed files are fresh: generate --check");

  const fresh = await bunClient(
    ...generateArgs(committedMap, committedZod),
    "--check",
  );
  show("exit", fresh.code);
  checkEqual(
    "--check exits 0 on the committed route map and zod module",
    fresh.code,
    0,
  );

  /* ---------------------------------------------------------------- */
  step("Generating somewhere else gives the same bytes");

  const mapCopy = join(scratch, "api.gen.ts");
  const zodCopy = join(scratch, "api.zod.gen.ts");
  const written = await bunClient(...generateArgs(mapCopy, zodCopy));
  show("stdout", written.stdout.trim());
  checkEqual("exit 0", written.code, 0);
  check(
    "the route map equals the committed one, byte for byte",
    (await Bun.file(mapCopy).text()) === (await Bun.file(committedMap).text()),
  );
  // The header names the documents' hash: the cache buster of a persisted query cache.
  const hash = /typesHash: ([0-9a-f]{16})/.exec(
    await Bun.file(mapCopy).text(),
  )?.[1];
  check("its header records a 16-digit typesHash", hash !== undefined, hash);

  /* ---------------------------------------------------------------- */
  step("A stale file fails --check (exit 1), and writing it back fixes it");

  const stale = join(scratch, "stale.gen.ts");
  await cp(mapCopy, stale);
  await Bun.write(
    stale,
    `${await Bun.file(stale).text()}\n// edited by hand\n`,
  );
  const staleZod = join(scratch, "stale.zod.gen.ts");
  await cp(zodCopy, staleZod);
  const stale1 = await bunClient(...generateArgs(stale, staleZod), "--check");
  checkEqual("--check on a hand-edited file exits 1", stale1.code, 1);
  show("stderr", stale1.stderr.trim());
  checkEqual(
    "it wrote nothing",
    (await Bun.file(stale).text()).endsWith("// edited by hand\n"),
    true,
  );
  checkEqual(
    "regenerating exits 0",
    (await bunClient(...generateArgs(stale, staleZod))).code,
    0,
  );
  checkEqual(
    "and --check is then 0",
    (await bunClient(...generateArgs(stale, staleZod), "--check")).code,
    0,
  );

  /* ---------------------------------------------------------------- */
  step("The same calls, typed from the generated map");

  const state = createApi();
  const adapter = new BunHttpAdapter(0, { logger: noopLogger });
  adapter.use(state.users.mount, state.users.router);
  const server = await adapter.listen(0);
  const base = `http://127.0.0.1:${server.port}`;

  try {
    /** What the client's logger was told. */
    const warnings: unknown[][] = [];
    /** Answers a 418 for one id, as a proxy might; a drifted body for another; the rest to the server. */
    const fetching = async (request: Request): Promise<Response> => {
      const { pathname } = new URL(request.url);
      if (pathname === "/users/teapot")
        return new Response("short and stout", { status: 418 });
      if (pathname === "/users/drift")
        return Response.json({ id: 7, name: "Drift" });
      return fetch(request);
    };
    const client = createClient<Routes>({
      baseUrl: base,
      manifest,
      fetch: fetching,
      // The built-in schemas, loaded on first use: the generated zod module.
      schemas: () => import("./helpers/api.zod.gen"),
      logger: {
        debug: () => undefined,
        error: () => undefined,
        warn: (...args) => void warnings.push(args),
      },
    });

    // The route map is the generator's: the operationId names a call.
    const byId = await client.op.getUser({ params: { id: "1" } });
    checkEqual(
      "api.op.getUser() is GET /users/:id",
      byId.ok && byId.data.name,
      "Ada",
    );

    const gone = await client.op.getUser({ params: { id: "99" } });
    if (!gone.ok && gone.status === 404) {
      // `x-bun-errors` narrowed `code` to the literal the route declares.
      const code: "NOT_FOUND" = gone.error.code;
      checkEqual(
        "a 404's error.code is the literal NOT_FOUND",
        code,
        "NOT_FOUND",
      );
    } else {
      check("a 404 result", false, gone);
    }

    /* -------------------------------------------------------------- */
    step("A status the route does not declare");

    const teapot = await checkRejects(
      "a 418 is not a declared status",
      () => client.get("/users/:id", { params: { id: "teapot" } }),
      { name: "UnexpectedStatusError" },
    );
    check(
      "it is an UnexpectedStatusError",
      teapot instanceof UnexpectedStatusError,
      teapot,
    );
    if (teapot instanceof UnexpectedStatusError) {
      checkEqual("naming the declared statuses", teapot.declared, [200, 404]);
    }

    /* -------------------------------------------------------------- */
    step("Validation on the client: before sending, and on arrival");

    const sent = state.state.hits.length;
    const refused = await checkRejects(
      "a malformed email never leaves the client",
      () =>
        client.post("/users/", {
          body: { name: "Mallory", email: "not-an-email" },
        }),
      { name: "ValidationError" },
    );
    if (refused instanceof ValidationError) {
      show("issues", refused.issues);
      checkEqual(
        "the issue is on the body's email",
        refused.issues[0]?.path,
        "email",
      );
      checkEqual("direction", refused.direction, "request");
    }
    checkEqual("the server saw no request", state.state.hits.length, sent);

    const drifted = await client.get("/users/:id", { params: { id: "drift" } });
    check(
      "a drifted response is still delivered (the default is to warn)",
      drifted.ok,
      drifted,
    );
    check("and the logger was told", warnings.length === 1, warnings);

    /* -------------------------------------------------------------- */
    step("The type-level half");

    const refusedByTypes = async (): Promise<void> => {
      // @ts-expect-error -- no operation by that name in the generated map
      await client.op.getUsers({ params: { id: "1" } });
      const r = await client.op.getUser({ params: { id: "1" } });
      // @ts-expect-error -- GET /users/:id declares 200 and 404 only
      if (!r.ok && r.status === 409) void r;
      // @ts-expect-error -- the 404's code is the literal NOT_FOUND, never CONFLICT
      if (!r.ok && r.status === 404 && r.error.code === "CONFLICT") void r;
    };
    void refusedByTypes;
    show("three refusals at compile time (see the source)");
  } finally {
    await adapter.close();
  }
} finally {
  await rm(scratch, { recursive: true, force: true });
}

summary();
