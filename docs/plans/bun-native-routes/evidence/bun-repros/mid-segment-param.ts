/**
 * Minimal reproduction (no dependencies): a key with a `:` in the middle of a
 * segment is accepted, matched as ONE whole-segment param, and reported under
 * the name after the last `:`. Neither behaviour is documented; a rejection
 * (like the one for duplicate names) would be safer. Related feature request:
 * oven-sh/bun#41363.
 *
 *   bun mid-segment-param.ts
 *
 * Expected: `/mid/:a-:b` rejected at Bun.serve(), or params { a: "1", b: "2" }.
 * Actual (Bun 1.4.3-canary.1+5f554969b, linux x64): params { b: "1-2" }.
 */
const server = Bun.serve({
  port: 0,
  routes: { "/mid/:a-:b": (req) => Response.json(req.params) },
  fetch: () => new Response("fetch"),
});
console.log(`Bun ${Bun.version} (${Bun.revision}) ${process.platform} ${process.arch}`);
console.log(`GET /mid/1-2 -> ${await (await fetch(`${server.url}mid/1-2`)).text()}`);
server.stop(true);
