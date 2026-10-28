/**
 * Compile-time checks for `@Cacheable`, `@CachePut` and `@CacheEvict` (plan
 * §10.2): a key function's parameters are checked against the method's, the
 * method must return a `Promise`, and `unless`'s result against the method's
 * result. Checked by `bun run check` (`bun test`, even with `--check`, never
 * reads a `*.type-test.ts`); each `@ts-expect-error` is a negative control —
 * an unused one is an error.
 */
import type { Cache } from "../lib/cache/index";
import { Cacheable, CacheEvict, CachePut } from "../lib/cache/index";

/** A user, as the service below returns it. */
interface User {
  id: number;
  name: string;
}

export class TypedService {
  // The key's parameter types, and the tags inferred from them.
  @Cacheable({
    key: (id: number) => `user:${id}`,
    tags: (id) => [`user:${id.toFixed(0)}`],
    ttl: 60_000,
  })
  async find(id: number): Promise<User> {
    return { id, name: "x" };
  }

  // A key reading fewer parameters than the method takes.
  @Cacheable({ key: (orgId: string) => `orgs:${orgId}`, staleIfError: 1_000 })
  async listOrgs(orgId: string, q: { page: number }): Promise<string[]> {
    return [orgId, String(q.page)];
  }

  // A template and the default key accept any parameters.
  @Cacheable({ key: "orgs:{0}:page:{1.page}", cache: "reports" })
  async page(orgId: string, q: { page: number }): Promise<string> {
    return `${orgId}${q.page}`;
  }

  @Cacheable()
  async anything(a: Map<string, number>, b?: Date): Promise<number> {
    return a.size + (b?.getTime() ?? 0);
  }

  // `unless` reads the result, typed by its annotation; its arguments are
  // the key's, without shrinking them.
  @Cacheable({
    key: (q: string) => `search:${q}`,
    unless: (result: string[], q) => result.length === 0 || q === "",
  })
  async search(q: string): Promise<string[]> {
    return [q];
  }

  // `condition` reads the arguments.
  @Cacheable({ key: (n: number) => `n:${n}`, condition: (n) => n > 0 })
  async square(n: number): Promise<number> {
    return n * n;
  }

  // @ts-expect-error a key typed for another parameter is refused
  @Cacheable({ key: (id: string) => `user:${id}` })
  async wrongKey(id: number): Promise<User> {
    return { id, name: "x" };
  }

  // @ts-expect-error a method that does not return a Promise is refused
  @Cacheable({ key: (id: number) => `user:${id}` })
  notAsync(id: number): User {
    return { id, name: "x" };
  }

  // @ts-expect-error an `unless` typed for another result is refused
  @Cacheable({ key: "k", unless: (result: number) => result > 0 })
  async wrongUnless(): Promise<string> {
    return "x";
  }

  @CachePut({ key: (u: User) => `user:${u.id}`, tags: (u) => [`user:${u.id}`] })
  async save(u: User): Promise<User> {
    return u;
  }

  // @ts-expect-error CachePut's key is checked the same way
  @CachePut({ key: (u: string) => u })
  async saveWrong(u: User): Promise<User> {
    return u;
  }

  @CacheEvict({ tags: (id: number) => [`user:${id}`] })
  async update(id: number, patch: Partial<User>): Promise<User> {
    return { id, name: patch.name ?? "" };
  }

  @CacheEvict({ all: true, beforeInvocation: true })
  async reset(): Promise<void> {}

  // @ts-expect-error CacheEvict's tags are checked against the parameters
  @CacheEvict({ tags: (id: string) => [id] })
  async updateWrong(id: number): Promise<void> {
    void id;
  }
}

/** The re-exported `Cache` is bun-cache's, not `any`. */
export function useCache(cache: Cache): Promise<boolean> {
  // @ts-expect-error `set` needs a key and a value
  void cache.set();
  return cache.set("k", 1);
}
