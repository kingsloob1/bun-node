/**
 * Request headers and cookies on TODAY's bun-common (unpatched), to decide
 * the write-back question with measurements (README, "Request headers" and
 * "Request cookies"). Runs against the workspace package:
 *
 *   bun request-parts.probe.ts        (from this directory)
 *
 * Q1-* cookies: how they are parsed and stored, signed ones too, and what a
 *               `cookies` schema can and cannot tell about signing.
 * Q2-* headers: what `req.headers` is, who reads it later, and what breaks
 *               when it is replaced by a schema's parsed output (option c),
 *               merged (c'), or kept and copied aside (b).
 */
import type { BunRequest, RouterHandler } from "@kingsleyweb/bun-common";
import { BunRouter, signCookie, typeIs } from "@kingsleyweb/bun-common";
import busboy from "busboy";
import { z } from "zod";

const out: string[] = [];
const log = (line: string) => out.push(line);
const j = (v: unknown) => JSON.stringify(v);

/* ------------------------------------------------------------------ Q1 */
const SECRET = "k1";
const signedSession = `s:${signCookie("alice", SECRET)}`;
const tampered = `s:alice.${"A".repeat(43)}`;

async function cookieCase(label: string, cookieHeader: string, handler: (req: BunRequest) => unknown) {
  const r = new BunRouter();
  r.get(
    "/c",
    (req, _res, next) => {
      // What the `parseCookies: { secret }` request option does, per request.
      req.parseCookies({ forceUpdateRequest: true, secret: SECRET });
      next();
    },
    (req, res) => res.json({ v: handler(req) ?? null }),
  );
  const resp = await r.fetch("/c", { headers: { cookie: cookieHeader } });
  log(`${label} => ${resp.status} ${await resp.text()}`);
}

await cookieCase("Q1a storage: plain, j: JSON, signed, tampered", `plain=1; obj=j:${encodeURIComponent('{"x":1}')}; sid=${encodeURIComponent(signedSession)}; bad=${encodeURIComponent(tampered)}`, (req) => ({
  cookies: req.cookies,
  signedCookies: req.signedCookies,
}));
await cookieCase("Q1b forged UNSIGNED sid lands in req.cookies", "sid=alice", (req) => ({ cookies: req.cookies, signedCookies: req.signedCookies }));

{
  // A `cookies` schema cannot require a signature: the forged unsigned value
  // passes it. A `signedCookies` schema can: absent (forged) and `false`
  // (tampered) both fail it.
  const SidSchema = z.object({ sid: z.string() });
  const check = (label: string, header: string, part: "cookies" | "signedCookies") =>
    cookieCase(label, header, (req) => {
      const r = SidSchema.safeParse(part === "cookies" ? req.cookies : req.signedCookies);
      return r.success ? `passes ${part} schema: ${j(r.data)}` : `fails ${part} schema: ${r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`;
    });
  await check("Q1c forged sid=alice vs a cookies schema", "sid=alice", "cookies");
  await check("Q1d forged sid=alice vs a signedCookies schema", "sid=alice", "signedCookies");
  await check("Q1e tampered s: sid vs a signedCookies schema", `sid=${encodeURIComponent(tampered)}`, "signedCookies");
  await check("Q1f genuine signed sid vs a signedCookies schema", `sid=${encodeURIComponent(signedSession)}`, "signedCookies");
}

{
  // Write-back: the setter exists and survives; what a later layer reads.
  const r = new BunRouter();
  r.get(
    "/w",
    (req, _res, next) => {
      const parsed = z.object({ n: z.coerce.number() }).parse(req.cookies); // strips `other`
      req.cookies = parsed as never;
      next();
    },
    (req, res) => res.json({ cookies: req.cookies, typeofN: typeof req.cookies.n, other: req.cookies.other ?? "(gone)" }),
  );
  const resp = await r.fetch("/w", { headers: { cookie: "n=5; other=x" } });
  log(`Q1g write-back req.cookies = parsed (zod strips) => ${resp.status} ${await resp.text()}`);
}

/* ------------------------------------------------------------------ Q2 */
{
  const r = new BunRouter();
  r.get("/h", (req, res) => {
    const a = req.headers;
    const b = req.headers;
    const same = a === b;
    req.setHeader("x-added", "1");
    const afterSet = req.headers;
    res.json({
      kind: Object.prototype.toString.call(a),
      keys: Object.keys(a),
      setCookieIsArray: Array.isArray(a["set-cookie"]),
      cachedIdentity: same,
      rebuiltAfterSetHeader: afterSet !== a,
      xAdded: afterSet["x-added"],
    });
  });
  const resp = await r.fetch("/h", { headers: { "X-N": "5", Accept: "application/json", "Set-Cookie": "a=1" } });
  log(`Q2a what req.headers is => ${await resp.text()}`);
}

// One request, three header strategies, the same follow-on reads.
const HeaderSchema = z.object({ "x-n": z.coerce.number() }); // zod's default: unknown keys stripped
type Strategy = "none" | "c-replace" | "c-merge" | "b-copy";
async function headerCase(strategy: Strategy) {
  const r = new BunRouter();
  const replaceHeaders: RouterHandler = (req, _res, next) => {
    const parsed = HeaderSchema.parse(req.headers);
    if (strategy === "c-replace") req.headers = parsed as never;
    if (strategy === "c-merge") req.headers = { ...req.headers, ...parsed } as never;
    if (strategy === "b-copy") (req as unknown as { valid: unknown }).valid = { headers: parsed };
    next();
  };
  r.post("/h", replaceHeaders, async (req, res) => {
    const reads: Record<string, unknown> = {};
    const tryRead = async (name: string, fn: () => unknown) => {
      try {
        reads[name] = await fn();
      } catch (error) {
        reads[name] = `THROWS ${(error as Error).message.slice(0, 60)}`;
      }
    };
    await tryRead("x-n", () => `${typeof req.headers["x-n"]} ${j(req.headers["x-n"])}`);
    await tryRead("req.get(content-type)", () => req.get("content-type"));
    await tryRead("req.is(multipart)", () => req.is("multipart"));
    await tryRead("req.hasBody", () => req.hasBody);
    await tryRead("typeIs.hasBody(req)", () => typeIs.hasBody(req as never));
    await tryRead("req.accepts(json)", () => req.accepts("json"));
    await tryRead("req.rawHeaders.length", () => req.rawHeaders.length);
    await tryRead("headersDistinct[x-n]", () => j(req.headersDistinct["x-n"]));
    // What BunRequest's multipart parser hands busboy for an unbuffered body
    // (BunRequest.ts: `busboy({ ...busBoyOpts, headers: this.headers })`).
    await tryRead("busboy({ headers: req.headers })", () => (busboy({ headers: req.headers as never }), "constructs"));
    req.setHeader("x-later", "1");
    await tryRead("x-n after req.setHeader", () => `${typeof req.headers["x-n"]} ${j(req.headers["x-n"])}`);
    await tryRead("req.valid.headers[x-n]", () => j((req as unknown as { valid?: { headers: { "x-n": number } } }).valid?.headers["x-n"]));
    res.json(reads);
  });
  const body = "--b\r\nContent-Disposition: form-data; name=\"field\"\r\n\r\nv\r\n--b--\r\n";
  const resp = await r.fetch("/h", {
    method: "POST",
    body,
    // Accept: text/html, so a stripped Accept (anything acceptable) shows as a wrong "json".
    headers: { "X-N": "5", Accept: "text/html", "Content-Type": "multipart/form-data; boundary=b", "Content-Length": String(body.length) },
  });
  log(`Q2-${strategy.padEnd(9)} => ${resp.status} ${await resp.text()}`);
}
for (const s of ["none", "c-replace", "c-merge", "b-copy"] as const) await headerCase(s);

{
  // Case: names arrive lower-cased, so a schema keyed "X-N" never matches.
  const r = new BunRouter();
  r.get("/case", (req, res) => {
    const upper = z.object({ "X-N": z.string() }).safeParse(req.headers);
    const lower = z.object({ "x-n": z.string() }).safeParse(req.headers);
    res.json({ upperKeyedSchema: upper.success ? "passes" : `fails: ${upper.error.issues[0]?.message}`, lowerKeyedSchema: lower.success ? "passes" : "fails" });
  });
  log(`Q2e header case => ${await (await r.fetch("/case", { headers: { "X-N": "5" } })).text()}`);
}

console.log(`# bun ${Bun.version} (${Bun.revision.slice(0, 9)}), unpatched workspace bun-common\n${out.join("\n")}`);
