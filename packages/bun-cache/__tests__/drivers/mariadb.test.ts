/**
 * The mariadb driver (plan §7.5): the conformance kit and the SQL specifics, on
 * the server `BUN_CACHE_TEST_MARIADB_URL` (or `BUN_JOBS_TEST_MARIADB_URL`) names. See
 * `sqlSuite.ts`.
 */
import { registerSqlSuite } from "./sqlSuite";

await registerSqlSuite("mariadb");
