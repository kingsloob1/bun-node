/** File-based route `GET /ping` — the static-dispatch fixture. */
export function handler(): Response {
  return new Response("ok");
}
