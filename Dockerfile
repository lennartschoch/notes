# Notes app — one image that serves both the API and the built React SPA.
#
# The Express server (server/src/index.ts) serves client/dist when it exists,
# so a single container is the whole app: no separate web server, no nginx.
#
# Multi-stage: the builder needs Vite/Tailwind/TypeScript (all devDependencies),
# the runtime only needs express + cors. node:22-bookworm-slim is multi-arch,
# so this builds and runs natively on the Pi's arm64.

# ── Build ────────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS build

WORKDIR /app

# Manifests (and the workspace stubs) first, so `npm ci` caches until
# dependencies actually change, independent of source edits.
COPY package.json package-lock.json ./
COPY server/package.json ./server/package.json
COPY client/package.json ./client/package.json
RUN npm ci

# Source, then the workspace build: server (tsc) + client (vite build).
COPY . .
RUN npm run build

# ── Runtime ──────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app

# Production dependencies only (express, cors; the client deps come along but
# are unused at runtime). Dev tooling is not in this image.
COPY package.json package-lock.json ./
COPY server/package.json ./server/package.json
COPY client/package.json ./client/package.json
RUN npm ci --omit=dev && npm cache clean --force

# Only the built artefacts are carried over from the builder.
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/client/dist ./client/dist

# Notes are written here. Create it owned by `node` BEFORE the volume is
# declared: Docker seeds a fresh named volume with the image directory's
# ownership, so the unprivileged user can write to it. Without this the volume
# root is root-owned and every save fails with EACCES.
RUN mkdir -p /data && chown node:node /data
ENV NOTES_DATA_FILE=/data/notes.json
VOLUME ["/data"]

USER node

# Only reachable from the compose network / a LAN-published port; never bind
# this container directly to the public internet.
EXPOSE 4000

# GET /api/health returns 200 when the API is actually answering. Node 22 has
# global fetch, so no extra tooling is needed in the slim image.
HEALTHCHECK --interval=30s --timeout=5s --retries=3 --start-period=15s \
  CMD node -e "fetch('http://127.0.0.1:4000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/dist/index.js"]
