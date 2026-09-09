/**
 * File-based route `GET /search/:category/:page?` — one required param plus an
 * optional catch-all. `[[...page]]` is the only *native* optional-parameter
 * syntax among the four dispatch strategies benchmarked here.
 */
export function handler(params: Record<string, string>): Response {
  return new Response(`${params.category}/${params.page ?? "-"}`);
}
