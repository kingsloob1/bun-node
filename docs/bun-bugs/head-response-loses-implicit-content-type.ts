/**
 * Bun.serve: a HEAD response built without headers loses the implicit
 * Content-Type that the same response gets for GET.
 *
 *   bun docs/bun-bugs/head-response-loses-implicit-content-type.ts
 *
 * Prints the raw response head for GET and HEAD, for a string body built
 * three ways. Exits 1 while the bug is present (so it can gate a workaround
 * removal), 0 once GET and HEAD agree.
 */
import net from "node:net";
import process from "node:process";

const bodies: Record<string, () => Response> = {
  "new Response(string)": () => new Response("hello"),
  "new Response(string, { status: 201 })": () =>
    new Response("hello", { status: 201 }),
  "explicit Content-Type (control)": () =>
    new Response("hello", { headers: { "content-type": "text/plain" } }),
};

const server = Bun.serve({
  port: 0,
  fetch(request) {
    const make = bodies[decodeURIComponent(new URL(request.url).pathname.slice(1))];
    return make ? make() : new Response("not found", { status: 404 });
  },
});

/** The response head of one raw request, lower-cased header names. */
function head(method: string, path: string): Promise<Record<string, string>> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(server.port!, "127.0.0.1");
    let data = "";
    socket.on("data", (chunk) => {
      data += chunk;
    });
    socket.on("error", reject);
    socket.on("end", () => {
      const [statusLine, ...lines] = data.split("\r\n\r\n")[0].split("\r\n");
      const headers: Record<string, string> = { status: statusLine };
      for (const line of lines) {
        const colon = line.indexOf(":");
        headers[line.slice(0, colon).toLowerCase()] = line.slice(colon + 1).trim();
      }
      resolve(headers);
    });
    socket.write(`${method} ${path} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`);
  });
}

console.log(`Bun ${Bun.version} (${Bun.revision})\n`);
let mismatches = 0;
for (const name of Object.keys(bodies)) {
  const path = `/${encodeURIComponent(name)}`;
  const get = await head("GET", path);
  const headResponse = await head("HEAD", path);
  const same = get["content-type"] === headResponse["content-type"];
  if (!same) mismatches++;
  console.log(`${same ? "same" : "DIFF"}  ${name}`);
  console.log(`      GET  content-type: ${get["content-type"] ?? "(none)"}`);
  console.log(`      HEAD content-type: ${headResponse["content-type"] ?? "(none)"}`);
}
server.stop(true);
console.log(`\n${mismatches} case(s) where HEAD and GET disagree`);
process.exit(mismatches ? 1 : 0);
