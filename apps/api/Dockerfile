# syntax=docker/dockerfile:1

# Build from the repository root, which is the context the workspace needs:
#   docker build -f apps/api/Dockerfile .

# The one place Node is pinned. Dependabot bumps the tag and digest together.
# Debian, not Alpine: sharp and @node-rs/argon2 ship glibc prebuilds.
FROM node:22.23.4-bookworm-slim@sha256:4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da AS node-image

FROM node-image AS base
# HUSKY=0: no .git in the build context for the prepare hook to find.
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    HUSKY=0
WORKDIR /app
# The pnpm version comes from packageManager in the root package.json.
COPY package.json ./
RUN corepack enable && corepack install

FROM base AS build
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter @cafepos/api...
COPY apps/api/tsconfig.json apps/api/tsconfig.build.json apps/api/nest-cli.json apps/api/
COPY apps/api/src apps/api/src
RUN pnpm --filter @cafepos/api build

FROM base AS prod-deps
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod --filter @cafepos/api...

# No pnpm and no dev dependencies in what ships.
FROM node-image AS runtime
ENV NODE_ENV=production
# Same layout as the workspace, so the symlinks in apps/api/node_modules still
# reach the store in /app/node_modules. The commands below run from here.
WORKDIR /app/apps/api
COPY --from=prod-deps --chown=node:node /app/node_modules /app/node_modules
COPY --from=prod-deps --chown=node:node /app/apps/api/node_modules ./node_modules
COPY --from=build --chown=node:node /app/apps/api/dist ./dist
COPY --chown=node:node apps/api/drizzle ./drizzle
COPY --chown=node:node apps/api/package.json ./
USER node

# API, then the metrics listener, which stays off the load balancer.
EXPOSE 3000 9464

# Liveness only: a slow database must not get the container killed.
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=3 \
    CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.PORT ?? 3000}/healthz`).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]

# Migrations: node dist/database/migrate.js
CMD ["node", "dist/main"]
