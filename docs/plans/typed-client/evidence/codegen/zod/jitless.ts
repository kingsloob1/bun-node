/** The generated classic schema with Zod's JIT off, as under a CSP without 'unsafe-eval'. bun jitless.ts */
import { join } from "node:path";
import { z } from "zod";
z.config({ jitless: true });
const classic = (await import(join(import.meta.dir, "app.zod-classic.gen.ts"))).schemas["GET /users"].responses[200];
const body = { items: Array.from({ length: 20 }, (_, i) => ({ id: String(i), name: `user ${i}`, email: `u${i}@example.com`, role: i % 2 ? "admin" : "member", createdAt: new Date(1_760_000_000_000 + i).toISOString() })), next: 2 };
for (let i = 0; i < 2000; i++) classic.safeParse(body);
const t0 = Bun.nanoseconds();
for (let i = 0; i < 20_000; i++) if (!classic.safeParse(body).success) throw new Error("x");
console.log(`cost generated classic, jitless          ${((Bun.nanoseconds() - t0) / 20_000 / 1000).toFixed(2)} µs/op`);
