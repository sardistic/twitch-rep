import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadDotenv, loadEnv } from "@chatterscope/config";

loadDotenv();
import { createPool } from "../client.js";
import { runMigrations } from "../migrate.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.resolve(here, "../../migrations");

const env = loadEnv();
const pool = createPool(env.POSTGRES_URL);

try {
  const { applied } = await runMigrations(pool, migrationsDir, (message) =>
    console.log(`[migrate] ${message}`),
  );
  console.log(
    applied.length === 0
      ? "[migrate] database is up to date"
      : `[migrate] applied ${applied.length} migration(s)`,
  );
} finally {
  await pool.end();
}
