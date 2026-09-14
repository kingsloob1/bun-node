/** File-based route `GET /api/v1/users/:userId/books/:bookId` — two required params. */
export function handler(params: Record<string, string>): Response {
  return new Response(`${params.userId}/${params.bookId}`);
}
