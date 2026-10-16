# Builds the hub and the Discord bridge from the monorepo.
#   docker compose -f deploy/docker-compose.yml build
FROM node:24-alpine AS build
WORKDIR /repo
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @agentmesh/hub --filter @agentmesh/discord-bridge build
# Standalone folders: the package's dist plus its production node_modules.
RUN pnpm --filter @agentmesh/hub deploy --prod --legacy /out/hub \
 && pnpm --filter @agentmesh/discord-bridge deploy --prod --legacy /out/discord-bridge

FROM node:24-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
# The image's `node` user is uid 1000 — the default first user on Ubuntu VMs —
# so it can read seed files (mode 600) owned by that user on the host.
RUN mkdir -p /data && chown node:node /data

FROM runtime AS hub
COPY --from=build --chown=node:node /out/hub ./
USER node
ENV AGENTMESH_CONFIG=/config AGENTMESH_DATA_DIR=/data
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:8787/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js"]

FROM runtime AS discord-bridge
COPY --from=build --chown=node:node /out/discord-bridge ./
USER node
ENV AGENTMESH_CONFIG=/config
CMD ["node", "dist/main.js"]
