# Patchwork server: the web UI plus the engine (git, worktrees, the Claude agent) on port 3000.

FROM node:24-bookworm-slim AS build
WORKDIR /app
# Desktop and test binaries aren't needed here.
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1 \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
COPY package.json package-lock.json .npmrc ./
RUN npm ci
COPY . .
RUN npm run build && npm run server:build

# Production dependencies only: the agent SDK, its native binary for this platform, and zod.
FROM node:24-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci --omit=dev --ignore-scripts

FROM node:24-bookworm-slim
RUN apt-get update \
    # bubblewrap and socat let Claude Code sandbox the agent's shell commands.
    && apt-get install -y --no-install-recommends git openssh-client ca-certificates bubblewrap socat \
    && rm -rf /var/lib/apt/lists/* \
    # Repositories are mounted from the host and may be owned by a different user id.
    && git config --system safe.directory '*' \
    && mkdir -p /data && chown node:node /data
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/build ./build
COPY --from=build /app/dist-server ./dist-server
COPY package.json ./
# Repositories are cloned into /data; PATCHWORK_REPOS is only set when a folder is mounted
# (compose.local-repos.yaml).
ENV NODE_ENV=production \
    PORT=3000 \
    PATCHWORK_DATA_DIR=/data
USER node
EXPOSE 3000
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=3s \
    CMD node -e "fetch('http://localhost:3000/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "dist-server/server.mjs"]
