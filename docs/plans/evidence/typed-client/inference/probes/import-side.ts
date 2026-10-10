import type { B } from "./statements";
const ok: B extends Record<"GET /x" | "GET /y", true> ? true : false = true;
void ok;
