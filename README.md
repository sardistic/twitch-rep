# ChatterScope

A moderation research tool for authorized Twitch moderators and broadcasters.
Enter a Twitch username and see a consolidated, evidence-based profile: account
identity and age, verified vs. observed roles, channels observed, message
history, and local moderation notes — with the data source, freshness, and
confidence labeled on every assertion.

ChatterScope is a moderation **context** tool, not a reputation scoring system.
It never produces trust/danger scores or ban recommendations, and it never
correlates Twitch users with off-platform identities.

See [TWITCH_CHATTER_INTELLIGENCE_HANDOFF.md](TWITCH_CHATTER_INTELLIGENCE_HANDOFF.md)
for the full specification and milestone plan.

## Status

Milestone 1 (repository and infrastructure) is implemented:

- pnpm + Turborepo monorepo with strict TypeScript
- Docker Compose for PostgreSQL 16, ClickHouse 24.8, and Redis 7
- Transactional, checksummed SQL migration system (`@chatterscope/postgres`)
- ClickHouse schema with configurable retention TTL (`@chatterscope/clickhouse`)
- Validated environment configuration (`@chatterscope/config`)
- Fastify API with `/healthz` verifying all three data services
- GitHub Actions CI (build, lint, typecheck, test, migrate, format check)

## Local development

Prerequisites: Node.js ≥ 20.11, Docker.

```bash
corepack enable
pnpm install
cp .env.example .env   # then fill in SESSION_SECRET etc. as milestones require them
docker compose -f infra/docker-compose.yml up -d
pnpm db:migrate
pnpm db:seed
pnpm dev
```

The API listens on http://localhost:4000. Verify the stack:

```bash
curl http://localhost:4000/healthz
```

Expected response when all services are reachable:

```json
{
  "status": "ok",
  "services": { "postgres": "ok", "clickhouse": "ok", "redis": "ok" },
  "version": "0.1.0",
  "timestamp": "2026-07-18T00:00:00.000Z"
}
```

A `503` with `"status": "degraded"` identifies which service is down.

## Commands

| Command           | Purpose                                                           |
| ----------------- | ----------------------------------------------------------------- |
| `pnpm build`      | Build all packages and apps                                       |
| `pnpm dev`        | Run all dev servers in parallel                                   |
| `pnpm lint`       | ESLint across the workspace                                       |
| `pnpm typecheck`  | TypeScript `--noEmit` across the workspace                        |
| `pnpm test`       | Vitest unit tests                                                 |
| `pnpm db:migrate` | Apply pending PostgreSQL migrations                               |
| `pnpm db:seed`    | Apply deterministic development seed data (refuses in production) |
| `pnpm format`     | Prettier write                                                    |

## Repository layout

```text
apps/
  api/          Fastify REST API (health endpoints in Milestone 1)
packages/
  clickhouse/   ClickHouse client + retention-parameterized schema
  config/       Zod-validated environment configuration
  eslint-config/
  postgres/     PostgreSQL pool, migration runner, migrations, seed
  typescript-config/
infra/
  docker-compose.yml
  clickhouse/init.sql
docs/
  architecture-decisions.md
```

Later milestones add `apps/web`, `apps/worker`, `apps/ingest`,
`apps/extension`, and the `contracts`, `auth`, `providers`, and `ui` packages.

## Environment variables

All variables are validated at startup (see `packages/config`). Copy
`.env.example` and generate real values for `SESSION_SECRET`,
`ENCRYPTION_KEY`, and `TWITCH_EVENTSUB_SECRET` (e.g. `openssl rand -hex 32`) —
no insecure defaults exist, and services that need a secret refuse to start
without it.
