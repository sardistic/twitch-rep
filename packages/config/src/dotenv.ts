import { existsSync } from "node:fs";
import path from "node:path";

/**
 * Loads the nearest .env file into process.env by walking up from `startDir`
 * (default: cwd). Existing process.env values win. No-op when no .env exists,
 * so CI and production can rely purely on real environment variables.
 */
export function loadDotenv(startDir: string = process.cwd()): string | null {
  let dir = path.resolve(startDir);
  for (;;) {
    const candidate = path.join(dir, ".env");
    if (existsSync(candidate)) {
      const before = { ...process.env };
      process.loadEnvFile(candidate);
      for (const [key, value] of Object.entries(before)) {
        if (value !== undefined) process.env[key] = value;
      }
      return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}
