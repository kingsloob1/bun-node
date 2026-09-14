/** File-based route `GET /user/:id` — one required parameter. */
export function handler(params: Record<string, string>): Response {
  return new Response(params.id);
}
