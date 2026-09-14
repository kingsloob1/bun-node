import { MemoryDriver } from "../lib/index";
import { driverContract } from "./helpers/driverContract";

/**
 * The memory driver against the shared contract. It is the reference
 * implementation, so a failure here is a bug in the contract's expectations
 * as often as in the driver.
 */
driverContract("memory", async () => ({ driver: new MemoryDriver() }));
