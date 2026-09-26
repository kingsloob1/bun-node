// UDP spike: Bun.udpSocket. Run: bun udp.ts
// Loopback only: no real-network loss, reordering, MTU/fragmentation or NAT behaviour can show here.
const sleep = (n: number) => new Promise(r => setTimeout(r, n));

// 1. basic, connected, sendMany
{
  const got: string[] = [];
  const srv = await Bun.udpSocket({ hostname: "127.0.0.1", port: 0, socket: { data(_s, d, port, addr, flags) { got.push(`${d}<-${addr}:${port} flags=${JSON.stringify(flags)}`); } } });
  const cli = await Bun.udpSocket({ hostname: "127.0.0.1", port: 0 });
  const r1 = cli.send("hello", srv.port, "127.0.0.1");
  const r2 = cli.sendMany(["a", srv.port, "127.0.0.1", "b", srv.port, "127.0.0.1"]);
  const conn = await Bun.udpSocket({ hostname: "127.0.0.1", port: 0, connect: { hostname: "127.0.0.1", port: srv.port } });
  const r3 = conn.send("connected"); const r4 = conn.sendMany(["x", "y"]);
  await sleep(100);
  console.log(`RESULT 1 send->${r1} sendMany(2)->${r2} connected send->${r3} connected sendMany(2)->${r4}; received: ${got.join(" ; ")}`);
  let dns: string;
  try { dns = `returned ${cli.send("x", srv.port, "localhost")}`; } catch (e) { dns = `threw ${(e as Error).message}`; }
  console.log(`RESULT 1 send to hostname "localhost" (no DNS): ${dns}`);
  srv.close(); cli.close(); conn.close();
}

// 2. datagram sizes on IPv4 loopback (lo MTU is 65536; real links are ~1500)
{
  const got: { len: number; trunc: boolean }[] = [];
  const srv = await Bun.udpSocket({ hostname: "127.0.0.1", port: 0, socket: { data(_s, d, _p, _a, f) { got.push({ len: d.byteLength, trunc: f?.truncated }); } } });
  const errs: string[] = [];
  const cli = await Bun.udpSocket({ hostname: "127.0.0.1", port: 0, socket: { error(_s, e) { errs.push(`error arg=${e === undefined ? "undefined" : String((e as any)?.message ?? e)}`); } } });
  const out: string[] = [];
  for (const n of [1200, 1472, 1500, 9000, 16384, 65507, 65508, 70000]) {
    got.length = 0;
    let r: string;
    try { r = String(cli.send(new Uint8Array(n), srv.port, "127.0.0.1")); } catch (e) { r = `threw ${(e as Error).message}`; }
    await sleep(50);
    out.push(`${n}B: send=${r} recv=${got.map(g => `${g.len}${g.trunc ? "(truncated)" : ""}`).join(",") || "none"}`);
  }
  console.log(`RESULT 2 ${out.join(" | ")}${errs.length ? ` ; error handler: ${errs.join(",")}` : ""}`);
  srv.close(); cli.close();
}

// 3. burst: 200k x 1 KiB datagrams with sendMany; receiver-buffer overflow is real loss even on loopback
{
  let received = 0; let maxSeq = -1; let outOfOrder = 0;
  const srv = await Bun.udpSocket({ hostname: "127.0.0.1", port: 0, socket: { data(_s, d) { received++; const seq = new DataView(d.buffer, d.byteOffset).getUint32(0); if (seq < maxSeq) outOfOrder++; else maxSeq = seq; } } });
  let drains = 0;
  const cli = await Bun.udpSocket({ hostname: "127.0.0.1", port: 0, connect: { hostname: "127.0.0.1", port: srv.port }, socket: { drain() { drains++; } } });
  const N = 200_000; const B = 1024; let accepted = 0; let short = 0;
  const t0 = performance.now();
  for (let i = 0; i < N; i += 1000) {
    const batch: Uint8Array[] = [];
    for (let j = i; j < i + 1000; j++) { const b = new Uint8Array(B); new DataView(b.buffer).setUint32(0, j); batch.push(b); }
    const n = cli.sendMany(batch); accepted += n; if (n < batch.length) short++;
    if (i % 20000 === 0) await sleep(0); // give the receiver a turn now and then
  }
  const sendMs = performance.now() - t0;
  await sleep(1000);
  console.log(`RESULT 3 sent ${N} x ${B}B via connected sendMany in ${Math.round(sendMs)}ms: accepted by kernel ${accepted}, short batches ${short}, drains ${drains}; received ${received} (${((1 - received / accepted) * 100).toFixed(1)}% lost in the receive buffer), out-of-order ${outOfOrder}`);
  srv.close(); cli.close();
}

// 4. connected socket to a closed port: does ICMP port-unreachable surface?
{
  const errs: string[] = [];
  const dead = await Bun.udpSocket({ hostname: "127.0.0.1", port: 0 }); const deadPort = dead.port; dead.close();
  const cli = await Bun.udpSocket({ hostname: "127.0.0.1", port: 0, connect: { hostname: "127.0.0.1", port: deadPort }, socket: { error(_s, e) { errs.push(`error arg=${e === undefined ? "undefined" : String((e as any)?.message ?? e)}`); } } });
  const r: unknown[] = [];
  for (let i = 0; i < 3; i++) { try { r.push(cli.send("ping")); } catch (e) { r.push(`threw ${(e as Error).message}`); } await sleep(50); }
  console.log(`RESULT 4 connected send to closed port x3: returns ${JSON.stringify(r)}; error handler: ${JSON.stringify(errs)}`);
  cli.close();
  const un = await Bun.udpSocket({ hostname: "127.0.0.1", port: 0, socket: { error(_s, e) { errs.push(`unconnected: error arg=${e === undefined ? "undefined" : String((e as any)?.message ?? e)}`); } } });
  const r2: unknown[] = [];
  for (let i = 0; i < 3; i++) { try { r2.push(un.send("ping", deadPort, "127.0.0.1")); } catch (e) { r2.push(`threw ${(e as Error).message}`); } await sleep(50); }
  console.log(`RESULT 4 unconnected send to closed port x3: returns ${JSON.stringify(r2)}; error handler: ${JSON.stringify(errs.filter(e => e.startsWith("unconnected")))}`);
  un.close();
}

// 5. DTLS / TLS option on udpSocket?
{
  let r: string;
  try { const s = await Bun.udpSocket({ port: 0, tls: { cert: "x", key: "y" } } as any); r = `accepted (ignored?) keys=${Object.keys(s).join(",")}`; s.close(); } catch (e) { r = `threw ${(e as Error).message}`; }
  console.log(`RESULT 5 Bun.udpSocket({ tls }) -> ${r}`);
}
// 6. burst again, receiver in a separate process (its own event loop), 20k x 1 KiB unpaced, then paced
for (const paced of [false, true]) {
  const child = Bun.spawn(["bun", "-e", `
    let n = 0; const s = await Bun.udpSocket({ hostname: "127.0.0.1", port: 0, socket: { data() { n++; } } });
    console.log(s.port); setTimeout(() => { console.log(n); process.exit(0); }, 2500);
  `], { stdout: "pipe" });
  const rd = child.stdout.getReader(); const dec = new TextDecoder();
  const port = Number(dec.decode((await rd.read()).value).trim());
  const cli = await Bun.udpSocket({ hostname: "127.0.0.1", port: 0, connect: { hostname: "127.0.0.1", port } });
  const N = 20_000; let accepted = 0;
  for (let i = 0; i < N; i += 100) {
    accepted += cli.sendMany(Array.from({ length: 100 }, () => new Uint8Array(1024)));
    if (paced) await sleep(1); // ~100 datagrams per ms-ish tick
  }
  let text = ""; for (;;) { const { value, done } = await rd.read(); if (done) break; text += dec.decode(value); }
  const received = Number(text.trim().split("\n").pop());
  console.log(`RESULT 6 separate-process receiver, ${N} x 1 KiB ${paced ? "paced 100/tick" : "unpaced"}: accepted ${accepted}, received ${received} (${((1 - received / accepted) * 100).toFixed(1)}% lost)`);
  cli.close();
}

// 7. node:dgram receive-buffer knobs (Bun.udpSocket has none)
{
  const dgram = await import("node:dgram");
  const s = dgram.createSocket("udp4");
  await new Promise<void>(r => s.bind(0, "127.0.0.1", () => r()));
  const before = s.getRecvBufferSize(); s.setRecvBufferSize(4 * 1024 * 1024);
  console.log(`RESULT 7 node:dgram getRecvBufferSize ${before} -> after setRecvBufferSize(4 MiB) ${s.getRecvBufferSize()}; Bun.udpSocket has setRecvBufferSize: ${"setRecvBufferSize" in (await Bun.udpSocket({ port: 0 }))}`);
  s.close();
}
process.exit(0);
