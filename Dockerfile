# ChatterScope API image. Runs migrations + ClickHouse schema init, then the API.
FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml turbo.json ./
COPY packages ./packages
COPY apps/api ./apps/api
RUN pnpm install --frozen-lockfile
RUN pnpm build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app ./
USER node
EXPOSE 4000
CMD ["sh", "-c", "node packages/postgres/dist/bin/migrate.js && node packages/clickhouse/dist/bin/init.js && node apps/api/dist/main.js"]
