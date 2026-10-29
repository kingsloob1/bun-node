/**
 * Bun.gunzipSync decodes only the first member of a multi-member gzip
 * payload and silently ignores whatever follows it — further members or
 * garbage. node:zlib's gunzipSync (in Bun and in Node) decodes every member
 * and throws on trailing garbage.
 *
 *   bun docs/bun-bugs/gunzip-sync-reads-first-member-only.ts
 *
 * Exits 1 while the bug is present, 0 once Bun.gunzipSync agrees with
 * node:zlib on both inputs.
 */
import process from "node:process";
import { gunzipSync } from "node:zlib";

console.log(`Bun ${Bun.version} (${Bun.revision}) ${process.platform}-${process.arch}`);

const encoder = new TextEncoder();
const first = Bun.gzipSync(encoder.encode("hello "));
const second = Bun.gzipSync(encoder.encode("world"));
const inputs: Record<string, Uint8Array<ArrayBuffer>> = {
  "two members (RFC 1952 §2.2)": new Uint8Array([...first, ...second]),
  "one member, then 3 garbage bytes": new Uint8Array([...first, 1, 2, 3]),
};

/** What a decoder answered: the text, or the error it threw. */
function attempt(decode: () => Uint8Array): string {
  try {
    return JSON.stringify(new TextDecoder().decode(decode()));
  } catch (error) {
    return `throws: ${(error as Error).message}`;
  }
}

let differ = false;
for (const [what, bytes] of Object.entries(inputs)) {
  const bun = attempt(() => Bun.gunzipSync(bytes));
  const node = attempt(() => gunzipSync(bytes));
  differ ||= bun !== node;
  console.log(`${bun === node ? "same" : "DIFF"}  ${what}`);
  console.log(`      Bun.gunzipSync    ${bun}`);
  console.log(`      zlib.gunzipSync   ${node}`);
}
process.exit(differ ? 1 : 0);
