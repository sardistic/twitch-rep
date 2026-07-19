import type { PostgresPool } from "./client.js";

export type ProviderRecord = {
  id: string;
  organizationId: string | null;
  providerType: string;
  name: string;
  baseUrl: string | null;
  enabled: boolean;
  createdAt: Date;
};

type ProviderRow = {
  id: string;
  organization_id: string | null;
  provider_type: string;
  name: string;
  base_url: string | null;
  enabled: boolean;
  created_at: Date;
};

function toProvider(row: ProviderRow): ProviderRecord {
  return {
    id: row.id,
    organizationId: row.organization_id,
    providerType: row.provider_type,
    name: row.name,
    baseUrl: row.base_url,
    enabled: row.enabled,
    createdAt: row.created_at,
  };
}

const COLUMNS = "id, organization_id, provider_type, name, base_url, enabled, created_at";

export async function createProvider(
  pool: PostgresPool,
  provider: {
    organizationId: string;
    providerType: string;
    name: string;
    baseUrl: string;
  },
): Promise<ProviderRecord> {
  const result = await pool.query<ProviderRow>(
    `INSERT INTO providers (organization_id, provider_type, name, base_url)
     VALUES ($1, $2, $3, $4)
     RETURNING ${COLUMNS}`,
    [provider.organizationId, provider.providerType, provider.name, provider.baseUrl],
  );
  return toProvider(result.rows[0]!);
}

export async function listProvidersForOrgs(
  pool: PostgresPool,
  organizationIds: string[],
): Promise<ProviderRecord[]> {
  if (organizationIds.length === 0) return [];
  const result = await pool.query<ProviderRow>(
    `SELECT ${COLUMNS} FROM providers WHERE organization_id = ANY($1) ORDER BY created_at`,
    [organizationIds],
  );
  return result.rows.map(toProvider);
}

export async function getProviderForOrgs(
  pool: PostgresPool,
  providerId: string,
  organizationIds: string[],
): Promise<ProviderRecord | null> {
  if (organizationIds.length === 0) return null;
  const result = await pool.query<ProviderRow>(
    `SELECT ${COLUMNS} FROM providers WHERE id = $1 AND organization_id = ANY($2)`,
    [providerId, organizationIds],
  );
  return result.rows[0] ? toProvider(result.rows[0]) : null;
}

export async function deleteProvider(
  pool: PostgresPool,
  providerId: string,
  organizationIds: string[],
): Promise<boolean> {
  const result = await pool.query(
    "DELETE FROM providers WHERE id = $1 AND organization_id = ANY($2)",
    [providerId, organizationIds],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function startSyncRun(pool: PostgresPool, providerId: string): Promise<string> {
  const result = await pool.query<{ id: string }>(
    "INSERT INTO provider_sync_runs (provider_id, status) VALUES ($1, 'running') RETURNING id",
    [providerId],
  );
  return result.rows[0]!.id;
}

export async function finishSyncRun(
  pool: PostgresPool,
  runId: string,
  outcome: {
    status: "succeeded" | "failed";
    recordsRead: number;
    recordsWritten: number;
    cursor?: unknown;
    error?: string;
  },
): Promise<void> {
  await pool.query(
    `UPDATE provider_sync_runs
     SET completed_at = now(), status = $2, records_read = $3, records_written = $4,
         cursor = $5, error = $6
     WHERE id = $1`,
    [
      runId,
      outcome.status,
      outcome.recordsRead,
      outcome.recordsWritten,
      JSON.stringify(outcome.cursor ?? null),
      outcome.error ?? null,
    ],
  );
}
