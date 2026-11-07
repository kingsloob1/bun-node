/**
 * A Nest controller app on `BunHttpAdapter` and the typed client generated
 * from it — `@Validate` and `@Describe` on the controller become the OpenAPI
 * document, `bun-client generate` turns that into a route map, and the same
 * calls are typed from it. Each step is asserted.
 *
 * ```bash
 * bun 12-typed-client/controller-client.ts   # from examples/bun-nest
 * bun run gen:client                         # rewrite helpers/api.gen.ts and api.zod.gen.ts
 * bun run check:client                       # the same with --check
 * ```
 *
 * - **The contract is the controller.** `helpers/app.ts` has no OpenAPI
 *   annotation beyond `@Validate({ params, body, responses })` and
 *   `@Describe({ operationId, errors, cache })`. `generateOpenApi(adapter.instance)`
 *   reads that metadata (it is reflect metadata, which Nest copies onto the
 *   handler it registers), and `bun-client generate --module` reads the
 *   document: the app is booted without listening and closed again.
 * - **A Nest backend and a router backend give a frontend the same client.**
 *   The generated map has `api.op.getUser`, and a 404's `error.code` is the
 *   literal `"NOT_FOUND"` that `errors: ["NOT_FOUND"]` declared.
 * - **Validation on the client** is the generated zod module as the client's
 *   `schemas`: a body the controller's own `@Validate` would refuse is
 *   refused before it is sent.
 * - Run it from `examples/bun-nest`: Bun reads the decorator options from the
 *   working directory's `tsconfig.json` (oven-sh/bun#28605).
 */
import {
  createClient,
  UnexpectedStatusError,
  ValidationError,
} from "@kingsleyweb/bun-client";
import { runCli } from "@kingsleyweb/bun-client/codegen";
import { join } from "node:path";
import { check, checkEqual, checkRejects, summary } from "../shared/check";
import { show, step, title } from "../shared/console";
import { createApp, store } from "./helpers/app";
import { manifest } from "./helpers/api.gen";
import type { Routes } from "./helpers/api.gen";
import "reflect-metadata";

title("A Nest controller app and its generated typed client");

/* ------------------------------------------------------------------ */
step("The committed client is what the controllers generate: --check");

const here = import.meta.dir;
let stderr = "";
const code = await runCli(
  [
    "generate",
    "--module",
    join(here, "helpers/app.ts"),
    "--out",
    join(here, "helpers/api.gen.ts"),
    "--zod",
    join(here, "helpers/api.zod.gen.ts"),
    "--check",
  ],
  {
    cwd: join(here, ".."),
    stdout: () => undefined,
    stderr: (text) => void (stderr += text),
  },
);
checkEqual(
  "--check exits 0 on the route map and zod module beside this file",
  code,
  0,
);
if (code !== 0) show("stderr", stderr);

/* ------------------------------------------------------------------ */
step("The same calls, typed from the generated map");

store.reset();
const { app, adapter } = await createApp();
await app.listen(0);
const api = createClient<Routes>({
  baseUrl: `http://127.0.0.1:${adapter.listeningPort}`,
  manifest,
  // The generated zod module, loaded on first use: the client's built-in checks.
  schemas: () => import("./helpers/api.zod.gen"),
});

try {
  const found = await api.op.getUser({ params: { id: "1" } });
  checkEqual(
    "api.op.getUser() reads a user",
    found.ok && found.data.name,
    "Ada",
  );

  const missing = await api.op.getUser({ params: { id: "99" } });
  if (!missing.ok && missing.status === 404) {
    // Narrowed by the status, and by `errors: ["NOT_FOUND"]` to the literal.
    const codeOfError: "NOT_FOUND" = missing.error.code;
    checkEqual(
      "the 404's error.code is the literal NOT_FOUND",
      codeOfError,
      "NOT_FOUND",
    );
  } else {
    check("a declared 404 is a result", false, missing);
  }

  const created = await api.post("/users", { body: { name: "Linus" } });
  checkEqual(
    "POST /users answers a declared 201",
    [created.ok, created.status],
    [true, 201],
  );
  const renamed = await api.patch("/users/:id", {
    params: { id: "1" },
    body: { name: "Ada Lovelace" },
  });
  checkEqual(
    "PATCH /users/:id renames",
    renamed.ok && renamed.data.name,
    "Ada Lovelace",
  );

  /* ---------------------------------------------------------------- */
  step("Validation: on the client, and again on the server");

  const before = store.hits.length;
  const refused = await checkRejects(
    "an empty name is refused before it is sent",
    () => api.post("/users", { body: { name: "" } }),
    { name: "ValidationError" },
  );
  if (refused instanceof ValidationError) {
    show("issue", refused.issues[0]);
    checkEqual("on the body's name", refused.issues[0]?.path, "name");
  }
  checkEqual("the controller never ran", store.hits.length, before);

  // The server checks the same schema: with the client's checks off, the
  // controller's @Validate answers 400, a status the route does not declare.
  const serverSide = await checkRejects(
    "validate: false sends it; the controller's @Validate refuses it with a 400",
    () => api.post("/users", { body: { name: "" }, validate: false }),
    { name: "UnexpectedStatusError" },
  );
  if (serverSide instanceof UnexpectedStatusError) {
    checkEqual(
      "a status the document does not declare",
      serverSide.status,
      400,
    );
  }
  checkEqual("and the controller still never ran", store.hits.length, before);

  /* ---------------------------------------------------------------- */
  step("The type-level half");

  const refusedByTypes = async (): Promise<void> => {
    // @ts-expect-error -- no such operation in the controller's document
    await api.op.deleteUser({ params: { id: "1" } });
    // @ts-expect-error -- the body is { name: string }
    await api.post("/users", { body: { name: 7 } });
    // @ts-expect-error -- :id is a path param, required
    await api.get("/users/:id", {});
    const r = await api.op.getUser({ params: { id: "1" } });
    // @ts-expect-error -- the 404's code is NOT_FOUND, never GONE
    if (!r.ok && r.status === 404 && r.error.code === "GONE") void r;
  };
  void refusedByTypes;
  show("four refusals at compile time (see the source)");
} finally {
  await app.close();
}

summary();
