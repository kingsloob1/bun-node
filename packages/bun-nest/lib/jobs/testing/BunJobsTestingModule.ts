import type { DynamicModule } from "@nestjs/common";
import type {
  BunJobsBuildOptions,
  BunJobsModuleContextOptions,
} from "../BunJobsModule";
import { MemoryDriver } from "@kingsleyweb/bun-jobs";
import { BunJobsModule } from "../BunJobsModule";

/** What {@link BunJobsTestingModule.forRoot} accepts: `BunJobsModule`'s, each optional. */
export type BunJobsTestingModuleOptions = Partial<BunJobsBuildOptions> &
  BunJobsModuleContextOptions;

/**
 * `BunJobsModule` for a test: a memory driver of its own, a namespace unique to this call,
 * nothing started, and a short drain on close. It provides the same tokens, so an
 * application's own modules resolve `@InjectQueue` as usual.
 *
 * ```ts
 * const moduleRef = await Test.createTestingModule({
 *   imports: [BunJobsTestingModule.forRoot(), EmailsModule],
 * }).compile();
 * const app = await moduleRef.init();
 * ```
 */
// eslint-disable-next-line ts/no-extraneous-class -- the shape of a Nest module's factory
export class BunJobsTestingModule {
  /**
   * The module.
   *
   * @param options `BunJobsModule`'s options, which win over these defaults: `driver` a new
   * `MemoryDriver`, `namespace` `test-<uuid>`, `autoStart` `false`, `shutdown`
   * `{ timeout: 1_000 }`.
   */
  static forRoot(options: BunJobsTestingModuleOptions = {}): DynamicModule {
    return BunJobsModule.forRoot({
      driver: new MemoryDriver(),
      namespace: `test-${crypto.randomUUID()}`,
      autoStart: false,
      shutdown: { timeout: 1_000 },
      ...options,
    });
  }
}
