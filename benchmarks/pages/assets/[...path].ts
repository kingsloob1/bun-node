/** File-based route `GET /assets/*` — a required catch-all parameter. */
export function handler(params: Record<string, string>): Response {
  return new Response(params.path);
}
