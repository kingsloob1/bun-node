/**
 * The postgres driver (plan §7.4): the conformance kit and the SQL specifics, on
 * the server `BUN_CACHE_TEST_POSTGRES_URL` (or `BUN_JOBS_TEST_POSTGRES_URL`) names. See
 * `sqlSuite.ts`.
 */
import { registerSqlSuite } from "./sqlSuite";

await registerSqlSuite("postgres");
