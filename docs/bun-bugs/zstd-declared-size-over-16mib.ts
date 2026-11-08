/**
 * Bun.zstdDecompressSync enforces a frame's declared Frame_Content_Size only
 * up to 16 MiB. A frame that declares more than 16 MiB but holds more than
 * it declares is decoded whole, its real content allocated, before Bun
 * throws: an 8 KiB frame declaring 20 MiB and holding 256 MiB grows the
 * process by about 256 MiB. Declaring 15 MiB, the same frame is refused
 * without allocating. (A frame that declares no size decodes without any
 * bound: oven-sh/bun#28162, shown for context, not judged here.)
 *
 *   bun docs/bun-bugs/zstd-declared-size-over-16mib.ts
 *
 * Each case runs in a child process of its own, so one case's freed memory
 * cannot hide the next one's growth. Exits 1 while a frame declaring 20 MiB
 * grows the process by more than 64 MiB, 0 once Bun refuses it within about
 * its declared size.
 */
import process from "node:process";

const MiB = 1024 * 1024;

/** A zstd frame of RLE blocks (RFC 8878 §3.1.1) holding `actual` bytes, declaring `declared` when given. */
function frame(actual: number, declared?: number): Uint8Array {
  const out = [0x28, 0xb5, 0x2f, 0xfd];
  let flag = 0;
  let fcs: number[] = [];
  if (declared !== undefined) {
    flag = 2; // a 4-byte Frame_Content_Size
    fcs = [0, 8, 16, 24].map((shift) => (declared >>> shift) & 0xff);
  }
  out.push(flag << 6, (17 - 10) << 3, ...fcs); // window 128 KiB
  for (let left = actual; left > 0;) {
    const size = Math.min(left, 128 * 1024);
    left -= size;
    const header = (size << 3) | (1 << 1) | (left === 0 ? 1 : 0); // RLE block
    out.push(header & 0xff, (header >> 8) & 0xff, (header >> 16) & 0xff, 0);
  }
  return new Uint8Array(out);
}

const CASES: Record<string, () => Uint8Array> = {
  "declares 20 MiB, holds 256 MiB": () => frame(256 * MiB, 20 * MiB),
  "declares 15 MiB, holds 256 MiB": () => frame(256 * MiB, 15 * MiB),
  "declares nothing, holds 256 MiB (#28162)": () => frame(256 * MiB),
};

const which = process.argv[2];
if (which !== undefined) {
  // The child: decode one case, print the result and the growth.
  const input = CASES[which]();
  Bun.gc(true);
  const before = process.memoryUsage().rss;
  let result: string;
  try {
    result = `decoded ${Bun.zstdDecompressSync(input).byteLength / MiB} MiB`;
  } catch (error) {
    result = `threw ${(error as Error).message}`;
  }
  const grew = (process.memoryUsage().rss - before) / MiB;
  console.log(JSON.stringify({ result, grew: Math.round(grew) }));
  process.exit(0);
}

console.log(`Bun ${Bun.version} (${Bun.revision}) ${process.platform}-${process.arch}`);
let present = false;
for (const name of Object.keys(CASES)) {
  const child = Bun.spawnSync([process.execPath, import.meta.path, name]);
  const { result, grew } = JSON.parse(child.stdout.toString()) as {
    result: string;
    grew: number;
  };
  console.log(`${name}: input 8 KiB -> ${result}, RSS +${grew} MiB`);
  if (name.startsWith("declares 20 MiB") && grew > 64) present = true;
}
process.exit(present ? 1 : 0);
