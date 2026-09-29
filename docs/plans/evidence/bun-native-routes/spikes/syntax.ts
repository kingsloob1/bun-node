/**
 * Which route keys `Bun.serve({ routes })` accepts at all. Each key gets a
 * server of its own, so a rejection names exactly one key.
 *
 *   bun docs/plans/evidence/bun-native-routes/spikes/syntax.ts
 */
const keys = [
  "/plain",
  "/:a",
  "/x/:a/:b/:c/:d/:e/:f/:g/:h/:i/:j/:k/:l/:m/:n/:o/:p/:q",
  "/two/:a/:a",
  "/opt/:a?",
  "/re/:id(\\d+)",
  "/star/*",
  "/named/*rest",
  "/braced/{*rest}",
  "/mid/*/end",
  "/mid/:a-:b",
  "/dot/:file.json",
  "/café",
  "/caf%C3%A9",
  "noslash",
  "",
  "/",
  "*",
  "/*",
  "/sp ace",
  "/q?x=1",
  "/(group)",
  "/{opt}",
  "/a//b",
  "/:",
];
console.log(`Bun ${Bun.version} (${Bun.revision})\n`);
for (const key of keys) {
  let server: Bun.Server<undefined> | undefined;
  try {
    server = Bun.serve({ port: 0, routes: { [key]: () => new Response("ok") }, fetch: () => new Response("fetch") });
    console.log(`${JSON.stringify(key).padEnd(60)} accepted`);
  } catch (error) {
    console.log(`${JSON.stringify(key).padEnd(60)} REJECTED ${(error as Error).message.split("\n")[0]}`);
  } finally {
    server?.stop(true);
  }
}
