import { validateParseBodyOption } from "../../../../packages/bun-common/lib/BunRequest";
const cfg = { contentTypes: { json: true, urlencoded: true, text: true, raw: true, xml: true, multipart: { opts: { detectFileType: false } } } };
for (const [n, c] of [["object", cfg], ["plain {}", {}], ["true", true]] as const) {
  for (let i = 0; i < 1e5; i++) validateParseBodyOption(c as any);
  const t = performance.now(); const N = 1e6;
  for (let i = 0; i < N; i++) validateParseBodyOption(c as any);
  console.log(n, ((performance.now() - t) * 1e6 / N).toFixed(0), "ns");
}
