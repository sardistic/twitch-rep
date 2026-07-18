import { describe, expect, it } from "vitest";
import { schemaStatements } from "./index.js";

describe("schemaStatements", () => {
  it("produces database and both table statements with the configured TTL", () => {
    const statements = schemaStatements("chatterscope", 365);
    expect(statements).toHaveLength(3);
    expect(statements[0]).toContain("CREATE DATABASE IF NOT EXISTS chatterscope");
    expect(statements[1]).toContain("chatterscope.chat_messages");
    expect(statements[1]).toContain("INTERVAL 365 DAY DELETE");
    expect(statements[2]).toContain("chatterscope.role_observations");
    expect(statements[2]).toContain("INTERVAL 365 DAY DELETE");
  });

  it("supports configurable retention", () => {
    const statements = schemaStatements("chatterscope", 30);
    expect(statements[1]).toContain("INTERVAL 30 DAY DELETE");
  });

  it("rejects unsafe database names and invalid retention", () => {
    expect(() => schemaStatements("bad;name", 365)).toThrow(/database name/);
    expect(() => schemaStatements("chatterscope", 0)).toThrow(/positive integer/);
    expect(() => schemaStatements("chatterscope", 1.5)).toThrow(/positive integer/);
  });
});
