// Raw-socket helper: keep one TCP connection, send requests on it, read responses.
import net from "node:net";
export function conn(port: number) {
  const s = net.connect(port, "127.0.0.1");
  let buf = "";
  let closed = false;
  const waiters: Array<() => void> = [];
  s.on("data", (d) => { buf += d.toString(); waiters.splice(0).forEach((w) => w()); });
  s.on("close", () => { closed = true; waiters.splice(0).forEach((w) => w()); });
  s.on("error", () => {});
  const ready = new Promise<void>((r) => s.once("connect", () => r()));
  return {
    ready,
    get closed() { return closed; },
    async request(path: string, timeoutMs = 3000): Promise<string> {
      buf = "";
      if (closed) return "<closed before send>";
      s.write(`GET ${path} HTTP/1.1\r\nHost: x\r\nConnection: keep-alive\r\n\r\n`);
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const m = buf.match(/\r\n\r\n/);
        if (m) {
          const len = Number(/content-length: (\d+)/i.exec(buf)?.[1] ?? NaN);
          const idx = buf.indexOf("\r\n\r\n") + 4;
          if (!Number.isNaN(len) && buf.length - idx >= len) return summarize(buf);
        }
        if (closed) return buf ? summarize(buf) + " <then closed>" : "<closed>";
        await new Promise<void>((r) => { waiters.push(r); setTimeout(r, 20); });
      }
      return "<timeout> " + summarize(buf);
    },
    end() { s.destroy(); },
  };
}
function summarize(b: string) {
  const [head, body] = b.split("\r\n\r\n");
  const status = head.split("\r\n")[0];
  const connection = /\r\nconnection: ([^\r]*)/i.exec(head)?.[1] ?? "-";
  return `${status} | connection=${connection} | body=${JSON.stringify(body)}`;
}
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
