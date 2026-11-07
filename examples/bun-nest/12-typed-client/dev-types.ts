/**
 * `DevTypesModule` — the dev type sync. It serves the app's own OpenAPI and
 * AsyncAPI documents, with their hash, to `bun-client generate --url` and
 * `bun-client watch`, and writes a token file those commands find the server
 * through. Each behaviour is asserted.
 *
 * ```bash
 * bun 12-typed-client/dev-types.ts   # from examples/bun-nest
 * ```
 *
 * In development, mount it and leave the watcher beside the app:
 *
 * ```bash
 * bun --watch src/main.ts                       # the app, on BunHttpAdapter
 * bunx bun-client watch --out src/api.gen.ts    # regenerates on every change
 * ```
 *
 * - **Fail closed.** `enabled` must be exactly `true`; the module throws under
 *   `NODE_ENV=production`; every request needs the bearer token and a
 *   loopback peer, or gets the app's own 404. It is mounted on the adapter, below
 *   Nest's pipeline, so no guard or filter of the app decides who reaches it.
 * - **The documents are the app's**: controllers through
 *   `generateOpenApi(adapter.instance)`, gateways through `gatewayAsyncApi`.
 *   The hash is the `ETag`, and `If-None-Match` is answered `304`.
 * - **The token file** is written when `app.listen()` binds and removed by
 *   `app.close()`. Here it goes to a temporary directory (`tokenFile`'s
 *   `<port>` template); by default it is
 *   `node_modules/.cache/bun-types/<port>.json` under the working directory.
 * - **`generate --url` gives the same module as `generate --module`**: the
 *   committed `helpers/api.gen.ts` is byte for byte what the running app's
 *   endpoint produces. `watch` follows the same endpoint and rewrites the
 *   file when the hash changes; it runs until a signal, so it is not started
 *   here (the playground's smoke check and bun-nest's own suite cover it).
 */
import { runCli } from "@kingsleyweb/bun-client/codegen";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { check, checkEqual, summary } from "../shared/check";
import { show, step, title } from "../shared/console";
import { createApp, store } from "./helpers/app";
import "reflect-metadata";

title("DevTypesModule: the dev type sync");

store.reset();
const dir = await mkdtemp(join(tmpdir(), "nest-dev-types-"));
const info = { title: "Users", version: "1.0.0" };
const { app, adapter } = await createApp({
  devTypes: {
    enabled: true,
    tokenFile: join(dir, "<port>.json"),
    openapi: info,
    asyncapi: info,
  },
});
await app.listen(0);
const port = Number(adapter.listeningPort);
const endpoint = `http://127.0.0.1:${port}/__bun/types`;
const tokenFile = join(dir, `${port}.json`);

try {
  /* ---------------------------------------------------------------- */
  step("The token file, and a request without the token");

  check(
    "the token file was written when the app bound its port",
    existsSync(tokenFile),
  );
  const { token, url } = JSON.parse(await readFile(tokenFile, "utf8")) as {
    token: string;
    url: string;
  };
  show("token file", { url, token: `${token.slice(0, 4)}…` });

  const anonymous = await fetch(endpoint);
  checkEqual("without the token: the app's own 404", anonymous.status, 404);

  /* ---------------------------------------------------------------- */
  step("The documents, their hash and the 304");

  const authorized = { headers: { authorization: `Bearer ${token}` } };
  const served = await fetch(endpoint, authorized);
  const body = (await served.json()) as {
    hash: string;
    openapi: { paths: object };
    asyncapi: { channels: object };
  };
  checkEqual("with the token: 200", served.status, 200);
  const etag = served.headers.get("etag");
  show("hash", body.hash);
  check(
    "the ETag is the hash",
    etag !== null && etag.includes(body.hash),
    etag,
  );
  checkEqual(
    "the OpenAPI document lists the controllers' routes",
    Object.keys(body.openapi.paths).sort(),
    ["/users", "/users/{id}"],
  );
  checkEqual(
    "and the AsyncAPI document the gateway's channel",
    Object.keys(body.asyncapi.channels),
    ["chat"],
  );

  const again = await fetch(endpoint, {
    headers: { ...authorized.headers, "if-none-match": etag ?? "" },
  });
  checkEqual("If-None-Match answers 304", again.status, 304);

  /* ---------------------------------------------------------------- */
  step("generate --url gives the committed client, byte for byte");

  let stderr = "";
  const out = join(dir, "api.gen.ts");
  const zod = join(dir, "api.zod.gen.ts");
  const code = await runCli(
    [
      "generate",
      "--url",
      endpoint,
      "--token-file",
      dir,
      "--out",
      out,
      "--zod",
      zod,
    ],
    {
      cwd: dir,
      stdout: () => undefined,
      stderr: (text) => void (stderr += text),
    },
  );
  checkEqual("generate --url exits 0", code, 0);
  if (code !== 0) show("stderr", stderr);
  const committed = await Bun.file(
    join(import.meta.dir, "helpers/api.gen.ts"),
  ).text();
  check(
    "the route map equals helpers/api.gen.ts",
    (await Bun.file(out).text()) === committed,
  );
  const committedZod = await Bun.file(
    join(import.meta.dir, "helpers/api.zod.gen.ts"),
  ).text();
  check(
    "and the zod module equals helpers/api.zod.gen.ts",
    (await Bun.file(zod).text()) === committedZod,
  );
  check(
    "the header's typesHash is the endpoint's hash",
    (await Bun.file(out).text()).includes(`typesHash: ${body.hash}`),
  );
} finally {
  await app.close();
}

check("the token file is removed by app.close()", !existsSync(tokenFile));
await rm(dir, { recursive: true, force: true });

summary();
