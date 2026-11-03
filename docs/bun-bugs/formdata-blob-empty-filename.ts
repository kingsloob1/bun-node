/**
 * FormData: a Blob appended without a file name is serialised with
 * `filename=""`, where the spec names it "blob" (oven-sh/bun#35439, its
 * divergence 1).
 *
 *   bun docs/bun-bugs/formdata-blob-empty-filename.ts
 *
 * Prints the part's Content-Disposition for a bare Blob, and for the same
 * Blob appended with an explicit name (the workaround, a control). Exits 1
 * while the bug is present, 0 once a bare Blob is named "blob".
 */
import process from "node:process";

console.log(`Bun ${Bun.version} (${Bun.revision})`);

/** The Content-Disposition lines of a form's serialised parts. */
async function dispositions(form: FormData): Promise<string[]> {
  const text = await new Response(form).text();
  return text
    .split("\r\n")
    .filter((line) => line.toLowerCase().startsWith("content-disposition:"));
}

const bare = new FormData();
bare.append("file", new Blob(["x"], { type: "application/pdf" }));
const named = new FormData();
named.append("file", new Blob(["x"], { type: "application/pdf" }), "blob");

const [bareLine] = await dispositions(bare);
const [namedLine] = await dispositions(named);
console.log(`bare Blob:          ${bareLine}`);
console.log(`named "blob" (ctl): ${namedLine}`);
console.log(`entry .name:        ${JSON.stringify((bare.get("file") as File).name)}`);

const present = !bareLine.includes('filename="blob"');
console.log(present ? "BUG present" : "fixed");
process.exit(present ? 1 : 0);
