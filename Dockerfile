# Multi-stage build producing two runtime images (api, worker) from one base.
#
# The api and worker are SEPARATE processes so they scale independently — a
# burst of OCR should not need more API replicas, and the money-moving worker
# should never share a process with request handling. Same source, same
# dependencies, different entrypoint; which one you run is a compose/k8s choice.
#
# Build:
#   docker build --target api    -t refinance-api    .
#   docker build --target worker -t refinance-worker .

# ---- base: install deps + generate the Prisma client once ------------------
FROM node:20-slim AS base
WORKDIR /app

# Prisma needs openssl at runtime for its query engine.
RUN apt-get update && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*

RUN corepack enable

# Copy only manifests first, so `pnpm install` is cached until a dep changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/domain/package.json   packages/domain/
COPY packages/db/package.json       packages/db/
COPY packages/adapters/package.json packages/adapters/
COPY apps/api/package.json          apps/api/
COPY apps/worker/package.json       apps/worker/

RUN pnpm install --frozen-lockfile

# Now the source.
COPY . .

# Generate the Prisma client against the committed schema.
RUN pnpm db:generate

# tsx runs the TypeScript directly at runtime, so there's no separate compile
# step — the same approach as `pnpm dev`, minus watch. A production build could
# instead emit JS with tsup/esbuild; kept simple here on purpose.

# ---- api -------------------------------------------------------------------
FROM base AS api
ENV NODE_ENV=production
EXPOSE 3000
# Migrations are applied out-of-band (a release job runs `prisma migrate deploy`),
# not on container start — so a scaled-up replica never races another on schema.
CMD ["pnpm", "--filter", "@refi/api", "start:prod"]

# ---- worker ----------------------------------------------------------------
FROM base AS worker
ENV NODE_ENV=production
CMD ["pnpm", "--filter", "@refi/worker", "start:prod"]
