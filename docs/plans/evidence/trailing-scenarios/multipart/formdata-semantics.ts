// What each parser answers for the same raw multipart bytes.
import busboy from "busboy";
type Part = string;
const B = "ProbeBoundary";
const ct = (b = B) => `multipart/form-data; boundary=${b}`;
const part = (disp: string, value: string, extra = "") =>
  `--${B}\r\nContent-Disposition: ${disp}\r\n${extra}\r\n${value}\r\n`;
const end = `--${B}--\r\n`;
function viaBusboy(body: Buffer, contentType: string, opts: Record<string, unknown> = {}) {
  return new Promise<Part[]>((resolve) => {
    const out: Part[] = [];
    let bb;
    try { bb = busboy({ headers: { "content-type": contentType }, ...opts }); }
    catch (e) { resolve([`THROWS ${(e as Error).message}`]); return; }
    const pending: Promise<void>[] = [];
    bb.on("field", (n, v, info) => out.push(`field ${JSON.stringify(n)}=${JSON.stringify(v)} (${info.mimeType})`));
    bb.on("file", (n, s, info) => pending.push(new Promise((r) => {
      const c: Buffer[] = []; s.on("data", (d: Buffer) => c.push(d));
      s.on("end", () => { out.push(`file ${JSON.stringify(n)} name=${JSON.stringify(info.filename)} type=${info.mimeType} enc=${info.encoding} bytes=${JSON.stringify(Buffer.concat(c).toString("latin1"))}`); r(); });
    })));
    bb.on("close", async () => { await Promise.all(pending); resolve(out); });
    bb.on("error", (e) => { out.push(`ERROR ${(e as Error).message}`); resolve(out); });
    bb.end(body);
  });
}
async function viaFormData(body: Buffer, contentType: string) {
  try {
    const fd = await new Response(body, { headers: { "content-type": contentType } }).formData();
    const out: Part[] = [];
    for (const [n, v] of fd) {
      if (typeof v === "string") out.push(`field ${JSON.stringify(n)}=${JSON.stringify(v)}`);
      else out.push(`file ${JSON.stringify(n)} name=${JSON.stringify(v.name)} type=${v.type || '""'} bytes=${JSON.stringify(Buffer.from(await v.arrayBuffer()).toString("latin1"))}`);
    }
    return out;
  } catch (e) { return [`THROWS ${(e as Error).name}: ${(e as Error).message}`]; }
}
const cases: [string, string | Buffer, string?][] = [
  ["plain field and file", part('form-data; name="a"', "1") + part('form-data; name="f"; filename="x.txt"', "hi", "Content-Type: text/plain\r\n") + end],
  ["UTF-8 field name (raw bytes, as browsers send)", part('form-data; name="café"', "1") + end],
  ["UTF-8 filename (raw bytes)", part('form-data; name="f"; filename="naïve.txt"', "hi", "Content-Type: text/plain\r\n") + end],
  ["RFC 5987 filename*", part(`form-data; name="f"; filename*=UTF-8''na%C3%AFve.txt`, "hi", "Content-Type: text/plain\r\n") + end],
  ["value with a bare LF and CRLF", part('form-data; name="a"', "x\ny\r\nz") + end],
  ["file with no Content-Type", part('form-data; name="f"; filename="x.bin"', "hi") + end],
  ["empty filename (an empty file input)", part('form-data; name="f"; filename=""', "", "Content-Type: application/octet-stream\r\n") + end],
  ["no filename but a file Content-Type", part('form-data; name="f"', "hi", "Content-Type: application/octet-stream\r\n") + end],
  ["field with a charset", part('form-data; name="a"', "\xe9", "Content-Type: text/plain; charset=latin1\r\n") + end],
  ["repeated names, in order", part('form-data; name="a"', "1") + part('form-data; name="b"', "2") + part('form-data; name="a"', "3") + end],
  ["path in filename", part('form-data; name="f"; filename="C:\\\\dir\\\\x.txt"', "hi", "Content-Type: text/plain\r\n") + end],
  ["preamble and epilogue", "preamble\r\n" + part('form-data; name="a"', "1") + end + "epilogue"],
  ["missing closing boundary", part('form-data; name="a"', "1")],
  ["body with no parts", end],
  ["part with no name", part("form-data", "1") + end],
  ["not form-data disposition", part('attachment; name="a"', "1") + end],
  ["Content-Transfer-Encoding: base64", part('form-data; name="f"; filename="x"', "aGk=", "Content-Type: text/plain\r\nContent-Transfer-Encoding: base64\r\n") + end],
  ["quoted boundary", part('form-data; name="a"', "1") + end, `multipart/form-data; boundary="${B}"`],
  ["garbage body", "not multipart at all"],
  ["no boundary parameter", part('form-data; name="a"', "1") + end, "multipart/form-data"],
];
for (const [name, raw, type] of cases) {
  const body = Buffer.isBuffer(raw) ? raw : Buffer.from(raw, name.includes("charset") ? "latin1" : "utf8");
  const a = await viaBusboy(body, type ?? ct());
  const b = await viaFormData(body, type ?? ct());
  console.log(`### ${name}\n  busboy:   ${a.join("\n            ") || "(nothing)"}\n  formData: ${b.join("\n            ") || "(nothing)"}`);
}
console.log("\n### busboy with defParamCharset utf8, UTF-8 names:");
console.log("  ", (await viaBusboy(Buffer.from(part('form-data; name="café"; filename="naïve.txt"', "hi", "Content-Type: text/plain\r\n") + end), ct(), { defParamCharset: "utf8" })).join(" | "));
