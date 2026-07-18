import pg from "pg";

export type PostgresPool = pg.Pool;

export function createPool(connectionString: string): PostgresPool {
  return new pg.Pool({
    connectionString,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
}

export async function checkPostgres(pool: PostgresPool): Promise<void> {
  await pool.query("SELECT 1");
}
