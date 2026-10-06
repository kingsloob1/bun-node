/**
 * `new Response(body)` does not put the body's Content-Type into
 * `response.headers`, as the Fetch standard requires ("extract a body":
 * a string is `text/plain;charset=UTF-8`, a URLSearchParams is
 * `application/x-www-form-urlencoded;charset=UTF-8`, a Blob its own type).
 * Bun.serve writes the type on the wire, so a served client sees it, but
 * code reading `response.headers` (a socket-free test, a middleware, a
 * proxy) does not.
 *
 *   bun docs/bun-bugs/response-headers-miss-body-content-type.ts
 *
 * Exits 1 while any case differs from the standard, 0 once none does.
 */
import process from "node:process";

const cases: [string, () => Response, string][] = [
  ["string", () => new Response("hello"), "text/plain;charset=utf-8"],
  [
    "URLSearchParams",
    () => new Response(new URLSearchParams("a=1")),
    "application/x-www-form-urlencoded;charset=utf-8",
  ],
  ["Blob with a type", () => new Response(new Blob(["x"], { type: "text/csv" })), "text/csv"],
  ["Request with a string body", () => new Request("http://x/", { method: "POST", body: "hello" }) as unknown as Response, "text/plain;charset=utf-8"],
  ["Response.json (control)", () => Response.json({ a: 1 }), "application/json;charset=utf-8"],
];

console.log(`Bun ${Bun.version} (${Bun.revision})\n`);
let wrong = 0;
for (const [name, make, expected] of cases) {
  const actual = make().headers.get("content-type");
  const ok = actual?.toLowerCase() === expected;
  if (!ok) wrong++;
  console.log(`${ok ? "ok  " : "DIFF"}  ${name}: ${actual ?? "(none)"}  (standard: ${expected})`);
}
console.log(`\n${wrong} case(s) differ from the Fetch standard`);
process.exit(wrong ? 1 : 0);
