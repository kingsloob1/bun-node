import type { DriverConfig, JobsDriver } from "./driver";
import { ConfigError } from "../shared/errors";
import { FileDriver } from "./file-driver";
import { MemoryDriver } from "./memory-driver";
import { MongoDriver } from "./mongo/mongo-driver";
import { RedisDriver } from "./redis/redis-driver";
import { SqlDriver } from "./sql/sql-driver";

/**
 * Builds a driver from a plain config object.
 *
 * Configs matter beyond convenience: a spawned child cannot receive a driver
 * instance*, only a description of how to build one, so `childDriver` and
 * `RunContext.driverConfig` are configs and this is what turns them back into
 * a driver on the other side.
 *
 * Only the backends that have landed are constructible; the rest raise a
 * {@link ConfigError} naming what is missing rather than failing later with
 * something obscure.
 */
export function createDriver(config: DriverConfig): JobsDriver {
  switch (config.type) {
    case "memory":
      return new MemoryDriver();
    case "file":
      return new FileDriver({ root: config.root });
    case "sql":
      return new SqlDriver({
        url: config.url,
        connection: config.connection,
        adapter: config.adapter,
        tablePrefix: config.tablePrefix,
        tables: config.tables,
        notify: config.notify,
      });
    case "mongodb":
      return new MongoDriver({
        url: config.url,
        connection: config.connection,
        database: config.database,
        collectionPrefix: config.collectionPrefix,
        collections: config.collections,
      });
    case "redis":
      return new RedisDriver({
        url: config.url,
        connection: config.connection,
        cluster: config.cluster,
        keyPrefix: config.keyPrefix,
      });
    default:
      throw new ConfigError("Unrecognised driver config", {
        config: config as unknown,
      });
  }
}

/**
 * Normalises a driver option into an instance plus whether the caller owns
 * it. Only a driver we built here is ours to close: an instance handed in is
 * shared, and closing it would break every other user of it.
 */
export function resolveDriver(driver: JobsDriver | DriverConfig | undefined): {
  driver: JobsDriver;
  owned: boolean;
} {
  if (!driver) {
    return { driver: new MemoryDriver(), owned: true };
  }

  if ("type" in driver && typeof driver.type === "string") {
    return { driver: createDriver(driver as DriverConfig), owned: true };
  }

  return { driver: driver as JobsDriver, owned: false };
}
