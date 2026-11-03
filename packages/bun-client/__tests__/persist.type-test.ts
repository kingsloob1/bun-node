/**
 * The persister's types (plan §6.4, PR-C8): `idbPersister` is a persister
 * query-core's `persistQueryClient` takes, its options are what they say,
 * and the generated module's `typesHash` is a `buster`. Each
 * `@ts-expect-error` is a negative control: it must error, and it must be
 * there (an unused one fails the check too). The `Expect<Equal<…>>` lines
 * pin the types.
 *
 * Checked by `bun run check`, not by `bun test`; nothing here runs.
 */
import type { IdbPersisterOptions } from "../lib/persist";
import type {
  PersistedClient,
  Persister,
  PersistQueryClientOptions,
} from "@tanstack/query-persist-client-core";
import { QueryClient } from "@tanstack/query-core";
import { persistQueryClient } from "@tanstack/query-persist-client-core";
import { typesHash } from "./codegen/fixtures/app.gen";
import { idbPersister } from "../lib/persist";
import { FakeIndexedDb } from "./persist/fakeIdb";

type Equal<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2
    ? true
    : false;
type Expect<T extends true> = T;

export function probe(): void {
  const persister = idbPersister({
    database: "app",
    store: "queries",
    key: "client",
    throttleTime: 500,
    onError: (error) => void error,
  });
  type _persister = Expect<Equal<typeof persister, Persister>>;

  // query-core's own options take it, with the generated hash as the buster.
  const options = {
    queryClient: new QueryClient(),
    persister,
    buster: typesHash,
    maxAge: 60_000,
  } satisfies PersistQueryClientOptions;
  void persistQueryClient(options);
  type _buster = Expect<Equal<typeof typesHash, "3dcc0f6a50e0371c">>;

  // The options are optional, one by one and together.
  idbPersister();
  idbPersister({});
  // A structural IndexedDB: the in-test one fits, as the browser's does
  // (the consumer check's browser cells pass `globalThis.indexedDB`).
  idbPersister({ indexedDB: new FakeIndexedDb() });

  type _restore = Expect<
    Equal<
      Awaited<ReturnType<Persister["restoreClient"]>>,
      PersistedClient | undefined
    >
  >;
  type _throttle = Expect<
    Equal<IdbPersisterOptions["throttleTime"], number | undefined>
  >;

  // @ts-expect-error the database is a name
  idbPersister({ database: 1 });
  // @ts-expect-error an unknown option
  idbPersister({ buster: typesHash });
  // @ts-expect-error not an IndexedDB: no open()
  idbPersister({ indexedDB: {} });
  // @ts-expect-error open() must return a request
  idbPersister({ indexedDB: { open: () => 1 } });
  // @ts-expect-error the buster is a string
  void persistQueryClient({ ...options, buster: 1 });
}
