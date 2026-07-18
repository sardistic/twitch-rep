import { describe, expect, it } from "vitest";
import { checksum, orderMigrations, parseMigrationFilename } from "./migrate.js";

describe("parseMigrationFilename", () => {
  it("parses valid filenames", () => {
    expect(parseMigrationFilename("0001_initial_schema.sql")).toEqual({
      id: 1,
      name: "initial_schema",
      filename: "0001_initial_schema.sql",
    });
  });

  it("rejects invalid filenames", () => {
    expect(parseMigrationFilename("init.sql")).toBeNull();
    expect(parseMigrationFilename("01_short.sql")).toBeNull();
    expect(parseMigrationFilename("0001_Bad-Name.sql")).toBeNull();
  });
});

describe("orderMigrations", () => {
  it("orders by numeric prefix", () => {
    const ordered = orderMigrations(["0010_later.sql", "0002_second.sql", "0001_first.sql"]);
    expect(ordered.map((m) => m.id)).toEqual([1, 2, 10]);
  });

  it("throws on duplicate ids", () => {
    expect(() => orderMigrations(["0001_a.sql", "0001_b.sql"])).toThrow(/Duplicate/);
  });

  it("throws on files outside the convention instead of skipping them", () => {
    expect(() => orderMigrations(["0001_a.sql", "stray.sql"])).toThrow(/naming convention/);
  });
});

describe("checksum", () => {
  it("is stable for identical content and differs otherwise", () => {
    expect(checksum("SELECT 1;")).toBe(checksum("SELECT 1;"));
    expect(checksum("SELECT 1;")).not.toBe(checksum("SELECT 2;"));
  });
});
