import { loadDotenv, loadEnv } from "@chatterscope/config";

loadDotenv();
import { createPool } from "../client.js";
import { seed } from "../seed.js";

const env = loadEnv();
if (env.NODE_ENV === "production") {
  console.error("[seed] refusing to seed a production database");
  process.exit(1);
}

const pool = createPool(env.POSTGRES_URL);
try {
  await seed(pool, (message) => console.log(`[seed] ${message}`));
} finally {
  await pool.end();
}
