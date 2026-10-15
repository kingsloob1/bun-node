# Coverage check of the two matrices, and the 22 commits they did not name

Checked by the plan's author after both matrices were written, in the
`nestjs/nest` clone:

```bash
git rev-list v11.1.27..v12.1.3 ; git rev-list v11.2.1..v11.2.7     # 1207 distinct commits
# every 9-character hash appearing as a table row in either matrix (rows and appendix buckets): 718
```

| Set | Commits | Named by a matrix |
|---|---|---|
| everything in `v11.1.27..v12.1.3` plus `v11.2.1..v11.2.7` | 1207 | 718 |
| first-parent commits of `v11.1.27..v12.1.3` | 579 | 571; the 8 others are PR merges (`0f30dcc47` #17464, `1d5f960b1` #16653, `5061da357` #17416, `5d93228db` #17086, `9879885ea` #17435, `b2e7fb5e7` #17469, `b7ed7eae3` #17509, `db504f5c3` #17141) whose own commits are classified as rows |
| unnamed commits touching any `packages/*` | 126 | 104 of them are merge commits (containers of classified commits); **22 are non-merge commits, classified below** |
| unnamed commits touching no `packages/*` | 363 | side-branch commits in `sample/`, `integration/`, tooling and root dependencies: the kind the appendices bucket as NO |

The 22 are commits inside side branches that the platforms matrix did not
expand (it expanded the four merges that bundle work). None changes our
classification:

| Hash | First in | Packages | Subject | Class | Why |
|---|---|---|---|---|---|
| `6e38e7d7e` | v11.1.29 | platform-ws | chore(deps): bump ws from 8.21.0 to 8.21.1 | NO | we do not use `ws`; Bun's native WebSockets |
| `0ca12be50` | v11.2.0 | platform-ws | chore(deps): bump ws from 8.21.1 to 8.21.2 | NO | same |
| `1d279f4de` | v12.0.0 | platform-ws | chore(deps): bump ws from 8.21.2 to 8.21.3 | NO | same |
| `541977a8a` | v11.1.28 | platform-express | fix(deps): update dependency multer to v2.2.0 [security] | NO (reference) | we do not use multer; multer's limits and messages are the reference for our uploads, covered by the matrix rows on multer 2.4 (`cf5204639`, `28c5620ac`) and the plan's G14/G16 |
| `5ec2e5823` | v12.0.0 | platform-socket.io | Update io-adapter.ts | NO | socket.io adapter; we ship our own |
| `6c2c60c18` | v12.0.0 | platform-socket.io | chore: improve platform-socket.io types | NO | same |
| `6dbeb92bf` | v11.1.28 | microservices, websockets | test: remove leftover debug console.log statements | NO | tests only |
| `98a6a3c73` | v11.1.29 | platform-fastify | chore(deps): bump fastify from 5.10.0 to 5.11.0 | NO | no Fastify adapter |
| `efbb9dd17` | v11.1.29 | platform-fastify | chore(deps): bump @fastify/cors from 11.2.0 to 11.3.0 | NO | same |
| `ae305fbc3` | v11.2.0 | platform-fastify | chore(deps): bump fastify from 5.11.0 to 5.11.2 | NO | same |
| `ec2af4444` | v11.2.0 | platform-fastify | fix(deps): update dependency fastify to v5.11.3 | NO | same |
| `eb459f78e` | v11.2.0 | platform-fastify | fix(fastify): run middleware on routes excluded from global prefix | NO | Fastify's own middleware mounting; the Express/ours equivalent is measured by the routing differential's `mw-prefix` group |
| `f3965519e` | v11.2.0 | platform-fastify | fix(fastify): avoid double prefixing inherited middleware | NO | Fastify-specific (`@fastify/middie`); ours receives full paths from the core |
| `b4de1c505` | v12.0.0 | platform-fastify | fix(deps): update dependency find-my-way to v9.8.0 | NO | no Fastify adapter |
| `ce9b4289c` | v12.0.0 | platform-fastify | fix(deps): update dependency fastify to v5.12.0 | NO | same |
| `e332c65fa` | v12.0.0 | platform-fastify | chore(deps): bump @fastify/formbody from 8.0.2 to 9.0.0 | NO | same |
| `7e65752ba` | v11.2.2 | all | chore(release): publish v11.2.2 release | NO | release commit |
| `2b36ee5fe` | v11.2.3 | all | chore(release): publish v11.2.3 release | NO | release commit |
| `d5046225d` | v11.2.4 | all | chore(release): publish v11.2.4 release | NO | release commit |
| `e91618cee` | v11.2.5 | all | chore(release): publish v11.2.5 release | NO | release commit |
| `c07cfb0be` | v11.2.6 | all | v11.2.6 | NO | release commit |
| `c666d7f72` | v11.2.7 | all | v11.2.7 | NO | release commit |

So every non-merge commit in the range that touches one of the nine Nest
packages is classified: 199 + 235 rows in the two matrices (a commit touching
both scopes is in both), plus these 22.
