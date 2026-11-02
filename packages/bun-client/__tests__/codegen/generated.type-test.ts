/**
 * The golden modules as a client reads them (typed-client plan §12.1):
 * `createClient` over the corpus's and the third-party document's generated
 * maps, with what each mapping gives a call. Every `@ts-expect-error` is a
 * negative control: a wrong call, or a wrong expectation of a generated
 * type, must fail the check. Checked by `bun run check`.
 */
import type { Client, Result } from "../../lib/index";
import type * as corpus from "./fixtures/corpus.gen";
import type * as pets from "./fixtures/thirdParty.gen";

type Equal<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2
    ? true
    : false;
type Expect<T extends true> = T;

declare const api: Client<corpus.Routes>;
declare const store: Client<pets.Routes>;

// Recursion through component names.
type _tree = Expect<Equal<corpus.Tree["children"][number], corpus.Tree>>;
type _parent = Expect<
  Equal<corpus.Tree["parent"], corpus.Tree | null | undefined>
>;
type _owner = Expect<Equal<NonNullable<corpus.Meta["owner"]>, corpus.Tree>>;

// allOf, enums, const, nullable (3.1 and 3.0), tuples, maps.
type _named = Expect<Equal<corpus.Pet["name"], string>>;
type _kind = Expect<Equal<corpus.Pet["kind"], "cat" | "dog">>;
type _status = Expect<Equal<corpus.Pet["status"], "active">>;
type _age = Expect<Equal<corpus.Pet["age"], number | null | undefined>>;
type _legacy = Expect<Equal<pets.NewPet["tag"], string | null | undefined>>;
type _position = Expect<
  Equal<corpus.Pet["position"], [number, number] | undefined>
>;
type _trail = Expect<
  Equal<corpus.Pet["trail"], [string, ...number[]] | undefined>
>;
type _labels = Expect<
  Equal<corpus.Meta["labels"], Record<string, string> | undefined>
>;
type _closed = Expect<
  Equal<corpus.Pet["closed"], Record<string, never> | undefined>
>;
type _never = Expect<Equal<corpus.Pet["never"], undefined>>;
type _unknown = Expect<Equal<corpus.Pet["notString"], unknown>>;
type _rating = Expect<Equal<pets.Shelter["rating"], 1 | 2 | 3 | undefined>>;
type WrongPosition = Equal<corpus.Pet["position"], number[] | undefined>;
// @ts-expect-error -- a closed tuple is not an array
type _wrongPosition = Expect<WrongPosition>;

// Renamed components: a sanitized name, a reserved one, a leading digit.
type _profile = Expect<Equal<corpus.UserProfile, { id?: string }>>;
type _record = Expect<Equal<corpus.RecordSchema["value"], number | undefined>>;
type _digit = Expect<Equal<corpus._2fa, boolean>>;

async function calls() {
  // Path-level, $ref and header params; the required header wins over the path item's optional one.
  const tree = await api.get("/trees/:id", {
    params: { id: "t" },
    query: { depth: 2 },
  });
  type _tree200 = Expect<
    Equal<Extract<typeof tree, { status: 200 }>["data"]["id"], string>
  >;
  if (!tree.ok) {
    type _code = Expect<Equal<typeof tree.error.code, "NOT_FOUND" | "GONE">>;
  }
  type _trace = Expect<
    Equal<corpus.Routes["GET /trees/:id"]["headers"]["x-trace"], string>
  >;
  // @ts-expect-error -- depth is required
  void api.get("/trees/:id", { params: { id: "t" }, query: {} });
  // @ts-expect-error -- depth is a number
  void api.get("/trees/:id", { params: { id: "t" }, query: { depth: "2" } });

  // Quoted param names, from a third-party style path.
  void api.get('/odd/:"user-id"/:"a b"', {
    params: { "user-id": "u", "a b": "b" },
  });
  // @ts-expect-error -- both params are required
  void api.get('/odd/:"user-id"/:"a b"', { params: { "user-id": "u" } });

  // A oneOf error with the codes narrowed in each member.
  const created = await api.post("/pets", {
    body: { name: "Rex", kind: "dog", status: "active" },
  });
  if (!created.ok && created.status === 409) {
    type _conflict = Expect<
      Equal<typeof created.error.code, "CONFLICT" | "INVALID">
    >;
  }
  // @ts-expect-error -- `status` is required and must be "active"
  void api.post("/pets", { body: { name: "Rex", kind: "dog" } });

  // Bodies by media type: a form, raw bytes, none.
  void api.op.createPet({ body: new URLSearchParams() });
  void api.put("/files/:path", { params: { path: "a" }, body: new Blob([]) });
  void api.put("/files/:path", { params: { path: "a" } });
  // @ts-expect-error -- a form body is URLSearchParams, not an object
  void api.post("/forms", { body: { a: 1 } });

  // Text and binary responses.
  type _file = Expect<
    Equal<Result<corpus.Routes["PUT /files/:path"]>["data"], string | Blob>
  >;

  // An SSE route: no body through the HTTP call, its events on the entry.
  type _events = Expect<
    Equal<
      corpus.Routes["GET /streams/:id/events"]["events"],
      { end: corpus.Pet; ping: undefined; tick: { n: number } }
    >
  >;
  type _stream = Expect<
    Equal<corpus.Routes["GET /streams/:id/events"]["stream"], "sse">
  >;

  // Cache tags as literal tuples.
  type _tags = Expect<
    Equal<
      corpus.Routes["GET /trees/:id"]["cache"]["tags"],
      ["tree:{id}", "trees"]
    >
  >;

  // The third-party document: keys from its paths, an integer path param.
  const _pet = await store.op.showPetById({
    params: { petId: 1 },
    throwOnError: true,
  });
  type _owner = Expect<
    Equal<typeof _pet.owner, pets.Person | pets.Shelter | undefined>
  >;
  // @ts-expect-error -- petId is an integer
  void store.get("/pets/:petId", { params: { petId: true } });
  // @ts-expect-error -- deletePet has no operationId, so no op
  void store.op.deletePet;
}
void calls;
