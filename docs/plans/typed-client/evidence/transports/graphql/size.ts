/** Browser bundle sizes (minified, gzip) of a GraphQL client's runtime options. `bun graphql/size.ts` */
import { join } from "node:path";
const dir = join(import.meta.dir, "entries");
console.log("entry        min_KB  gzip_KB");
for (const name of ["thin", "gqltada", "graphqljs", "urql"]) {
  const r = await Bun.build({ entrypoints: [join(dir, `${name}.ts`)], target: "browser", minify: true });
  if (!r.success) { console.log(name, "FAILED", r.logs); continue; }
  const bytes = new Uint8Array(await r.outputs[0]!.arrayBuffer());
  console.log(`${name.padEnd(12)} ${(bytes.length / 1024).toFixed(1).padStart(6)}  ${(Bun.gzipSync(bytes).length / 1024).toFixed(1).padStart(7)}`);
}
