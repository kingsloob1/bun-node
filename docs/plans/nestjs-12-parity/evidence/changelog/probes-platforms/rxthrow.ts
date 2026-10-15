import { of } from "/home/kingsloob1/Desktop/projects/mine/bun-node-nest12-ae-1015/node_modules/rxjs/dist/esm5/index.js";
const deep: any = {}; let cur = deep; for (let i = 0; i < 200000; i++) { cur.a = {}; cur = cur.a; }
of(deep).subscribe({ next: (v) => { JSON.stringify(v); }, error: () => console.log("error cb") });
setTimeout(() => console.log("still alive after 200ms"), 200);
