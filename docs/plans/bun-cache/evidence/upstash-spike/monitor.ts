// Counts the commands the server executes while it runs, over a raw TLS socket in MONITOR mode.
// Prints a per-command tally on SIGTERM/SIGINT or after argv[2] seconds. Never prints the URL or arguments.
const raw = process.env.BUN_CACHE_TEST_UPSTASH_REDIS_URL ?? process.env.REDIS_PROBE_URL!;
const u = new URL(raw);
const seconds = Number(process.argv[2] ?? 30);
const out = process.argv[3];
function hello(): string {
  const user = decodeURIComponent(u.username || "default");
  const pass = decodeURIComponent(u.password);
  const cmd = (...parts: string[]) =>
    `*${parts.length}\r\n${parts.map((p) => `$${Buffer.byteLength(p)}\r\n${p}\r\n`).join("")}`;
  return cmd("AUTH", user, pass) + cmd("MONITOR");
}
const tally = new Map<string, number>();
let total = 0;
let segment: string | undefined;
const segments = new Map<string, string[]>();
let buffered = "";
let ready = false;
const socket = await Bun.connect({
  hostname: u.hostname,
  port: Number(u.port || 6379),
  tls: u.protocol === "rediss:" ? { serverName: u.hostname } : undefined,
  socket: {
    open(s) {
      s.write(hello());
    },
    error(_s, e) { console.error("sock error", String(e)); },
    close() { if (process.env.MON_DEBUG) console.error("closed"); },
    data(_s, data) {
      if (process.env.MON_DEBUG) console.error("recv:", JSON.stringify(data.toString().slice(0, 80)));
      buffered += data.toString();
      let nl: number;
      while ((nl = buffered.indexOf("\r\n")) !== -1) {
        const line = buffered.slice(0, nl);
        buffered = buffered.slice(nl + 2);
        if (line === "+OK") {
          ready = true;
          continue;
        }
        if (line.startsWith("-")) {
          console.error("monitor error:", line.slice(0, 120));
          continue;
        }
        // +<ts> [<db> <addr>] "CMD" "arg" ...
        const em = /"ECHO" "@@([^"]*)"/i.exec(line);
        if (em) {
          segment = em[1];
          segments.set(segment, []);
          continue;
        }
        const m = /^\+\d+\.\d+ \[[^\]]*\] "([^"]+)"/.exec(line);
        if (m && segment !== undefined) segments.get(segment)!.push(m[1].toUpperCase());
        if (m) {
          const name = m[1].toUpperCase();
          tally.set(name, (tally.get(name) ?? 0) + 1);
          total++;
        }
      }
    },
  },
});

const report = async () => {
  const seg = [...segments].filter(([k]) => k !== "end").map(([k, v]) => `  ${k}: ${v.length} [${v.join(" ")}]`);
  const lines = [...seg, `total ${total}`, ...[...tally].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`)];
  if (out) await Bun.write(out, lines.join("\n") + "\n");
  console.log(lines.join("\n"));
  socket.end();
  process.exit(0);
};
process.on("SIGTERM", report);
process.on("SIGINT", report);
setTimeout(report, seconds * 1000);
setTimeout(() => console.error("monitor ready:", ready), 3000);
