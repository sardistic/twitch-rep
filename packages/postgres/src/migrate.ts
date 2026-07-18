import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import type { PostgresPool } from "./client.js";

export type MigrationFile = {
  id: number;
  name: string;
  filename: string;
};

const MIGRATION_PATTERN = /^(\d{4})_([a-z0-9_]+)\.sql$/;

export function parseMigrationFilename(filename: string): MigrationFile | null {
  const match = MIGRATION_PATTERN.exec(filename);
  if (!match) return null;
  return { id: Number(match[1]), name: match[2] as string, filename };
}

/**
 * Orders migration files by numeric prefix and rejects duplicates or files
 * that do not follow the NNNN_name.sql convention (so a stray file can never
 * be silently skipped).
 */
export function orderMigrations(filenames: string[]): MigrationFile[] {
  const migrations: MigrationFile[] = [];
  for (const filename of filenames) {
    const parsed = parseMigrationFilename(filename);
    if (!parsed) {
      throw new Error(
        `Migration file "${filename}" does not match the NNNN_name.sql naming convention`,
      );
    }
    migrations.push(parsed);
  }
  migrations.sort((a, b) => a.id - b.id);
  for (let i = 1; i < migrations.length; i++) {
    if (migrations[i]!.id === migrations[i - 1]!.id) {
      throw new Error(`Duplicate migration id ${migrations[i]!.id}`);
    }
  }
  return migrations;
}

export function checksum(sql: string): string {
  return createHash("sha256").update(sql).digest("hex");
}

export type AppliedMigration = { id: number; name: string; checksum: string };

export async function runMigrations(
  pool: PostgresPool,
  migrationsDir: string,
  log: (message: string) => void = () => {},
): Promise<{ applied: string[] }> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id integer PRIMARY KEY,
      name text NOT NULL,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  const filenames = (await readdir(migrationsDir)).filter((f) => f.endsWith(".sql"));
  const migrations = orderMigrations(filenames);

  const appliedRows = await pool.query<AppliedMigration>(
    "SELECT id, name, checksum FROM schema_migrations ORDER BY id",
  );
  const appliedById = new Map(appliedRows.rows.map((row) => [row.id, row]));

  const applied: string[] = [];
  for (const migration of migrations) {
    const sql = await readFile(path.join(migrationsDir, migration.filename), "utf8");
    const sum = checksum(sql);
    const existing = appliedById.get(migration.id);
    if (existing) {
      if (existing.checksum !== sum) {
        throw new Error(
          `Migration ${migration.filename} was modified after being applied (checksum mismatch)`,
        );
      }
      continue;
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (id, name, checksum) VALUES ($1, $2, $3)", [
        migration.id,
        migration.name,
        sum,
      ]);
      await client.query("COMMIT");
      log(`applied ${migration.filename}`);
      applied.push(migration.filename);
    } catch (error) {
      await client.query("ROLLBACK");
      throw new Error(`Migration ${migration.filename} failed: ${(error as Error).message}`);
    } finally {
      client.release();
    }
  }
  return { applied };
}
