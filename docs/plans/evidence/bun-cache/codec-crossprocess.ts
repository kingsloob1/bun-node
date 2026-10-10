// Does a bun:jsc `serialize` buffer decode in ANOTHER process, for values that
// may hold in-process references (Blob, File)? A same-process round trip
// (codecs.ts) cannot tell a copied payload from a handle.
// Run: bun codec-crossprocess.ts
import { serialize, deserialize } from "bun:jsc";

if (process.argv[2] === "child") {
  const bytes = await Bun.file(process.argv[3]!).bytes();
  try {
    const v = deserialize(bytes) as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const [k, x] of Object.entries(v)) out[k] = x instanceof Blob ? `${x.constructor.name}(${x.size} B, type=${JSON.stringify(x.type)}) text=${JSON.stringify(await x.text())}` : `${(x as object)?.constructor?.name}: ${String(x)}`;
    console.log(JSON.stringify(out, null, 1));
  } catch (e) { console.log(`child: deserialize threw ${(e as Error).message}`); }
  process.exit(0);
}
console.log(`Bun ${Bun.version} (${Bun.revision.slice(0, 9)})`);
const file = `${process.env.SPIKE_DIR ?? `${process.env.HOME}/.cache/bun-node-e6/cacheplan`}/codec-${process.pid}.bin`;
const value = { blob: new Blob(["hello blob"], { type: "text/plain" }), file: new File(["file body"], "a.txt", { type: "text/plain" }), date: new Date(0), map: new Map([["k", 1]]) };
const buf = new Uint8Array(serialize(value) as unknown as ArrayBuffer);
console.log(`serialized ${buf.length} bytes; contains "hello blob" bytes: ${Buffer.from(buf).includes("hello blob")}`);
await Bun.write(file, buf);
const child = Bun.spawnSync([process.execPath, import.meta.path, "child", file]);
console.log(`child process decode:\n${child.stdout.toString()}${child.stderr.toString()}`);
await Bun.file(file).delete();
