import { fileTypeFromBuffer, FileTypeParser } from "file-type";
const x = Buffer.from("x".repeat(1024));
const png = Buffer.concat([Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,0,0,0,13,0x49,0x48,0x44,0x52]), Buffer.alloc(1000)]);
const pdf = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(1000)]);
const jpg = Buffer.concat([Buffer.from([0xff,0xd8,0xff,0xe0]), Buffer.alloc(1000)]);
const parser = new FileTypeParser();
async function time(name: string, f: () => Promise<unknown>) {
  for (let i = 0; i < 2000; i++) await f();
  const t = performance.now(); const n = 20000;
  for (let i = 0; i < n; i++) await f();
  console.log(name.padEnd(20), ((performance.now() - t) * 1000 / n).toFixed(1), "µs", JSON.stringify(await f()));
}
for (const [n, b] of [["text", x], ["png", png], ["pdf", pdf], ["jpg", jpg]] as const) {
  await time(n, () => fileTypeFromBuffer(b));
  await time(n + " reused", () => parser.fromBuffer(b));
}
