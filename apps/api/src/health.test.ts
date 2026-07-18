import { describe, expect, it } from "vitest";
import { buildHealthReport } from "./health.js";

const ok = async () => {};
const fail = async () => {
  throw new Error("down");
};

describe("buildHealthReport", () => {
  it("reports ok when every service check passes, with the required shape", async () => {
    const now = new Date("2026-07-18T00:00:00.000Z");
    const report = await buildHealthReport(
      { postgres: ok, clickhouse: ok, redis: ok },
      "0.1.0",
      () => now,
    );
    expect(report).toEqual({
      status: "ok",
      services: { postgres: "ok", clickhouse: "ok", redis: "ok" },
      version: "0.1.0",
      timestamp: "2026-07-18T00:00:00.000Z",
    });
  });

  it("reports degraded and marks only the failing service", async () => {
    const report = await buildHealthReport({ postgres: ok, clickhouse: fail, redis: ok }, "0.1.0");
    expect(report.status).toBe("degraded");
    expect(report.services).toEqual({ postgres: "ok", clickhouse: "error", redis: "ok" });
  });
});
