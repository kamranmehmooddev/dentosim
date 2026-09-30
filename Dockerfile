# DentoSim — one image for the web app and the processing worker.
#   docker build -t dentosim .
#   web:    docker run dentosim            (default: next start on :3000)
#   worker: docker run dentosim worker
#   migrate:docker run dentosim migrate
FROM node:22-bookworm-slim AS build
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
COPY fixtures ./fixtures
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @dentosim/canonical build \
 && pnpm --filter @dentosim/pipeline build \
 && pnpm --filter @dentosim/viewer-core build \
 && pnpm --filter @dentosim/server build \
 && pnpm --filter @dentosim/worker build \
 && pnpm --filter @dentosim/web build \
 && pnpm prune --prod --config.ignore-scripts=true || true

FROM node:22-bookworm-slim
# 7-Zip for .7z/.rar uploads; tini for signal handling
RUN apt-get update && apt-get install -y --no-install-recommends p7zip-full tini ca-certificates && rm -rf /var/lib/apt/lists/* \
 && corepack enable && useradd -r -u 10001 dentosim
WORKDIR /app
COPY --from=build --chown=dentosim /app /app
COPY docker/entrypoint.sh /entrypoint.sh
USER dentosim
ENV NODE_ENV=production PORT=3000
EXPOSE 3000
ENTRYPOINT ["/usr/bin/tini", "--", "/entrypoint.sh"]
CMD ["web"]
