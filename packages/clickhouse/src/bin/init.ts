import { loadDotenv, loadEnv } from "@chatterscope/config";
import { createClickHouse, ensureSchema } from "../index.js";

loadDotenv();
const env = loadEnv();

const config = {
  url: env.CLICKHOUSE_URL,
  database: env.CLICKHOUSE_DATABASE,
  username: env.CLICKHOUSE_USERNAME,
  password: env.CLICKHOUSE_PASSWORD,
  messageRetentionDays: env.MESSAGE_RETENTION_DAYS,
};

const client = createClickHouse(config);
try {
  await ensureSchema(client, config);
  console.log(`[clickhouse-init] schema ensured in ${config.database}`);
} finally {
  await client.close();
}
