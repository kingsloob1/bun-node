import { connect } from "node:net";
const server = Bun.serve({ port: 0, fetch: (req) => new Response(`${req.method} ${new URL(req.url).pathname} body=${req.headers.get("content-length")}`) });
const raw = await new Promise<string>((resolve, reject) => {
  const s = connect(server.port, "127.0.0.1", () => s.write("QUERY /search HTTP/1.1\r\nHost: x\r\nContent-Type: text/plain\r\nContent-Length: 3\r\nConnection: close\r\n\r\nabc"));
  let out = ""; s.on("data", (d) => (out += d)); s.on("end", () => resolve(out)); s.on("error", reject);
});
console.log(raw.split("\r\n")[0], "|", raw.split("\r\n\r\n")[1]);
const r = await fetch(`http://127.0.0.1:${server.port}/f`, { method: "QUERY", body: "xyz" }).then((r) => r.text()).catch((e) => `fetch error: ${e}`);
console.log("fetch:", r);
server.stop(true);
