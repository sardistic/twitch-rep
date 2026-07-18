export type ServiceState = "ok" | "error";

export type HealthChecks = {
  postgres: () => Promise<void>;
  clickhouse: () => Promise<void>;
  redis: () => Promise<void>;
};

export type HealthReport = {
  status: "ok" | "degraded";
  services: Record<"postgres" | "clickhouse" | "redis", ServiceState>;
  version: string;
  timestamp: string;
};

const CHECK_TIMEOUT_MS = 3_000;

async function runCheck(check: () => Promise<void>): Promise<ServiceState> {
  const timeout = new Promise<never>((_, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`health check timed out after ${CHECK_TIMEOUT_MS}ms`)),
      CHECK_TIMEOUT_MS,
    );
    timer.unref?.();
  });
  try {
    await Promise.race([check(), timeout]);
    return "ok";
  } catch {
    return "error";
  }
}

export async function buildHealthReport(
  checks: HealthChecks,
  version: string,
  now: () => Date = () => new Date(),
): Promise<HealthReport> {
  const [postgres, clickhouse, redis] = await Promise.all([
    runCheck(checks.postgres),
    runCheck(checks.clickhouse),
    runCheck(checks.redis),
  ]);
  const services = { postgres, clickhouse, redis };
  const status = Object.values(services).every((state) => state === "ok") ? "ok" : "degraded";
  return { status, services, version, timestamp: now().toISOString() };
}
