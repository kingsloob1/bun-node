// fetch() should send the URL's pathname as the request target, unchanged.
// new URL("http://h//a//b").pathname is "//a//b" (WHATWG URL), and Node's
// fetch (undici) sends "GET //a//b HTTP/1.1". Exits 1 while the bug is present.
import net from "node:net";

const seen = [];
const server = net.createServer((socket) => {
  socket.once("data", (chunk) => {
    seen.push(chunk.toString("latin1").split("\r\n")[0]);
    socket.end("HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
  });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${server.address().port}//a//b?x=1`;

await (await fetch(url)).text();
server.close();

const expected = `GET ${new URL(url).pathname}${new URL(url).search} HTTP/1.1`;
console.log("runtime:      ", typeof Bun !== "undefined" ? `bun ${Bun.version} (${Bun.revision})` : `node ${process.versions.node}`);
console.log("URL pathname: ", new URL(url).pathname);
console.log("expected line:", expected);
console.log("request line: ", seen[0]);
process.exit(seen[0] === expected ? 0 : 1);
