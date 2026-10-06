import { parseMultipart as parseMultipartMjackson } from "@mjackson/multipart-parser";
import { parseMultipart } from "@remix-run/multipart-parser";
import busboy from "busboy";
const B = "ProbeBoundary";
const part = (disp: string, value: string, extra = "") => `--${B}\r\nContent-Disposition: ${disp}\r\n${extra}\r\n${value}\r\n`;
const end = `--${B}--\r\n`;
const cases: [string, string][] = [
  ["UTF-8 field name (raw)", part('form-data; name="café"', "1") + end],
  ["RFC 5987 filename*", part(`form-data; name="f"; filename*=UTF-8''na%C3%AFve.txt`, "hi", "Content-Type: text/plain\r\n") + end],
  ["path in filename", part('form-data; name="f"; filename="C:\\\\dir\\\\x.txt"', "hi", "Content-Type: text/plain\r\n") + end],
  ["no filename, octet-stream type", part('form-data; name="f"', "hi", "Content-Type: application/octet-stream\r\n") + end],
  ["field with charset=latin1", part('form-data; name="a"', "\xe9", "Content-Type: text/plain; charset=latin1\r\n") + end],
  ["file with no Content-Type", part('form-data; name="f"; filename="x.bin"', "hi") + end],
  ["empty filename", part('form-data; name="f"; filename=""', "", "Content-Type: application/octet-stream\r\n") + end],
  ["missing closing boundary", part('form-data; name="a"', "1")],
  ["part with no headers", `--${B}\r\n\r\nvalue\r\n` + end],
];
for (const [name, raw] of cases) {
  const body = Buffer.from(raw, name.includes("charset") ? "latin1" : "utf8");
  let remix: string;
  try {
    remix = [...parseMultipart(body, { boundary: B })].map((p) => `${p.isFile ? "file" : "field"} name=${JSON.stringify(p.name)} filename=${JSON.stringify(p.filename)} type=${p.mediaType} value=${JSON.stringify(p.isFile ? Buffer.from(p.bytes).toString("latin1") : p.text)}`).join(" | ") || "(nothing)";
  } catch (e) { remix = `THROWS ${(e as Error).message}`; }
  let mjackson: string;
  try {
    mjackson = [...parseMultipartMjackson(body, { boundary: B })].map((p) => `${p.isFile ? "file" : "field"} name=${JSON.stringify(p.name)} filename=${JSON.stringify(p.filename)} type=${p.mediaType} value=${JSON.stringify(p.isFile ? Buffer.from(p.bytes).toString("latin1") : p.text)}`).join(" | ") || "(nothing)";
  } catch (e) { mjackson = `THROWS ${(e as Error).message}`; }
  const bb = await new Promise<string>((res) => {
    const out: string[] = []; const b = busboy({ headers: { "content-type": `multipart/form-data; boundary=${B}` } });
    b.on("field", (n, v, i) => out.push(`field name=${JSON.stringify(n)} type=${i.mimeType} value=${JSON.stringify(v)}`));
    b.on("file", (n, s, i) => { out.push(`file name=${JSON.stringify(n)} filename=${JSON.stringify(i.filename)} type=${i.mimeType}`); s.resume(); });
    b.on("close", () => res(out.join(" | ") || "(nothing)")); b.on("error", (e) => res(`ERROR ${e.message}`)); b.end(body);
  });
  console.log(`### ${name}\n  busboy:   ${bb}\n  remix:    ${remix}\n  mjackson: ${mjackson}`);
}
