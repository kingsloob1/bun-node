/**
 * A client for the posts API, written as browser code would be: it imports
 * the shared contract and `@kingsleyweb/bun-common/contract`, nothing else
 * (`../contract-sharing.ts` bundles it for a browser to prove it).
 *
 * Both ends are checked: a **sender** refuses a bad request before it leaves,
 * and a **receiver** parses each reply against the status it came with, so a
 * server that answers outside its contract is caught here too.
 *
 * Not an example on its own: `run-all.ts` skips files under `modules/`.
 */
import type { Received, Sent } from "@kingsleyweb/bun-common/contract";
import {
  ContractError,
  createReceiver,
  createSender,
} from "@kingsleyweb/bun-common/contract";
import { createPost } from "./posts-contract";

/** The one thing the client needs from its host: `fetch`, or `router.fetch` in a test. */
export type FetchLike = (path: string, init: RequestInit) => Promise<Response>;

/** What the client may send as a new post: the schema's input, so `tags` is optional. */
export type NewPostInput = NonNullable<
  Sent<typeof createPost, "inbound">["body"]
>;

/** A reply, parsed: the status and its body, typed per status. */
export type PostsReply = Received<typeof createPost, "outbound">;

/** A posts client over `fetchFn`. */
export function postsClient(fetchFn: FetchLike) {
  const checkRequest = createSender(createPost, "inbound");
  const parseReply = createReceiver(createPost, "outbound");

  /** Sends `body` as it is, unchecked: what a client without the contract would do. */
  async function post(
    path: string,
    body: unknown,
  ): Promise<PostsReply | ContractError> {
    const response = await fetchFn(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return parseReply({ status: response.status, body: await response.json() });
  }

  return {
    /** Every request this client actually sent, by path. */
    sent: [] as string[],

    /**
     * Creates a post. A body that fails the contract comes back as a
     * `ContractError` and is never sent; a reply that fails it, too.
     */
    async create(
      body: NewPostInput,
      path = "/posts",
    ): Promise<PostsReply | ContractError> {
      const checked = await checkRequest({ body });
      if (checked instanceof ContractError) return checked;
      this.sent.push(path);
      return post(path, checked.body);
    },

    /** Sends any body, skipping the sender: a client that does not share the contract. */
    async createUnchecked(body: unknown): Promise<PostsReply | ContractError> {
      this.sent.push("/posts");
      return post("/posts", body);
    },
  };
}
