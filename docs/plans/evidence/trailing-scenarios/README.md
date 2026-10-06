# Evidence: why some scenarios trailed, and the body-parsing work

Backs [`../../research-trailing-scenarios.md`](../../research-trailing-scenarios.md).
Measured on Bun 1.4.2, a 4-vCPU Xeon, on `claude/wizardly-feynman-c72eec`
from `b2374a0` to `05c8efa`. Each script loads the packages from this
checkout, so it measures whatever is checked out: re-run before relying on a
figure. Run them from the repo root with `BUN_OPTIONS=` (this environment's
shell exports `--smol`). The `wrk` figures themselves come from
`benchmarks/wrk.ts`; its reports are in `benchmarks/results/`.

| File | Doc section | What it measures |
|---|---|---|
| `research-inproc.ts` | "Where they stand" | Each trailing scenario in process, bun-common against Elysia 2 |
| `research-wh.ts`, `research-wh2.ts` | "Where they stand", §5 | The wildcard and headers gap, in process |
| `research-json.ts`, `research-json2.ts` | §1 | Stages of a JSON request: construction, the body read, the parse |
| `research-hdr.ts` | §4 | `Headers` and `Response` construction costs behind the headers scenario |
| `ab-scen.ts` | §1–§6 | Interleaved A/B of every wrk scenario's route set in process; `BASE=<checkout of the base commit>` |
| `profiling/prof-scen.ts` | §1–§6 | One scenario in a loop, for `bun --cpu-prof` |
| `profiling/summ.ts`, `profiling/incl.ts` | all | Self and inclusive time per function from a `.cpuprofile` |
| `profiling/body-server.ts`, `*.lua` | §7 | A served adapter for profiling under `wrk` (`CAPPED=1` for the object-form `parseBody`) |
| `multipart/stages.ts` | §7 | busboy (piped and in one write), `file-type`, `Request.formData()` and the whole route, separately |
| `multipart/router-loop.ts`, `multipart/adapter-loop.ts` | §7 | One upload in a loop, for timing and `--cpu-prof`; the adapter one sends a `Content-Length` as a served request does |
| `multipart/file-type-cost.ts` | §7 | `file-type` sniffing cost by content: text, PNG, PDF, JPEG |
| `multipart/plain-names.ts` | §7 | Which field names picoquery answers unchanged (the plain-name fast path's guard) |
| `multipart/formdata-speed.ts` | §7 | busboy against Bun's `formData()`, seven upload shapes, answers checked equal |
| `multipart/formdata-semantics.ts` | §7 | What each answers on 20 inputs where they could differ |
| `multipart/alternatives/speed.ts` | §7 | busboy, @fastify/busboy, bun-common's buffered parser, `formData()`, the Remix and remix-the-web parsers and multipasta, seven upload shapes, answers checked equal. Its own `package.json`: `npm install` there first |
| `multipart/alternatives/remix-semantics.ts` | §7 | What busboy and the two Remix parsers answer on nine inputs where they could differ |
| `urlencoded-parsers.ts` | §7 | picoquery against `formData()` and `URLSearchParams` for urlencoded bodies |
| `parse-body-resolve.ts` | §7 | Resolving an object-form `parseBody` per request |

Profiling a served adapter under `wrk`:

```bash
D=docs/plans/evidence/trailing-scenarios/profiling
CAPPED=1 taskset -c 0 bun --cpu-prof --cpu-prof-dir=/tmp/prof $D/body-server.ts &   # prints READY <port>
taskset -c 1-3 wrk -t2 -c64 -d6s -s $D/form.lua http://127.0.0.1:<port>/form
kill -INT %1; bun $D/summ.ts /tmp/prof/*.cpuprofile
```
